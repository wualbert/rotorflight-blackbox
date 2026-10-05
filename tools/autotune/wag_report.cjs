'use strict';

/**
 * Oscillation report: <dir>/bursts.json (from wag.cjs) -> <dir>/report.md and <dir>/results.json
 *
 *   node tools/autotune/wag_report.cjs <dir>
 *
 * Every number in the report is computed here, and every decision is taken by a rule in RULES. Uncertainties are
 * leave-one-flight-out (jackknife) standard errors.
 */

const fs = require('node:fs'), path = require('node:path');
const lib = require('./lib.cjs');
const { cx } = lib;

const RULES = {
    // Groups of flights come from the pilot, never from the data: <dir>/groups.json, { "starts": [log numbers],
    // "why": "what changed", "note": "status text" }. Without it, one group.
    minFlights: 3,          // an airframe response is estimated only from this many flights
    thresholds: [10, 20, 40], // deg/s: shares of time are given at or above these amplitudes
    stickDriven: 0.5,       // a window of 10 deg/s or more is no oscillation when the stick moves in the band by more than this share of the motion
    fitBand: { roll: [2, 24], pitch: [2, 24], yaw: [2, 20] }, // Hz, plant model fit
    maxSigma: 0.35,         // plant bins enter the fit below this relative standard error
    adequateChi2: 3,        // a plant model with reduced chi-square above this is not used
    loadBand: [3, 12],      // Hz, band over which tail effectiveness is compared between tail loads
    onset: { small: 30, low: 50, high: 150, minHalfCycles: 6 }, // deg/s: a self-excited event grows from below small to above high
    gainMargin: 2,          // conventional lower bound (6 dB)
    reserve: 1.25,          // yaw, least change: margin required = largest margin at which the loop still went unstable x reserve
    phaseMargin: 35,        // deg; yaw I is lowered when a lower P leaves less than this
    yawIsteps: [90, 60, 40],
    lowBand: [1, 8],        // Hz, where the pilot's commands are; tracking there may not get worse than `tolerance`
    tolerance: 0.10,
    improvement: 0.10,      // roll, pitch: a change must cut the oscillation band amplitude by this much ...
    sigmas: 2,              // ... and by this many standard errors
    floor: 0.03,            // added to every predicted change: the error of such predictions on simulated truth (test suite)
    peakSensitivity: 1.5,   // roll, pitch: a loop that amplifies motion by more than this is looked at for a change
    candidates: { P: [0.8, 0.6], I: [0.5, 0.25], D: [0.5, 1.5] },
    yawP: [62, 52, 47, 43, 38, 34, 30, 26, 22], yawD: [8, 11, 15, 20], yawI: [120, 90, 60],
    teeth: { most: 130, fewest: 12, within: 0.0008 }, // tooth ratios tried against a line that is no multiple of the main rotor
    collectiveBins: [10, 30, 60], yawStickBins: [50, 200, 500], // % of collective range; deg/s of yaw setpoint
    stickScale: [100, 100, 100, 250], // stick movement that counts as 1: roll, pitch, yaw in deg/s of setpoint, collective in its own units (10 % of its range)
    vibration: [40, 497],   // Hz: what counts as vibration, above where the helicopter moves as a whole
    lineWidth: 3,           // Hz either side of a line that is counted as that line
};

const DIR = process.argv[2];
if (!DIR) { console.error('usage: node wag_report.cjs <dir with bursts.json>'); process.exit(2); }
const data = JSON.parse(fs.readFileSync(path.join(DIR, 'bursts.json'), 'utf8')), BANDS = data.rule.bands, AX = lib.AXES;
const PILOT = fs.existsSync(path.join(DIR, 'groups.json')) ? JSON.parse(fs.readFileSync(path.join(DIR, 'groups.json'), 'utf8')) : { starts: [0] };

// ---------------------------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------------------------

