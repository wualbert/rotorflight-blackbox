'use strict';

/**
 * Step 2 of 2: turn segments.json into measurements, validated predictions and recommendations.
 *
 *   node tools/autotune/report.cjs <dir with segments.json>
 *
 * Writes report.md and results.json next to it. Every decision is produced by RULES below and is printed
 * with the numbers that triggered it. The prediction method is checked against simulated ground truth in
 * test/autotune.test.cjs.
 */

const fs = require('node:fs'), path = require('node:path');
const lib = require('./lib.cjs');
const { cx } = lib;

const RULES = {
    headspeedBinRpm: 250,
    minFlights: 3,          // leave-one-flight-out needs at least three flights
    fitBand: [1, 30],       // Hz searched for usable plant bins
    maxSigma: 0.2,          // a plant bin is usable when its relative standard error is below this
    sigmaFloor: 0.03,       // systematic error floor measured on synthetic data
    gainTolerance: 0.07,    // segments belong to one gain set when every gain agrees within 7 %
    crossAxisShift: 0.05,   // gate V1: own-stick response may move this much when the other sticks are held constant
    weightedLoopError: 0.10, // gate V2b
    trackError: 0.15,       // gate V3
    multipliers: [0.8, 0.9, 1.1, 1.2], // at most 20 % per gain per iteration
    maxGainsChanged: 3,
    // systematic accuracy of predictions, measured by predicting a gain change and then simulating flights with
    // that change (test/autotune.test.cjs). Added in quadrature to the statistical standard error.
    trackingFloor: 0.025,   // of the setpoint RMS inside the band
    disturbanceFloor: 0.03, // of the flown disturbance RMS
    componentMin: 0.10,     // tracking or disturbance must improve by 10 % of its flown value ...
    minSigmas: 2,           // ... and by 2 standard errors
    maxHarm: 0.01,          // the other component may not get worse by more than 1 %
    totalMinDrop: 0.02,     // and the total error must fall by at least 2 %
    tolerance: 0.01,        // constraints are checked to 1 %
    lineProminence: 5,      // vibration line: amplitude at least 5x the band median
    lineSpread: 0.04,       // ... in a segment whose headspeed stayed within 4 %
    lineCluster: 0.015,     // lines within 1.5 % of one line / rotor ratio form a family
};

const DIR = process.argv[2];
if (!DIR) { console.error('usage: node report.cjs <dir with segments.json>'); process.exit(2); }
const data = JSON.parse(fs.readFileSync(path.join(DIR, 'segments.json')));

// ---- helpers ---------------------------------------------------------------------------------
const n1 = (v, d = 1) => v === null || v === undefined || !isFinite(v) ? 'n/a' : v.toFixed(d);
const pm = (v, se, d = 1) => `${n1(v, d)} ± ${n1(se, d)}`;
const table = (head, rows) => ['| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|', ...rows.map(r => '| ' + r.join(' | ') + ' |')].join('\n');
const median = (xs) => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };
const wmedian = (pairs) => { const s = pairs.filter(p => p[0] !== null && p[0] !== undefined && isFinite(p[0])).sort((a, b) => a[0] - b[0]); const tot = s.reduce((t, p) => t + p[1], 0); let acc = 0; for (const p of s) { acc += p[1]; if (acc >= tot / 2) return p[0]; } return null; };
const jackSE = (values) => { const n = values.length, m = values.reduce((s, v) => s + v, 0) / n; return Math.sqrt((n - 1) / n * values.reduce((s, v) => s + (v - m) ** 2, 0)); };
const deg = (c) => cx.arg(c) * 180 / Math.PI;
const hsBin = (s) => Math.round(s.headspeed.median / RULES.headspeedBinRpm) * RULES.headspeedBinRpm;
const minutes = (segs) => segs.reduce((t, s) => t + s.seconds, 0) / 60;

const ols = lib.solve;

// ---- gain sets -------------------------------------------------------------------------------
const KEYS = { roll: ['P', 'D', 'F'], pitch: ['P', 'D', 'F'], yaw: ['P_cw', 'P_ccw', 'D'] };
const gainOf = (s, axis, k) => { const g = s.axes[axis].gains[k]; return g ? g.gain : null; };

function gainSets(segs, axis) { // greedy: longest segments define the sets, others join the first set they agree with
    const sets = [];
    for (const s of segs.slice().sort((a, b) => b.seconds - a.seconds)) {
        const v = KEYS[axis].map(k => gainOf(s, axis, k));
        if (v.some(x => x === null)) continue;
        const hit = sets.find(set => set.ref.every((r, i) => Math.abs(v[i] - r) <= Math.max(1, RULES.gainTolerance * Math.abs(r))));
        if (hit) hit.segs.push(s); else sets.push({ ref: v, segs: [s] });
    }
    for (const set of sets) set.label = set.ref.map(v => Math.round(v)).join('/');
    return sets.sort((a, b) => minutes(b.segs) - minutes(a.segs));
}

function gainsOf(segs, axis) {
    const w = (pick) => wmedian(segs.map(s => [pick(s.axes[axis].gains), s.axes[axis].spectra.windows]));
    const g = { I: w(x => x.I && x.I.gain), decayPerS: Math.max(0, w(x => x.I && x.I.decayPerS) || 0), relaxLevel: w(x => x.I && x.I.relaxLevel), relaxCutoff: w(x => x.I && x.I.relaxCutoff), D: w(x => x.D && x.D.gain), dCutoff: w(x => x.D && x.D.cutoff),
        B: w(x => x.B && x.B.gain) || 0, bCutoff: w(x => x.B && x.B.cutoff) || 35, gyroCutoff: w(x => x.gyroCutoff) };
    if (axis === 'yaw') {
        g.Pcw = w(x => x.P_cw && x.P_cw.gain); g.Pccw = w(x => x.P_ccw && x.P_ccw.gain);
        g.P = (g.Pcw + g.Pccw) / 2;          // P already carries the stop gain; the linear model uses the mean of both directions
        const fr2 = w(x => x.F && x.F.r2);
        g.F = Math.max(0, w(x => x.F && x.F.gain) || 0); g.Fr2 = fr2; // yaw F after regressing out the precompensation
    } else { g.P = w(x => x.P && x.P.gain); g.F = w(x => x.F && x.F.gain); }
    g.r2 = { P: w(x => (x.P || x.P_cw || {}).r2), D: w(x => x.D && x.D.r2), F: w(x => x.F && x.F.r2), B: w(x => x.B && x.B.r2), I: w(x => x.I && x.I.r2) };
    return g;
}

// ---- report ----------------------------------------------------------------------------------
const results = { rules: RULES, inputs: data.files, flights: data.flights.length, segments: data.segments.length, order: {}, groups: [], decisions: [] };
const out = [], usable = data.segments;

out.push(`# Tuning analysis: ${data.flights[0].craft}`, '',
    `Generated by \`tools/autotune/report.cjs\` from ${data.files.length} log file(s). Firmware ${data.flights[0].firmware}. Logging rate ${data.flights[0].rate} Hz.`, '',
    'Every number below is computed from the logs. "±" is one standard error from leave-one-flight-out resampling. Decisions follow fixed rules, listed in section 7.', '',
    '## 1. Data', '',
    '- Input files: ' + data.files.map(f => { const fl = data.flights.filter(x => x.file === f); return `\`${f}\` (${fl.length} flights)`; }).join(', ') + '.',
    `- ${data.flights.length} flights decoded, ${(data.flights.reduce((s, f) => s + f.durationS, 0) / 60).toFixed(1)} min in total.`,
    `- ${usable.length} segments used, ${minutes(usable).toFixed(1)} min. Segment rule: ${data.rules}.`,
    `- ${data.skipped.length} logs not used: ` + Object.entries(data.skipped.reduce((t, s) => { const k = s.reason.replace(/ in RTFL.*/, ' in another file'); t[k] = (t[k] || 0) + 1; return t; }, {})).map(([k, v]) => `${v} × ${k}`).join('; ') + '.',
    `- ${data.flights.filter(f => f.gaps).length} flights have logging gaps; segments are cut at each gap.`, '');

const bins = {};
for (const s of usable) (bins[hsBin(s)] = bins[hsBin(s)] || []).push(s);
const binKeys = Object.keys(bins).sort((a, b) => a - b);
out.push(table(['Headspeed bin (rpm)', 'Segments', 'Flights', 'Minutes', 'Analysed'],
    binKeys.map(b => { const fl = new Set(bins[b].map(s => s.flight)).size; return [b, bins[b].length, fl, minutes(bins[b]).toFixed(1), fl >= RULES.minFlights ? 'yes' : `no, under ${RULES.minFlights} flights`]; })), '');

// ---- 2. gains --------------------------------------------------------------------------------
out.push('## 2. Gains in effect', '',
    'Regressed from the logged PID terms through sample-exact replicas of the firmware filters, so they are the gains the controller applied in each segment. R² is the share of the logged term explained. ' +
    `Segments whose gains agree within ${Math.round(RULES.gainTolerance * 100)} % form one set.`, '');
for (const axis of lib.AXES) {
    const sets = gainSets(usable, axis);
    out.push(`**${axis}**: ${sets.length} gain set(s)` + (sets.length > 8 ? ', 8 most flown shown' : ''), '',
        table(axis === 'yaw' ? ['P × CW stop', 'P × CCW stop', 'I', 'Relax level', 'D', 'D cutoff (Hz)', 'F', 'B', 'Segments', 'Minutes', 'R² P', 'R² D', 'R² I', 'R² F']
            : ['P', 'I', 'Relax level', 'D', 'F', 'B', 'Gyro cutoff (Hz)', 'D cutoff (Hz)', 'Segments', 'Minutes', 'R² P', 'R² D', 'R² F', 'R² I'],
        sets.slice(0, 8).map(set => { const g = gainsOf(set.segs, axis);
            return axis === 'yaw' ? [n1(g.Pcw), n1(g.Pccw), n1(g.I, 0), n1(g.relaxLevel, 0), n1(g.D), n1(g.dCutoff, 0), n1(g.F), n1(g.B), set.segs.length, minutes(set.segs).toFixed(1), n1(g.r2.P, 3), n1(g.r2.D, 3), n1(g.r2.I, 2), n1(g.r2.F, 2)]
                : [n1(g.P), n1(g.I, 0), n1(g.relaxLevel, 0), n1(g.D), n1(g.F), n1(g.B), n1(g.gyroCutoff, 0), n1(g.dCutoff, 0), set.segs.length, minutes(set.segs).toFixed(1), n1(g.r2.P, 3), n1(g.r2.D, 3), n1(g.r2.F, 3), n1(g.r2.I, 2)]; })), '');
}
out.push('Relax level is the I-term relax threshold in deg/s that best explains the logged I term. The yaw F gain is measured after regressing the collective and cyclic precompensation out of the logged term.', '');