const n = (v, d = 1) => (typeof v === 'number' && isFinite(v)) ? v.toFixed(d) : '–';
const pm = (v, se, d = 1) => `${n(v, d)} ± ${n(se, d)}`;
const pct = (v, d = 1) => `${n(100 * v, d)} %`;
const deg = (z) => cx.arg(z) * 180 / Math.PI;
const quantile = (a, p) => { if (!a.length) return NaN; const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const median = (a) => quantile(a, 0.5);
const sum = (a) => a.reduce((s, v) => s + v, 0);
const mode = (list) => { const c = new Map(); let best = null; for (const v of list) { c.set(v, (c.get(v) || 0) + 1); if (best === null || c.get(v) > c.get(best)) best = v; } return best; };
const jackSE = (v) => { const m = v.length, mu = sum(v) / m; return Math.sqrt((m - 1) / m * sum(v.map(x => (x - mu) ** 2))); };
const unpack = (p) => { const S = {}; for (const k in p) S[k] = Array.isArray(p[k]) ? Float64Array.from(p[k]) : p[k]; return S; };
const table = (head, rows) => ['| ' + head.join(' | ') + ' |', '|' + head.map(() => '---').join('|') + '|', ...rows.map(r => '| ' + r.join(' | ') + ' |'), ''];
const weightedMedian = (pairs) => { const s = [...pairs].sort((a, b) => a[0] - b[0]), tot = sum(s.map(p => p[1])); let acc = 0; for (const [v, w] of s) { acc += w; if (acc >= tot / 2) return v; } return NaN; };
function spearman(x, y) {
    const rank = (a) => { const idx = a.map((v, i) => i).sort((i, j) => a[i] - a[j]), r = new Array(a.length); idx.forEach((i, k) => { r[i] = k; }); return r; };
    const u = rank(x), v = rank(y), m = u.length, mu = (m - 1) / 2; let a = 0, b = 0, c = 0;
    for (let i = 0; i < m; i++) { a += (u[i] - mu) * (v[i] - mu); b += (u[i] - mu) ** 2; c += (v[i] - mu) ** 2; }
    return a / Math.sqrt(b * c);
}

// gains in the form lib.loop wants; yaw P is the mean of the two stop directions, which is what a small oscillation sees
function gainsOf(g, a) {
    const P = a === 2 ? (g.P_cw.gain + g.P_ccw.gain) / 2 : g.P.gain;
    return { P, I: g.I.gain, D: g.D.gain, F: g.F.gain, B: g.B ? g.B.gain : 0, gyroCutoff: g.gyroCutoff, dCutoff: g.D.cutoff, bCutoff: g.B ? g.B.cutoff : 35, decayPerS: 0 };
}
const usable = (g, a) => g && g.I && g.D && g.F && (a === 2 ? g.P_cw && g.P_ccw : g.P);

function loopFigures(a, gains, plant) {
    const m = lib.margins(a, gains, plant, 40); let phaseMargin = null, crossHz = null, prev = null;
    for (let f = 1; f < 40; f += 0.05) { const L = lib.loop(a, gains, plant, f).L, mag = cx.abs(L); if (prev !== null && prev > 1 && mag <= 1) { phaseMargin = 180 + deg(L); if (phaseMargin > 180) phaseMargin -= 360; crossHz = f; } prev = mag; }
    return { gainMargin: m.gainMargin, gainMarginHz: m.gainMarginHz, peakSensitivity: m.peakSensitivity, peakSensitivityHz: m.peakSensitivityHz, phaseMargin, crossHz, rejection2Hz: cx.abs(lib.loop(a, gains, plant, 2).S) };
}

// pooled plant of a set of spectra, with the best adequate parametric model and its leave-one-flight-out replicates
function plantOf(items, a) {
    const pooled = lib.pool(items.filter(it => it.spectra && it.spectra.windows > 0));
    if (pooled.flights < RULES.minFlights) return { pooled, model: null, why: `${pooled.flights} flight(s), ${RULES.minFlights} needed` };
    const band = RULES.fitBand[AX[a]], fit = lib.fitPlant(pooled, band[0], band[1], RULES.maxSigma), best = fit.models[0];
    if (!best) return { pooled, model: null, why: `${fit.points} frequency bins known to ${RULES.maxSigma * 100} %, 8 needed` };
    if (best.chi2red > RULES.adequateChi2) return { pooled, model: null, fit, why: `no model fits: best reduced chi-square ${n(best.chi2red, 2)} (${best.kind})` };
    return { pooled, fit, model: best, plant: (f) => lib.plantResponse(best, f), replicas: best.jack.map(j => (f) => lib.plantResponse(j, f)) };
}
const withSE = (P, fn) => { const v = fn(P.plant), reps = P.replicas.map(fn); return { value: v, se: (v === null || reps.some(x => x === null)) ? null : jackSE(reps) }; };
const describe = (m) => m.kind === 'lag' ? `K e^(-s τ) / (s + a): K ${pm(m.K, m.se.K, 0)} deg/s² per unit, a ${pm(m.a, m.se.a)} 1/s, delay τ ${pm(m.tau * 1000, m.se.tau * 1000)} ms`
    : m.kind === 'second' ? `resonance: gain ${pm(m.K, m.se.K, 0)} deg/s per unit, frequency ${pm(m.fn, m.se.fn)} Hz, damping ratio ${pm(m.zeta, m.se.zeta, 2)}, delay ${pm(m.tau * 1000, m.se.tau * 1000)} ms`
        : `damped integrator with resonance: K ${pm(m.K, m.se.K, 0)}, a ${pm(m.a, m.se.a)} 1/s, resonance ${pm(m.fn, m.se.fn)} Hz with damping ratio ${pm(m.zeta, m.se.zeta, 2)}, delay ${pm(m.tau * 1000, m.se.tau * 1000)} ms`;
const minus180 = (pl) => { for (let f = 4; f < 40; f += 0.02) { const g = pl(f); if (g[1] > 0 && g[0] < 0) return f; } return null; };

const out = [], results = { rules: RULES };
const H = (s) => out.push(s, '');

// ---------------------------------------------------------------------------------------------
// 1. The logs, and the groups they fall into
// ---------------------------------------------------------------------------------------------

const L = data.lines, watchAt = L.watch ? L.watch.length - 1 : -1, hasLine = L.foreign !== null && L.foreign !== undefined;
const lineWindows = L.perWindow || [], flown = data.flights.filter(f => f.flown).sort((a, b) => a.log - b.log);
const size3 = (w, key = 'raw') => Math.hypot(...[0, 1, 2].map(a => w[key][a][watchAt]));
{ let day = null; for (const f of data.flights) { f.day = f.start.startsWith('0000') ? day : f.start.slice(0, 10); day = f.day; } }
const lowest = Math.min(...flown.flatMap(f => Object.keys(f.seconds).map(Number).filter(p => p > 0)));
for (const f of flown) { const w = lineWindows.filter(v => v.log === f.log && v.profile === lowest); f.reference = hasLine && w.length >= 3 ? median(w.map(v => size3(v))) : null; }
const groups = [], startOf = (log) => Math.max(...PILOT.starts.filter(v => v <= log));
for (const f of flown) {
    const g = groups[groups.length - 1];
    if (!g || startOf(f.log) !== startOf(g.flights[0].log)) groups.push({ day: f.day, flights: [f] }); else g.flights.push(f);
}
for (const g of groups) { g.logs = g.flights.map(f => f.log); g.name = g.logs.length > 1 ? `#${g.logs[0]}–#${g.logs[g.logs.length - 1]}` : `#${g.logs[0]}`; g.reference = median(g.flights.map(f => f.reference).filter(v => v !== null)); g.targetOf = {};
    for (const p of [0, 1, 2, 3, 4, 5, 6]) { const t = mode(g.flights.map(f => f.targetOf[p]).filter(v => v !== undefined)); if (t !== null) g.targetOf[p] = t; } }
const groupOf = (log) => groups.find(g => g.logs.includes(log));
const latest = groups[groups.length - 1];
const profileName = (g, p) => p < 0 ? 'switching' : `${p || 'as armed'} (${g.targetOf[p] || '?'} rpm)`;
results.groups = groups.map(g => ({ name: g.name, day: g.day, logs: g.logs, reference: g.reference, targetOf: g.targetOf }));

H('# Oscillation report');
H(`Source: ${data.files.map(f => '`' + f + '`').join(', ')}. Generated by \`tools/autotune/wag_report.cjs\`; every threshold is in \`RULES\` at the top of that script and in \`RULE\` in \`wag.cjs\`. ` +
    'Times are seconds from the start of a log, as the viewer shows them.');
if (PILOT.note) H(PILOT.note);
H('Percentages below count half-second windows; the independent unit is the flight, and they carry no error bars.');
H('## 1. The logs');
out.push(`Every sample counts that was logged in flight: airborne, rotor above ${data.rule.flight.headspeed} rpm. It counts for the PID profile that was active at that moment, however short the stay and whatever the headspeed was doing. ` +
    `${data.flights.length} logs, ${flown.length} flown, ${n(sum(flown.map(f => f.flyingS)), 0)} s in flight.`, '');
out.push((PILOT.why ? `Groups of flights come from the pilot: a group starts at log ${PILOT.starts.map(v => '#' + v).join(', ')} (${PILOT.why}).` : 'One group: the pilot named no change between flights (`groups.json`).') + (hasLine ? ` The last column is the vibration line at ${n(L.foreign, 3)} × rotor speed on profile ${lowest}, which every flight has (section 6).` : ''), '');
out.push(...table(['Log', 'Start (clock of the flight controller)', 'In flight (s)', ...[1, 2, 3].map(p => `Profile ${p} (s)`), 'Yaw P, I, D, F, B at arming', hasLine ? `Line at ${n(L.foreign, 2)} ×, profile ${lowest} (deg/s)` : '', 'Group'],
    flown.map(f => [`#${f.log}`, f.start.startsWith('0000') ? 'clock not set' : f.start.slice(0, 16).replace('T', ' '), n(f.flyingS, 0), ...[1, 2, 3].map(p => f.seconds[p] ? `${n(f.seconds[p], 0)} at ${f.targetOf[p] || '?'} rpm` : '–'), String(f.header.yawPID), n(f.reference), groupOf(f.log).name])));
out.push(`Not flights (rotor not up to speed while airborne, or the body not turning by ${data.rule.flight.rate} deg/s rms): ${data.flights.filter(f => !f.flown).map(f => `#${f.log} (${f.durationS} s)`).join(', ')}.`, '');

// ---------------------------------------------------------------------------------------------
// 2. Oscillation by profile and group
// ---------------------------------------------------------------------------------------------

const W = data.windows.map(w => Object.assign({ group: groupOf(w.log), key: w.ramp ? -1 : w.profile }, w));
const driven = (w, a) => w[AX[a]] >= RULES.thresholds[0] && w.stick[a] > RULES.stickDriven * w[AX[a]];
const cell = (g, p) => W.filter(w => w.group === g && w.key === p);
const stats = (list, a) => { const free = list.filter(w => !driven(w, a)).map(w => w[AX[a]]); return { seconds: list.length * data.rule.windowS, stick: list.length - free.length, median: median(free), p90: quantile(free, 0.9), p99: quantile(free, 0.99), max: Math.max(0, ...free), shares: RULES.thresholds.map(t => free.filter(v => v >= t).length / (list.length || 1)) }; };

H('## 2. How much each axis oscillates, by profile');
out.push(`Amplitude is that of gyro − setpoint in the band where the axis oscillates (roll ${BANDS.roll.join('–')} Hz, pitch ${BANDS.pitch.join('–')} Hz, yaw ${BANDS.yaw.join('–')} Hz), over half-second windows. ` +
    `"Switching" holds the windows in which the profile changes or the governor target is on the move. A window of ${RULES.thresholds[0]} deg/s or more in which the stick itself moves in the band by more than ${RULES.stickDriven * 100} % of the motion is not counted: there the difference between gyro and setpoint is the helicopter following the stick. The last column says how many those were.`, '');
results.census = [];
for (let a = 0; a < 3; a++) {
    out.push(`**${AX[a]}**`, '');
    const rows = [];
    for (const g of groups) for (const p of [1, 2, 3, 0, -1]) { const list = cell(g, p); if (list.length < 10) continue; const s = stats(list, a);
        results.census.push({ axis: AX[a], group: g.name, profile: p, target: g.targetOf[p], ...s });
        rows.push([g.name, profileName(g, p), n(s.seconds, 0), n(s.median), n(s.p90), n(s.p99), n(s.max, 0), ...s.shares.map(v => pct(v)), s.stick]); }
    out.push(...table(['Group', 'Profile', 'Seconds', 'Median (deg/s)', '90th pct', '99th pct', 'Largest', ...RULES.thresholds.map(t => `≥ ${t} deg/s`), 'Stick-driven windows'], rows));
}

// 2.1 the sticks
H('### 2.1 With the sticks taken into account');
const day = groups.filter(g => g.day === latest.day), activity = (w) => Math.max(...w.stickSwing.map((v, i) => v === null ? 0 : v / RULES.stickScale[i]));
out.push(`Stick movement is the swing of each setpoint over a window and the half second before it. The activity of a window is the largest of the four, each divided by ${RULES.stickScale.slice(0, 3).join(', ')} deg/s (roll, pitch, yaw) and ${RULES.stickScale[3]} (collective, 10 % of its range).`, '');
out.push(...table(['Group', 'Profile', 'Windows', 'Roll stick, median / 90th pct (deg/s)', 'Pitch stick', 'Yaw stick', 'Collective', 'Activity, median / 90th pct', 'Activity below 0.3 (sticks nearly still)'], day.flatMap(g => [1, 2, 3].map(p => { const list = cell(g, p); if (list.length < 10) return null;
    const A = list.map(activity); return [g.name, profileName(g, p), list.length, ...[0, 1, 2, 3].map(i => `${n(median(list.map(w => w.stickSwing[i])), 0)} / ${n(quantile(list.map(w => w.stickSwing[i]), 0.9), 0)}`), `${n(median(A), 2)} / ${n(quantile(A, 0.9), 2)}`, `${A.filter(v => v < 0.3).length} windows`]; })).filter(Boolean)));
out.push('**Same stick activity, before and after.** The windows of each profile are sorted into quarters by stick activity, both groups together, so that a quarter holds windows flown equally hard. Each cell is the median amplitude in that quarter, first group / last group. If harder flying made the difference, it would vanish inside a quarter.', '');
results.sticks = { byActivity: [], split: [] };
if (day.length >= 2) { const first = day[0], last = day[day.length - 1];
    out.push(...table(['Axis', 'Profile', ...[1, 2, 3, 4].map(q => `Quarter ${q}${q === 1 ? ' (calmest)' : q === 4 ? ' (busiest)' : ''}: ${first.name} / ${last.name}`), `Rank correlation of amplitude with activity, ${first.name}`, last.name], AX.flatMap((name, a) => [1, 2, 3].map(p => {
        const both = [...cell(first, p), ...cell(last, p)]; if (cell(first, p).length < 40 || cell(last, p).length < 40) return null;
        const cuts = [0.25, 0.5, 0.75].map(q => quantile(both.map(activity), q)), quarter = (w) => cuts.filter(c => activity(w) >= c).length;
        const cells = [0, 1, 2, 3].map(q => [first, last].map(g => cell(g, p).filter(w => quarter(w) === q && !driven(w, a)))), rho = [first, last].map(g => spearman(cell(g, p).map(activity), cell(g, p).map(w => w[name])));
        results.sticks.byActivity.push({ axis: name, profile: p, cuts, quarters: cells.map(c => c.map(l => ({ windows: l.length, median: median(l.map(w => w[name])) }))), correlation: rho });
        return [name, p, ...cells.map(c => c.map(l => l.length >= 5 ? n(median(l.map(w => w[name]))) : '–').join(' / ')), n(rho[0], 2), n(rho[1], 2)]; })).filter(Boolean))); }

// the same against one stick at a time, in fixed steps, so that flights flown differently can be compared like with like
const steps = (cuts, unit) => [...cuts, Infinity].map((hi, i) => ({ lo: i ? cuts[i - 1] : 0, hi, name: i === 0 ? `below ${hi}${unit}` : hi === Infinity ? `${cuts[i - 1]}${unit} or more` : `${cuts[i - 1]}–${hi}${unit}` }));
results.sticks.byStick = [];
for (const [title, value, bins] of [['how far the collective moved, in % of its range', (w) => w.stickSwing[3] === null ? NaN : w.stickSwing[3] / (RULES.stickScale[3] * 10) * 100, steps(RULES.collectiveBins, ' %')], ['how far the yaw stick moved, in deg/s', (w) => w.stickSwing[2], steps(RULES.yawStickBins, '')]]) {
    out.push(`**By ${title}** (window and the half second before it). Each cell: windows, median amplitude in deg/s, and for yaw the share of windows at ${RULES.thresholds[2]} deg/s or more.`, '');
    out.push(...table(['Axis', 'Profile', 'Group', ...bins.map(b => b.name)], AX.flatMap((name, a) => [1, 2, 3].flatMap(p => day.map(g => { const list = cell(g, p).filter(w => isFinite(value(w))); if (list.length < 10) return null;
        const cells = bins.map(b => list.filter(w => value(w) >= b.lo && value(w) < b.hi && !driven(w, a)));
        results.sticks.byStick.push({ by: title, axis: name, profile: p, group: g.name, bins: bins.map((b, i) => ({ name: b.name, windows: cells[i].length, median: median(cells[i].map(w => w[name])), large: cells[i].filter(w => w[name] >= RULES.thresholds[2]).length })) });
        return [name, p, g.name, ...cells.map(c => c.length ? `${c.length}: ${n(median(c.map(w => w[name])))}` + (a === 2 ? `, ${pct(c.filter(w => w.yaw >= RULES.thresholds[2]).length / c.length, 0)}` : '') : '0')]; }))).filter(Boolean)));
}

// what the four sticks explain of the gyro motion, band by band: multiple coherence
function explainedBy(list, a) { // list: entries of data.sticks to pool; returns per band the gyro power and the part explained
    const nb = list[0].to - list[0].from + 1, wn = sum(list.map(e => e.windows)), outp = [];
    for (let b = 0; b < nb; b++) { const M = Array.from({ length: 4 }, () => Array.from({ length: 5 }, () => [0, 0])); let yy = 0, tr = 0;
        for (const e of list) { for (let p = 0; p < 4; p++) { for (let q = 0; q < 4; q++) { M[p][q][0] += e.xxRe[b * 16 + p * 4 + q]; M[p][q][1] += e.xxIm[b * 16 + p * 4 + q]; } M[p][4][0] += e.xyRe[b * 12 + a * 4 + p]; M[p][4][1] += e.xyIm[b * 12 + a * 4 + p]; } yy += e.yy[b * 3 + a]; }
        const xy = M.map(row => row[4].slice()); for (let p = 0; p < 4; p++) tr += M[p][p][0];
        for (let p = 0; p < 4; p++) M[p][p][0] += 1e-9 * tr;                     // keeps a stick that does not move from breaking the solution
        for (let c = 0; c < 4; c++) { let piv = c; for (let r2 = c + 1; r2 < 4; r2++) if (cx.abs(M[r2][c]) > cx.abs(M[piv][c])) piv = r2; [M[c], M[piv]] = [M[piv], M[c]]; // rows are equations; the unknowns keep their order, and so does xy
            const dd = M[c][c]; for (let j = 0; j <= 4; j++) M[c][j] = cx.div(M[c][j], dd);
            for (let r2 = 0; r2 < 4; r2++) if (r2 !== c) { const f = M[r2][c]; for (let j = 0; j <= 4; j++) M[r2][j] = cx.sub(M[r2][j], cx.mul(f, M[c][j])); } }
        let ex = 0; for (let p = 0; p < 4; p++) ex += xy[p][0] * M[p][4][0] + xy[p][1] * M[p][4][1];   // Re(conj(Sxy) h)
        const share = Math.min(1, Math.max(0, ex / yy)), rest = Math.min(1, (1 - share) * wn / Math.max(1, wn - 4)); // the second factor undoes the share that four random inputs would explain by chance
        outp.push({ hz: list[0].from + b, total: yy / wn / list[0].amplitude, rest: rest * yy / wn / list[0].amplitude, share: 1 - rest }); }
    return { windows: wn, bands: outp };
}
out.push(`**What the sticks explain.** In each band 1 Hz wide, the motion of the gyro is split into the part that follows linearly from the four sticks together (roll, pitch, yaw and collective, so that one stick shaking another axis is counted too) and the rest. Amplitudes are of the gyro itself, not of gyro − setpoint, summed over the band where the axis oscillates.`, '');
const bandAmp = (bands, band, key) => Math.sqrt(sum(bands.filter(b => b.hz >= band[0] && b.hz <= band[1]).map(b => b[key])));
out.push(...table(['Axis', 'Group', 'Profile', 'Windows', 'Band (Hz)', 'Gyro motion in the band (deg/s)', 'Explained by the sticks', 'Not explained (deg/s)', 'Same, 1–4 Hz: gyro motion', 'Explained by the sticks'], AX.flatMap((name, a) => day.flatMap(g => [1, 2, 3].map(p => {
    const list = (data.sticks || []).filter(e => g.logs.includes(e.log) && e.profile === p); if (!list.length || sum(list.map(e => e.windows)) < 40) return null;
    const E = explainedBy(list, a), band = BANDS[name], tot = bandAmp(E.bands, band, 'total'), rest = bandAmp(E.bands, band, 'rest'), lowT = bandAmp(E.bands, [1, 4], 'total'), lowR = bandAmp(E.bands, [1, 4], 'rest');
    results.sticks.split.push({ axis: name, group: g.name, profile: p, windows: E.windows, band, total: tot, rest, low: { total: lowT, rest: lowR }, hz: E.bands.map(b => b.hz), spectrumTotal: E.bands.map(b => Math.sqrt(b.total)), spectrumRest: E.bands.map(b => Math.sqrt(b.rest)) });
    return [name, g.name, profileName(g, p), E.windows, band.join('–'), n(tot), pct(1 - (rest / tot) ** 2, 0), n(rest), n(lowT), pct(1 - (lowR / lowT) ** 2, 0)]; }))).filter(Boolean)));
out.push('The last two columns are a check of the method: between 1 and 4 Hz, where the helicopter does follow the sticks, they must explain most of the motion.', '');

// ---------------------------------------------------------------------------------------------
// 3. Log by log
// ---------------------------------------------------------------------------------------------

const segments = data.segments.map(s => Object.assign({ group: groupOf(s.log) }, s));
const tuneOf = (log, profile, a) => { const s = segments.filter(v => v.log === log && v.profile === profile && usable(v.axes[AX[a]].gains, a)).sort((p, q) => q.seconds - p.seconds)[0]; return s ? s.axes[AX[a]].gains : null; };
const lineCell = (list, key, which, d = 0) => list.length ? which.map(a => n(median(list.map(v => v[key][a] ? v[key][a][watchAt] : NaN).filter(isFinite)), d)).join(' / ') : '–';

H('## 3. Log by log');
out.push('The same amplitudes per log, median and 90th percentile, with the yaw gains in effect on that profile in that log. The gains are recovered from the logged PID terms, because the header only records the profile that was active at arming. ' +
    (hasLine ? `The last columns give the size of the line at ${n(L.foreign, 2)} × rotor speed: in the raw gyro, and in the commands to the servos (one cyclic servo, and the tail servo), in microseconds of pulse width.` : ''), '');
results.perLog = [];
for (const p of [3, 2, 1]) {
    const rows = [];
    for (const f of flown) { const list = W.filter(w => w.log === f.log && w.key === p); if (list.length < 10) continue;
        const gy = tuneOf(f.log, p, 2), gr = tuneOf(f.log, p, 0), gp = tuneOf(f.log, p, 1), lw = lineWindows.filter(v => v.log === f.log && v.profile === p), st = [0, 1, 2].map(a => stats(list, a));
        results.perLog.push({ log: f.log, group: groupOf(f.log).name, profile: p, seconds: list.length * data.rule.windowS, roll: st[0], pitch: st[1], yaw: st[2], yawGains: gy && gainsOf(gy, 2), yawStop: gy && [gy.P_cw.gain, gy.P_ccw.gain],
            line: lw.length ? { raw: [0, 1, 2].map(a => median(lw.map(v => v.raw[a][watchAt]))), gyro: [0, 1, 2].map(a => median(lw.map(v => v.gyro[a][watchAt]))), control: [0, 1, 2].map(a => median(lw.map(v => v.control[a][watchAt]))), servo: [0, 3].map(k => lw[0].servo[k] ? median(lw.map(v => v.servo[k][watchAt])) : null) } : null });
        rows.push([`#${f.log}`, groupOf(f.log).name, n(list.length * data.rule.windowS, 0), ...st.map(s => `${n(s.median)} / ${n(s.p90)}`), gy ? `${n(gy.P_cw.gain)} / ${n(gy.P_ccw.gain)}` : '–', gy ? n(gy.I.gain, 0) : '–', gy ? n(gy.D.gain) : '–',
            gr ? `${n(gr.P.gain, 0)} / ${n(gr.I.gain, 0)} / ${n(gr.D.gain, 0)}` : '–', gp ? `${n(gp.P.gain, 0)} / ${n(gp.I.gain, 0)} / ${n(gp.D.gain, 0)}` : '–', ...(hasLine ? [lineCell(lw, 'raw', [0, 1, 2]), lineCell(lw, 'servo', [0, 3])] : [])]); }
    if (!rows.length) continue;
    out.push(`**Profile ${p}**`, '');
    out.push(...table(['Log', 'Group', 'Seconds', 'Roll (deg/s)', 'Pitch', 'Yaw', 'Yaw P × stop CW / CCW', 'Yaw I', 'Yaw D', 'Roll P / I / D', 'Pitch P / I / D', ...(hasLine ? ['Line, raw gyro roll / pitch / yaw (deg/s)', 'Line, servo commands cyclic / tail (µs)'] : [])], rows));
}

// ---------------------------------------------------------------------------------------------
// 4. What the oscillation looks like
// ---------------------------------------------------------------------------------------------

H('## 4. At what frequency');
out.push(`Amplitude of gyro − setpoint in bands 1 Hz wide, averaged over ${data.rule.spectrum.seconds} s windows that lie within one profile. A hump that stands out from its neighbours is an oscillation; a smooth slope is not. The largest value of each column is in bold.`, '');
const spectrumOf = (g, p, a) => { const list = data.spectrum.filter(s => g.logs.includes(s.log) && s.profile === p), wn = sum(list.map(s => s.windows)); if (wn < 8) return null; return { windows: wn, hz: list[0].hz, amplitude: list[0].hz.map((_, i) => Math.sqrt(sum(list.map(s => s.power[a][i])) / wn)) }; };
results.spectrum = [];
for (let a = 0; a < 3; a++) {
    const cols = groups.flatMap(g => [1, 2, 3].map(p => ({ g, p, s: spectrumOf(g, p, a) }))).filter(c => c.s);
    if (!cols.length) continue;
    for (const c of cols) { let k = 0; c.s.amplitude.forEach((v, i) => { if (c.s.hz[i] >= 6 && v > c.s.amplitude[k]) k = i; }); c.peak = c.s.hz[k] < 6 ? null : k; results.spectrum.push({ axis: AX[a], group: c.g.name, profile: c.p, windows: c.s.windows, hz: c.s.hz, amplitude: c.s.amplitude }); }
    out.push(`**${AX[a]}** (deg/s)`, '');
    out.push(...table(['Hz', ...cols.map(c => `${c.g.name}, profile ${c.p}`)], cols[0].s.hz.filter(h => h <= 24).map((h, i) => [h, ...cols.map(c => c.peak === i ? `**${n(c.s.amplitude[i])}**` : n(c.s.amplitude[i]))])));
}
out.push('Which axes move together: for the bursts of each axis, the motion of the other two at the same frequency, as a share of the motion of the axis itself (median over bursts of 10 deg/s or more).', '');
out.push(...table(['Bursts of', 'Group', 'Profile', 'Bursts', 'Typical frequency (Hz)', 'Roll', 'Pitch', 'Yaw'], AX.flatMap((name, a) => groups.flatMap(g => [1, 2, 3].map(p => {
    const b = data.bursts.filter(v => v.axis === name && g.logs.includes(v.log) && v.profileStart === p && v.profileEnd === p && v.amplitude >= 10 && v.stickShare < RULES.stickDriven);
    return b.length < 5 ? null : [name, g.name, p, b.length, n(weightedMedian(b.map(v => [v.hz, v.seconds]))), ...[0, 1, 2].map(k => k === a ? '1' : n(median(b.map(v => v.others[k])), 2))]; }))).filter(Boolean)));

// ---------------------------------------------------------------------------------------------
// 5. Large yaw events
// ---------------------------------------------------------------------------------------------

const lim = data.limits, atLimit = (range) => (lim.lo !== null && range[0] <= lim.lo + 5e-4) || (lim.hi !== null && range[1] >= lim.hi - 5e-4);
const crossS = (speed) => (lim.lo !== null && lim.hi !== null && speed > 0) ? (lim.hi - lim.lo) / speed : null; // time to cross the whole control range
const large = data.bursts.filter(b => b.large).sort((a, b) => a.log - b.log || a.atS - b.atS);

H('## 5. Large tail events');
const stickDriven = (b) => b.stickShare >= RULES.stickDriven;
out.push(`Every yaw burst in the file with a typical amplitude of ${data.rule.big.amplitude} deg/s or a swing of ${data.rule.big.peak} deg/s or more: ${large.length}. Headspeed is given as the range during the burst, because in most of them it is far from steady. ` +
    `"Stick in band" is how much the yaw stick itself moves at the frequencies of the burst, as a share of the motion; at ${RULES.stickDriven * 100} % or more the burst is the helicopter following the stick, and it is marked and not counted as an oscillation (${large.filter(stickDriven).length} of ${large.length}). "Sticks" is how far each stick moved during the burst and the half second before it. ` +
    `The yaw control is limited to ${n(lim.lo, 3)} … ${n(lim.hi, 3)}; in flight it sat on the lower limit for ${lim.samplesAtLo} samples and on the upper for ${lim.samplesAtHi}.`, '');
out.push(...table(['Log', 'Group', 'At (s)', 'Lasts (s)', 'Hz', 'Amplitude (deg/s)', 'Largest swing', 'Angle (± deg)', 'Growth per cycle', 'Profile', 'Headspeed (rpm)', 'Tail load', 'Control from … to', 'Yaw P × stop CW / CCW', 'Stick in band', 'Sticks: roll / pitch / yaw (deg/s)', 'Collective (% of range)'],
    large.map(b => { const g = tuneOf(b.log, b.profileStart, 2); return [`#${b.log}`, groupOf(b.log).name, n(b.atS), n(b.seconds, 2), n(b.hz), n(b.amplitude, 0), n(b.peak, 0), n(b.angleDeg, 2), (b.growthPerCycle >= 0 ? '+' : '') + pct(b.growthPerCycle, 0),
        b.profileStart === b.profileEnd ? b.profileStart : `${b.profileStart} → ${b.profileEnd}`, `${n(b.hsLow, 0)} … ${n(b.hsHigh, 0)}`, n(-b.control, 2), `${n(b.controlRange[0], 2)} … ${n(b.controlRange[1], 2)}` + (atLimit(b.controlRange) ? ' (limit)' : ''),
        g ? `${n(g.P_cw.gain)} / ${n(g.P_ccw.gain)}` : '–', pct(b.stickShare, 0) + (stickDriven(b) ? ' (stick)' : ''), b.stickSwing ? b.stickSwing.slice(0, 3).map(v => n(v, 0)).join(' / ') : '–', b.stickSwing && b.stickSwing[3] !== null ? n(b.stickSwing[3] / (RULES.stickScale[3] * 10) * 100, 0) : '–']; })));
out.push(...table(['Group', 'Profile', 'Seconds', 'Large events, stick-driven ones left out', 'Seconds in them', 'Per minute of flight'], groups.flatMap(g => [1, 2, 3].map(p => { const secs = cell(g, p).length * data.rule.windowS, ev = large.filter(b => g.logs.includes(b.log) && b.profileStart === p && !stickDriven(b));
    return secs < 5 ? null : [g.name, profileName(g, p), n(secs, 0), ev.length, n(sum(ev.map(b => b.seconds))), n(ev.length / secs * 60, 2)]; })).filter(Boolean)));

// ---------------------------------------------------------------------------------------------
// 6. What turns with the rotor
// ---------------------------------------------------------------------------------------------

H('## 6. Vibration');
results.lines = { list: L.list, foreign: L.foreign };
const specFile = path.join(DIR, 'spectra.json');
if (fs.existsSync(specFile)) {
    const SP = JSON.parse(fs.readFileSync(specFile, 'utf8')), V = RULES.vibration;
    H('### 6.1 How much vibration, by profile');
    out.push(`Vibration is everything the gyro shows between ${V[0]} and ${V[1]} Hz, as rms, from windows of steady headspeed (\`spectra.json\`). "Lines" are the multiples 1 to 4 of rotor speed` + (hasLine ? ` and the line at ${n(L.foreign, 2)} ×` : '') + `, each with ${RULES.lineWidth} Hz either side; "the rest" is what remains when they are taken out. The filtered gyro is what the PID loops work on.`, '');
    results.vibration = [];
    const rows = [];
    for (const g of day) for (const p of [1, 2, 3]) { const list = SP.profiles.filter(e => g.logs.includes(e.log) && e.profile === p), wn = sum(list.map(e => e.windows)); if (wn < 5) continue;
        const rotor = sum(list.map(e => e.headspeed * e.windows)) / wn / 60, pow = (key, a) => list[0][key][a].map((_, k) => sum(list.map(e => e[key][a][k] * e.windows)) / wn);
        const isLine = (hz) => [1, 2, 3, 4].some(k => Math.abs(hz - k * rotor) <= RULES.lineWidth), isForeign = (hz) => hasLine && Math.abs(hz - L.foreign * rotor) <= RULES.lineWidth;
        const rmsOf = (P, test) => Math.sqrt(sum(P.map((v, hz) => (hz >= V[0] && hz <= V[1] && test(hz)) ? v / 2 : 0)));
        const e = { group: g.name, profile: p, windows: wn, rotorHz: rotor, raw: [], gyro: [], control: [] };
        for (const key of ['raw', 'gyro', 'control']) for (let a = 0; a < 3; a++) { const P = pow(key, a); e[key].push({ total: rmsOf(P, () => true), rotor: rmsOf(P, isLine), foreign: rmsOf(P, isForeign), rest: rmsOf(P, (hz) => !isLine(hz) && !isForeign(hz)), low: Math.sqrt(sum(P.map((v, hz) => (hz >= 4 && hz < V[0]) ? v / 2 : 0))) }); }
        results.vibration.push(e);
        for (let a = 0; a < 3; a++) rows.push([AX[a], g.name, profileName(g, p), wn, n(e.raw[a].total), n(e.raw[a].rotor), hasLine ? n(e.raw[a].foreign) : '–', n(e.raw[a].rest), n(e.gyro[a].total), n(e.gyro[a].rotor), hasLine ? n(e.gyro[a].foreign) : '–', n(e.gyro[a].rest), n(1000 * e.control[a].total, 1)]); }
    rows.sort((x, y) => AX.indexOf(x[0]) - AX.indexOf(y[0]));
    out.push(...table(['Axis', 'Group', 'Profile', 'Windows', 'Raw gyro, all (deg/s rms)', 'Rotor lines 1–4', `Line at ${hasLine ? n(L.foreign, 2) : '–'} ×`, 'The rest', 'Filtered gyro, all', 'Rotor lines 1–4', `Line at ${hasLine ? n(L.foreign, 2) : '–'} ×`, 'The rest', 'Control (‰ of full authority, rms)'], rows));
    out.push('Figures: `figures/spectrum_raw.png` and `figures/spectrum_gyro.png` (against frequency, by profile), `figures/orders.png` (against rotor revolutions, raw and filtered), `figures/line_tracking.png` (the line against headspeed, every window), `figures/spectrogram_log*.png` (whole logs from start to end). Drawn by `tools/autotune/spectra_plot.py`.', '');
}
H('### 6.2 What turns with the rotor');
if (!L.windows) out.push('The log holds no raw gyro, or too little steady flight, to look for lines.', '');
else {
    out.push(`The raw gyro is resampled against rotor revolutions (${L.windows} windows of ${L.revolutions} revolutions, resolution ${n(L.resolution, 4)}), so that whatever turns with the rotor is a sharp line whatever the headspeed does. ` +
        'Positions are multiples of the main rotor\'s own once-per-revolution line, which makes them independent of the headspeed reading and of the clock. "Passes the filters" is the filtered gyro over the raw gyro at that line.', '');
    out.push(...table(['× main rotor', 'What', 'Raw gyro roll (deg/s)', 'Pitch', 'Yaw', 'Passes the filters, roll', 'Pitch', 'Yaw'], L.list.slice().sort((a, b) => Math.max(...b.raw) - Math.max(...a.raw)).slice(0, 8).map(l =>
        [n(l.order, 4), l.harmonic ? `main rotor, ${l.harmonic} per revolution` : (hasLine && Math.abs(l.order - L.foreign) < 1e-9 ? 'not a multiple of the main rotor' : hasLine && Math.abs(Math.abs(l.order - L.foreign) - Math.round(Math.abs(l.order - L.foreign))) < 0.003 ? `the ${n(L.foreign, 2)} line ${l.order < L.foreign ? '−' : '+'} ${Math.round(Math.abs(l.order - L.foreign))}` : '–'),
            ...l.raw.map(v => n(v)), ...l.filterPasses.map(v => pct(v, 0))])));
    const dips = []; L.filter.forEach((f, i) => { const v = Math.max(...f.passes), a = L.filter[i - 1], b = L.filter[i + 1]; if (a && b && v < 0.2 && v <= Math.max(...a.passes) && v <= Math.max(...b.passes)) dips.push(f.order); });
    results.lines.notches = dips;
    out.push(`Where the gyro filters cut, read from the same data: the filtered gyro falls below 20 % of the raw gyro at ${dips.map(v => n(v, 2)).join(', ')} × main rotor.`, '');
    if (hasLine) {
        const near = L.filter.filter(f => Math.abs(f.order - L.foreign) < 0.026)[0], fr = [];
        for (let q = RULES.teeth.fewest; q <= 40; q++) for (let p = q; p <= RULES.teeth.most; p++) if (Math.abs(p / q - L.foreign) < RULES.teeth.within) fr.push([p, q]);
        results.lines.ratios = fr;
        out.push(`**The line at ${n(L.foreign, 4)}.** It is the largest vibration in the file, it is no multiple of the main rotor, and the filters pass ${L.list.find(l => l.order === L.foreign).filterPasses.map(v => pct(v, 0)).join(' / ')} of it (roll / pitch / yaw)` + (near ? '' : '') + '. ' +
            `Its position is measured to about ${n(L.resolution / 3, 4)}. Ratios of whole numbers within ${RULES.teeth.within} of it, with 12 to 40 teeth on the smaller wheel: ${fr.length ? fr.map(([p, q]) => `${p}/${q} = ${n(p / q, 4)}`).join(', ') : 'none'}. ` +
            'That is arithmetic on a measured frequency. The log says how often this thing turns; it cannot say what it is, and it holds no gear ratio.', '');

        H('### 6.3 The line, flight by flight');
        out.push(`Size of the line at ${n(L.foreign, 2)} × rotor speed per group and profile, median over ${data.rule.lineWindowS} s windows with steady headspeed: in the raw gyro, in the filtered gyro that the PID loops work on, in the control (thousandths of full authority), and in the servo commands.`, '');
        results.lines.byGroup = [];
        out.push(...table(['Group', 'Profile', 'Windows', 'Line at (Hz)', 'Raw gyro roll / pitch / yaw (deg/s)', 'Filtered gyro', 'Control roll / pitch / yaw (‰)', 'Servo commands, cyclic / tail (µs)', 'Main rotor once per rev., raw gyro', 'Same, filtered'], groups.flatMap(g => [1, 2, 3].map(p => {
            const lw = lineWindows.filter(v => g.logs.includes(v.log) && v.profile === p); if (lw.length < 3) return null;
            const one = (key) => [0, 1, 2].map(a => n(median(lw.map(v => v[key][a][0])), 1)).join(' / ');
            results.lines.byGroup.push({ group: g.name, profile: p, windows: lw.length, raw: [0, 1, 2].map(a => median(lw.map(v => v.raw[a][watchAt]))), gyro: [0, 1, 2].map(a => median(lw.map(v => v.gyro[a][watchAt]))), control: [0, 1, 2].map(a => median(lw.map(v => v.control[a][watchAt]))), servo: [0, 3].map(k => lw[0].servo[k] ? median(lw.map(v => v.servo[k][watchAt])) : null) });
            return [g.name, profileName(g, p), lw.length, n(median(lw.map(v => L.foreign * v.headspeed / 60)), 0), lineCell(lw, 'raw', [0, 1, 2]), lineCell(lw, 'gyro', [0, 1, 2]), lineCell(lw, 'control', [0, 1, 2], 1), lineCell(lw, 'servo', [0, 3]), one('raw'), one('gyro')]; })).filter(Boolean)));

        H('### 6.4 Does the oscillation follow the line?');
        out.push(`Rank correlation, over the same windows, between the size of the line in the raw gyro and the amplitude of the oscillation in the band of each axis. It says whether the two rise and fall together within a profile; it does not say which drives which.`, '');
        results.lines.correlation = [];
        out.push(...table(['Group', 'Profile', 'Windows', 'Roll', 'Pitch', 'Yaw', 'Line against tail load', 'Line against collective'], groups.flatMap(g => [1, 2, 3].map(p => { const lw = lineWindows.filter(v => g.logs.includes(v.log) && v.profile === p); if (lw.length < 20) return null;
            const c = [0, 1, 2].map(a => spearman(lw.map(v => v.raw[a][watchAt]), lw.map(v => v.osc[a]))), s = lw.map(v => size3(v)), cl = spearman(s, lw.map(v => Math.abs(v.load))), cc = lw[0].collective === null ? NaN : spearman(s, lw.map(v => v.collective));
            results.lines.correlation.push({ group: g.name, profile: p, windows: lw.length, axes: c, load: cl, collective: cc });
            return [g.name, profileName(g, p), lw.length, ...c.map(v => n(v, 2)), n(cl, 2), n(cc, 2)]; })).filter(Boolean)));
    }
}

// ---------------------------------------------------------------------------------------------
// 7. Airframe response and margins, group by group
// ---------------------------------------------------------------------------------------------

H('## 7. Airframe response and stability margins');
out.push(`Response from control to rate, identified with the pilot's stick as the instrument, which stays unbiased under feedback, from the stretches of 20 s or more on one profile. For yaw, windows that touch an output limit are left out. ` +
    `A response is given where ${RULES.minFlights} flights or more contribute; models are fitted to the bins known to ${RULES.maxSigma * 100} % and the one with the lowest reduced chi-square is used. ` +
    'Gain margin is the factor by which the response may rise before the loop oscillates by itself. Peak sensitivity is the largest factor by which the loop amplifies motion it did not command.', '');
const long = segments.filter(s => s.long), classes = [...new Set(long.map(s => s.class))].sort((a, b) => a - b), plants = {};
const plantFor = (g, c, a) => { const k = `${g.name}|${c}|${a}`; if (!(k in plants)) plants[k] = plantOf(long.filter(s => s.group === g && s.class === c).map(s => ({ flight: s.flight, spectra: unpack(a === 2 ? s.yawClear : s.axes[AX[a]].spectra) })), a); return plants[k]; };
const tunes = []; // every (group, class, axis) with the gains flown
for (const g of groups) for (const c of classes) for (let a = 0; a < 3; a++) {
    const segs = segments.filter(s => s.group === g && s.class === c && usable(s.axes[AX[a]].gains, a)); if (!segs.length) continue;
    const clean = median(segs.map(s => s.axes[AX[a]].gains).filter(v => v.I.decayPerS <= 0.05).map(v => v.I.gain)), sets = [];
    for (const s of segs) { const G = gainsOf(s.axes[AX[a]].gains, a); if (s.axes[AX[a]].gains.I.decayPerS > 0.05 && isFinite(clean)) G.I = clean; // the I term cannot be recovered where the output sat on its limits
        const key = `${Math.round(G.P)}|${Math.round(G.D)}`; let t = sets.find(v => v.key === key);
        if (!t) sets.push(t = { key, group: g, class: c, a, gains: G, stop: a === 2 ? [s.axes.yaw.gains.P_cw.gain, s.axes.yaw.gains.P_ccw.gain] : null, pairs: [] });
        if (!t.pairs.some(v => v.log === s.log && v.profile === s.profile)) t.pairs.push({ log: s.log, profile: s.profile }); }
    tunes.push(...sets);
}
for (const t of tunes) { const P = plantFor(t.group, t.class, t.a), w = W.filter(v => !v.ramp && t.pairs.some(q => q.log === v.log && q.profile === v.profile)), st = stats(w, t.a);
    Object.assign(t, { P, seconds: st.seconds, stats: st, logs: [...new Set(t.pairs.map(q => `#${q.log}`))], last: Math.max(...t.pairs.map(q => q.log)) });
    if (P.model) { t.figures = loopFigures(t.a, t.gains, P.plant); t.gm = withSE(P, pl => loopFigures(t.a, t.gains, pl).gainMargin); t.ms = withSE(P, pl => loopFigures(t.a, t.gains, pl).peakSensitivity); } }
results.response = [];
for (let a = 0; a < 3; a++) {
    out.push(`**${AX[a]}: airframe response**`, '');
    out.push(...table(['Group', 'Headspeed (rpm)', 'Flights', 'Windows', 'Model', 'Reduced chi-square', 'Phase reaches −180° at (Hz)', 'Gain there (deg/s per unit)', 'Gain at 10 Hz'], groups.flatMap(g => classes.map(c => { const P = plantFor(g, c, a); if (!P.pooled.windows) return null;
        if (!P.model) return [g.name, c, P.pooled.flights, P.pooled.windows, P.why, '–', '–', '–', '–'];
        const f180 = withSE(P, minus180), g180 = withSE(P, pl => { const f = minus180(pl); return f ? cx.abs(pl(f)) : null; }), g10 = withSE(P, pl => cx.abs(pl(10)));
        results.response.push({ axis: AX[a], group: g.name, class: c, flights: P.pooled.flights, model: Object.assign({}, P.model, { jack: undefined }), minus180Hz: f180, gainThere: g180, gainAt10Hz: g10 });
        return [g.name, c, P.pooled.flights, P.pooled.windows, describe(P.model), n(P.model.chi2red, 2), pm(f180.value, f180.se), pm(g180.value, g180.se, 0), pm(g10.value, g10.se, 0)]; })).filter(Boolean)));
    const list = tunes.filter(t => t.a === a && t.seconds >= 5);
    out.push(`**${AX[a]}: the tunes that were flown**`, '');
    out.push(...table(['Group', 'Headspeed (rpm)', 'Logs', a === 2 ? 'P × stop CW / CCW' : 'P', 'I', 'D', 'Seconds', 'Gain margin', 'at (Hz)', 'Phase margin (deg)', 'Peak sensitivity', 'at (Hz)', 'Amplitude, median / 99th pct (deg/s)', `≥ ${RULES.thresholds[1]} deg/s`],
        list.map(t => [t.group.name, t.class, t.logs.join(' '), a === 2 ? `${n(t.stop[0])} / ${n(t.stop[1])}` : n(t.gains.P, 0), n(t.gains.I, 0), n(t.gains.D, a === 2 ? 1 : 0), n(t.seconds, 0), t.gm ? pm(t.gm.value, t.gm.se, 2) : t.P.why, t.gm ? n(t.figures.gainMarginHz) : '–', t.gm ? n(t.figures.phaseMargin, 0) : '–',
            t.ms ? pm(t.ms.value, t.ms.se, 2) : '–', t.ms ? n(t.figures.peakSensitivityHz) : '–', `${n(t.stats.median)} / ${n(t.stats.p99)}`, pct(t.stats.shares[1])])));
}
results.tunes = tunes.map(t => ({ axis: AX[t.a], group: t.group.name, class: t.class, logs: t.logs, gains: t.gains, stop: t.stop, seconds: t.seconds, figures: t.figures || null, gainMarginSE: t.gm ? t.gm.se : null, amplitude: t.stats }));

// tail effectiveness against tail load, all flights of a headspeed together
H('### 7.1 Tail effectiveness against tail load');
out.push(`Measured yaw response of the windows in each range of tail load (minus the mean yaw control), divided by the response of all windows at that headspeed, averaged over ${RULES.loadBand.join('–')} Hz with weights 1/σ². All groups together.`, '');
const loadNames = [...data.rule.loadBins, Infinity].map((hi, b) => b === 0 ? `below ${hi}` : hi === Infinity ? `above ${data.rule.loadBins[b - 1]}` : `${data.rule.loadBins[b - 1]} – ${hi}`);
const ratioOf = (rows, plant, sig) => { let sw = 0, sl = 0, sp = 0; for (const r of rows) { if (r.f < RULES.loadBand[0] || r.f > RULES.loadBand[1] || !sig.has(r.f)) continue; const w = 1 / sig.get(r.f) ** 2, q = cx.div(r.G, plant(r.f)); sw += w; sl += w * Math.log(cx.abs(q)); sp += w * cx.arg(q); } return sw ? { gain: Math.exp(sl / sw), phase: sp / sw * 180 / Math.PI } : null; };
results.load = [];
out.push(...table(['Headspeed (rpm)', 'Tail load', 'Flights', 'Windows', 'Effectiveness relative to all', 'Extra phase (deg)'], classes.flatMap(c => { const all = plantOf(long.filter(s => s.class === c).map(s => ({ flight: s.flight, spectra: unpack(s.yawClear) })), 2); if (!all.model) return [];
    return loadNames.map((name, b) => { const pooled = lib.pool(long.filter(s => s.class === c).map(s => ({ flight: s.flight, spectra: unpack(s.yawByLoad[b]) })).filter(it => it.spectra.windows > 0));
        if (pooled.flights < RULES.minFlights) return [c, name, pooled.flights, pooled.windows, 'too few flights', '–'];
        const sig = new Map(pooled.rows.filter(r => r.Gse && r.Gse.sigma < RULES.maxSigma).map(r => [r.f, Math.max(0.03, r.Gse.sigma)])), v = ratioOf(pooled.rows, all.plant, sig);
        if (!v || sig.size < 4) return [c, name, pooled.flights, pooled.windows, 'response not known well enough', '–'];
        const reps = pooled.leaveOut.map(o => ratioOf(lib.rowsOf(o), all.plant, sig)), se = { gain: jackSE(reps.map(x => x.gain)), phase: jackSE(reps.map(x => x.phase)) }, load = sum(long.filter(s => s.class === c).map(s => s.yawByLoad[b].loadSum)) / sum(long.filter(s => s.class === c).map(s => s.yawByLoad[b].windows));
        results.load.push({ class: c, bin: name, load, flights: pooled.flights, windows: pooled.windows, gain: v.gain, gainSE: se.gain, phase: v.phase, phaseSE: se.phase });
        return [c, `${name} (mean ${n(load, 2)})`, pooled.flights, pooled.windows, pm(v.gain, se.gain, 2), pm(v.phase, se.phase, 0)]; }); })));

// how the large events start
H('### 7.2 How the large tail events start and what they settle into');
const o = RULES.onset;
out.push(`Each large event is followed half cycle by half cycle (yaw error band-passed ${data.rule.cycleBand.join('–')} Hz). An event is self-excited when the swing grows from below ${o.small} to above ${o.high} deg/s over at least ${o.minHalfCycles / 2} cycles. ` +
    `Start: half cycles below ${o.low} deg/s. Settled: half cycles above ${o.high} deg/s. "Response" is yaw rate swing over control swing; in an oscillation that sustains itself this is the airframe response at that frequency, and it is compared with the model of the group the flight belongs to. ` +
    'An event can start by itself once the response at the start reaches the gain margin of the tune. Extra lag is the phase the airframe must have for the loop to close at −180° at the settled frequency, minus the phase of the model there. Range time is how long the commanded control would take to cross its whole range at the speed it is asked to move.', '');
const events = [];
for (const b of large.filter(v => !stickDriven(v))) {
    const g = groupOf(b.log), c = lib.headspeedClass(b.targetStart), P = plantFor(g, c, 2), hc = b.halfCycles, t = tunes.find(v => v.a === 2 && v.pairs.some(q => q.log === b.log && q.profile === b.profileStart));
    if (!P.model || !t || !t.gm) continue;
    const first = hc.findIndex(h => Math.abs(h.peak) >= o.high); let start = -1;
    if (first > 0) for (let i = first - 1; i >= 0; i--) if (Math.abs(hc[i].peak) < o.small) { start = i; break; }
    const ev = { log: b.log, group: g.name, atS: b.atS, class: c, profile: b.profileStart, selfExcited: start >= 0 && first - start >= o.minHalfCycles, gainMargin: t.gm.value, stop: t.stop };
    const ratio = (list) => median(list.filter(h => h.control > 0.01).map(h => Math.abs(h.peak) / h.control / cx.abs(P.plant(h.hz))));
    if (ev.selfExcited) {
        const run = hc.slice(start, first + 1), low = run.filter(h => Math.abs(h.peak) < o.low && Math.abs(h.peak) >= 10);
        let sx = 0, sy = 0, sxy = 0, sxx = 0; run.forEach((h, i) => { const k = i / 2, l = Math.log(Math.abs(h.peak)); sx += k; sy += l; sxy += k * l; sxx += k * k; });
        Object.assign(ev, { onsetAtS: run[0].atS, onsetHz: median(low.map(h => h.hz)), onsetLoad: median(low.map(h => h.load)), onsetHeadspeed: median(low.map(h => h.headspeed)), onsetStick: median(low.map(h => h.stick / Math.abs(h.peak))),
            growth: Math.exp((run.length * sxy - sx * sy) / (run.length * sxx - sx * sx)) - 1, cyclesToLarge: (first - start) / 2, onsetResponse: ratio(low), model180: minus180(P.plant) });
    }
    const big = hc.filter(h => Math.abs(h.peak) >= o.high);
    if (big.length >= o.minHalfCycles) {
        const hz = median(big.map(h => h.hz)), C = lib.loop(2, t.gains, () => [1, 0], hz).L; // feedback response alone
        Object.assign(ev, { settledHz: hz, settledSwing: median(big.map(h => Math.abs(h.peak))), settledControl: median(big.map(h => h.control)), settledResponse: ratio(big),
            extraLag: ((-180 - deg(C)) - deg(P.plant(hz)) + 540) % 360 - 180, servoSpeed: median(big.map(h => h.control * 2 * Math.PI * h.hz)) });
    }
    if (ev.selfExcited || ev.settledHz) events.push(ev);
}
results.events = events;
out.push(...table(['Log', 'Group', 'Profile', 'Start (s)', 'Self-excited', 'Start frequency (Hz)', 'Model −180° (Hz)', 'Growth per cycle', 'Tail load at start', 'Headspeed at start (rpm)', 'Stick / yaw swing', 'Response at start / model', 'Gain margin of the tune', 'Settled frequency (Hz)', 'Settled swing (deg/s)', 'Control swing', 'Response settled / model', 'Extra lag (deg)', 'Range time (ms)'],
    events.map(e => [`#${e.log}`, e.group, e.profile, n(e.onsetAtS || e.atS), e.selfExcited ? 'yes' : 'no, began large', n(e.onsetHz), n(e.model180), e.growth === undefined ? '–' : '+' + pct(e.growth, 0), n(e.onsetLoad, 2), n(e.onsetHeadspeed, 0), e.onsetStick === undefined ? '–' : pct(e.onsetStick, 0), n(e.onsetResponse, 2), n(e.gainMargin, 2),
        n(e.settledHz), n(e.settledSwing, 0), n(e.settledControl, 2), n(e.settledResponse, 2), n(e.extraLag, 0), e.servoSpeed ? n(1000 * crossS(e.servoSpeed), 0) : '–'])));
const self = events.filter(e => e.selfExcited);

H('### 7.3 Checked and found small');
const causes = [];
{ const share = large.filter(b => data.torque[lib.headspeedClass(b.targetStart)] && b.throttlePerGyro !== null && b.volts).map(b => { const t = data.torque[lib.headspeedClass(b.targetStart)]; return Math.abs(t.beta[1]) * b.volts * b.throttlePerGyro / (Math.abs(t.beta[0]) * b.controlPerGyro); });
    const c = Object.keys(data.torque).sort((p, q) => data.torque[q].samples - data.torque[p].samples)[0], t = data.torque[c];
    if (t && share.length) { results.motorShare = { median: median(share), quartiles: [quantile(share, 0.25), quantile(share, 0.75)] };
        causes.push(['Governor and motor torque', `During the large events throttle moves by ${n(1e4 * median(large.map(b => b.throttlePerGyro)), 2)} % of full scale per 100 deg/s of yaw rate, and headspeed reads ${n(median(large.map(b => b.headspeedPerGyro)), 2)} rpm per deg/s (a yawing fuselage alone gives 0.17). ` +
            `Regression of yaw acceleration at ${c} rpm (${t.flights} flights, R² ${n(t.r2, 2)}): tail control ${pm(t.beta[0], t.se[0], 0)} deg/s² per unit, throttle × battery voltage ${pm(t.beta[1], t.se[1], 0)} deg/s² per volt. ` +
            `The throttle movement therefore supplies ${pct(median(share))} of the yaw torque that the tail control supplies in the same events (median over ${share.length} events; quartiles ${pct(quantile(share, 0.25))} and ${pct(quantile(share, 0.75))}).`]); } }
{ const rows = classes.map(c => { const F = long.filter(s => s.class === c).map(s => s.axes.yaw.filter).filter(Boolean); if (!F.length) return null; const i = F[0].hz.indexOf(12), re = sum(F.map(f => f.ryRe[i])), im = sum(F.map(f => f.ryIm[i])); return { c, ms: -Math.atan2(im, re) / (2 * Math.PI * 12) * 1000 }; }).filter(Boolean);
    if (rows.length) { results.filterDelayMs = rows; causes.push(['Lag of the gyro filters below 30 Hz', `Filtered against raw gyro at 12 Hz: ${rows.map(v => `${n(v.ms)} ms at ${v.c} rpm`).join(', ')}. The airframe responses of this section carry 14 to 21 ms of delay; the filters are a small part of it, and the rest is after the flight controller (servo, linkage, rotor), which the log cannot split.`]); } }
if (self.length) causes.push(['Pilot input', `Swing of the yaw stick in the ${data.rule.cycleBand.join('–')} Hz band while the self-excited events start, as a share of the swing of the yaw rate: ${self.map(e => `${pct(e.onsetStick, 0)} (#${e.log})`).join(', ')}.`]);
out.push(...table(['Candidate', 'Measurement'], causes));

// ---------------------------------------------------------------------------------------------
// 8. Decisions
// ---------------------------------------------------------------------------------------------

H('## 8. Decisions');
out.push(`Decisions are taken for the helicopter as it flew last, group ${latest.name}, on the airframe response measured in that group. Where that group has too few flights for a response, no decision is taken.`, '');
results.decisions = { group: latest.name, yaw: [], rollPitch: [], filter: null };

H('### 8.1 Yaw');
const unstable = self.filter(e => e.gainMargin !== null), worst = unstable.slice().sort((x, y) => y.gainMargin - x.gainMargin)[0];
if (!worst) out.push('No decision: no event in the file started by itself, so the log holds no case of the yaw loop going unstable.', '');
else {
    out.push(`**Rule.** The loop went unstable by itself with tunes whose gain margin, on the response of their own group, was as high as ${n(worst.gainMargin, 2)} (log #${worst.log} at ${n(worst.onsetAtS)} s, growing ${pct(worst.growth, 0)} per cycle); the response measured at the start of the events was up to ${n(Math.max(...unstable.map(e => e.onsetResponse)), 2)} times the model. ` +
        `The gain margin therefore has to exceed that figure on every profile: × ${RULES.reserve} as the least, × ${RULES.gainMargin} to keep the usual margin of ${RULES.gainMargin} in those moments. P is lowered in both stop directions alike; I is lowered only when the phase margin would otherwise fall below ${RULES.phaseMargin}°; D stays, because it buys no gain margin (table below).`, '');
    for (const c of classes) {
        const P = plantFor(latest, c, 2), mine = tunes.filter(t => t.a === 2 && t.group === latest && t.class === c).sort((x, y) => y.last - x.last)[0];
        if (!mine) continue;
        if (!P.model) { out.push(`**${c} rpm: no decision.** Response of group ${latest.name} not known: ${P.why}.`, ''); results.decisions.yaw.push({ class: c, change: null, why: P.why }); continue; }
        const ref = mine, f0 = ref.figures, stopRatio = ref.stop.map(v => v / ref.gains.P);
        const tune = (need) => { for (let p = ref.gains.P; p >= 5; p -= 0.5) { if (loopFigures(2, Object.assign({}, ref.gains, { P: p }), P.plant).gainMargin < need) continue;
            for (const i of [ref.gains.I, ...RULES.yawIsteps.filter(v => v < ref.gains.I)]) { const g = Object.assign({}, ref.gains, { P: p, I: i }), f = loopFigures(2, g, P.plant);
                if (f.phaseMargin >= Math.min(RULES.phaseMargin, f0.phaseMargin)) return { gains: g, figures: f, gm: withSE(P, pl => loopFigures(2, g, pl).gainMargin) }; }
            return null; } return null; };
        const tiers = [['Least change', worst.gainMargin * RULES.reserve], ['Usual margin', worst.gainMargin * RULES.gainMargin]].map(([name, need]) => ({ name, need: Math.max(RULES.gainMargin, need), t: tune(Math.max(RULES.gainMargin, need)) }));
        out.push(`**${c} rpm**, last flown in log #${ref.last}.`, '');
        out.push(...table(['', 'Gain margin required', 'Yaw P × stop CW / CCW', 'I', 'D', 'Gain margin', 'Phase margin (deg)', 'Peak sensitivity', 'Disturbance left at 2 Hz'],
            [['Last flown', '–', `${n(ref.stop[0])} / ${n(ref.stop[1])}`, n(ref.gains.I, 0), n(ref.gains.D), pm(ref.gm.value, ref.gm.se, 2), n(f0.phaseMargin, 0), n(f0.peakSensitivity, 2), n(f0.rejection2Hz, 2)],
                ...tiers.map(x => !x.t ? [x.name, n(x.need, 2), 'not reached by any P', '–', '–', '–', '–', '–', '–'] : x.t.gains.P >= ref.gains.P - 0.25 && x.t.gains.I === ref.gains.I ? [x.name, n(x.need, 2), 'as flown', '', '', '', '', '', ''] :
                    [x.name, n(x.need, 2), `${n(x.t.gains.P * stopRatio[0])} / ${n(x.t.gains.P * stopRatio[1])}`, n(x.t.gains.I, 0), n(x.t.gains.D), pm(x.t.gm.value, x.t.gm.se, 2), n(x.t.figures.phaseMargin, 0), n(x.t.figures.peakSensitivity, 2), `${n(x.t.figures.rejection2Hz, 2)} (${pct(x.t.figures.rejection2Hz / f0.rejection2Hz - 1, 0)} less firm)`])]));
        results.decisions.yaw.push({ class: c, lastFlown: { log: ref.last, stop: ref.stop, gains: ref.gains, figures: f0, gainMarginSE: ref.gm.se }, tiers: tiers.map(x => ({ name: x.name, requiredGainMargin: x.need, gains: x.t && x.t.gains, stopCW: x.t && x.t.gains.P * stopRatio[0], stopCCW: x.t && x.t.gains.P * stopRatio[1], figures: x.t && x.t.figures, gainMarginSE: x.t && x.t.gm.se })) });
    }
    const c = lib.headspeedClass(worst.class), P = plantFor(latest, c, 2).model ? plantFor(latest, c, 2) : null, ref = P && tunes.filter(t => t.a === 2 && t.group === latest && t.class === c).sort((x, y) => y.last - x.last)[0];
    if (P && ref) { out.push(`What D and I do, at ${c} rpm on the response of group ${latest.name}. Each cell: gain margin / phase margin (deg) / disturbance left at 2 Hz (1 = no feedback; smaller holds better).`, '');
        out.push(...table(['P (mean of stop directions)', ...RULES.yawD.map(d => `D ${d}`)], RULES.yawP.map(p => [p, ...RULES.yawD.map(d => { const f = loopFigures(2, Object.assign({}, ref.gains, { P: p, D: d }), P.plant); return `${n(f.gainMargin, 2)} / ${n(f.phaseMargin, 0)} / ${n(f.rejection2Hz, 2)}`; })])));
        out.push(...table(['I', 'Gain margin', 'Phase margin (deg)', 'Disturbance left at 2 Hz'], RULES.yawI.map(i => { const f = loopFigures(2, Object.assign({}, ref.gains, { I: i }), P.plant); return [i, n(f.gainMargin, 2), n(f.phaseMargin, 0), n(f.rejection2Hz, 2)]; }))); }
}

H('### 8.2 Roll and pitch');
out.push(`For every headspeed whose loop amplifies by more than ${RULES.peakSensitivity}, each single gain change in the list is evaluated on the airframe model with the measured spectra: amplitude in the oscillation band, and error over ${RULES.lowBand.join('–')} Hz where the stick is. ` +
    `The standard error of a predicted cut is the jackknife error combined with ${RULES.floor * 100} %, the error such predictions showed on simulated flights. A change is taken when it cuts the band amplitude by at least ${RULES.improvement * 100} % and ${RULES.sigmas} standard errors, keeps the ${RULES.lowBand.join('–')} Hz error within ${RULES.tolerance * 100} % and keeps the gain margin at ${RULES.gainMargin} or above; of those, the largest cut wins.`, '');
for (const a of [0, 1]) for (const c of classes) {
    const e = tunes.filter(t => t.a === a && t.group === latest && t.class === c).sort((x, y) => y.seconds - x.seconds)[0]; if (!e) continue;
    const tag = `${AX[a]} at ${c} rpm`, band = BANDS[AX[a]];
    if (!e.P.model) { out.push(`**${tag}: no decision.** ${e.P.why}.`, ''); results.decisions.rollPitch.push({ axis: AX[a], class: c, change: null, why: e.P.why }); continue; }
    if (e.ms.value <= RULES.peakSensitivity) { out.push(`**${tag}: no change.** Peak sensitivity ${pm(e.ms.value, e.ms.se, 2)} is within ${RULES.peakSensitivity}.`, ''); results.decisions.rollPitch.push({ axis: AX[a], class: c, change: null, why: 'peak sensitivity within the rule' }); continue; }
    const rows = e.P.pooled.rows, tab = (pl) => new Map(rows.map(r => [r.f, pl(r.f)])), amplitude = Math.SQRT2 * lib.bandRms(rows, 'ee', band[0], band[1]);
    const figure = (g, pl, rws) => { const t = tab(pl), osc = lib.predict(a, g, e.gains, t, rws, { band }), low = lib.predict(a, g, e.gains, t, rws, { band: RULES.lowBand }), f = loopFigures(a, g, pl); return { osc: osc.disturb, low: low.total, gm: f.gainMargin, ms: f.peakSensitivity }; };
    const reps = e.P.replicas.map((pl, i) => ({ pl, rows: lib.rowsOf(e.P.pooled.leaveOut[i]) })), base = figure(e.gains, e.P.plant, rows), baseReps = reps.map(r => figure(e.gains, r.pl, r.rows)), cands = [];
    for (const k of Object.keys(RULES.candidates)) for (const m of RULES.candidates[k]) {
        const g = Object.assign({}, e.gains, { [k]: e.gains[k] * m }), v = figure(g, e.P.plant, rows), r = reps.map(x => figure(g, x.pl, x.rows));
        const cut = 1 - v.osc / base.osc, cutSE = Math.hypot(RULES.floor, jackSE(r.map((x, i) => 1 - x.osc / baseReps[i].osc))), low = v.low / base.low - 1, fails = [];
        if (cut < RULES.improvement) fails.push(`cut below ${RULES.improvement * 100} %`); if (cut < RULES.sigmas * cutSE) fails.push(`cut below ${RULES.sigmas} standard errors`);
        if (low > RULES.tolerance) fails.push(`${RULES.lowBand.join('–')} Hz error up ${pct(low, 0)}`); if (v.gm !== null && v.gm < RULES.gainMargin) fails.push(`gain margin ${n(v.gm, 2)}`);
        cands.push({ gain: k, factor: m, value: g[k], cut, cutSE, low, gm: v.gm, ms: v.ms, fails });
    }
    out.push(`**${tag}**, flown P ${n(e.gains.P, 0)}, I ${n(e.gains.I, 0)}, D ${n(e.gains.D, 0)}: gain margin ${pm(e.gm.value, e.gm.se, 2)}, peak sensitivity ${pm(e.ms.value, e.ms.se, 2)} at ${n(e.figures.peakSensitivityHz)} Hz; band ${band.join('–')} Hz, amplitude ${n(amplitude)} deg/s.`, '');
    out.push(...table(['Change', 'Band amplitude', `Error ${RULES.lowBand.join('–')} Hz`, 'Peak sensitivity', 'Gain margin', 'Rule'], cands.map(cd => [`${cd.gain} ${n(e.gains[cd.gain], 0)} → ${n(cd.value, 0)}`, `${cd.cut >= 0 ? '−' : '+'}${n(100 * Math.abs(cd.cut), 0)} ± ${n(100 * cd.cutSE, 0)} %`, `${cd.low >= 0 ? '+' : '−'}${n(100 * Math.abs(cd.low), 0)} %`, n(cd.ms, 2), n(cd.gm, 2), cd.fails.length ? 'fails: ' + cd.fails.join('; ') : 'passes'])));
    const pass = cands.filter(cd => !cd.fails.length).sort((x, y) => y.cut - x.cut)[0];
    out.push(pass ? `**Decision: ${AX[a]} ${pass.gain} ${n(e.gains[pass.gain], 0)} → ${n(pass.value, 0)} on the ${c} rpm profile.** Predicted: gain margin ${n(e.gm.value, 2)} → ${n(pass.gm, 2)}, peak sensitivity ${n(e.ms.value, 2)} → ${n(pass.ms, 2)}, amplitude in ${band.join('–')} Hz down by ${n(100 * pass.cut, 0)} ± ${n(100 * pass.cutSE, 0)} %. ` +
        'The cut is smaller than the change in peak sensitivity because the loop amplifies only close to its peak, while the motion is spread over the whole hump of section 4. A prediction until a flight confirms it.' : '**Decision: no change.** No candidate passes the rule.', '');
    results.decisions.rollPitch.push({ axis: AX[a], class: c, flown: e.gains, amplitude, peakSensitivity: e.ms, gainMargin: e.gm, candidates: cands, change: pass || null });
}

if (hasLine) {
    H('### 8.3 The vibration line');
    const l = L.list.find(v => v.order === L.foreign), here = (results.lines.byGroup || []).filter(v => v.group === latest.name), first = (results.lines.byGroup || []).filter(v => v.group !== latest.name && groups.find(g => g.name === v.group).day === latest.day);
    const latestServo = Math.max(0, ...here.flatMap(h => h.servo || []).filter(v => v !== null));
    const grew = here.map(h => { const b = first.find(v => v.profile === h.profile); return b ? { profile: h.profile, factor: [0, 1, 2].map(a => h.raw[a] / b.raw[a]) } : null; }).filter(Boolean);
    results.decisions.filter = { order: L.foreign, passes: l.filterPasses, grew };
    out.push(`Measured: the line at ${n(L.foreign, 2)} × rotor speed is ${grew.length ? grew.map(v => `${v.factor.map(x => n(x, 1)).join(' / ')} times larger on profile ${v.profile}`).join(', ') + ` (roll / pitch / yaw) in group ${latest.name} than in the group before it` : 'present in every flight'}; ` +
        `the gyro filters pass ${l.filterPasses.map(v => pct(v, 0)).join(' / ')} of it, against ${L.list.filter(v => v.harmonic && v.harmonic <= 2).map(v => pct(Math.max(...v.filterPasses), 1)).join(' and ')} of the main rotor lines at 1 and 2 per revolution, which have a notch each${latestServo > 0.5 ? `; and it reaches the servos (${n(latestServo)} µs, 6.3)` : ''}.`, '');
    const cors = (results.lines.correlation || []).flatMap(v => v.axes).filter(isFinite), filtered = Math.max(...l.filterPasses) < 0.05;
    out.push((filtered ? '**Decision: no filter change.** The filters already keep this line out of the PID loops; what makes it is a mechanical question. '
        : '**Decision: keep this line out of the PID loops, and find what makes it.** A notch that sits on it would cut it the way the main rotor notches cut theirs. Whether the oscillation at lower frequency then goes down is not shown by this file. ') +
        `${grew.length ? `Line and oscillation are both larger in group ${latest.name} than before, but w` : 'W'}ithin a group, window by window, the oscillation does not follow the line: the rank correlations of 6.4 lie between ${n(Math.min(...cors), 2)} and ${n(Math.max(...cors), 2)}, median ${n(median(cors), 2)}.`, '');
}

// ---------------------------------------------------------------------------------------------
// 9. Limits
// ---------------------------------------------------------------------------------------------

H('## 9. What this file cannot show');
out.push(...[
    '- No change proposed here has been flown after the fact. Each is a prediction, and the next flight is the test.',
    '- What differs between the groups of flights is read from the data alone. What was changed on the helicopter between them is not in the log.',
    '- The log records what the flight controller commanded, not where the servos or the blades were. The extra lag at large amplitude in 7.2 is measured as a whole.',
    '- The gyro reports vibration of the flight controller on its mount as well as motion of the helicopter. At several hundred hertz the log cannot tell the two apart.',
    `- Tail effectiveness at tail loads above ${data.rule.loadBins[data.rule.loadBins.length - 1]} rests on few windows, because the pilot rarely stays there.`,
    '- Frequencies assume the clock of the flight controller; the loop ran at ' + n(median(flown.map(f => f.actualRate)), 1) + ' frames per second against a nominal ' + flown[0].rate + '. Spectra in section 7 use the nominal rate, which shifts their frequencies by ' + pct(flown[0].rate / median(flown.map(f => f.actualRate)) - 1, 1) + '.',
].concat(['']));

fs.writeFileSync(path.join(DIR, 'report.md'), out.join('\n'));
fs.writeFileSync(path.join(DIR, 'results.json'), JSON.stringify(results, (k, v) => k === 'jack' || (k === 'P' && v && v.pooled) || k === 'group' && v && v.flights ? (v && v.name) : v, 1));
console.error(`wrote ${path.join(DIR, 'report.md')} and results.json`);