// ---- 3. vibration lines ----------------------------------------------------------------------
out.push('## 3. Narrow vibration lines: mechanical or control loop?', '',
    'A control-loop oscillation or an airframe resonance keeps its frequency when headspeed changes. A mechanical vibration moves in proportion to rotor speed. ' +
    `Per segment, the strongest narrow line between 8 and 30 Hz in the gyro spectrum (0.125 Hz resolution) is kept when its amplitude is at least ${RULES.lineProminence}× the band median and headspeed stayed within ${RULES.lineSpread * 100} % during the segment. ` +
    `Lines within ${RULES.lineCluster * 100} % of a common line ÷ rotor ratio form a family. The largest family is fitted against rotor frequency.`, '');
{
    const rows = [];
    for (const axis of lib.AXES) {
        const steady = usable.filter(s => s.axes[axis].line && (s.headspeed.p95 - s.headspeed.p05) / s.headspeed.median <= RULES.lineSpread);
        const pts = steady.filter(s => s.axes[axis].line.prominence >= RULES.lineProminence).map(s => ({ rotor: s.headspeed.median / 60, hz: s.axes[axis].line.hz, amp: s.axes[axis].line.amplitude, ratio: s.axes[axis].line.hz / (s.headspeed.median / 60) }));
        let fam = [];
        for (const c of pts) { const m = pts.filter(p => Math.abs(p.ratio / c.ratio - 1) <= RULES.lineCluster); if (m.length > fam.length) fam = m; }
        const r = { axis, steadySegments: steady.length, lines: pts.length, inFamily: fam.length };
        if (fam.length >= 5) {
            const fit = ols(fam.map(p => [1, p.rotor]), fam.map(p => p.hz)), prop = lib.fitLine(fam.map(p => p.rotor), fam.map(p => p.hz));
            const mean = fam.reduce((t, p) => t + p.hz, 0) / fam.length, sd = (f) => Math.sqrt(fam.reduce((t, p) => t + f(p) ** 2, 0) / (fam.length - 1));
            Object.assign(r, { order: prop.k, orderSE: prop.se, slope: fit.beta[1], slopeSE: fit.se[1], intercept: fit.beta[0], interceptSE: fit.se[0], r2: fit.r2,
                rotorSpanHz: [Math.min(...fam.map(p => p.rotor)), Math.max(...fam.map(p => p.rotor))], lineSpanHz: [Math.min(...fam.map(p => p.hz)), Math.max(...fam.map(p => p.hz))],
                amplitudeMedian: median(fam.map(p => p.amp)), amplitudeMax: Math.max(...fam.map(p => p.amp)), scatterIfRotorLockedHz: sd(p => p.hz - prop.k * p.rotor), scatterIfFixedHz: sd(p => p.hz - mean),
                slopeSigmas: fit.beta[1] / fit.se[1], interceptSigmas: fit.beta[0] / fit.se[0], otherRatios: pts.filter(p => !fam.includes(p)).map(p => +p.ratio.toFixed(3)).sort() });
            r.verdict = Math.abs(r.slopeSigmas) > 5 && Math.abs(r.interceptSigmas) < 3 ? 'rotor-locked' : Math.abs(r.slopeSigmas) < 2 ? 'fixed frequency' : 'undecided';
        } else r.verdict = 'no family of 5 or more lines';
        results.order[axis] = r;
        rows.push([axis, `${r.lines} of ${r.steadySegments}`, r.inFamily, r.order === undefined ? 'n/a' : pm(r.order, r.orderSE, 4), r.slope === undefined ? 'n/a' : `${pm(r.slope, r.slopeSE, 4)} (${n1(Math.abs(r.slopeSigmas))} σ from 0)`,
            r.slope === undefined ? 'n/a' : `${pm(r.intercept, r.interceptSE, 2)} Hz (${n1(Math.abs(r.interceptSigmas))} σ from 0)`, n1(r.r2, 4),
            r.rotorSpanHz ? `${n1(r.lineSpanHz[0])} to ${n1(r.lineSpanHz[1])} for rotor ${n1(r.rotorSpanHz[0])} to ${n1(r.rotorSpanHz[1])}` : 'n/a',
            r.scatterIfFixedHz === undefined ? 'n/a' : `${n1(r.scatterIfRotorLockedHz, 2)} / ${n1(r.scatterIfFixedHz, 2)}`, r.amplitudeMedian === undefined ? 'n/a' : `${n1(r.amplitudeMedian)} / ${n1(r.amplitudeMax)}`, r.verdict]);
    }
    out.push(table(['Axis', 'Segments with a line', 'In largest family', 'Line ÷ rotor frequency', 'Slope (Hz per rotor Hz)', 'Intercept', 'R²', 'Line span (Hz)', 'Scatter if rotor-locked / if fixed (Hz)', 'Amplitude median / max (deg/s)', 'Verdict'], rows), '',
        'Verdict rule: rotor-locked when the slope is more than 5 standard errors from zero and the intercept within 3 standard errors of zero; fixed frequency when the slope is within 2 standard errors of zero.', '');
    const notes = lib.AXES.filter(a => results.order[a].order !== undefined).map(a => { const r = results.order[a], all = r.otherRatios.concat([r.order]), span = Math.max(...all) - Math.min(...all);
        r.expectedByChance = span > 0 ? r.lines * 2 * RULES.lineCluster * r.order / span : null;
        return `${a}: ${r.inFamily} of ${r.lines} lines fall in the family; if the ratios were scattered evenly over their range (${n1(Math.min(...all), 3)} to ${n1(Math.max(...all), 3)}), ${n1(r.expectedByChance)} would`; });
    if (notes.length) out.push('Could a family be a coincidence? ' + notes.join('. ') + '.', '');
}

// ---- 4. per headspeed and axis ---------------------------------------------------------------
out.push('## 4. Response per headspeed and axis', '',
    '- **T**: closed loop, setpoint to gyro, `Sry / Srr`. **G**: airframe, mixer input to gyro, `Sry / Sru`. Using the setpoint as instrument keeps G unbiased although the data is closed loop.',
    `- **Validated band**: the longest stretch of frequency bins where G is known to better than ${RULES.maxSigma * 100} % (one standard error), tolerating dropouts of up to 1 Hz. All predictions are confined to it.`,
    '- **Tracking error**: RMS of `gyro − setpoint` that remains after removing the best-fitting pure delay, for the stick input as flown.',
    '- **Uncommanded motion**: gyro motion the setpoint does not explain, `(1 − coherence) × gyro PSD`.',
    '- **Peak sensitivity**: the largest factor by which feedback amplifies a disturbance inside the band. 1.0 means no amplification anywhere.',
    '- **Predictions** apply the firmware control law, with the gains of section 2, to the measured G. No airframe model is assumed.', '');

const SHOW = [1, 2, 3, 5, 7, 10, 12, 14, 16, 18, 20, 25];

for (const bin of binKeys) {
    const segsBin = bins[bin];
    if (new Set(segsBin.map(s => s.flight)).size < RULES.minFlights) continue;
    out.push(`### ${bin} rpm`, '');
    for (let a = 0; a < 3; a++) {
        const axis = lib.AXES[a], set = gainSets(segsBin, axis)[0];
        const pooledG = lib.pool(segsBin.map(s => ({ flight: s.flight, spectra: s.axes[axis].spectra })));
        const pooledT = lib.pool(set.segs.map(s => ({ flight: s.flight, spectra: s.axes[axis].spectra })));
        const G = { bin: +bin, axis, gainSet: set.label, plantFlights: pooledG.flights, plantWindows: pooledG.windows, loopFlights: pooledT.flights, loopWindows: pooledT.windows };
        results.groups.push(G);
        const decide = (d) => { G.decision = d; results.decisions.push(Object.assign({ axis, bin: +bin, flights: pooledT.flights, windows: pooledT.windows }, d)); };
        out.push(`#### ${axis} at ${bin} rpm`, '',
            `Airframe response from ${pooledG.windows} windows (2 s each) in ${pooledG.flights} flights. Closed loop from the most-flown gain set (${set.label}): ${pooledT.windows} windows in ${pooledT.flights} flights.`, '');
        if (pooledT.flights < RULES.minFlights) {
            out.push(`**Not analysed.** The most-flown gain set covers ${pooledT.flights} flight(s); ${RULES.minFlights} are needed to compute uncertainty.`, '');
            decide({ change: false, reason: `${pooledT.flights} flight(s) on the most-flown gain set, ${RULES.minFlights} needed` }); continue;
        }
        const gains = gainsOf(set.segs, axis), rowsT = pooledT.rows, rowsG = pooledG.rows, at = (rows, f) => rows.find(r => r.f === f);
        G.gains = Object.assign({}, gains);
        gains.relax = lib.relaxResponse(rowsT);
        G.relaxAt = [1, 2, 5, 10].map(f => ({ hz: f, magnitude: cx.abs(gains.relax(f)) }));

        out.push(table(['Hz', '\\|T\\|', 'T phase (deg)', 'Coherence', '\\|G\\| (deg/s per unit)', 'G phase (deg)', 'G std. error'],
            SHOW.map(f => { const t = at(rowsT, f), g = at(rowsG, f); return [f, pm(cx.abs(t.T), cx.abs(t.T) * t.Tse.seLog, 2), pm(deg(t.T), t.Tse.sePhase * 180 / Math.PI, 0), n1(t.cohRY, 3),
                pm(cx.abs(g.G), cx.abs(g.G) * g.Gse.seLog, 0), pm(deg(g.G), g.Gse.sePhase * 180 / Math.PI, 0), n1(100 * g.Gse.sigma, 0) + ' %']; })), '');

        const vb = lib.validBand(rowsG, RULES.fitBand[0], RULES.fitBand[1], RULES.maxSigma);
        if (!vb || vb.band[1] - vb.band[0] < 5) {
            out.push(`**Not analysed.** No stretch of 5 Hz or more has the airframe response known to ${RULES.maxSigma * 100} %.`, '');
            decide({ change: false, reason: `airframe response not known to ${RULES.maxSigma * 100} % over any 5 Hz stretch` }); continue;
        }
        const band = vb.band, inBand = (r) => r.f >= band[0] && r.f <= band[1], tableG = lib.plantTable(rowsG, vb);
        G.validBand = band; G.usableBins = vb.usable.length; G.bandBins = vb.bins;

        // ---- measured
        const repsT = pooledT.leaveOut.map(L => lib.rowsOf(L));
        const lowOf = (rows) => { let s = 0, n = 0; for (const r of rows) if (r.f >= 1 && r.f <= 3) { s += cx.abs(r.T); n++; } return s / n; };
        const peakOf = (rows) => { let p = { mag: 0 }; for (const r of rows) if (inBand(r) && r.f >= 3) { const m = cx.abs(r.T); if (m > p.mag) p = { mag: m, f: r.f }; } return p; };
        const resid = (rows, f0, f1) => { let s = 0; for (const r of rows) if (r.f >= f0 && r.f <= f1) s += lib.residualPsd(r) * 0.5; return Math.sqrt(s); };
        const dM = lib.delayFit(rowsT, (f, r) => r.T, band[0], band[1]), dJ = repsT.map(rows => lib.delayFit(rows, (f, r) => r.T, band[0], band[1]));
        const M = { lowFreqGain: lowOf(rowsT), lowFreqGainSE: jackSE(repsT.map(lowOf)), peakT: peakOf(rowsT).mag, peakTHz: peakOf(rowsT).f, peakTSE: jackSE(repsT.map(r => peakOf(r).mag)),
            delayMs: dM.delayMs, delayMsSE: jackSE(dJ.map(d => d.delayMs)), trackRms: dM.shapeRms, trackRmsSE: jackSE(dJ.map(d => d.shapeRms)),
            setpointRms: lib.bandRms(rowsT, 'rr', 0.5, 60), setpointInBand: lib.bandRms(rowsT, 'rr', band[0], band[1]),
            uncommanded: resid(rowsT, 0.5, 60), uncommandedInBand: resid(rowsT, band[0], band[1]), uncommandedInBandSE: jackSE(repsT.map(r => resid(r, band[0], band[1]))),
            uncommandedLow: resid(rowsT, 0.5, 8), uncommandedLowSE: jackSE(repsT.map(r => resid(r, 0.5, 8))), uncommandedHigh: resid(rowsT, 8, 25), uncommandedHighSE: jackSE(repsT.map(r => resid(r, 8, 25))) };
        G.measured = M;
        out.push(`Validated band ${n1(band[0])} to ${n1(band[1])} Hz (${vb.usable.length} of ${vb.bins} bins usable). It holds ${n1(100 * (M.setpointInBand / M.setpointRms) ** 2, 0)} % of the setpoint power and ${n1(100 * (M.uncommandedInBand / M.uncommanded) ** 2, 0)} % of the uncommanded motion power.`, '',
            table(['Measured', 'Value'], [
                ['Closed-loop gain, 1 to 3 Hz (ideal 1.00)', pm(M.lowFreqGain, M.lowFreqGainSE, 3)],
                ['Largest \\|T\\| in band', `${pm(M.peakT, M.peakTSE, 2)} at ${n1(M.peakTHz)} Hz`],
                ['Best-fit pure delay', pm(M.delayMs, M.delayMsSE) + ' ms'],
                ['Tracking error, in band', pm(M.trackRms, M.trackRmsSE) + ' deg/s RMS'],
                ['Setpoint, 0.5 to 60 Hz', n1(M.setpointRms) + ' deg/s RMS'],
                ['Uncommanded motion, 0.5 to 8 Hz', pm(M.uncommandedLow, M.uncommandedLowSE) + ' deg/s RMS'],
                ['Uncommanded motion, 8 to 25 Hz', pm(M.uncommandedHigh, M.uncommandedHighSE) + ' deg/s RMS'],
            ]), '');

        // ---- cross-axis check: the same gain with the other three stick inputs held constant
        const crossBy = new Map();
        for (const x of set.segs) if (x.cross) { if (!crossBy.has(x.flight)) crossBy.set(x.flight, []); crossBy.get(x.flight).push(x.cross); }
        const crossFlights = [...crossBy.values()].map(lib.sumCross), cg = lib.crossAxisGain(lib.sumCross(crossFlights), a);
        const cj = crossFlights.map((_, i) => lib.crossAxisGain(lib.sumCross(crossFlights.filter((__, j) => j !== i)), a));
        const cross = Object.assign({ aloneSE: jackSE(cj.map(x => x.alone)), heldSE: jackSE(cj.map(x => x.held)), shift: cg.held - cg.alone, shiftSE: jackSE(cj.map(x => x.held - x.alone)) }, cg);
        G.crossAxis = cross;
        out.push(table(['Cross-axis check, 1 to 3 Hz', 'Value'], [
            ['Closed-loop gain from this stick alone', pm(cross.alone, cross.aloneSE, 3)], ['Same, with roll, pitch, yaw and collective inputs held constant', pm(cross.held, cross.heldSE, 3)],
            ['Shift', pm(cross.shift, cross.shiftSE, 3)], ['Coherence of this stick with collective', n1(cross.cohCollective, 3)], ['Largest coherence with another stick', n1(cross.cohStick, 3)]]), '');

        // ---- descriptive airframe model
        const fit = lib.fitPlant(pooledG, band[0], band[1], RULES.maxSigma, RULES.sigmaFloor);
        G.airframeModels = fit.models.map(m => Object.assign({}, m, { jack: undefined }));
        const label = { second: 'one resonance + delay', lag: 'damped integrator + delay', lagres: 'damped integrator × one resonance + delay' };
        out.push('Airframe models fitted to G, for description only (predictions do not use them). χ² per degree of freedom near 1 means the model matches the data to within its uncertainty.', '',
            table(['Model', 'Gain', 'Resonance (Hz)', 'Damping ratio', 'Pole (Hz)', 'Delay (ms)', 'χ² / dof'],
                fit.models.map(m => [label[m.kind], pm(m.K, m.se.K, 0) + (m.kind === 'second' ? ' deg/s per unit' : ' deg/s² per unit'), m.fn === undefined ? '' : pm(m.fn, m.se.fn, 2), m.zeta === undefined ? '' : pm(m.zeta, m.se.zeta, 3),
                    m.a === undefined ? '' : pm(m.a / 2 / Math.PI, m.se.a / 2 / Math.PI, 2), pm(m.tau * 1000, m.se.tau * 1000), n1(m.chi2red, 2)])), '');

        // ---- gates
        const base = lib.predict(a, gains, gains, tableG, rowsT, vb);
        let inside = 0, nb = 0, num = 0, den = 0;
        for (const r of rowsT) {
            if (!vb.usable.includes(r.f)) continue;
            const p = lib.loop(a, gains, (f) => tableG.get(f), r.f).T, rel = cx.abs(cx.sub(p, r.T)) / cx.abs(r.T), g = at(rowsG, r.f);
            if (rel <= 2 * Math.hypot(RULES.sigmaFloor, r.Tse.sigma, g.Gse.sigma)) inside++;
            nb++; num += r.rr * cx.abs(cx.sub(p, r.T)) ** 2; den += r.rr * cx.abs(r.T) ** 2;
        }
        const need = 0.95 - 2 * Math.sqrt(0.95 * 0.05 / nb), wErr = Math.sqrt(num / den), dTrack = Math.abs(base.track - M.trackRms), allow = Math.max(RULES.trackError * M.trackRms, 2 * M.trackRmsSE);
        G.gates = {
            V1: { value: Math.abs(cross.shift), limit: Math.max(RULES.crossAxisShift, 2 * cross.shiftSE), pass: Math.abs(cross.shift) <= Math.max(RULES.crossAxisShift, 2 * cross.shiftSE) },
            V2a: { value: inside / nb, limit: need, pass: inside / nb >= need, text: `${inside} of ${nb} bins within 2 standard errors` },
            V2b: { value: wErr, limit: RULES.weightedLoopError, pass: wErr <= RULES.weightedLoopError },
            V3: { value: dTrack, limit: allow, pass: dTrack <= allow, predicted: base.track, measured: M.trackRms } };
        out.push('Are the single-axis estimates trustworthy, and does the control law, with the recovered gains and the measured G, reproduce what was measured?', '',
            table(['Gate', 'Value', 'Limit', 'Result'], [
                ['V1 response to this stick unchanged when the other sticks are held constant', `shift ${n1(cross.shift, 3)}`, `within ${n1(G.gates.V1.limit, 3)}`, G.gates.V1.pass ? 'pass' : 'FAIL'],
                ['V2a predicted T inside the error bars', `${inside} of ${nb} bins (${n1(100 * inside / nb, 0)} %)`, `≥ ${n1(100 * need, 0)} %`, G.gates.V2a.pass ? 'pass' : 'FAIL'],
                ['V2b error of predicted T, weighted by stick input', n1(100 * wErr, 1) + ' %', `≤ ${RULES.weightedLoopError * 100} %`, G.gates.V2b.pass ? 'pass' : 'FAIL'],
                ['V3 tracking error, predicted vs measured', `${n1(base.track)} vs ${pm(M.trackRms, M.trackRmsSE)} deg/s`, `within ${n1(allow)} deg/s`, G.gates.V3.pass ? 'pass' : 'FAIL'],
            ]), '');
        G.flown = base;
        const failed = Object.entries(G.gates).filter(([, g]) => !g.pass).map(([k]) => k);
        if (failed.length) {
            out.push(`**No recommendation for ${axis} at ${bin} rpm.** Gate ${failed.join(', ')} failed, so predictions for this group are not trusted.`, '');
            decide({ change: false, reason: `gate ${failed.join(', ')} failed`, gates: G.gates }); continue;
        }

        // ---- predictions, each repeated on every leave-one-flight-out replicate
        const reps = pooledG.flightIds.map((id, j) => { const i = pooledT.flightIds.indexOf(id); return { table: lib.plantTable(lib.rowsOf(pooledG.leaveOut[j]), vb), rows: i >= 0 ? repsT[i] : rowsT }; });
        const names = ['P', 'I', 'D', 'F', 'B'].filter(k => gains[k] > 0);
        const outOfBand = []; for (let f = band[1] + 0.5; f <= 100; f += 0.5) outOfBand.push(f);
        const fbFlown = outOfBand.map(f => lib.feedbackGain(a, gains, f));
        const floors = { track: RULES.trackingFloor * M.setpointInBand, disturb: RULES.disturbanceFloor * base.disturb };
        G.floors = floors;
        const evaluate = (g, from) => {
            const tau = base.delayMs / 1000, p = lib.predict(a, g, gains, tableG, rowsT, vb, tau), ref = from ? lib.predict(a, from, gains, tableG, rowsT, vb, tau) : base;
            const d = reps.map(rp => { const b0 = lib.predict(a, gains, gains, rp.table, rp.rows, vb), t = b0.delayMs / 1000, r = from ? lib.predict(a, from, gains, rp.table, rp.rows, vb, t) : b0, c = lib.predict(a, g, gains, rp.table, rp.rows, vb, t);
                return { track: r.track - c.track, disturb: r.disturb - c.disturb, total: r.total - c.total }; });
            const e = { p, ref, dTrack: ref.track - p.track, seTrack: Math.hypot(jackSE(d.map(x => x.track)), floors.track), dDisturb: ref.disturb - p.disturb, seDisturb: Math.hypot(jackSE(d.map(x => x.disturb)), floors.disturb),
                drop: ref.total - p.total, dropSE: jackSE(d.map(x => x.total)), broken: [] };
            const tol = 1 + RULES.tolerance;
            if (p.peakSensitivity > base.peakSensitivity * tol) e.broken.push(`peak sensitivity ${n1(base.peakSensitivity, 2)} → ${n1(p.peakSensitivity, 2)}`);
            if (p.peakT > base.peakT * tol) e.broken.push(`largest |T| ${n1(base.peakT, 2)} → ${n1(p.peakT, 2)}`);
            if (Math.abs(p.lowFreqGain - 1) > Math.max(Math.abs(base.lowFreqGain - 1), 0.05) + RULES.tolerance) e.broken.push(`gain at 1 to 3 Hz ${n1(base.lowFreqGain, 3)} → ${n1(p.lowFreqGain, 3)}`);
            const k = outOfBand.findIndex((f, i) => lib.feedbackGain(a, g, f) > fbFlown[i] * tol);
            if (k >= 0) e.broken.push(`feedback gain raised above the band, at ${n1(outOfBand[k])} Hz`);
            // decision rule
            const gainT = e.dTrack >= RULES.minSigmas * e.seTrack && e.dTrack >= RULES.componentMin * ref.track, gainD = e.dDisturb >= RULES.minSigmas * e.seDisturb && e.dDisturb >= RULES.componentMin * ref.disturb;
            e.why = e.broken.length ? 'constraint: ' + e.broken.join('; ')
                : e.dTrack < -RULES.maxHarm * ref.track ? `tracking worse by ${n1(-100 * e.dTrack / ref.track)} %`
                : e.dDisturb < -RULES.maxHarm * ref.disturb ? `disturbance worse by ${n1(-100 * e.dDisturb / ref.disturb)} %`
                : !(gainT || gainD) ? `no component improves by ${RULES.componentMin * 100} % and ${RULES.minSigmas} std. errors`
                : e.drop < RULES.totalMinDrop * base.total ? `total falls by ${n1(100 * e.drop / base.total)} %, under ${RULES.totalMinDrop * 100} %` : null;
            e.accept = e.why === null; e.improves = gainT && gainD ? 'tracking and disturbance' : gainT ? 'tracking' : gainD ? 'disturbance' : null;
            return e;
        };

        const sens = [];
        for (const k of names) for (const m of [0.8, 1.2]) { const g = Object.assign({}, gains, { [k]: gains[k] * m }), e = evaluate(g);
            sens.push({ gain: k, multiplier: m, value: g[k], dTrack: e.dTrack, seTrack: e.seTrack, dDisturb: e.dDisturb, seDisturb: e.seDisturb, drop: e.drop, accept: e.accept, why: e.why, predicted: e.p }); }
        G.sensitivity = sens;
        out.push(`Predicted effect of one gain at a time, others as flown. Positive numbers are improvements. Flown: tracking ${n1(base.track)}, disturbance ${n1(base.disturb)}, total ${n1(base.total)} deg/s RMS; ` +
            `peak sensitivity ${n1(base.peakSensitivity, 2)} at ${n1(base.peakSensitivityHz)} Hz; largest |T| ${n1(base.peakT, 2)}; gain at 1 to 3 Hz ${n1(base.lowFreqGain, 3)}. ` +
            `Each ± combines the statistical standard error with the prediction floor (${n1(floors.track, 2)} deg/s for tracking, ${n1(floors.disturb, 2)} deg/s for disturbance).`, '',
            table(['Change', 'New value', 'Tracking improves by', 'Disturbance improves by', 'Total improves by', 'Peak sensitivity', 'Largest \|T\|', 'Gain 1 to 3 Hz', 'Passes the rule?'],
                sens.map(x => [`${x.gain} ${x.multiplier < 1 ? '−' : '+'}20 %`, n1(x.value), `${pm(x.dTrack, x.seTrack, 2)} (${n1(x.dTrack / x.seTrack)} σ)`, `${pm(x.dDisturb, x.seDisturb, 2)} (${n1(x.dDisturb / x.seDisturb)} σ)`, n1(x.drop, 2),
                    n1(x.predicted.peakSensitivity, 2), n1(x.predicted.peakT, 2), n1(x.predicted.lowFreqGain, 3), x.accept ? 'yes' : 'no: ' + x.why])), '');

        // ---- search: add one gain at a time, only while the addition itself passes the rule
        let current = Object.assign({}, gains); const changed = [], steps = []; let stop = null;
        for (let it = 0; it < RULES.maxGainsChanged; it++) {
            let best = null, runnerUp = null;
            for (const k of names) { if (changed.includes(k)) continue;
                for (const m of RULES.multipliers) { const g = Object.assign({}, current, { [k]: gains[k] * m }), e = evaluate(g, it ? current : null);
                    if (e.accept && (!best || e.drop > best.e.drop)) best = { k, m, g, e };
                    if (!e.accept && (!runnerUp || e.drop > runnerUp.e.drop)) runnerUp = { k, m, e }; } }
            if (!best) { stop = runnerUp ? `the best remaining change (${runnerUp.k} ×${runnerUp.m}) fails the rule: ${runnerUp.e.why}` : 'no gain is left to change'; break; }
            current = best.g; changed.push(best.k);
            steps.push({ gain: best.k, multiplier: best.m, from: gains[best.k], to: best.g[best.k], improves: best.e.improves, dTrack: best.e.dTrack, seTrack: best.e.seTrack, dDisturb: best.e.dDisturb, seDisturb: best.e.seDisturb, drop: best.e.drop,
                atBound: best.m === Math.min(...RULES.multipliers) || best.m === Math.max(...RULES.multipliers) });
        }
        G.search = { steps, stop };
        if (!steps.length) {
            out.push(`**No change recommended for ${axis} at ${bin} rpm.** ${stop[0].toUpperCase() + stop.slice(1)}.`, '');
            decide({ change: false, reason: stop, gates: G.gates, flown: base, measured: M }); continue;
        }
        const total = evaluate(current);
        out.push(table(['Recommended', 'As flown', 'Recommended value', 'Improves', 'Tracking improves by', 'Disturbance improves by'],
            steps.map(x => [x.gain, n1(x.from), n1(x.to) + (x.atBound ? ' (step limit reached)' : ''), x.improves, `${pm(x.dTrack, x.seTrack, 2)} (${n1(x.dTrack / x.seTrack)} σ)`, `${pm(x.dDisturb, x.seDisturb, 2)} (${n1(x.dDisturb / x.seDisturb)} σ)`])), '',
            table(['Predicted', 'As flown', 'Recommended'], [
                ['Tracking error (deg/s RMS)', n1(base.track), `${n1(total.p.track)}, better by ${pm(total.dTrack, total.seTrack, 2)} (${n1(total.dTrack / total.seTrack)} σ)`],
                ['Disturbance (deg/s RMS)', n1(base.disturb), `${n1(total.p.disturb)}, better by ${pm(total.dDisturb, total.seDisturb, 2)} (${n1(total.dDisturb / total.seDisturb)} σ)`],
                ['Total error (deg/s RMS)', n1(base.total), `${n1(total.p.total)} (−${n1(100 * total.drop / base.total)} %)`],
                ['Closed-loop gain 1 to 3 Hz', n1(base.lowFreqGain, 3), n1(total.p.lowFreqGain, 3)],
                ['Peak sensitivity', n1(base.peakSensitivity, 2), n1(total.p.peakSensitivity, 2)], ['Largest \|T\| in band', n1(base.peakT, 2), n1(total.p.peakT, 2)]]), '',
            stop ? `Search stopped because ${stop}.` : `Search stopped at ${RULES.maxGainsChanged} gains.`, '');
        decide({ change: true, changes: steps, tracking: [base.track, total.p.track], dTrack: total.dTrack, seTrack: total.seTrack, disturbance: [base.disturb, total.p.disturb], dDisturb: total.dDisturb, seDisturb: total.seDisturb,
            total: [base.total, total.p.total], lowFreqGain: [base.lowFreqGain, total.p.lowFreqGain], gates: G.gates, flown: base, predicted: total.p, measured: M, validBand: band });
    }
}

// ---- 5. yaw against the gains flown ----------------------------------------------------------
out.push('## 5. Yaw behaviour against the gains that were flown', '',
    'Yaw gains differ between segments, so the logs are a natural experiment. Each segment of 30 s or more is one observation. ' +
    'Yaw gains were set lower on the faster headspeeds, so gain and headspeed cannot be told apart across headspeeds. The regression therefore compares segments only within the same headspeed class, ' +
    'and holds collective activity and yaw stick activity constant, because a harder-flown segment disturbs the tail more whatever the gains.', '');
{
    const klass = (s) => s.headspeed.median < 3900 ? 0 : s.headspeed.median < 4600 ? 1 : 2, names = ['under 3900 rpm', '3900 to 4600 rpm', 'over 4600 rpm'];
    const obs = usable.filter(s => s.seconds >= 30 && s.axes.yaw.gains.P_cw && s.axes.yaw.gains.P_ccw && s.axes.yaw.gains.D && s.collectiveRms !== null).map(s => {
        const rows = lib.rowsOf(lib.sumSpectra([s.axes.yaw.spectra])), g = s.axes.yaw.gains;
        const resid = (f0, f1) => { let t = 0; for (const r of rows) if (r.f >= f0 && r.f <= f1) t += lib.residualPsd(r) * 0.5; return Math.sqrt(t); };
        return { k: klass(s), P: (g.P_cw.gain + g.P_ccw.gain) / 2, D: g.D.gain, coll: s.collectiveRms, sp: s.axes.yaw.setpointRms, hold: resid(0.5, 8), wag: resid(8, 25), err: lib.bandRms(rows, 'ee', 0.5, 60) };
    });
    // centre every variable on its headspeed class: what is left is the within-class variation
    const centred = (key) => { const m = [0, 1, 2].map(k => { const v = obs.filter(o => o.k === k).map(o => o[key]); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0; }); return obs.map(o => o[key] - m[o.k]); };
    const cP = centred('P'), cD = centred('D'), corr = (x, y) => { let a = 0, b = 0, c = 0; for (let i = 0; i < x.length; i++) { a += x[i] * y[i]; b += x[i] * x[i]; c += y[i] * y[i]; } return a / Math.sqrt(b * c); };
    const spanOf = (x) => Math.max(...x) - Math.min(...x), classes = [0, 1, 2].filter(k => obs.some(o => o.k === k));
    const tests = 6, dof = obs.length - (4 + classes.length), z = 2.638; // two-sided 5 % shared by 6 tests (Bonferroni)
    const tCrit = z + (z ** 3 + z) / (4 * dof) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * dof * dof);
    results.yawExperiment = { observations: obs.length, perClass: classes.map(k => ({ class: names[k], n: obs.filter(o => o.k === k).length })), withinClassSpanP: spanOf(cP), withinClassSpanD: spanOf(cD), withinClassCorrelationPD: corr(cP, cD), tCritical: tCrit, fits: {} };
    out.push(table(['Headspeed class', 'Observations', 'P × stop, min to max', 'D, min to max'], classes.map(k => { const o = obs.filter(x => x.k === k);
        return [names[k], o.length, `${n1(Math.min(...o.map(x => x.P)))} to ${n1(Math.max(...o.map(x => x.P)))}`, `${n1(Math.min(...o.map(x => x.D)))} to ${n1(Math.max(...o.map(x => x.D)))}`]; })), '',
        `Within a class, P and D were mostly changed together: their correlation is ${n1(corr(cP, cD), 2)}. The closer to 1, the less their effects can be separated.`, '');
    const rows = [];
    for (const [key, label] of [['hold', 'Uncommanded yaw motion, 0.5 to 8 Hz'], ['wag', 'Uncommanded yaw motion, 8 to 25 Hz'], ['err', 'Yaw gyro − setpoint, 0.5 to 60 Hz']]) {
        const fit = ols(obs.map(o => [o.P, o.D, o.coll / 100, o.sp / 10].concat(classes.map(k => o.k === k ? 1 : 0))), obs.map(o => o[key]));
        if (!fit) continue;
        const t = (i) => fit.beta[i] / fit.se[i], med = median(obs.map(o => o[key])), verdict = (i) => Math.abs(t(i)) >= tCrit ? 'evidence' : 'none';
        results.yawExperiment.fits[key] = { median: med, beta: fit.beta, se: fit.se, r2: fit.r2, tP: t(0), tD: t(1), detectableP: 2 * fit.se[0] * spanOf(cP), detectableD: 2 * fit.se[1] * spanOf(cD) };
        rows.push([label, n1(med), `${pm(fit.beta[0], fit.se[0], 3)} (t ${n1(t(0))}, ${verdict(0)})`, `${pm(fit.beta[1], fit.se[1], 3)} (t ${n1(t(1))}, ${verdict(1)})`,
            `${pm(fit.beta[2], fit.se[2], 2)} (t ${n1(t(2))})`, `${pm(fit.beta[3], fit.se[3], 2)} (t ${n1(t(3))})`, n1(fit.r2, 2), `${n1(2 * fit.se[0] * spanOf(cP))} / ${n1(2 * fit.se[1] * spanOf(cD))}`]);
    }
    out.push(table(['Metric (deg/s RMS)', 'Median', 'Per unit of P × stop', 'Per unit of D', 'Per 100 collective RMS', 'Per 10 deg/s yaw stick RMS', 'R²', 'Smallest detectable effect of the P / D changes flown'], rows), '',
        `Six gain coefficients are tested at once, so one counts as evidence only at |t| ≥ ${n1(tCrit, 2)} (5 % shared across the six tests, ${dof} degrees of freedom). ` +
        'The last column is two standard errors times the within-class span that was flown: a real effect smaller than that would go unseen in this data.', '');
}

// ---- 6. decisions ----------------------------------------------------------------------------
out.push('## 6. Decisions', '',
    table(['Axis', 'Headspeed (rpm)', 'Decision', 'Basis'], results.decisions.map(d => [d.axis, d.bin,
        d.change ? d.changes.map(c => `${c.gain} ${n1(c.from)} → ${n1(c.to)}`).join(', ') : 'no change',
        d.change ? `measured closed-loop gain at 1 to 3 Hz ${pm(d.measured.lowFreqGain, d.measured.lowFreqGainSE, 3)}; predicted tracking ${n1(d.tracking[0])} → ${n1(d.tracking[1])} deg/s RMS (${n1(d.dTrack / d.seTrack)} σ), disturbance ${n1(d.disturbance[0])} → ${n1(d.disturbance[1])} (${n1(d.dDisturb / d.seDisturb)} σ), ` +
            `gain at 1 to 3 Hz ${n1(d.lowFreqGain[0], 3)} → ${n1(d.lowFreqGain[1], 3)}; ${d.windows} windows in ${d.flights} flights; band ${n1(d.validBand[0])} to ${n1(d.validBand[1])} Hz` : d.reason])), '',
    'A recommended value is a prediction. Change one gain, fly, log and rerun this analysis: the next report measures whether the predicted change happened.', '');

// ---- 7. rules --------------------------------------------------------------------------------
out.push('## 7. Rules applied', '',
    `1. Segments: ${data.rules}. Headspeed bins of ${RULES.headspeedBinRpm} rpm. A group needs ${RULES.minFlights} flights on one gain set.`,
    `2. Plant bins are usable below ${RULES.maxSigma * 100} % standard error. A ${RULES.sigmaFloor * 100} % floor covers systematic error.`,
    `3. Gates, all at the flown gains. V1: the 1 to 3 Hz response of an axis to its own stick must not move by more than ${RULES.crossAxisShift} (or 2 standard errors) when the other three stick inputs are held constant. V2a: the share of bins where predicted T lies within 2 standard errors of measured T must reach the binomial lower bound for 95 %. V2b: the stick-weighted error of predicted T must be ≤ ${RULES.weightedLoopError * 100} %. V3: predicted tracking error must be within ${RULES.trackError * 100} % or 2 standard errors of the measured one.`,
    '4. Predicted quantities, all inside the validated band, for the stick spectrum and disturbances as recorded: tracking error after the best-fit delay, disturbance (uncommanded motion scaled by the change in sensitivity), total = √(tracking² + disturbance²).',
    `5. Uncertainty of a predicted change: leave-one-flight-out standard error combined with a floor of ${RULES.trackingFloor * 100} % of the in-band setpoint RMS for tracking and ${RULES.disturbanceFloor * 100} % of the flown disturbance. The floors are the prediction errors found when a gain change was predicted and then flown in simulation.`,
    `6. Constraints on any candidate, checked to ${RULES.tolerance * 100} %: peak sensitivity not above flown; largest |T| not above flown; closed-loop gain at 1 to 3 Hz no further from 1 than flown or 0.05; feedback gain not raised at any frequency between the band and 100 Hz, where the airframe is not measured.`,
    `7. A change passes when tracking or disturbance improves by at least ${RULES.componentMin * 100} % of its flown value and ${RULES.minSigmas} standard errors, the other does not get worse by more than ${RULES.maxHarm * 100} %, and the total falls by at least ${RULES.totalMinDrop * 100} %.`,
    `8. Search: gains move by ×${RULES.multipliers.join(', ×')} of the flown value, one gain added at a time, each addition having to pass rule 7 on its own. At most ${RULES.maxGainsChanged} gains change.`, '');

fs.writeFileSync(path.join(DIR, 'report.md'), out.join('\n'));
fs.writeFileSync(path.join(DIR, 'results.json'), JSON.stringify(results, (k, v) => k === 'jack' ? undefined : (typeof v === 'number' ? +v.toPrecision(6) : v), 1));
console.error(`wrote ${path.join(DIR, 'report.md')} and results.json`);
