'use strict';

/**
 * Governor autotune scenarios: the model families of gov_tune.cjs (docs/GOVERNOR_AUTOTUNE.md sections 5 and 7;
 * analysis/governor-20261014/critique.md wins on conflicts) from the identified governor twin (gov_twin, gov_fit) and the native
 * Rotorflight 4.6 governor in closed loop (gov_sim):
 *   power        gov_headspeed (the throttle reserve, the battery-voltage tradeoff), gov_use_voltage_comp and gov_pwr_filter (the numbers of
 *                voltage compensation)
 *   spoolup      gov_spoolup_time, gov_use_pid_spoolup (scenario S), gov_startup_time, gov_spooldown_time, and gov_autorotation_timeout (a
 *                BAILOUT from a slow rotor)
 *   tracking     gov_tracking_time (the target slope after a PID profile change, RECOVERY and BAILOUT: critique M6)
 *   fallback     gov_recovery_time, gov_fallback_drop, gov_use_fallback_precomp (scenario G; the cue rule: the measured throttle decrease in
 *                FALLBACK; a new recovery time must keep its RECOVERY and BAILOUT cases)
 *   maxThrottle  gov_max_throttle (the 95-98 % test for the RPM signal errors at 100 % throttle: a check with opt-in CLI text)
 *   bypass       gov_bypass_throttle (a check with opt-in CLI text: the BYPASS switch is the pilot's choice)
 *
 *   evaluate(runs, o)  async -> S. All simulations and numbers. o: { model (gov_fit.identify: params, samples, uncertainty, split), validation
 *                      (gov_fit.validate: status, checks, tmScan, events; optional), recovered (gov_params.recover), cli, configs (gov_sim.configOf),
 *                      base (gov_tune.tune without families), progress(f, text), steps (the parts to calculate: power, trial, spool, tracking,
 *                      fallback, bypass, vcomp, bailout; default all) }
 *   families(S)        { power, spoolup, tracking, fallback, maxThrottle, bypass }: (ctx) -> rows (gov_tune.tune(runs, { families }))
 *   finish(res)        the opt-in CLI text of the check rows (row.optIn) in res.recommendations (advice.exportPlan: severity 'check', optIn)
 *   tune(runs, o)      async: evaluate, gov_tune.tune with the families, finish -> the gov_tune result + scenarios (summary(S): numbers, plots)
 *   twinSet(model, validation, ref), softSet(model), dReq(p, H, A, X, Y, ocv, Hf), bootstrap(d), glitchSets(times, gapS)
 *
 * Twin set (the robustness rule): the main twin, up to RULES.twins.max sets of model.samples (bootstrap and jackknife) at the extremes of
 * tm, kv, the load scale and te, the tm-scan winner (tm × factor) when the validation check tmBand fails (Fireball: tm × 1.4), and tm ×
 * RULES.twins.noCurrent when the logs have no battery current (critique C13: then the logs do not give the authority). The samples share
 * one ESC soft start: for the spool-up and the BAILOUT two more sets scale the ramp rates by the p5 and p95 of the single-start fits of
 * ass. A problem is found with the main twin and the log; a change is a recommendation only if its constraints hold for every twin of the
 * set and, for every twin, the paired bootstrap of its effect on the test flights (10-s ACTIVE blocks, or the events of an event scenario:
 * the same blocks or events for the value at this time and the candidate; one unit for each spool-up) gives a mean of more than
 * RULES.scnAccept.se standard errors with RULES.scnAccept.minUnits units or more. The candidates are selected on the training flights only
 * (model.split). The interval of an effect is the range of mean ± 2 SE over the twin set. A change of values that the acceptance tests
 * together (the spool-up time with the PID spool-up, the FALLBACK precomp with the drop of a PID profile) is one group of recommendations
 * (advice.cjs group: all or none).
 *
 * Battery levels (scenarios E and F): a level is a rest voltage. The twin OCV in flight is the level less the rest offset vp, and it
 * stays at that value for the whole flight (kappa 0): each point of the voltage curve is the flights flown at one battery voltage. E is
 * the lowest end-of-flight rest voltage of the training flights (else 3.70 V/cell; the selection), A the lowest of all flights (the
 * effect on the test flights), F 4.20 V/cell. Without a recorded voltage the battery numbers are not available.
 *
 * Headspeed: the reserve rule uses the steady duty of the twin for the load of each 0.1-s block of ACTIVE flight (the censored demand above
 * the maximum throttle comes from the load model: critique C11). A candidate keeps the thrust: at H = r·Hf the collective moves to coll/r²
 * (the thrust is in proportion to the headspeed squared and to the blade pitch: the pivot is the zero collective, not the c0 of the torque
 * law) and the cyclic and the yaw to 1/r², in the range that the flights use. The headspeed with the same collective is in the evidence
 * (with the thrust part r²). One recommendation decreases the headspeed by RULES.scnPower.maxChange at most, to a value that is different
 * from the headspeed of each other PID profile by one step or more (CLAUDE.md "PID profiles": govRequest identifies the PID profile).
 *
 * Saturation: a period at the maximum throttle that starts in SPOOLUP, RECOVERY or BAILOUT, or with the headspeed under half of the
 * request, is ESC acceleration (critique C9), not power. The log and the twin use the same definitions (stats()). The twin under-predicts
 * the deepest saturation of the Fireball log 11 (0.42 V of load that the model does not explain): the power rows add the part of the log
 * that the twin does not give at the recorded voltage (time at the maximum, droop, the 95 % throttle) to the twin numbers at E.
 */

const GT = require('./gov_twin.cjs');
const GD = require('./gov_data.cjs');
const GP = require('./gov_params.cjs');
const GS = require('./gov_sim.cjs');
const GTU = require('./gov_tune.cjs');
const HG = require('./health_gov.cjs'); // check G21: the time at the maximum for "no sudden change" (DEFAULT_RULES.G21.minOkS)

// Thresholds. id: the rule number in the texts and in the CLI file; source in the words of the pilot. The keys with an id are added to
// gov_tune RULES (toRecommendation reads the rule of a row there).
const RULES = {
    // the robustness rule of every change (GOVERNOR_AUTOTUNE.md section 7): se standard errors of the paired bootstrap (boot resamples)
    // of 10-s ACTIVE blocks or of events, minUnits blocks or events at least
    // (minUnits 3: a bootstrap of 2 units has 3 different means only)
    scnAccept: { id: 'GC1', se: 2, blockS: 10, boot: 1000, minUnits: 3, seed: 20261015, source: 'toolkit rule, no flight test',
        text: 'Each model of the set must agree with a change, and the test flights must show an effect of more than 2 standard errors.' },
    // noCurrent: the tm factors of the set without battery current (critique C13)
    twins: { max: 6, order: ['tm', 'kv', 'load', 'te'], noCurrent: [0.7, 1.4] },
    // reserve: the throttle reserve at the q quantile of the load (models_and_guidance 7.2: 15-25 %); qs: the quantiles of the report;
    // blockS: the load blocks; sampleHz: the decimation of the load samples; fullCell, endCell: V/cell of F and of E without a recorded end;
    // curveCell: the other points of the voltage curve; settleS, minRestS: the rest voltage after the motor stops; lowShare: a saturation
    // period that starts under this part of the request is ESC acceleration (gov_tune RULES.saturation.lowShare); near: saturated within
    // this of the maximum (gov_sim satEps); windowS, worst: droop95; range, step: the headspeed search (part of Hf, rpm); maxChange: the
    // largest decrease of the headspeed in one recommendation (the model extrapolates the load: fly, then do the analysis again);
    // minSatS: a change needs this time (s) at the maximum throttle (load, not ESC acceleration) in ACTIVE flight of the logs of the PID
    // profile, else the candidate is a check with opt-in CLI text (the reserve rule alone is a design margin, not a measured problem); periods:
    // the evidence shows the longest periods of check GT7 of the PID profile (log and frame seconds);
    // glitch, fallbackS: the FALLBACK limit of the RPM signal is glitch x gov_headspeed (flight_governor.c:576, 588, 1596): a candidate
    // headspeed whose limit is not more than the largest |hs - PT2(hs, gov_rpm_filter)| of the logged ACTIVE flight (not within fallbackS
    // of a logged FALLBACK) gives FALLBACK at a recorded change of the headspeed signal (critique M15)
    scnPower: { id: 'GC2', reserve: 0.15, q: 0.95, qs: [0.5, 0.95, 0.99], blockS: 0.1, sampleHz: 100, fullCell: 4.2, endCell: 3.7, curveCell: [3.6, 3.8, 4.0],
        settleS: 0.5, minRestS: 0.1, lowShare: 0.5, near: 0.005, windowS: 1, worst: 0.05, range: [0.6, 1.3], step: 10, maxChange: 0.1, minSatS: 0.25, periods: 5, glitch: 0.25, fallbackS: 1,
        source: 'Rotorflight documentation, a throttle reserve of 15 % to 25 %',
        text: 'At the end of the battery, the throttle must be 85 % or less for 95 % of the load of the flights.' },
    // overshoot: % after SPOOLUP (gov_tune RULES.spool, check G16); step, min, max: the search (0.1 s); offS: the switch off at the start;
    // afterS: the time after the end of the spool-up; groundS: the load after the SPOOLUP exit of a recorded spool-up (critique M17); synthHz:
    // the frame rate of the synthetic runs (the governor steps at the PID rate)
    // trustTol: the error of the twin overshoot without test spool-ups (% points: gov_fit RULES.events.overshoot)
    scnSpool: { id: 'GC3', overshoot: 2, step: 10, min: 10, max: 400, offS: 0.5, afterS: 8, groundS: 3, synthHz: 250, trustTol: 2, source: 'toolkit rule, no flight test',
        text: 'After SPOOLUP, the headspeed must be more than the target by 2 % or less, at the start and at the end of the battery.' },
    // from: the headspeed range of the target ramp (part of Hf); points: the grid; windowS: the saturated time after an event
    scnTracking: { id: 'GC4', from: 0.8, points: 11, windowS: 3, source: 'toolkit rule, no flight test',
        text: 'The headspeed target must not increase faster than the motor can increase the headspeed with less than the maximum throttle.' },
    // minDrop: the smallest drop (%): the pilot must know about the error and land (Rotorflight documentation); drops, recovery: the other
    // values of the search; random: seeded ACTIVE times for each flight; gapS: the smallest time between two errors in one simulation;
    // mergeS: errors closer than this are one; satInS: the error after the start of a saturation period (the logged FALLBACK entries came
    // 0.15-0.26 s after it, critique V3); eventS: the window of an event; entryS: FALLBACK must start in this time; sag: the 90 % line;
    // over: the largest overshoot after RECOVERY (else the overshoot of the value at this time)
    // preS, points: the plot of the error with the largest loss (s before the error, the largest number of points)
    scnFallback: { id: 'GC5', minDrop: 5, drops: [5, 15, 20], recovery: [10, 30], random: 3, gapS: 8, mergeS: 1, satInS: 0.2, eventS: 5, entryS: 0.01, sag: 0.9, over: 0.02, preS: 0.5, points: 1500,
        source: 'Rotorflight documentation ("gov_fallback_drop": the pilot must know about the error) and a toolkit rule',
        text: 'After an RPM signal error, the FALLBACK and RECOVERY values must give the smallest headspeed decrease. The throttle decrease in FALLBACK must stay at 5 % or more.' },
    // the gov_max_throttle values of the test (the CLI value: the last one); the twin set runs the CLI value, the main twin all. A PID
    // profile gets the test with a FALLBACK at the maximum throttle, or with minShare of ACTIVE flight at the maximum throttle and sudden
    // changes of the headspeed signal there (check G21, gov_tune RULES.glitch). When check G21 of the analysis gives a change for the PID
    // profile (gov_tune g21Change: the maximum - health_gov DEFAULT_RULES.G21.margin), the model also flies that value with the twin set,
    // and the row gives its cost as evidence: a check with no CLI text of its own (the CLI text is the one of check G21)
    scnTrial: { id: 'GC6', values: [95, 98], minShare: 0.005, source: 'toolkit rule, no flight test',
        text: 'A lower maximum throttle is a test for the RPM signal errors at 100 % throttle, not a change for all flights.' },
    // mixerPerStick: the mixer collective at the end of the collective stick when the log has no rcCommand[3] (mixer[3] = 2.083 rcCommand[3]
    // in the Fireball and Gaui logs of 2026-10: the collective rate of these logs), else the median ratio of the samples with |stick| >= minStick; points: the curve points over the stick from -100 % to 100 % (flight_governor.c:415-427)
    scnBypass: { id: 'GC7', mixerPerStick: 1.042, minStick: 0.2, points: 9, source: 'firmware 4.6.0 and the logs of 2026-10',
        text: 'The BYPASS curve gives the throttle that holds the headspeed at each collective stick position, at the middle of the battery.' },
    scnVcomp: { id: 'GC8', cellV: 3.7, gain: [0.8, 1.2], source: 'firmware 4.6.0',
        text: 'Voltage compensation keeps the loop gain of the governor constant when the battery voltage decreases. It operates only with the voltage source ADC.' },
    // share: the BAILOUT starts with the rotor at this part of the target when the logs have no BAILOUT from a slow rotor (else their
    // median, at least minShare: the governor needs 5 % for the RPM signal, flight_governor.c:594); the motor is off for softOffS of gov_twin
    // first (the ESC soft start); afterS: after the end of BAILOUT (gov_tune RULES.bailout.afterS); runS: the RUN time after the switch;
    // holdS: ACTIVE before the switch to the middle position; auto: the middle position of the throttle switch (FUNCTION)
    // turn: the rotor speed (part of the target) of a RECOVERY after HOLD and of a BAILOUT from a turning rotor (gov_recovery_time); over,
    // satS: a different gov_recovery_time can increase the overshoot (% points) and the time at the maximum throttle (s) of these cases and
    // of the BAILOUTs from a slow rotor by this much at most
    scnBailout: { id: 'GC9', share: 0.2, minShare: 0.06, afterS: 6, runS: 12, holdS: 3, auto: 0.5, turn: 0.9, over: 1, satS: 0.5, source: 'toolkit rule, no flight test',
        text: 'The governor model shows the time at the maximum throttle and the overshoot after a BAILOUT from a slow rotor.' },
};
for (const [k, v] of Object.entries(RULES)) if (v && v.id && !GTU.RULES[k]) GTU.RULES[k] = v;

const MINE = ['power', 'spoolup', 'tracking', 'fallback', 'maxThrottle', 'bypass'];
const NOW = 'the values at this time';   // a part of a sentence (TEXT.fallback.tried)
const FL = GD.PHASES.indexOf('flight');

// ---------------------------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------------------------

const isNum = (v) => typeof v === 'number' && isFinite(v);
const r3 = (v, d = 3) => isNum(v) ? +v.toFixed(d) : null;
const fmt = (v, d = 1) => isNum(v) ? String(+v.toFixed(d)) : 'unknown';
const pct = (x, d = 1) => isNum(x) ? fmt(100 * x, d) : 'unknown';
const N = (l) => l + 1;
const prof = (p) => p > 0 ? `PID profile ${p}` : 'PID profile unknown';
const and = (l) => l.length < 2 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l[l.length - 1]}`;
const logWords = (logs) => { const u = [...new Set(logs)].sort((a, b) => a - b); return u.length === 1 ? `log ${N(u[0])}` : u.length > 4 ? `${u.length} logs (log ${N(u[0])} to log ${N(u[u.length - 1])})` : `logs ${and(u.map(N).map(String))}`; };
const many = (n, one, more) => `${n} ${n === 1 ? one : more || one + 's'}`;
const quote = (s) => `"${String(s).replace(/"/g, "'")}"`;
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
function quantile(a, q) { const v = Array.from(a).filter(x => !isNaN(x)); if (!v.length) return null; v.sort((x, y) => x - y); const x = q * (v.length - 1), i = Math.floor(x); return i + 1 < v.length ? v[i] + (x - i) * (v[i + 1] - v[i]) : v[i]; }
const median = (a) => quantile(a, 0.5);
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
const range = (a) => { const v = a.filter(isNum); return v.length ? [Math.min(...v), Math.max(...v)] : [null, null]; };
const num = (v) => v === null || v === undefined || v === '' ? null : isNum(Number(v)) ? Number(v) : null;

// ---------------------------------------------------------------------------------------------
// twin model
// ---------------------------------------------------------------------------------------------

// The required duty at rotor speed H, the gov_twin steady state in closed form (GT.steady): d·ocv − H/kv = (1 + beta·d²)·sL. A, X, Y: the
// means of |coll − c0|^pc, cyclic and |yaw| over a load block (blocksOf gives the inputs of the same thrust at another headspeed). Without
// voltage, ocv is the constant V0. Infinity: no duty meets the load.
function dReq(p, H, A, X, Y, ocv) {
    const n = H / p.Href, L = p.qc * A + p.qx * X + p.qy * Y;
    const sL = n * n * (p.q0 + L) + p.qf * n + (H > 0 ? p.qs : 0), e = H / p.kv, V = p.voltage && ocv > 0 ? ocv : p.V0, a = (p.voltage ? p.beta : 0) * sL;
    if (!(a > 1e-12)) return (e + sL) / V;
    const disc = V * V - 4 * a * (e + sL);
    return disc >= 0 ? (V - Math.sqrt(disc)) / (2 * a) : Infinity;
}
// the slip voltage at duty d (the motor and the battery of gov_twin)
const slipAt = (p, d, ocv, H) => { const V = p.voltage && ocv > 0 ? ocv : p.V0; return (d * V - H / p.kv) / (1 + (p.voltage ? p.beta : 0) * d * d); };
// the load blocks of a twin: the means of |coll − c0|^pc, cyclic, |yaw| (and of the logged throttle and voltage) over k samples. r: the
// inputs for the same thrust at r × the headspeed of the flights (collective coll/r²: the thrust pivot is the zero blade pitch, c0 is the
// collective of the smallest torque; cyclic and yaw /r²), in the range that the flights use (lim: { lo, hi } collective, cyc, yaw: the
// pilot cannot give more collective than the collective range)
function blocksOf(tw, S, r = 1, lim = null) {
    const k = S.k, m = Math.floor(S.coll.length / k), A = new Float64Array(m), X = new Float64Array(m), Y = new Float64Array(m), U = new Float64Array(m), V = new Float64Array(m), g = 1 / (r * r), sc = r !== 1 && lim;
    for (let b = 0; b < m; b++) {
        let a = 0, x = 0, y = 0, u = 0, v = 0;
        for (let j = b * k; j < b * k + k; j++) {
            const cc = sc ? Math.min(lim.hi, Math.max(lim.lo, S.coll[j] * g)) : S.coll[j], c = Math.abs(cc - tw.c0);
            a += c > 0 ? Math.exp(tw.pc * Math.log(c)) : 0; x += sc ? Math.min(lim.cyc, S.cyc[j] * g) : S.cyc[j]; y += sc ? Math.min(lim.yaw, Math.abs(S.yaw[j]) * g) : Math.abs(S.yaw[j]);
            u += S.u[j]; v += S.vbat ? S.vbat[j] : 0;
        }
        A[b] = a / k; X[b] = x / k; Y[b] = y / k; U[b] = u / k; V[b] = v / k;
    }
    return { m, A, X, Y, U, V: S.vbat ? V : null };
}
const demand = (tw, B, H, ocv) => { const d = new Float64Array(B.m); for (let b = 0; b < B.m; b++) d[b] = dReq(tw, H, B.A[b], B.X[b], B.Y[b], ocv); return d; };
const ocvOf = (tw, rest) => tw.voltage && rest > 0 ? rest - (tw.vp > 0 ? tw.vp : 0) : null;
// the highest headspeed (range × Hf, step rpm) whose q quantile of the required duty is <= 1 − reserve − extra. lim: the inputs keep the
// thrust in the collective range (blocksOf); null: the same inputs. A scan from the top (the demand need not be monotonic in H)
function maxHs(tw, S, Hf, ocv, extra = 0, lim = null) {
    const P = RULES.scnPower, top = 1 - P.reserve - extra, ok = (H) => quantile(demand(tw, lim ? blocksOf(tw, S, H / Hf, lim) : blocksOf(tw, S), H, ocv), P.q) <= top, c = 5 * P.step;
    for (let H = Math.floor(P.range[1] * Hf / c) * c; H >= P.range[0] * Hf; H -= c) if (ok(H)) { for (let h = H + c - P.step; h > H; h -= P.step) if (ok(h)) return h; return H; }
    return null;
}

// the battery current of the model (gov_fit has, else the twin parameters)
const hasCurrent = (model) => model && model.has ? !!model.has.current : !!(model && model.params && model.params.current);
// The twin set (see the header). ref: the median load { coll, cyc, yaw } for the load scale. factor: a tm twin (scan: the tm-scan winner,
// noCurrent: no battery current)
function twinSet(model, validation, ref = {}) {
    const main = GT.copy(model.params), out = [{ key: 'main', label: 'main model', p: main }];
    const S = (model.samples || []).map(s => GT.copy(main, s)), f = { tm: s => s.tm, kv: s => s.kv, te: s => s.te, load: s => GT.load(s, s.Href, ref.coll || 0, ref.cyc || 0, ref.yaw || 0) };
    const picks = [];
    if (S.length) for (const k of RULES.twins.order) { let lo = 0, hi = 0; S.forEach((s, i) => { if (f[k](s) < f[k](S[lo])) lo = i; if (f[k](s) > f[k](S[hi])) hi = i; }); picks.push([lo, `${k} low`], [hi, `${k} high`]); }
    const seen = new Set();
    for (const [i, label] of picks) if (!seen.has(i) && seen.size < RULES.twins.max) { seen.add(i); out.push({ key: `s${i}`, label, p: S[i] }); }
    const tb = validation && (validation.checks || []).find(c => c.rule === 'tmBand');
    let scan = null;
    if (tb && tb.pass === false) {
        const b = (validation.tmScan || []).filter(x => isNum(x.band)).reduce((a, x) => !a || x.band < a.band ? x : a, null);
        if (b) { scan = b.factor; out.push({ key: `tm${b.factor}`, label: `tm × ${b.factor}`, p: GT.copy(main, { tm: main.tm * b.factor }), factor: b.factor, scan: true }); }
    }
    if (!hasCurrent(model)) for (const f of RULES.twins.noCurrent) if (f !== scan) out.push({ key: `tm${f}`, label: `tm × ${f}`, p: GT.copy(main, { tm: main.tm * f }), factor: f, noCurrent: true });
    return out;
}
// the soft-start sets: a slower and a faster ESC start ramp. The single-start fits give the spread of ass (p5, p95); the ramp rates (ass,
// as1, asr) scale by p5/ass and p95/ass together (the parameters of one start trade off: their p5 together is not a start of the logs)
function softSet(model) {
    const u = model.uncertainty || {}, m = model.params, q = u.ass || {}, out = [];
    for (const [key, label, v] of [['softSlow', 'slow ESC start ramp', q.p5], ['softFast', 'fast ESC start ramp', q.p95]]) {
        const f = isNum(v) && m.ass > 0 ? v / m.ass : 1;
        if (Math.abs(f - 1) > 0.01) out.push({ key, label, factor: r3(f, 3), p: GT.copy(m, { ass: m.ass * f, as1: m.as1 * f, asr: m.asr * f }) });
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------------------------

// paired bootstrap of the effects d (> 0: the candidate is better): mean, se, lo/hi (mean ± se rule), pass
function bootstrap(d, seed) {
    const A = RULES.scnAccept, n = d.length, m = mean(d);
    if (n < A.minUnits) return { n, mean: m, se: null, lo: null, hi: null, pass: false };
    const rand = rng(seed || A.seed), B = A.boot, ms = new Float64Array(B);
    for (let b = 0; b < B; b++) { let s = 0; for (let k = 0; k < n; k++) s += d[Math.floor(rand() * n)]; ms[b] = s / n; }
    const mb = ms.reduce((s, x) => s + x, 0) / B, se = Math.sqrt(ms.reduce((s, x) => s + (x - mb) ** 2, 0) / (B - 1));
    return { n, mean: m, se, lo: m - A.se * se, hi: m + A.se * se, pass: m > 0 && m > A.se * se };
}
// the robustness rule over the twin set: each twin's bootstrap; pass when all pass; the interval over the set
function acceptOf(list) {
    const ok = list.filter(x => x.boot), lo = range(ok.map(x => x.boot.lo))[0], hi = range(ok.map(x => x.boot.hi))[1], main = ok.find(x => x.key === 'main');
    return { pass: ok.length > 0 && ok.length === list.length && ok.every(x => x.boot.pass), mean: main ? main.boot.mean : null, lo, hi, n: main ? main.boot.n : 0, twins: list.map(x => ({ key: x.key, label: x.label, n: x.boot ? x.boot.n : 0, mean: x.boot ? r3(x.boot.mean, 4) : null, se: x.boot ? r3(x.boot.se, 4) : null, pass: !!(x.boot && x.boot.pass) })) };
}

// ---------------------------------------------------------------------------------------------
// traces
// ---------------------------------------------------------------------------------------------

// the PID profile of each sample (the configuration: cfg.start and cfg.changes, as gov_sim)
function profOf(run, cfg) {
    const out = new Uint8Array(run.n); let cur = cfg.start || 0, j = 0; const ch = cfg.changes || [];
    for (let i = 0; i < run.n; i++) { while (j < ch.length && ch[j].k <= i) cur = ch[j++].profile; out[i] = cur; }
    return out;
}
// ACTIVE flight: the governor in ACTIVE, the recorded flight phase, no rescue
const inFlight = (run, tr, i) => tr.state[i] === 4 && (!run.phase || run.phase[i] === FL) && !(run.rescue && run.rescue[i]);
// the samples at the maximum throttle of the ESC acceleration: a period that starts in SPOOLUP, RECOVERY or BAILOUT, or under lowShare of the request
function accelMask(tr, mx, req) {
    const n = tr.u.length, out = new Uint8Array(n), P = RULES.scnPower;
    for (let i = 0; i < n;) {
        if (!(tr.u[i] >= mx(tr.profile[i]) - P.near && tr.u[i] > 0.05)) { i++; continue; }
        let j = i; while (j < n && tr.u[j] >= mx(tr.profile[j]) - P.near) j++;
        const q = req(tr.profile[i]);
        if ([2, 3, 8].includes(tr.state[i]) || (q > 0 && tr.hs[i] < P.lowShare * q)) out.fill(1, i, j);
        i = j;
    }
    return out;
}
// per PID profile in ACTIVE flight: n, sat (not ESC acceleration), e2, the 1-s window droops, and (o.blocks) the 10-s blocks [p, i0, i1] from
// o.from. tr: a gov_sim trace (every sample) or the log itself (u, hs, state, profile). o: { mx(p), req(p), from, blocks }
function stats(run, tr, o) {
    const n = tr.u.length, P = RULES.scnPower, W = Math.max(1, Math.round(P.windowS * run.rate)), Bn = Math.round(RULES.scnAccept.blockS * run.rate), acc = accelMask(tr, o.mx, o.req), out = {};
    for (let i = 0; i < n; i++) {
        if (!inFlight(run, tr, i)) continue;
        const p = tr.profile[i], A = out[p] || (out[p] = { n: 0, sat: 0, e2: 0, wins: [], wn: 0, wmax: 0, last: -2, blocks: [], bn: 0, b0: 0 }), q = o.req(p);
        const e = q > 0 ? (tr.hs[i] - q) / q : 0, sat = !acc[i] && tr.u[i] >= o.mx(p) - P.near;
        A.n++; A.e2 += e * e; if (sat) A.sat++;
        if (i !== A.last + 1) { A.wn = 0; A.wmax = 0; }
        A.last = i; A.wn++; if (-e > A.wmax) A.wmax = -e;
        if (A.wn === W) { A.wins.push(A.wmax); A.wn = 0; A.wmax = 0; }
        if (o.blocks && i >= (o.from || 0)) { if (!A.bn) A.b0 = i; if (++A.bn >= Bn) { A.blocks.push([+p, A.b0, i + 1]); A.bn = 0; } }
    }
    for (const A of Object.values(out)) delete A.last;
    return { profiles: out, acc };
}
// the part of a block of profile p (the ACTIVE flight samples of [i0, i1)) with the throttle above top(p): the reserve line (the rule of the
// power rows) or the maximum throttle; not the ESC acceleration (acc)
function blockSat(run, tr, acc, b, top) {
    let m = 0, s = 0; const [p, i0, i1] = b, lim = top(p);
    for (let i = i0; i < i1; i++) if (tr.profile[i] === p && inFlight(run, tr, i)) { m++; if (!acc[i] && tr.u[i] > lim) s++; }
    return m ? s / m : 0;
}
const reserveLine = (E) => (p) => (1 - RULES.scnPower.reserve) * E.mx(p);
// the pooled numbers of a list of stats: { [p]: { seconds, share, droop95, eRms } }
function pool(list, rate) {
    const out = {};
    for (const s of list) for (const [p, A] of Object.entries(s.profiles)) {
        const o = out[p] || (out[p] = { n: 0, sat: 0, e2: 0, wins: [] }); o.n += A.n; o.sat += A.sat; o.e2 += A.e2; o.wins.push(...A.wins);
    }
    const W = RULES.scnPower.worst;
    for (const o of Object.values(out)) {
        const w = o.wins.sort((a, b) => b - a), m = Math.max(1, Math.ceil(W * w.length));
        Object.assign(o, { seconds: r3(o.n / rate, 1), share: o.n ? o.sat / o.n : null, droop95: w.length ? w.slice(0, m).reduce((s, x) => s + x, 0) / m : null, eRms: o.n ? Math.sqrt(o.e2 / o.n) : null });
        delete o.wins; delete o.e2;
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// context
// ---------------------------------------------------------------------------------------------

const TEXT = {
    noModel: 'The governor model is not available. Thus, the analysis cannot calculate this value.',
    rejected: 'The governor model does not agree with the test flights ("rejected"). Thus, the analysis does not use it for recommendations.',
    noFlight: 'The governor model cannot use the flight logs. Thus, the analysis cannot calculate this value.',
    noProfile: (p) => `The governor model has no flight of ${prof(p)} that it can use. Thus, the analysis cannot calculate this value.`,
    noVoltage: 'The log does not record the battery voltage. Thus, the analysis cannot calculate the effect of the battery voltage.',
    excluded: (logs) => `The governor model cannot use ${logWords(logs)}.`,
    tm: (f) => `The test flights do not show the rotor time constant of the model. Thus, the set of models also has ${f} times this time constant.`,
    tmCurrent: (fs) => `The log does not record the battery current ("Ibat"). Thus, the set of models also has ${and(fs.map(String))} times the rotor time constant.`,
    set: (k) => `The ranges are for a set of ${k} governor models that agree with the flights.`,
    selection: (logs) => `The analysis selects the values on the flights that are not test flights (${logWords(logs)}).`,
    accept: (x, unit, d, what = 'part') => `On the test flights, the effect is ${fmt(x.mean, d)} ${unit} (${fmt(x.lo, d)} to ${fmt(x.hi, d)}, ${many(x.n, what)} of the flights).`,
    acceptNo: 'The test flights do not show an effect of more than 2 standard errors for each model. Thus, the analysis does not recommend a change.',
    acceptNoData: 'The test flights do not have sufficient data for this change. Thus, the analysis does not recommend a change.',
    power: {
        title: (p) => `Small throttle reserve at the end of the battery (${prof(p)})`,
        atMaxTitle: (p) => `Throttle at its maximum (${prof(p)})`,
        q95: (V, H, x, lo, hi) => `${isNum(V) ? `At ${fmt(V, 2)} V` : 'At the recorded battery voltage'}, the necessary throttle is ${pct(x, 1)} % or less for 95 % of the load at ${H} rpm (${pct(lo, 1)} % to ${pct(hi, 1)} %).`,
        extra: (x) => `At the recorded battery voltage, the log has ${pct(x, 1)} % more throttle than the model, and the analysis adds this value.`,
        reserve: (x) => `This gives a reserve of ${pct(x, 1)} %, and the minimum is ${pct(RULES.scnPower.reserve, 0)} %.`,
        max: (H, lo, hi) => `With the same thrust, the largest headspeed with this reserve is ${H} rpm (${lo} to ${hi} rpm).`,
        noMax: 'No lower headspeed gives this reserve with the same thrust.',
        noMaxWhy: 'At a lower headspeed, the collective must increase, and the load at a high collective increases.',
        step: (H) => `The analysis recommends ${H} rpm, a decrease of ${pct(RULES.scnPower.maxChange, 0)} % or less at one time. Then fly and do the analysis again.`,
        stepEv: (H) => `The analysis recommends a decrease of ${pct(RULES.scnPower.maxChange, 0)} % or less at one time: ${H} rpm.`,
        sat: (V, s, d) => `At ${fmt(V, 2)} V for the full flight, the throttle is at its maximum for ${pct(s, 2)} % of the time. The headspeed decreases by ${pct(d, 1)} %.`,
        satNote: 'The headspeed decrease is the mean of the worst 5 % of the time in ACTIVE flight.',
        satModel: (V, s) => `With the model at ${fmt(V, 2)} V for the full flight, the throttle is at its maximum for ${pct(s, 2)} % of the time in ACTIVE flight.`,
        q50: (a, b) => `At the end of the battery, the necessary throttle is ${pct(a, 1)} % (the median) and ${pct(b, 1)} % or less for 99 % of the load.`,
        full: (a) => `At the start of the battery, the necessary throttle is ${pct(a, 1)} % or less for 95 % of the load.`,
        unique: (h, p, to) => `${prof(p)} has the headspeed ${h} rpm. The app uses the headspeed to find the PID profile in the log. Thus, the analysis recommends ${isNum(to) ? `${to} rpm` : 'no lower headspeed'}.`,
        logQ: (a, b) => `At the recorded battery voltage, the log has a throttle of ${pct(a, 1)} % or less for 95 % of the time. The model gives ${pct(b, 1)} %.`,
        logSat: (m, t) => `At the recorded battery voltage, the log has ${pct(m, 2)} % of the time at the maximum throttle, and the model gives ${pct(t, 2)} %.`,
        logMore: 'The model gives less time at the maximum throttle than the log. Thus, the analysis adds the difference to the values of the model.',
        thrust: 'At a lower headspeed, the model increases the collective, the cyclic and the yaw to keep the same thrust. The collective stays in the range of the flights.',
        same: (H, k) => `With the same collective, ${H} rpm gives the reserve. But then each collective position gives only ${pct(k, 0)} % of the thrust.`,
        cand: (H, s0, s1) => `At ${H} rpm, the time with the throttle more than ${pct(1 - RULES.scnPower.reserve, 0)} % changes from ${pct(s0, 1)} % to ${pct(s1, 1)} % (the test flights, the end of the battery).`,
        ok: 'The reserve is sufficient for 95 % of the load.',
        higher: (H) => `With the same thrust, the reserve stays sufficient to ${H} rpm.`,
        power: 'A larger governor gain cannot give more power.',
        // the user (2026-10-15): a headspeed change is the decision of the pilot, never selected by default
        choice: 'The headspeed is the decision of the pilot. Thus, the app does not select this change. If you accept a lower headspeed, select the change.',
        choiceNote: 'The headspeed is the decision of the pilot. Thus, the app does not select this change.',
        noSat: (s) => `In the logs, the throttle is at its maximum for ${fmt(s, 2)} s in ACTIVE flight of this PID profile. Thus, this is a check and not a change.`,
        // the measured time that makes the result a change (RULES.scnPower.minSatS), and its periods (check GT7; review 2026-10-15)
        yesSat: (s) => `In the logs, the throttle is at its maximum for ${fmt(s, 2)} s in ACTIVE flight of this PID profile. For a recommendation, this time must be ${RULES.scnPower.minSatS} s or more.`,
        satPeriod: (q) => `Log ${N(q.log)} at ${fmt(q.t, 2)} s: the throttle is at its maximum for ${fmt(q.s, 2)} s in ACTIVE flight, with the load as the cause.`,
        glitch: (H, lim, mx) => `At ${H} rpm, the FALLBACK limit of the RPM signal is ${lim} rpm. In the logs, the headspeed signal is different from its filtered value by a maximum of ${mx} rpm.`,
        glitchNo: 'At this headspeed, the FALLBACK limit is less than a change of the headspeed signal in the logs. Thus, the analysis does not recommend this headspeed.',
        noData: (p) => `The flights that are not test flights have no ACTIVE flight in ${prof(p)}.`,
    },
    curve: (V, s) => `At ${fmt(V, 2)} V for the full flight, the throttle is at its maximum for ${pct(s, 2)} % of the time.`,
    vcomp: {
        gain: (v0, v1, g) => `From ${fmt(v0, 2)} V to ${fmt(v1, 2)} V, the loop gain of the governor decreases by ${pct(g, 1)} %.`,
        ff: (f) => `The F-term is for the voltage at the start, and at the end of the battery it is less than necessary by ${pct(f, 1)} %.`,
        drift: (a, b, n) => `For the voltage decrease of each flight, the model gives a throttle increase of ${fmt(a, 1)} points at the same load. The log gives ${fmt(b, 1)} points (${many(n, 'log')}).`,
        driftModel: (a, v0, v1) => `At the median load, the throttle increases by ${fmt(a, 1)} points from ${fmt(v0, 2)} V to ${fmt(v1, 2)} V.`,
        esc: 'With the voltage source ESC, the governor does not use voltage compensation.',
        iterm: 'The governor I-term compensates for the slow change of the throttle.',
        adcIf: (a, b) => `If the voltage source is ADC, voltage compensation ON changes the headspeed error of the model from ${fmt(a, 2)} % to ${fmt(b, 2)} %.`,
        adc: (a, b) => `Voltage compensation ON changes the headspeed error of the model from ${fmt(a, 2)} % to ${fmt(b, 2)} %.`,
        droop: (c, d) => `On the test flights, the largest headspeed decrease changes from ${fmt(c, 1)} % to ${fmt(d, 1)} % (the worst 5 % of the time).`,
        unknown: 'The voltage source is unknown. Thus, there is no CLI text.',
        pwr: 'This filter has an effect only with voltage compensation. The default value is correct for most helicopters.',
        pwrDefault: (v) => `The log does not show "gov_pwr_filter". The model uses the default value ${v}.`,
    },
    spool: {
        title: 'Headspeed overshoot after SPOOLUP (the model)',
        cur: (v, os, lo, hi) => `With "gov_spoolup_time" ${v}, the model gives an overshoot of ${fmt(os, 1)} % after SPOOLUP (${fmt(lo, 1)} % to ${fmt(hi, 1)} %).`,
        levels: 'The model starts the spool-up with the rotor stopped and the ground load of the flights, at the start and the end of the battery.',
        log: (m, lo, hi, n) => `The log gives ${fmt(m, 1)} % (${many(n, 'spool-up')}, ${fmt(lo, 1)} % to ${fmt(hi, 1)} %).`,
        trust: (list) => `On the test flights, the model gives ${and(list.map(x => `${fmt(x.closed, 1)} %`))}, and the log gives ${and(list.map(x => `${fmt(x.logOs, 1)} %`))}.`,
        cause: 'The start ramp of the ESC limits the rotor acceleration, and thus the throttle is too high at the end of SPOOLUP.',
        min: (v) => `The smallest value with an overshoot of ${RULES.scnSpool.overshoot} % or less for each model is ${v}.`,
        pid: (v) => `With "gov_use_pid_spoolup" ON, the smallest value is ${v}.`,
        pidNow: (v) => `With "gov_use_pid_spoolup" ON, the value ${v} gives an overshoot of ${RULES.scnSpool.overshoot} % or less for each model.`,
        none: (max) => `No value to ${max} gives an overshoot of ${RULES.scnSpool.overshoot} % or less for each model.`,
        esc: 'If the ESC has a value for its start ramp, a faster start ramp also decreases the overshoot.',
        airborne: 'Some spool-ups continue into the air. The analysis uses them because the logs have no other spool-ups.',
        keepPid: (on) => `The value is ${on}, and it sets the overshoot together with the spool-up time.`,
        unknownPid: (d) => `The log does not record this value. The model uses ${d}, the default value of the firmware.`,
        needPid: (v, a) => `With "gov_spoolup_time" ${v}, "gov_use_pid_spoolup" must be ON in each PID profile. ${isNum(a) ? `With OFF, the smallest value is ${a}.` : `With OFF, no value to ${RULES.scnSpool.max} is sufficient.`}`,
        unitEv: (q) => `Test spool-up of log ${N(q.log)} at ${fmt(q.t, 1)} s, ${isNum(q.rest) ? `${fmt(q.rest, 2)} V` : 'the recorded battery voltage'}: the overshoot of the model changes from ${fmt(q.base, 1)} % to ${fmt(q.cand, 1)} %.`,
        few: (n) => `The test flights have only ${many(n, 'spool-up')} for this test, and the minimum is ${RULES.scnAccept.minUnits}. Thus, the app does not select this change.`,
        otherLoad: 'This PID profile has no spool-up on the ground in the logs, and the model uses the load of the other spool-ups.',
        caseEv: (p, v, os) => `Overshoot of the model, ${prof(p)}, ${isNum(v) ? `${fmt(v, 2)} V` : 'the recorded battery voltage'}: ${fmt(os, 1)} %.`,
        setEv: 'Largest overshoot of the model, with the range for the set of models.',
        trustEv: (x) => `Test flight, log ${N(x.log)}: the log gives an overshoot of ${fmt(x.logOs, 1)} %, and the model gives ${fmt(x.closed, 1)} %.`,
        noSpool: 'The flight logs have no spool-up.',
        startup: (u0, v, t) => `The ESC starts the motor at a throttle of ${pct(u0, 1)} % (the model). With "gov_startup_time" ${v}, this occurs ${fmt(t, 2)} s after the start of IDLE.`,
        spooldown: (v, u, t) => `With "gov_spooldown_time" ${v}, the throttle decreases from ${pct(u, 1)} % to 0 in ${fmt(t, 1)} s.`,
        keep: 'The flight logs show no problem with this value.',
        withinTol: (x) => `The difference to the limit is in the error of the model on the test spool-ups (${fmt(x, 1)} % points), and the logs show no problem.`,
    },
    tracking: {
        acc: (a, V) => `${isNum(V) ? `At the median load and ${fmt(V, 2)} V` : 'At the median load'}, the motor can increase the headspeed at ${fmt(a, 0)} rpm/s with less than the maximum throttle.`,
        accEv: (p, a) => `In ${prof(p)}, the motor can increase the headspeed at ${fmt(a, 0)} rpm/s with less than the maximum throttle (the median load, the end of the battery).`,
        slope: (v, s) => `With "gov_tracking_time" ${v}, the target increases at ${fmt(s, 0)} rpm/s after a PID profile change, RECOVERY and BAILOUT.`,
        slopeEv: (p, s) => `In ${prof(p)}, the target increases at ${fmt(s, 0)} rpm/s.`,
        min: (v, lo, hi) => `The smallest value that keeps the target slope at or less than this acceleration is ${v} (${lo} to ${hi}).`,
        limit: (p, H) => `${prof(p)} (${H} rpm) sets this value.`,
        noneP: (p) => `In ${prof(p)}, the motor cannot increase the headspeed with less than the maximum throttle (the end of the battery, the median load).`,
        ok: 'Thus, the value at this time is sufficient.',
    },
    fallback: {
        times: (n, k, m) => `The model adds an RPM signal error at ${many(n, 'time')} in the flights. Of these, ${k} are at the maximum throttle or at a FALLBACK of the log, and ${m} are at other times in ACTIVE.`,
        base: (m, n) => `With the values at this time, the headspeed decreases to ${pct(m, 1)} % of the target after an RPM signal error (the mean of ${many(n, 'error')}).`,
        // the errors of one PID profile (the drop and the precomp of a PID profile change only its errors)
        baseP: (m, n, p) => `With the values at this time, the headspeed decreases to ${pct(m, 1)} % of the target after an RPM signal error in ${prof(p)} (the mean of ${many(n, 'error')}).`,
        alt: (w, m) => `With ${w}, it decreases to ${pct(m, 1)} %.`,
        cueNone: (p) => `In ${prof(p)}, the model has no RPM signal error at the maximum throttle.`,
        few: (p, n) => `The test flights have only ${many(n, 'RPM signal error')} in ${prof(p)}, and the minimum is ${RULES.scnAccept.minUnits}. Thus, the app does not select this change.`,
        all: 'The analysis selects one value for all PID profiles on the errors of all PID profiles.',
        total: (a, b) => `In the 5 s after the error, the total headspeed decrease changes from ${fmt(a, 1)} % s to ${fmt(b, 1)} % s.`,
        under: (a, b) => `The time with the headspeed at less than 90 % of the target changes from ${fmt(a, 2)} s to ${fmt(b, 2)} s.`,
        tried: (w, x) => `Selection flights, all PID profiles, ${w}: the total headspeed decrease is ${fmt(x.loss, 1)} % s. The lowest headspeed is ${pct(x.min, 1)} % (${many(x.n, 'error')}).`,
        recovery: 'RECOVERY starts at a throttle that the governor calculates from the headspeed and the motor constant. "gov_use_fallback_precomp" changes only the 0.2 s of FALLBACK.',
        drop: `The throttle decrease in FALLBACK tells the pilot that the RPM signal has an error. The analysis keeps the decrease of each error at ${RULES.scnFallback.minDrop} % or more.`,
        cue: (a, b, n) => `At the ${many(n, 'error')} at the maximum throttle, the smallest throttle decrease in FALLBACK changes from ${pct(a, 1)} % to ${pct(b, 1)} %.`,
        cueNo: () => `With "gov_use_fallback_precomp" ON, the throttle decrease in FALLBACK is less than ${RULES.scnFallback.minDrop} % at some errors at the maximum throttle.`,
        rate: 'This value also sets the rate of the throttle increase in RECOVERY, BAILOUT, AUTOROTATION and BYPASS.',
        recCase: (v, o, t) => `With "gov_recovery_time" ${v}, the overshoot after a RECOVERY or a BAILOUT increases by ${fmt(o, 1)} % points or less. The time at the maximum throttle increases by ${fmt(t, 2)} s or less.`,
        recNo: (v) => `With "gov_recovery_time" ${v}, the overshoot or the time at the maximum throttle after a RECOVERY or a BAILOUT increases too much. Thus, the analysis does not use this value.`,
        cons: (l) => `With the model "${l}", the throttle decrease in FALLBACK or the result after a BAILOUT is not satisfactory. Thus, the analysis does not recommend a change.`,
        cause: 'These values change only the effect of an RPM signal error. To remove the cause, examine the RPM sensor, its wire and its supply.',
        none: 'The flight logs have no time in ACTIVE flight for an RPM signal error.',
        noEvent: (p) => `The model has no RPM signal error in ACTIVE flight of ${prof(p)}.`,
        same: 'No other value gives a smaller headspeed decrease.',
        // a value that the rows do not know (review 2026-10-15: the model used the default value with no text)
        assumed: (name, v, src) => src === 'default value' ? `The log does not record "${name}". The model uses ${v}, the default value of the firmware.`
            : `The value of "${name}" at this time is unknown. The model uses ${v}${src && src !== 'unknown' ? ` (the source is ${quote(src)})` : ''}.`,
        noProblem: 'The flight logs have no RPM signal error. Thus, the analysis does not recommend a change.',
    },
    trial: {
        title: (p) => `Test of "gov_max_throttle" for the RPM signal errors (${prof(p)})`,
        do: (v) => `To find if the RPM signal errors occur only at 100 % throttle, fly one battery with "gov_max_throttle" ${v}.`,
        cost: (v, a, b, cur) => `At the end of the battery, the model gives ${pct(a, 2)} % of the time at the maximum throttle with ${v} %, and ${pct(b, 2)} % with ${cur} %.`,
        droop: (v, a, b) => `The headspeed decreases by ${pct(a, 1)} % with ${v} % and by ${pct(b, 1)} % at this time (the worst 5 % of the time).`,
        exit: 'The governor also uses 95 % of "gov_max_throttle" as the end of SPOOLUP, RECOVERY and BAILOUT.',
        none: 'The flight logs of this PID profile have no RPM signal error at the maximum throttle. Thus, the test is not necessary.',
        keep: 'Keep 100 % for the power.',
        atMax: (n, t) => `The logs have ${many(n, 'period')} at the maximum throttle in this PID profile (${fmt(t, 2)} s). The row of check GT7 shows each period.`,
        // check G21 of the analysis gives the change (its CLI text): this row gives the cost of its value in the model
        g21Title: (p, v) => `"gov_max_throttle" ${v} of check G21: the effect in the model (${prof(p)})`,
        g21NoModel: 'The model did not fly this value. Thus, this row does not show its effect.',
        g21: (v, q) => `Check G21 of the analysis gives "gov_max_throttle" ${v} with its CLI text. In the logs, ${fmt(q && q.k, 0)} of ${fmt(q && q.N, 0)} sudden changes of the headspeed signal occur at the maximum throttle (\`p = ${q && isNum(q.p) ? q.p : 'unknown'}\`).`,
        // the cost of the value of check G21 for the recommendation of check G21 (js/tuning_dialog.js shows it there): a, b the droop
        // (the worst 5 % of the time) with v and at this time
        g21Cost: (v, a, b) => `In the governor model, a maximum of ${v} % ${a > b + 5e-4 ? 'increases' : a < b - 5e-4 ? 'decreases' : 'does not change'} the headspeed decrease`
            + (Math.abs(a - b) <= 5e-4 ? ` (${pct(b, 1)} %, the worst 5 % of the time).` : ` from ${pct(b, 1)} % to ${pct(a, 1)} % (the worst 5 % of the time).`),
        // check G21 (health_gov g21Pool minOkS, review 2026-10-15): no sudden change in less than minOkS at the maximum is not measured
        short: (s, min) => `The logs have only ${fmt(s, 2)} s at the maximum throttle in this PID profile, and a minimum of ${min} s is necessary.`
            + ' Thus, the logs cannot show that the RPM signal has no errors at the maximum throttle.',
        noTime: 'The logs have no time at the maximum throttle in this PID profile. Thus, the logs cannot show that the RPM signal has no errors at the maximum throttle.',
        some: (k, n) => `In the flight logs of this PID profile, ${fmt(k, 0)} of ${fmt(n, 0)} sudden changes of the headspeed signal occur at the maximum throttle. Check G21 does not give a change for this PID profile.`,
    },
    bypass: {
        title: 'Throttle curve for BYPASS (the model)',
        curve: (H, p, V) => `The curve gives the throttle that holds ${H} rpm (${prof(p)}) at each collective stick position${isNum(V) ? `, at a battery voltage of ${fmt(V, 2)} V` : ''}.`,
        use: 'The governor uses this curve only in BYPASS, which has no headspeed control.',
        stick: (k) => `The log does not record the collective stick. Thus, the curve uses a mixer collective of ${fmt(k, 3)} at the end of the stick.`,
        stickLog: (k) => `In the logs, the mixer collective is ${fmt(k, 3)} at the end of the collective stick. The curve uses this value.`,
        rate: 'A different collective rate changes the correct curve.',
        point: (c, v, lo, hi) => `At ${fmt(100 * c, 0)} % collective stick, the throttle is ${fmt(v / 2, 1)} % (${fmt(lo / 2, 1)} % to ${fmt(hi / 2, 1)} %).`,
        high: (k) => `At ${many(k, 'point')}, the load is more than the power of the motor, and the curve uses 100 %.`,
    },
    bailout: {
        title: 'BAILOUT from a slow rotor (the model)',
        model: (s, H) => `The model flies a BAILOUT that starts with the rotor at ${pct(s, 0)} % of the target (${H} rpm), with the ESC start ramp of the model.`,
        res: (t, lo, hi, o) => `The throttle is at its maximum for ${fmt(t, 2)} s (${fmt(lo, 2)} s to ${fmt(hi, 2)} s). ${o > 0 ? `Then the headspeed is more than the target by ${fmt(o, 1)} %.` : `The headspeed stays less than the target for ${RULES.scnBailout.afterS} s after BAILOUT.`}`,
        log: (l, t, o, a, b) => `In log ${N(l)} at ${fmt(t, 1)} s, the log gives ${fmt(a, 2)} s and ${fmt(b, 1)} %, and the model gives ${fmt(o.satS, 2)} s and ${fmt(o.overshoot, 1)} %.`,
        noExit: (k, n) => `For ${k} of ${n} models and battery voltages, the governor does not go to ACTIVE in the time of the model.`,
        none: 'In the model, the rotor stops before the switch goes back to the top position. Thus, the governor does not go to BAILOUT.',
        do: 'To stop the motor on the ground, set the throttle switch to the low position. If "gov_autorotation_timeout" is 0, the governor does not use AUTOROTATION and BAILOUT.',
    },
};

// ---------------------------------------------------------------------------------------------
// evaluate
// ---------------------------------------------------------------------------------------------

const FULL = { points: 1e9 };
const flatCache = new WeakMap();
const flat = (tw) => { if (!flatCache.has(tw)) flatCache.set(tw, GT.copy(tw, { kappa: 0 })); return flatCache.get(tw); };

// the samples of profile p (ACTIVE flight, the logged state; part 'train' or 'test') at sampleHz: { coll, cyc, yaw, u, vbat, k }
function samplesOf(E, p, part) {
    const P = RULES.scnPower, c = [], x = [], y = [], u = [], v = [];
    for (const run of E.used) {
        const st = run.state, pr = E.prof.get(run), tf = E.testFrom.get(run), step = Math.max(1, Math.round(run.rate / P.sampleHz));
        if (!st) continue;
        const i0 = part === 'test' ? tf : 0, i1 = part === 'test' ? run.n : tf;
        for (let i = i0; i < i1; i += step) if (pr[i] === p && st[i] === 4 && (!run.phase || run.phase[i] === FL) && !(run.rescue && run.rescue[i])) {
            c.push(run.coll[i]); x.push(Math.hypot(run.roll[i], run.pitch[i])); y.push(run.yaw[i]); u.push(run.u ? run.u[i] : 0); v.push(run.vbat ? run.vbat[i] : 0);
        }
    }
    return { coll: c, cyc: x, yaw: y, u, vbat: E.voltage ? v : null, k: Math.max(1, Math.round(P.blockS * P.sampleHz)), n: c.length };
}
// the rest voltage after the motor stops (the median from settleS after the last running sample to the end), or null
function endRest(run) {
    const P = RULES.scnPower, u = run.u, v = run.vbat; if (!u || !v) return null;
    let L = run.n - 1; while (L >= 0 && !(u[L] > 0.02)) L--;
    const a = Math.round(L + P.settleS * run.rate), vals = []; for (let i = Math.max(0, a); i < run.n; i++) if (v[i] > 0) vals.push(v[i]);
    return L >= 0 && vals.length >= P.minRestS * run.rate ? median(vals) : null;
}
// the first sample of the test part: a test log 0; else the last testShare of the motor-running samples (gov_fit split)
function testFromOf(run, split) {
    if (split && split.mode === 'logs') return (split.testLogs || []).includes(run.log) ? 0 : run.n;
    const share = split && isNum(split.testShare) ? split.testShare : 0.4, u = run.u; let tot = 0; for (let i = 0; i < run.n; i++) if (u[i] > 0.02) tot++;
    let c = 0; for (let i = 0; i < run.n; i++) if (u[i] > 0.02 && ++c >= (1 - share) * tot) return i;
    return run.n;
}

async function evaluate(runs, o = {}) {
    const t0 = Date.now(), progress = o.progress || (() => {}), model = o.model, val = o.validation || null;
    const S = { reason: null, notes: [], timing: {}, profiles: [] };
    if (!model || !model.params) { S.reason = TEXT.noModel; return S; }
    if (val && val.status === 'rejected') { S.reason = TEXT.rejected; return S; }
    runs = (runs || []).filter(Boolean);
    const rec = o.recovered || GP.recover(runs, { cli: o.cli || null }), configs = o.configs || GS.configOf(runs, rec, { cli: o.cli || null });
    const base = o.base || GTU.tune(runs, { recovered: rec, cli: o.cli || null }), M = base.measures;
    const flights = runs.filter(r => r.class === 'flight'), cfgOf = (run) => run.synthCfg || configs[GS.keyOf(run)];
    const used = flights.filter(r => { const c = cfgOf(r); return c && !c.excluded && r.hs && r.thr && r.coll && r.roll && r.pitch && r.yaw && r.u && r.state && !(r.segment > 0); });
    const excluded = flights.filter(r => !used.includes(r)).map(r => r.log);
    if (excluded.length) S.notes.push(TEXT.excluded(excluded));
    if (!used.length) { S.reason = TEXT.noFlight; return S; }
    const stale = used.filter(r => (cfgOf(r).flags || []).length).map(r => r.log);
    S.mainParams = model.params;
    // the spool-up events of the validation (the twin against the log on the test flights: gov_fit events)
    S.validationSpool = val && val.events ? (val.events.spoolups || []).filter(e => e.overshoot && isNum(e.overshoot.closed) && isNum(e.overshoot.log)).map(e => ({ log: e.log, atS: e.atS, t: isNum(e.t) ? e.t : null, closed: r3(e.overshoot.closed, 2), logOs: r3(e.overshoot.log, 2) })) : [];
    const E = { runs, used, model, val, rec, configs, base, M, cfgOf, S, progress, stale, voltage: !!model.params.voltage };
    E.prof = new Map(used.map(r => [r, profOf(r, cfgOf(r))]));
    E.testFrom = new Map(used.map(r => [r, testFromOf(r, model.split)]));
    E.train = used.filter(r => E.testFrom.get(r) > 0); E.test = used.filter(r => E.testFrom.get(r) < r.n);
    // the values at this time (gov_tune currentValues), else the configuration of the last log with the value
    const cur = (name, p) => { const R = GTU.REG[name], c = R ? base.current.byName[name] && base.current.byName[name][R.scope === 'global' ? 0 : p] : base.current.related[name]; return c && c.value !== null && c.value !== undefined ? c.value : null; };
    const cfgVal = (name, p) => { for (let j = used.length - 1; j >= 0; j--) { const c = cfgOf(used[j]).cli, v = p ? c.profiles[p] && c.profiles[p][name] : c.global[name]; if (v !== undefined && v !== null) return v; } return null; };
    E.value = (name, p) => { const v = cur(name, p); return v !== null ? v : cfgVal(name, p); };
    // the source of the value that E.value takes from a configuration (gov_sim: 'CLI dump', 'log header', 'default value', ...), null when the
    // rows have the value or no configuration has it
    E.cfgSource = (name, p) => { if (cur(name, p) !== null) return null;
        for (let j = used.length - 1; j >= 0; j--) { const c = cfgOf(used[j]), cc = c.cli || {}, v = p ? (cc.profiles || {})[p] && cc.profiles[p][name] : (cc.global || {})[name];
            if (v !== undefined && v !== null) return (p ? (c.profileSources || {})[p] && c.profileSources[p][name] : (c.sources || {})[name]) || 'unknown'; }
        return null; };
    E.cur = cur;   // the value of the rows (null: unknown, no CLI text)
    // the PID profiles: base.profiles with a configuration
    E.P = {};
    for (const p of base.profiles) {
        let cfg = null; for (let j = used.length - 1; j >= 0 && !cfg; j--) if (cfgOf(used[j]).profiles[p]) cfg = cfgOf(used[j]);
        if (!(p > 0) || !cfg) continue;
        const Hf = num(E.value('gov_headspeed', p)) || num(cfg.cli.profiles[p].gov_headspeed), mx = num(E.value('gov_max_throttle', p)) || num(cfg.cli.profiles[p].gov_max_throttle) || 100;
        const thr = []; for (const run of used) { const pr = E.prof.get(run); for (let i = 0; i < run.n; i += 50) if (pr[i] === p && run.state[i] === 4) thr.push(run.thr[i]); }
        E.P[p] = { p, Hf, maxThr: mx / 100, cfg, stick: thr.length ? median(thr) : 1, train: samplesOf(E, p, 'train'), test: samplesOf(E, p, 'test') };
    }
    S.profiles = Object.keys(E.P).map(Number);
    if (!S.profiles.length) { S.reason = TEXT.noFlight; return S; }
    E.mx = (p) => E.P[p] ? E.P[p].maxThr : 1; E.req = (p) => E.P[p] ? E.P[p].Hf : 0;
    // the load reference of the twin set (the medians of the training samples) and the twin sets
    const all = Object.values(E.P).map(x => x.train), cat = (k) => [].concat(...all.map(s => s[k]));
    E.ref = { coll: median(cat('coll')) || 0, cyc: median(cat('cyc')) || 0, yaw: median(cat('yaw').map(Math.abs)) || 0 };
    const cq = (a, q) => quantile(a, q) || 0;
    E.lim = { lo: cq(cat('coll'), 0.001), hi: cq(cat('coll'), 0.999), cyc: cq(cat('cyc'), 0.999), yaw: cq(cat('yaw').map(Math.abs), 0.999) };
    S.lim = { lo: r3(E.lim.lo, 3), hi: r3(E.lim.hi, 3), cyc: r3(E.lim.cyc, 3), yaw: r3(E.lim.yaw, 3) };
    E.twins = twinSet(model, val, E.ref); E.soft = softSet(model);
    S.twins = E.twins.map(t => ({ key: t.key, label: t.label, factor: t.factor || null, scan: !!t.scan, noCurrent: !!t.noCurrent, kv: r3(t.p.kv, 2), tm: r3(t.p.tm, 4), te: r3(t.p.te, 4), load: r3(GT.load(t.p, t.p.Href, E.ref.coll, E.ref.cyc, E.ref.yaw), 3) }));
    S.soft = E.soft.map(t => ({ key: t.key, label: t.label, factor: t.factor, ass: r3(t.p.ass, 1), as1: r3(t.p.as1, 1), asr: r3(t.p.asr, 4) }));
    // the battery levels (rest voltages)
    if (E.voltage) {
        const cellsRow = base.rows.find(r => r.name === 'battery_cell_count'), rest0 = used.map(r => r.vbat ? r.vbat[0] : null).filter(isNum);
        const cells = cellsRow && cellsRow.cells > 0 ? cellsRow.cells : rest0.length ? Math.max(1, Math.round(Math.max(...rest0) / 4.1)) : null;
        // E of the training flights (the selection), A of all flights (the effect on the test flights; a test flight does not select a value)
        const ends = used.map(r => ({ log: r.log, v: endRest(r), train: E.testFrom.get(r) > 0 })).filter(x => isNum(x.v)), low = (a) => a.reduce((m, x) => !m || x.v < m.v ? x : m, null);
        const worst = low(ends.filter(x => x.train)), worstA = low(ends);
        if (cells) {
            const P = RULES.scnPower, full = P.fullCell * cells, end = worst ? worst.v : P.endCell * cells, endAll = worstA ? Math.min(end, worstA.v) : end;
            E.ocv = { cells, full, end, endAll, mid: (full + end) / 2, endLog: worst ? worst.log : null, endAllLog: worstA && worstA.v < end ? worstA.log : null, endSource: worst ? 'log' : 'rule' };
            E.levels = [{ key: 'F', rest: full }, { key: 'E', rest: end }];
        }
    }
    if (!E.ocv) { E.ocv = null; E.levels = [{ key: 'R', rest: null }]; if (!E.voltage) S.notes.push(TEXT.noVoltage); }
    S.ocv = E.ocv && Object.assign({}, E.ocv, { full: r3(E.ocv.full, 2), end: r3(E.ocv.end, 2), endAll: r3(E.ocv.endAll, 2), mid: r3(E.ocv.mid, 2) });
    // the level of the effect on the test flights: A when it is lower than E, else E (R without a recorded voltage)
    E.acc = E.ocv && E.ocv.endAll < E.ocv.end - 1e-3 ? { key: 'A', rest: E.ocv.endAll } : E.levels.find(l => l.key === 'E') || E.levels[0];
    S.stale = stale; S.split = model.split || null; S.train = E.train.map(r => r.log); S.test = E.test.map(r => r.log);
    const steps = [['power', power], ['trial', trial], ['spool', spool], ['tracking', tracking], ['fallback', fallback], ['bypass', bypass], ['vcomp', vcomp], ['bailout', bailout]];
    for (let j = 0; j < steps.length; j++) {
        const [k, f] = steps[j], t = Date.now();
        if (o.steps && !o.steps.includes(k)) continue;
        progress(j / steps.length, k);
        S[k] = await f(E);
        S.timing[k] = (Date.now() - t) / 1000;
    }
    progress(1, 'done');
    S.timing.totalS = (Date.now() - t0) / 1000;
    return S;
}

// a closed-loop run of the twin (every sample recorded when full)
const sim = (E, run, tw, sc, full = true) => GS.run(run, E.cfgOf(run), { plant: 'twin', twin: tw, scenario: sc || {}, record: full ? FULL : false });
const logTrace = (E, run) => ({ u: run.u, hs: run.hs, state: run.state, profile: E.prof.get(run) });

// ---- power: the headspeed and the battery voltage ----
async function power(E) {
    const P = RULES.scnPower, out = { profiles: {}, curve: [], levels: E.levels.map(l => ({ key: l.key, rest: r3(l.rest, 2) })) };
    const o = { mx: E.mx, req: E.req };
    // the log and the twin at the recorded voltage (main twin, FALLBACK forced as in the log)
    const logS = [], twR = [];
    for (const run of E.used) {
        logS.push(stats(run, logTrace(E, run), o));
        const res = await sim(E, run, E.twins[0].p, {}); if (res.trace) twR.push(stats(run, res.trace, o));
    }
    const rate = E.used[0].rate, logP = pool(logS, rate), twinR = pool(twR, rate);
    // E and F for the twin set, at a constant battery voltage, no RPM signal error. The test blocks of the level E.acc for the paired bootstrap
    // (A: the test flights only)
    const lv = {}, blocks = {}, accLv = E.acc;
    for (const l of E.levels.concat(accLv.key === 'A' ? [accLv] : [])) for (const t of E.twins) {
        const list = [];
        for (const run of E.used) {
            const isTest = E.testFrom.get(run) < run.n; if (l.key === 'A' && !isTest) continue;
            const res = await sim(E, run, flat(t.p), { ocv: l.rest || undefined, forceFallback: [] });
            if (!res.trace) continue;
            const s = stats(run, res.trace, Object.assign({ blocks: isTest && l.key === accLv.key, from: E.testFrom.get(run) }, o));
            list.push(s);
            if (isTest && l.key === accLv.key) for (const A of Object.values(s.profiles)) for (const b of A.blocks) (blocks[t.key] || (blocks[t.key] = [])).push({ run, b, base: blockSat(run, res.trace, s.acc, b, reserveLine(E)) });
        }
        if (l.key !== 'A') (lv[l.key] || (lv[l.key] = {}))[t.key] = pool(list, rate);
    }
    // the voltage curve (main twin)
    if (E.ocv) {
        const pts = P.curveCell.map(c => c * E.ocv.cells).filter(v => v > E.ocv.end + 0.05 && v < E.ocv.full - 0.05).map(v => ({ key: 'C', rest: v })).concat(E.levels);
        for (const l of pts.sort((a, b) => a.rest - b.rest)) {
            let pl = l.key === 'C' ? null : lv[l.key].main;
            if (!pl) { const list = []; for (const run of E.used) { const res = await sim(E, run, flat(E.twins[0].p), { ocv: l.rest, forceFallback: [] }); if (res.trace) list.push(stats(run, res.trace, o)); } pl = pool(list, rate); }
            out.curve.push({ rest: r3(l.rest, 2), perCell: r3(l.rest / E.ocv.cells, 3), key: l.key, profiles: Object.fromEntries(Object.entries(pl).map(([p, x]) => [p, { share: r3(x.share, 5), droop95: r3(x.droop95, 4) }])) });
        }
    }
    const lvE = E.ocv ? 'E' : 'R', lvF = E.ocv ? 'F' : 'R', restE = E.ocv ? E.ocv.end : null, restF = E.ocv ? E.ocv.full : null, jump = signalJump(E);
    // the headspeed of each PID profile (1-6: the values at this time, then the candidates): a candidate is different from the others by a step
    const taken = new Map(); for (let q = 1; q <= 6; q++) { const h = num(E.value('gov_headspeed', q)); if (isNum(h)) taken.set(q, [h]); }
    const clash = (p, h) => { for (const [q, hs] of taken) if (q !== p && hs.some(v => Math.abs(v - h) < P.step)) return q; return null; };
    for (const p of E.S.profiles) {
        const I = E.P[p], Hf = I.Hf, x = { Hf, maxThr: I.maxThr };
        out.profiles[p] = x;
        if (!I.train.n) { x.reason = TEXT.power.noData(p); continue; }
        // the required throttle (the censored demand uses the load model: critique C11)
        const per = E.twins.map(t => {
            const B = blocksOf(t.p, I.train), dE = demand(t.p, B, Hf, ocvOf(t.p, restE)), dF = demand(t.p, B, Hf, ocvOf(t.p, restF));
            // the twin at the recorded voltage: the d·V law at the loaded voltage of each block, against the log
            let dR = null; if (B.V) { dR = new Float64Array(B.m); for (let b = 0; b < B.m; b++) dR[b] = dReq(GT.copy(t.p, { beta: 0 }), Hf, B.A[b], B.X[b], B.Y[b], B.V[b]); }
            return { key: t.key, B, qE: P.qs.map(q => quantile(dE, q)), qF: P.qs.map(q => quantile(dF, q)), q95R: dR ? quantile(dR, P.q) : null };
        });
        const main = per[0], q95Log = quantile(blocksOf(E.twins[0].p, I.train).U, P.q);
        // the log at the recorded voltage against the twin: a larger log quantile adds to the reserve (the larger number)
        const extra = isNum(main.q95R) && isNum(q95Log) ? Math.max(0, q95Log - main.q95R) : 0;
        Object.assign(x, { qE: main.qE.map(v => r3(v, 4)), qF: main.qF.map(v => r3(v, 4)), q95E: range(per.map(t => t.qE[1])), q95R: r3(main.q95R, 4), q95Log: r3(q95Log, 4), extra: r3(extra, 4),
            reserveE: r3(1 - main.qE[1], 4), reserveSet: range(per.map(t => 1 - t.qE[1])), blocks: main.B.m });
        const ocE = (t) => ocvOf(t.p, restE);
        x.hmax = E.twins.map(t => maxHs(t.p, I.train, Hf, ocE(t), extra, E.lim));
        x.hmaxSame = E.twins.map(t => maxHs(t.p, I.train, Hf, ocE(t), extra, null));
        x.hmaxMain = x.hmax[0]; x.hmaxSet = x.hmax.every(isNum) ? range(x.hmax) : [null, range(x.hmax)[1]]; x.sameSet = x.hmaxSame.every(isNum) ? range(x.hmaxSame) : [null, range(x.hmaxSame)[1]];
        x.thrust = isNum(x.sameSet[0]) ? r3((x.sameSet[0] / Hf) ** 2, 3) : null;
        // closed loop: the log, the twin at the recorded voltage, E and F (set)
        const sE = E.twins.map(t => lv[lvE][t.key][p] || {}), sF = E.twins.map(t => lv[lvF][t.key][p] || {});
        Object.assign(x, { log: logP[p] ? { share: r3(logP[p].share, 5), droop95: r3(logP[p].droop95, 4), seconds: logP[p].seconds } : null, twinR: twinR[p] ? { share: r3(twinR[p].share, 5), droop95: r3(twinR[p].droop95, 4) } : null,
            E: { share: r3(sE[0].share, 5), droop95: r3(sE[0].droop95, 4), shareSet: range(sE.map(s => s.share)), droopSet: range(sE.map(s => s.droop95)) },
            F: { share: r3(sF[0].share, 5), droop95: r3(sF[0].droop95, 4), shareSet: range(sF.map(s => s.share)), droopSet: range(sF.map(s => s.droop95)) } });
        x.logMore = !!(x.log && x.twinR && x.log.share > x.twinR.share);
        // the larger of the twin and the log: the part of the log that the twin does not give at the recorded voltage is added to E
        const dS = x.log && x.twinR ? Math.max(0, x.log.share - x.twinR.share) : 0, dD = x.log && x.twinR && isNum(x.log.droop95) && isNum(x.twinR.droop95) ? Math.max(0, x.log.droop95 - x.twinR.droop95) : 0;
        x.Eadj = { share: r3((x.E.share || 0) + dS, 5), droop95: r3((x.E.droop95 || 0) + dD, 4) };
        // the candidate: the lowest largest headspeed of the set, if it is less than Hf, by maxChange at most
        x.reserveAdj = r3(1 - main.qE[1] - extra, 4);
        x.fails = 1 - main.qE[1] - extra < P.reserve;   // the problem: the main twin and the log; a change must then hold for each twin
        const cap = Math.ceil((1 - P.maxChange) * Hf / P.step) * P.step, h0 = isNum(x.hmaxSet[0]) ? Math.max(x.hmaxSet[0], cap) : null;
        x.logSatS = x.log && isNum(x.log.share) ? r3(x.log.share * x.log.seconds, 3) : 0;
        // a headspeed of another PID profile: the next step, first in the direction of more reserve (down) when the reserve sets the
        // candidate, else up; in [cap, Hf)
        let hc = h0;
        const q0 = x.fails && isNum(h0) ? clash(p, h0) : null;
        if (q0 !== null) {
            hc = null;
            for (const d of h0 > x.hmaxSet[0] ? [1, -1] : [-1, 1]) { for (let v = h0 + d * P.step; v >= cap && v < Hf; v += d * P.step) if (clash(p, v) === null) { hc = v; break; } if (hc !== null) break; }
            x.unique = { from: h0, profile: q0, to: hc };
        }
        if (x.fails && isNum(hc) && hc < Hf) {
            x.candidate = hc; x.limited = hc > x.hmaxSet[0]; taken.set(p, (taken.get(p) || []).concat([hc]));
            if (isNum(jump[p])) x.glitch = { maxRpm: Math.round(jump[p]), limitRpm: Math.round(P.glitch * hc), ok: jump[p] < P.glitch * hc };
            const res = [];
            for (const t of E.twins) {
                const bl = (blocks[t.key] || []).filter(q => q.b[0] === p), d = [], c0 = [], c1 = [];
                const byRun = new Map(); for (const q of bl) { if (!byRun.has(q.run)) byRun.set(q.run, []); byRun.get(q.run).push(q); }
                for (const [run, list] of byRun) {
                    const scaled = scaleRun(run, E.prof.get(run), p, hc / Hf, E.lim);
                    const r = await GS.run(scaled, E.cfgOf(run), { plant: 'twin', twin: flat(t.p), scenario: { ocv: accLv.rest || undefined, forceFallback: [], values: { profiles: { [p]: { gov_headspeed: hc } } } }, record: FULL });
                    if (!r.trace) continue;
                    const acc = accelMask(r.trace, E.mx, (q) => q === p ? hc : E.req(q));
                    for (const q of list) { const v = blockSat(run, r.trace, acc, q.b, reserveLine(E)); d.push(q.base - v); c0.push(q.base); c1.push(v); }
                }
                res.push({ key: t.key, label: t.label, boot: d.length ? bootstrap(d.map(v => 100 * v)) : bootstrap([]), base: mean(c0), cand: mean(c1) });
            }
            x.accept = acceptOf(res); x.accept.base = r3(res[0].base, 5); x.accept.cand = r3(res[0].cand, 5); x.accept.rest = r3(accLv.rest, 2);
        }
    }
    return out;
}
// the largest |hs - PT2(hs, gov_rpm_filter)| of each PID profile in the logged ACTIVE flight, not within fallbackS of a logged FALLBACK (the
// recorded headspeed: the raw RPM signal of the governor is possibly larger; gov_search RULES.filters)
function signalJump(E) {
    const P = RULES.scnPower, fc = num(E.value('gov_rpm_filter', 0)) || GTU.REG.gov_rpm_filter.default, out = {};
    for (const run of E.used) {
        const f = GP.pt2(run.hs, fc, run.pidHz, run.loopsPerFrame || 1), pr = E.prof.get(run), st = run.state, F = Math.round(P.fallbackS * run.rate), near = new Uint8Array(run.n);
        for (let k = 0; k < run.n; k++) if (st[k] === 6) near.fill(1, Math.max(0, k - F), Math.min(run.n, k + F));
        for (let k = 0; k < run.n; k++) if (st[k] === 4 && !near[k] && (!run.phase || run.phase[k] === FL)) { const d = Math.abs(run.hs[k] - f[k]); if (!(out[pr[k]] >= d)) out[pr[k]] = d; }
    }
    return out;
}
// a copy of a run with the inputs of profile p for the same thrust at r = H/Hf (blocksOf: the collective coll/r²), in the collective range lim
function scaleRun(run, pr, p, r, lim) {
    const k = 1 / (r * r), out = Object.assign({}, run), cap = (v, m) => Math.max(-m, Math.min(m, v)), cy = Float32Array.from(run.roll), cp = Float32Array.from(run.pitch), cc = Float32Array.from(run.coll), cw = Float32Array.from(run.yaw);
    for (let i = 0; i < run.n; i++) if (pr[i] === p) {
        cc[i] = Math.min(lim.hi, Math.max(lim.lo, cc[i] * k));
        const x = Math.hypot(cy[i], cp[i]), g = x > 0 ? Math.min(x * k, lim.cyc) / x : 0; cy[i] *= g; cp[i] *= g; cw[i] = cap(cw[i] * k, lim.yaw);
    }
    return Object.assign(out, { coll: cc, roll: cy, pitch: cp, yaw: cw });
}

// ---- the maximum throttle test (the RPM signal errors at 100 %: critique C14, M15) ----
async function trial(E) {
    // the values of the test, and the values of the changes of check G21 (each with the twin set)
    const g21 = [...new Set((E.S && E.S.profiles || []).map(p => GTU.g21Change(E.M.glitch, p, E.mx(p))).filter(Boolean).map(c => c.to))].filter(v => v >= 10 && v <= 100);
    const vals = [...new Set(RULES.scnTrial.values.concat(g21))].sort((a, b) => a - b), full = new Set([RULES.scnTrial.values[RULES.scnTrial.values.length - 1]].concat(g21));
    const out = { values: vals, g21, profiles: {} };
    const lvl = E.ocv ? E.ocv.end : undefined, rate = E.used[0].rate;
    for (const v of vals) {
        const twins = full.has(v) ? E.twins : E.twins.slice(0, 1);
        for (const t of twins) {
            const list = [], mx = (p) => Math.min(E.mx(p), v / 100);
            for (const run of E.used) { const res = await sim(E, run, flat(t.p), { ocv: lvl, forceFallback: [], values: { all: { gov_max_throttle: v } } }); if (res.trace) list.push(stats(run, res.trace, { mx, req: E.req })); }
            for (const [p, x] of Object.entries(pool(list, rate))) { const q = ((out.profiles[p] || (out.profiles[p] = {}))[v] || (out.profiles[p][v] = { set: [] })); if (t.key === 'main') Object.assign(q, { share: r3(x.share, 5), droop95: r3(x.droop95, 4) }); q.set.push({ key: t.key, share: x.share, droop95: x.droop95 }); }
        }
    }
    for (const P of Object.values(out.profiles)) for (const q of Object.values(P)) { q.shareSet = range(q.set.map(s => s.share)); q.droopSet = range(q.set.map(s => s.droop95)); delete q.set; }
    return out;
}

// ---- scenario S: the spool-up from a stopped motor ----
// a synthetic run: stick(t), a constant load, the rest voltage vrest, PID profile p, armed from the start
function synth(E, p, T, stick, load, vrest) {
    const ref = E.used[0], pidHz = ref.pidHz, rate = pidHz / Math.max(1, Math.round(pidHz / RULES.scnSpool.synthHz)), n = Math.round(T * rate), c = { time: new Float64Array(n) };
    for (const k of ['hs', 'motor[0]', 'rcCommand[4]', 'mixer[0]', 'mixer[1]', 'mixer[2]', 'mixer[3]', 'Vbat', 'profileAt', 'flightModeFlags']) c[k] = new Float32Array(n);
    const v = vrest > 0 ? vrest : ref.vbat ? ref.vbat[0] : 25;
    for (let i = 0; i < n; i++) {
        const t = i / rate; c.time[i] = t; c['rcCommand[4]'][i] = 1000 * stick(t); c['mixer[0]'][i] = 1000 * (load.cyc || 0); c['mixer[2]'][i] = 1000 * (load.yaw || 0);
        c['mixer[3]'][i] = 1000 * (load.coll || 0); c.Vbat[i] = 100 * v; c.profileAt[i] = p; c.flightModeFlags[i] = 1;
    }
    const run = GD.fromColumns(c, { log: -1, n, rate, actualRate: rate, timeStartUs: 20e6, header: Object.assign({}, ref.header) }, { class: 'flight', flights: [] });
    run.synthCfg = Object.assign({}, E.P[p].cfg, { start: p, changes: [], excluded: null });
    return run;
}
// the overshoot (% of the request) of a spool-up from a stopped motor, or Infinity when SPOOLUP does not end in ACTIVE
async function spoolOS(E, tw, p, load, vrest, values) {
    const SP = RULES.scnSpool, st = num(values.global.gov_startup_time) || num(E.value('gov_startup_time', 0)) || 200, sp = num(values.global.gov_spoolup_time);
    const T = SP.offS + 0.1 * st * 0.4 + 0.1 * sp + SP.afterS + 2, stick = E.P[p].stick, run = synth(E, p, T, (t) => t < SP.offS ? 0 : stick, load, vrest);
    const res = await GS.run(run, run.synthCfg, { plant: 'twin', twin: tw, scenario: { ocv: E.voltage && vrest > 0 ? vrest : undefined, values }, record: false });
    const m = res.metrics && res.metrics.profiles[p];
    return m && isNum(m.spoolOvershoot) ? m.spoolOvershoot : Infinity;
}
// the ground load after the SPOOLUP exit of a recorded spool-up (the medians over groundS), with its run and its rest voltage
function groundLoad(E, s) {
    const run = E.used.find(r => r.log === s.log && !(r.segment > 0)); if (!run || !isNum(s.i)) return null;
    const i1 = Math.min(run.n, s.i + Math.round(RULES.scnSpool.groundS * run.rate)), c = [], x = [], y = [];
    for (let i = s.i; i < i1; i++) { c.push(run.coll[i]); x.push(Math.hypot(run.roll[i], run.pitch[i])); y.push(Math.abs(run.yaw[i])); }
    return c.length ? { run, test: s.i >= E.testFrom.get(run), coll: median(c), cyc: median(x), yaw: median(y), rest: run.vbat ? run.vbat[0] : null, log: s.log, t: s.t, profile: s.profile } : null;
}
async function spool(E) {
    const SP = RULES.scnSpool, out = { profiles: {}, cases: [] };
    const curT = num(E.value('gov_spoolup_time', 0)), flags = {}; if (!isNum(curT)) { out.reason = 'unknown'; return out; }
    const loadsOf = (air) => E.M.spoolups.filter(s => !s.excluded && (air || !s.airborne) && E.P[s.profile]).map(s => Object.assign(groundLoad(E, s) || {}, { airborne: !!s.airborne })).filter(g => g.run);
    const ground = loadsOf(false), any = loadsOf(true), profiles = E.S.profiles.slice();
    // the ground spool-ups (critique M17); else all of them, with a note
    const pick = (part) => { const g = ground.filter(x => part ? x.test : !x.test); return g.length ? g : any.filter(x => part ? x.test : !x.test); };
    const sel = pick(false), tst = pick(true);
    out.airborne = sel.some(x => x.airborne) || tst.some(x => x.airborne);
    out.loads = sel.concat(tst).map(g => ({ log: g.log, t: g.t, profile: g.profile, test: g.test, airborne: g.airborne, coll: r3(g.coll, 3), cyc: r3(g.cyc, 3), yaw: r3(g.yaw, 3) }));
    if (!sel.length) { out.reason = 'noSpool'; return out; }
    // the PID spool-up of each PID profile: ON, OFF or unknown (the value of the rows; the log does not show it: the simulation uses the
    // firmware default, and a change has no CLI text)
    for (const p of profiles) { const v = E.cur('gov_use_pid_spoolup', p); flags[p] = v === null || v === undefined ? 'unknown' : String(v).toUpperCase() === 'ON' ? 'ON' : 'OFF'; }
    const unknownPid = profiles.some(p => flags[p] === 'unknown'), DEF = GTU.REG.gov_use_pid_spoolup.default;
    const levels = E.ocv ? [E.ocv.full, E.ocv.end] : [null], med = (g) => ({ coll: median(g.map(x => x.coll)), cyc: median(g.map(x => x.cyc)), yaw: median(g.map(x => x.yaw)) });
    // the training cases: the median ground load of each PID profile (of all spool-ups for a PID profile with none: a PID profile change
    // before the arm), at the start and at the end of the battery
    const cases = []; for (const p of profiles) { const g = sel.filter(x => x.profile === p), load = med(g.length ? g : sel); for (const v of levels) cases.push({ p, load, rest: v, own: g.length > 0 }); }
    out.own = profiles.filter(p => sel.some(x => x.profile === p));
    out.cases = cases.map(c => ({ profile: c.p, rest: r3(c.rest, 2), coll: r3(c.load.coll, 3), own: c.own }));
    const valuesOf = (T, fl) => ({ global: { gov_spoolup_time: T }, profiles: Object.fromEntries(profiles.map(p => [p, { gov_use_pid_spoolup: fl[p] === 'unknown' ? DEF : fl[p] }])) });
    const set = E.twins.concat(E.soft);
    const osAll = async (twins, values, stopAt) => { let worst = -Infinity; const each = []; for (const t of twins) for (const c of cases) { const v = await spoolOS(E, t.p, c.p, c.load, c.rest, values); each.push({ key: t.key, p: c.p, rest: c.rest, os: v }); worst = Math.max(worst, v); if (isNum(stopAt) && v > stopAt) return { worst, each, stopped: true }; } return { worst, each }; };
    const lim = SP.overshoot;
    // the value at this time (every twin), the log and the agreement of the twin with the test spool-ups (gov_fit events)
    const now = await osAll(set, valuesOf(curT, flags));
    const mainNow = now.each.filter(e => e.key === 'main');
    out.current = { value: curT, flags, main: range(mainNow.map(e => e.os)), set: range(now.each.map(e => e.os)), each: now.each.map(e => ({ key: e.key, profile: e.p, rest: r3(e.rest, 2), os: r3(e.os, 2) })) };
    // the smallest passing value of each option: the main twin first, then the set
    const search = async (fl) => {
        const passMain = async (T) => (await osAll(set.slice(0, 1), valuesOf(T, fl), lim)).worst <= lim;
        let T = curT, ok = await passMain(T);
        if (ok) { while (T - SP.step >= SP.min && await passMain(T - SP.step)) T -= SP.step; }
        else { while (!ok && T + SP.step <= SP.max) { T += SP.step; ok = await passMain(T); } if (!ok) return null; }
        while (T <= SP.max) { if ((await osAll(set, valuesOf(T, fl), lim)).worst <= lim) return T; T += SP.step; }
        return null;
    };
    const other = Object.fromEntries(profiles.map(p => [p, 'ON']));
    out.minCurrent = await search(flags);
    out.minPid = profiles.every(p => flags[p] === 'ON') ? out.minCurrent : await search(other);
    // a problem: the log (the median of the spool-ups) gives more than the limit, or the main twin does by more than its error on the test
    // spool-ups (gov_fit events: the largest |twin - log|, else trustTol). A change must then pass for each twin of the set
    const logOs = ground.length ? ground : any, osLog = E.M.spoolups.filter(s => logOs.some(g => g.log === s.log && g.t === s.t)).map(s => 100 * s.overshoot).filter(isNum);
    const trust = E.S.validationSpool || [];
    out.logMedian = osLog.length ? r3(median(osLog), 2) : null;
    out.tol = r3(trust.length ? Math.max(...trust.map(x => Math.abs(x.closed - x.logOs))) : SP.trustTol, 2);
    out.passNow = out.current.main[1] - out.tol <= lim && !(out.logMedian > lim);
    out.passSet = now.worst <= lim;
    // the curves of the main twin for the plot: the overshoot against the value, each case; with the PID spool-up too when it is OFF
    out.scan = []; out.scanPid = [];
    const pidOff = profiles.some(p => flags[p] !== 'ON');
    for (let T = Math.max(SP.min, curT - 4 * SP.step); T <= Math.min(SP.max, Math.max(curT, out.minCurrent || curT, out.minPid || curT) + 4 * SP.step); T += SP.step) {
        out.scan.push({ value: T, os: (await osAll(set.slice(0, 1), valuesOf(T, flags))).each.map(e => r3(e.os, 2)) });
        if (pidOff) out.scanPid.push({ value: T, os: (await osAll(set.slice(0, 1), valuesOf(T, other))).each.map(e => r3(e.os, 2)) });
    }
    if (out.passNow) return out;
    // the candidate: the smallest change. The value at this time with the PID spool-up if it passes for each model, else the smaller value.
    // A change of the PID spool-up needs its value at this time in each PID profile (the CLI text): else the value with the flags at this time
    out.pidNow = profiles.every(p => flags[p] === 'ON') ? false : (await osAll(set, valuesOf(curT, other), lim)).worst <= lim;
    const a = out.minCurrent, b = out.minPid, useB = !unknownPid && (out.pidNow || (isNum(b) && (!isNum(a) || b < a)));
    if (!useB && !isNum(a)) return out;
    out.candidate = { value: useB && out.pidNow ? curT : useB ? b : a, flags: useB ? other : flags };
    // the acceptance: one unit for each test spool-up (its ground load): the smallest effect of its rest voltage, F and A (the same spool-up
    // at three voltages is one unit, not three)
    const lv = [E.ocv ? E.ocv.full : null, E.ocv ? E.ocv.endAll : null].filter(isNum), res = [], units = [];
    for (const t of set) {
        const d = [];
        for (const g of tst) {
            let worst = Infinity;
            for (const v of [g.rest].concat(lv)) {
                const v0 = await spoolOS(E, t.p, g.profile, g, v, valuesOf(curT, flags)), v1 = await spoolOS(E, t.p, g.profile, g, v, valuesOf(out.candidate.value, out.candidate.flags));
                if (!isNum(v0) || !isNum(v1)) continue;
                worst = Math.min(worst, v0 - v1);
                if (t.key === 'main') units.push({ log: g.log, t: r3(g.t, 2), profile: g.profile, rest: r3(v, 2), base: r3(v0, 2), cand: r3(v1, 2) });
            }
            if (isFinite(worst)) d.push(worst);
        }
        res.push({ key: t.key, label: t.label, boot: bootstrap(d), all: d.length > 0 && d.every(v => v > 0) });
    }
    out.accept = Object.assign(acceptOf(res), { units, events: tst.length, better: res.every(x => x.all) });
    return out;
}

// ---- tracking: the target slope against the acceleration below the maximum throttle ----
async function tracking(E) {
    const TR = RULES.scnTracking, cur = num(E.value('gov_tracking_time', 0)), out = { value: cur, profiles: {} };
    const lvl = E.ocv ? E.ocv.end : null, lvlF = E.ocv ? E.ocv.full : null;
    for (const p of E.S.profiles) {
        const I = E.P[p], Hf = I.Hf; if (!I.train.n) continue;
        const per = E.twins.map(t => {
            const B = blocksOf(t.p, I.train), L = new Float64Array(B.m); for (let b = 0; b < B.m; b++) L[b] = t.p.qc * B.A[b] + t.p.qx * B.X[b] + t.p.qy * B.Y[b];
            const Lm = median(L), oc = ocvOf(t.p, lvl), ocF = ocvOf(t.p, lvlF);
            let a = Infinity; for (let j = 0; j < TR.points; j++) { const H = Hf * (TR.from + (1 - TR.from) * j / (TR.points - 1)), n = H / t.p.Href, sL = n * n * (t.p.q0 + Lm) + t.p.qf * n + t.p.qs;
                a = Math.min(a, (t.p.kv / Math.max(t.p.tm, GT.RULES.minTau)) * (slipAt(t.p, I.maxThr, oc, H) - sL)); }
            const kmot = Hf / dReqL(t.p, Hf, Lm, ocF), rateMax = Math.max(Hf, kmot);
            return { key: t.key, acc: a, kmot, min: a > 0 ? Math.ceil(10 * rateMax / a) : null };
        });
        const mins = per.map(q => q.min);
        out.profiles[p] = { acc: r3(per[0].acc, 0), accSet: range(per.map(q => q.acc)), kmot: r3(per[0].kmot, 0), min: per[0].min, minSet: mins.some(v => v === null) ? [range(mins)[0], null] : range(mins),
            slope: isNum(cur) && cur > 0 ? r3(Math.max(Hf, per[0].kmot) * 10 / cur, 0) : null, none: per.some(q => !(q.acc > 0)) };
    }
    const need = Object.values(out.profiles).map(x => x.minSet[1]);
    out.min = need.every(isNum) && need.length ? Math.max(...need) : null;
    out.ok = isNum(cur) && isNum(out.min) && (cur === 0 ? false : cur >= out.min);
    if (!isNum(cur) || out.ok || !isNum(out.min) || out.min > GTU.REG.gov_tracking_time.range[1]) return out;
    // the acceptance: the saturated time after the PID profile changes and the RECOVERY and BAILOUT exits of the test flights
    out.candidate = out.min;
    const res = [];
    for (const t of E.twins) {
        const d = [];
        for (const run of E.test) {
            const tf = E.testFrom.get(run), a = await sim(E, run, t.p, {}), b = await sim(E, run, t.p, { values: { global: { gov_tracking_time: out.min } } });
            if (!a.trace || !b.trace) continue;
            const W = Math.round(TR.windowS * run.rate), ev = (E.cfgOf(run).changes || []).map(c => c.k).filter(k => k >= tf);
            for (let k = Math.max(1, tf); k < run.n; k++) if (a.trace.state[k] === 4 && [3, 8].includes(a.trace.state[k - 1])) ev.push(k);
            const satS = (tr, k) => { let s = 0; for (let i = k; i < Math.min(run.n, k + W); i++) if (tr.u[i] >= E.mx(tr.profile[i]) - RULES.scnPower.near) s++; return s / run.rate; };
            for (const k of ev) d.push(satS(a.trace, k) - satS(b.trace, k));
        }
        res.push({ key: t.key, label: t.label, boot: bootstrap(d) });
    }
    out.accept = acceptOf(res);
    return out;
}
const dReqL = (p, H, L, ocv) => { const n = H / p.Href, sL = n * n * (p.q0 + L) + p.qf * n + (H > 0 ? p.qs : 0), e = H / p.kv, V = p.voltage && ocv > 0 ? ocv : p.V0, a = (p.voltage ? p.beta : 0) * sL;
    if (!(a > 1e-12)) return (e + sL) / V; const disc = V * V - 4 * a * (e + sL); return disc >= 0 ? (V - Math.sqrt(disc)) / (2 * a) : Infinity; };

// ---- scenario G: an RPM signal error at each saturation period, at each FALLBACK of the log and at random ACTIVE times ----
// sets of times at least gapS apart (one simulation each)
function glitchSets(times, gapS) {
    const sets = [];
    for (const t of times.slice().sort((a, b) => a - b)) { const s = sets.find(q => t - q[q.length - 1] >= gapS); if (s) s.push(t); else sets.push([t]); }
    return sets;
}
function glitchTimes(E, run) {
    const F = RULES.scnFallback, list = [], t0 = run.fromS || 0, T = run.time[run.n - 1];
    for (const f of E.M.fallbacks) if (f.log === run.log) list.push({ t: f.t - t0, kind: 'fallback' });
    for (const x of E.M.periods) if (x.log === run.log && x.kind === 'max' && x.cause === 'load' && x.state === 'ACTIVE') list.push({ t: x.t - t0 + Math.min(F.satInS, x.s / 2), kind: 'saturation' });
    const ok = list.filter(x => x.t > 0 && x.t < T).sort((a, b) => a.t - b.t), out = [];
    for (const x of ok) if (!out.length || x.t - out[out.length - 1].t >= F.mergeS) out.push(x);
    // seeded random times in ACTIVE flight, mergeS from the others (glitchSets puts errors closer than gapS in other simulations)
    const rand = rng(F.random * 7919 + run.log * 104729 + 1), st = run.state;
    for (let k = 0, tries = 0; k < F.random && tries < 200; tries++) {
        const i = Math.floor(rand() * run.n), t = run.time[i];
        if (st[i] !== 4 || (run.phase && run.phase[i] !== FL) || out.some(x => Math.abs(x.t - t) < F.mergeS)) continue;
        out.push({ t, kind: 'random' }); k++;
    }
    return out.sort((a, b) => a.t - b.t);
}
// the event of each error time in a trace: FALLBACK must start in entryS; the headspeed loss over eventS (% s), the lowest headspeed, the
// time under sag of the request, the overshoot after RECOVERY, and the throttle decrease in FALLBACK (1 - the mean throttle in FALLBACK / the
// throttle before the error: the pilot must know about the error) with atMax: the throttle before the error at its maximum (mx(p))
const idxOf = (run, t) => { let lo = 0, hi = run.n; while (lo < hi) { const k = (lo + hi) >> 1; if (run.time[k] < t) lo = k + 1; else hi = k; } return lo; };
function glitchEvents(run, tr, times, req, mx) {
    const F = RULES.scnFallback, rate = run.rate, out = [], at = (t) => idxOf(run, t);
    for (const t of times) {
        const k0 = at(t); let k6 = -1; for (let k = k0; k < Math.min(run.n, k0 + Math.max(2, Math.round(F.entryS * rate))); k++) if (tr.state[k] === 6) { k6 = k; break; }
        if (k6 < 0) { out.push(null); continue; }
        // the request of the PID profile of each sample: a PID profile change in the window is not a loss
        const p = tr.profile[k6], end = Math.min(run.n, k6 + Math.round(F.eventS * rate)); let loss = 0, mn = Infinity, under = 0, over = 0;
        for (let k = k6; k < end; k++) { const q = req(tr.profile[k]); if (!(q > 0)) continue; const r = tr.hs[k] / q; loss += Math.max(0, 1 - r); if (r < mn) mn = r; if (r < F.sag) under++; if (r - 1 > over) over = r - 1; }
        const u0 = tr.u[Math.max(0, k0 - 1)]; let uf = 0, m = 0; for (let k = k6; k < run.n && tr.state[k] === 6; k++) { uf += tr.u[k]; m++; }
        out.push({ t: r3(t, 3), profile: p, loss: 100 * loss / rate, min: mn, under: under / rate, over, drop: u0 > 0.02 && m ? 1 - uf / m / u0 : null, atMax: !!mx && u0 >= mx(p) - RULES.scnPower.near });
    }
    return out;
}
async function fallback(E) {
    const F = RULES.scnFallback, out = { profiles: {} };
    const times = new Map(E.used.map(r => [r, glitchTimes(E, r)]));
    out.times = E.used.map(r => ({ log: r.log, test: E.testFrom.get(r) < r.n, list: times.get(r).map(x => ({ t: r3(x.t, 2), kind: x.kind })) }));
    const cur = { precomp: {}, drop: {}, recovery: num(E.value('gov_recovery_time', 0)) };
    for (const p of E.S.profiles) { cur.precomp[p] = String(E.value('gov_use_fallback_precomp', p) || 'OFF').toUpperCase() === 'ON' ? 'ON' : 'OFF'; cur.drop[p] = num(E.value('gov_fallback_drop', p)); }
    out.current = cur;
    // the values that the rows do not know: the source of the value that the model uses (a default value of the firmware: the texts say so)
    out.assumed = { recovery: E.cfgSource('gov_recovery_time', 0), drop: {}, precomp: {} };
    for (const p of E.S.profiles) { out.assumed.drop[p] = E.cfgSource('gov_fallback_drop', p); out.assumed.precomp[p] = E.cur('gov_use_fallback_precomp', p) === null ? E.cfgSource('gov_use_fallback_precomp', p) || 'default value' : null; }
    if (!isNum(cur.recovery) || E.S.profiles.some(p => !isNum(cur.drop[p]))) { out.reason = 'unknown'; return out; }
    // the events of a twin and values on runs (part: train or test); the same order of events for each value set
    const evOf = async (tw, values, runs, part) => {
        const ev = [];
        for (const run of runs) {
            const tf = E.testFrom.get(run), tl = times.get(run).filter(x => { const k = idxOf(run, x.t); return part === 'all' || (part === 'test' ? k >= tf : k < tf); }).map(x => x.t);
            for (const s of glitchSets(tl, F.gapS)) { const r = await sim(E, run, tw, { forceFallback: [], glitches: s, values }); if (!r.trace) continue; for (const x of glitchEvents(run, r.trace, s, E.req, E.mx)) ev.push(x && Object.assign(x, { log: run.log, segment: run.segment || 0 })); }
        }
        return ev;
    };
    const valuesOf = (a) => ({ global: { gov_recovery_time: a.recovery }, profiles: Object.fromEntries(E.S.profiles.map(p => [p, { gov_use_fallback_precomp: a.precomp[p], gov_fallback_drop: a.drop[p] }])) });
    // cue: the smallest throttle decrease in FALLBACK at the errors at the maximum throttle (the pilot must know about the error)
    const summary = (ev) => { const v = ev.filter(Boolean), m = v.filter(x => x.atMax && isNum(x.drop)).map(x => x.drop);
        return { n: v.length, loss: mean(v.map(x => x.loss)), min: mean(v.map(x => x.min)), under: mean(v.map(x => x.under)), over: mean(v.map(x => x.over)), cue: m.length ? Math.min(...m) : null, cueN: m.length }; };
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b), clone = (a) => JSON.parse(JSON.stringify(a)), minD = F.minDrop / 100;
    // the cue rule (GC5): at each error at which the values at this time decrease the throttle by minDrop or more, the candidate does too.
    // The parameter is not sufficient: with the precomp ON at the maximum throttle, (I + F) x (1 - drop) can be more than 1 (critique V3)
    const cueOk = (ev, ref) => ev.length === ref.length && ref.every((x, j) => !x || !(x.drop >= minD) || !!ev[j] && ev[j].drop >= minD - 1e-6);
    // selection on the training flights (main twin): the precomp and the drop together, then the recovery time (with its BAILOUT and RECOVERY
    // cases: they must not get a larger overshoot or more time at the maximum throttle)
    const main = E.twins[0].p, tried = [], trainLogs = E.train.map(r => r.log), cases = recoveryCases(E, trainLogs), caseMemo = new Map();
    const casesOf = async (tw, key, rec, list) => { const k = `${key}|${rec}|${list.length}`; if (!caseMemo.has(k)) { const o2 = []; for (const c of list) o2.push(await caseRun(E, tw, c, rec)); caseMemo.set(k, o2); } return caseMemo.get(k); };
    const score = async (a) => { const ev = await evOf(main, valuesOf(a), E.train, 'train'), s = summary(ev); s.ev = ev;
        tried.push({ values: clone(a), loss: r3(s.loss, 3), min: r3(s.min, 4), under: r3(s.under, 3), over: r3(s.over, 4), n: s.n, cue: r3(s.cue, 4), cueN: s.cueN, cueOk: !b0 || cueOk(ev, b0.ev) }); return s; };
    let b0 = null, best = clone(cur), bs = await score(best);
    b0 = bs;
    out.base = tried[0];
    if (!bs.n) { out.reason = 'noEvent'; return out; }
    const overLim = Math.max(bs.over, F.over), allP = (v) => Object.fromEntries(E.S.profiles.map(p => [p, v]));
    const better = (s) => s.n === bs.n && s.loss < bs.loss - 1e-9 && s.over <= overLim && cueOk(s.ev, b0.ev);
    // the precomp ON needs a larger drop at the maximum throttle; with the precomp OFF a larger drop only increases the loss
    const steps = [(a) => { const l = []; for (const pc of ['OFF', 'ON']) for (const d of [null].concat(F.drops)) { if (pc === 'OFF' && d !== null && E.S.profiles.every(p => d >= a.drop[p])) continue;
            const c = Object.assign({}, a, { precomp: allP(pc), drop: d === null ? a.drop : allP(d) }); if (!same(c, a) && !l.some(q => same(q, c))) l.push(c); } return l; },
        (a) => F.recovery.filter(v => v !== a.recovery).map(v => Object.assign({}, a, { recovery: v }))];
    out.recovery = { cases: cases.map(c => ({ key: c.key, rest: r3(c.lvl, 2), share: c.share || null, log: isNum(c.log) ? c.log : null, t: isNum(c.t) ? r3(c.t, 2) : null })), tried: [] };
    for (const st of steps) {
        let pick = null, ps = null;
        for (const c of st(best)) {
            const s = await score(c);
            if (!better(s) || (ps && s.loss >= ps.loss)) continue;
            if (c.recovery !== cur.recovery && cases.length) {
                const a0 = await casesOf(main, 'main', cur.recovery, cases), a1 = await casesOf(main, 'main', c.recovery, cases), ok = a1.every((x, j) => caseOk(a0[j], x));
                out.recovery.tried.push({ value: c.recovery, ok, base: a0.map(x => x && { satS: x.satS, overshoot: x.overshoot }), cand: a1.map(x => x && { satS: x.satS, overshoot: x.overshoot }) });
                if (!ok) continue;
            }
            pick = c; ps = s;
        }
        if (pick) { best = pick; bs = ps; }
    }
    out.tried = tried; out.best = clone(best); out.bestScore = tried.find(x => same(x.values, best));
    // a change needs RPM signal errors in the flight logs (a FALLBACK, or a step of the headspeed signal at the maximum throttle)
    out.problem = E.M.fallbacks.length > 0 || !!(E.M.glitch && E.M.glitch.all && E.M.glitch.all.k > 0);
    // per PID profile: the events of the value at this time and of the best value (main twin, all flights) for the texts
    const allBase = await evOf(main, valuesOf(cur), E.used, 'all'), changed = JSON.stringify(best) !== JSON.stringify(cur);
    const allBest = changed ? await evOf(main, valuesOf(best), E.used, 'all') : allBase;
    for (const p of E.S.profiles) { const a = summary(allBase.filter(x => x && x.profile === p)), b = summary(allBest.filter(x => x && x.profile === p)); out.profiles[p] = { base: a, best: b }; }
    out.events = { all: summary(allBase), best: summary(allBest) };
    // the plot: the error with the largest loss at the values at this time (main twin), flown with each value set of the selection
    // (t: s in the run, the time of the error; the plot in frame seconds, fromS + time: the clock of the log viewer)
    const w = allBase.filter(Boolean).reduce((a, x) => !a || x.loss > a.loss ? x : a, null), wr = w && E.used.find(r => r.log === w.log && (r.segment || 0) === (w.segment || 0));
    if (wr) {
        const k0 = idxOf(wr, w.t - F.preS), k1 = Math.min(wr.n, idxOf(wr, w.t + F.eventS)), step = Math.max(1, Math.ceil((k1 - k0) / F.points)), ks = [];
        for (let k = k0; k < k1; k += step) ks.push(k);
        const alts = [], seen = new Set();
        for (const a of [cur].concat((out.tried || []).map(x => x.values))) {
            const key = JSON.stringify(a); if (seen.has(key)) continue; seen.add(key);
            const r = await sim(E, wr, main, { forceFallback: [], glitches: [w.t], values: valuesOf(a) }); if (!r.trace) continue;
            alts.push({ label: fbWhat(a, cur) || 'Values at this time', best: key === JSON.stringify(best) && key !== JSON.stringify(cur), t: ks.map(k => r3((wr.fromS || 0) + wr.time[k], 3)), hs: ks.map(k => Math.round(r.trace.hs[k])),
                target: ks.map(k => Math.round(r.trace.target[k])), u: ks.map(k => r3(r.trace.u[k], 4)) });
        }
        out.traces = { log: wr.log, segment: wr.segment || 0, t: r3((wr.fromS || 0) + w.t, 3), profile: w.profile, alts };
    }
    if (!changed || !out.problem) return out;
    // the acceptance on the test flights (the loss, each twin), with the cue rule for each twin and, for a new recovery time, its BAILOUT and
    // RECOVERY cases (all logs) for each twin and the two soft-start twins. The same rule for each PID profile on its own errors (accept.profiles:
    // the drop and the precomp of PID profile p change only the errors of p, so each PID profile has its own result; review 2026-10-15)
    const res = [], why = [], all = recoveryCases(E, E.used.map(r => r.log)), resP = {}, whyP = {};
    for (const t of E.twins) {
        const a = await evOf(t.p, valuesOf(cur), E.test, 'test'), b = await evOf(t.p, valuesOf(best), E.test, 'test'), d = [], dP = {};
        for (let j = 0; j < Math.min(a.length, b.length); j++) if (a[j] && b[j]) { const x = a[j].loss - b[j].loss; d.push(x); (dP[a[j].profile] || (dP[a[j].profile] = [])).push(x); }
        if (!cueOk(b, a)) why.push({ key: t.key, label: t.label, rule: 'cue' });
        res.push({ key: t.key, label: t.label, boot: bootstrap(d) });
        for (const p of E.S.profiles) {
            const mine = (x, j) => !!a[j] && a[j].profile === p, ap = a.filter(mine), bp = b.filter(mine);
            if (!cueOk(bp, ap)) (whyP[p] || (whyP[p] = [])).push({ key: t.key, label: t.label, rule: 'cue' });
            (resP[p] || (resP[p] = [])).push({ key: t.key, label: t.label, boot: bootstrap(dP[p] || []) });
        }
    }
    if (best.recovery !== cur.recovery) for (const t of E.twins.concat(E.soft)) {
        const a0 = await casesOf(t.p, t.key, cur.recovery, all), a1 = await casesOf(t.p, t.key, best.recovery, all);
        a1.forEach((x, j) => { if (!caseOk(a0[j], x)) why.push({ key: t.key, label: t.label, rule: 'recovery', case: all[j].key, rest: r3(all[j].lvl, 2), base: a0[j] && a0[j].overshoot, cand: x && x.overshoot }); });
    }
    out.accept = acceptOf(res); out.accept.constraints = why;
    if (why.length) out.accept.pass = false;
    // each PID profile: its errors, its cue rule, and the recovery cases of a new recovery time (the drop was selected with it)
    out.accept.profiles = {};
    for (const p of E.S.profiles) {
        const A = acceptOf(resP[p] || []); A.constraints = (whyP[p] || []).concat(why.filter(x => x.rule === 'recovery'));
        if (A.constraints.length) A.pass = false;
        out.accept.profiles[p] = A;
    }
    return out;
}

// the values of a FALLBACK value set that are not the same as in cur (a part of a sentence), '' when none
function fbWhat(a, cur) {
    const l = [];
    if (JSON.stringify(a.precomp) !== JSON.stringify(cur.precomp)) l.push(`"gov_use_fallback_precomp" ${Object.values(a.precomp)[0]}`);
    if (JSON.stringify(a.drop) !== JSON.stringify(cur.drop)) l.push(`"gov_fallback_drop" ${Object.values(a.drop)[0]}`);
    if (a.recovery !== cur.recovery) l.push(`"gov_recovery_time" ${a.recovery}`);
    return and(l);
}

// ---- the BYPASS curve ----
async function bypass(E) {
    const B = RULES.scnBypass, ps = E.S.profiles.filter(p => E.P[p].train.n);
    if (!ps.length) return { reason: 'noData' };
    const p = ps.reduce((a, q) => E.P[q].train.n > E.P[a].train.n ? q : a, ps[0]), I = E.P[p], s = I.train;
    // the mixer collective per collective stick from the recorded rcCommand[3] (the collective rate of the pilot), else the default
    const ratios = [];
    for (const r of E.runs) if (r.collStick && r.coll) for (let i = 0; i < r.n; i += 10) { const c = r.collStick[i]; if (Math.abs(c) >= B.minStick && isNum(r.coll[i])) ratios.push(r.coll[i] / c); }
    const kLog = ratios.length >= 100 ? median(ratios) : null;
    const cyc = median(s.cyc) || 0, yaw = median(s.yaw.map(Math.abs)) || 0, rest = E.ocv ? E.ocv.mid : null, k = isNum(kLog) && kLog > 0 ? kLog : B.mixerPerStick;
    const stick = Array.from({ length: B.points }, (_, j) => -1 + 2 * j / (B.points - 1));
    const curves = E.twins.map(t => stick.map(c => { const d = dReq(t.p, I.Hf, Math.pow(Math.abs(k * c - t.p.c0), t.p.pc), cyc, yaw, ocvOf(t.p, rest)); return Math.round(200 * Math.min(1, Math.max(0, d))); }));
    const raw = stick.map(c => dReq(E.twins[0].p, I.Hf, Math.pow(Math.abs(k * c - E.twins[0].p.c0), E.twins[0].p.pc), cyc, yaw, ocvOf(E.twins[0].p, rest)));
    return { profile: p, Hf: I.Hf, rest: r3(rest, 2), k: r3(k, 3), kLog: isNum(kLog) ? r3(kLog, 3) : null, stick: stick.map(c => r3(c, 3)), mixer: stick.map(c => r3(k * c, 3)), values: curves[0], lo: stick.map((_, j) => Math.min(...curves.map(c => c[j]))), hi: stick.map((_, j) => Math.max(...curves.map(c => c[j]))), over: raw.filter(d => !(d <= 1)).length, cyc: r3(cyc, 3), yaw: r3(yaw, 3) };
}

// ---- voltage compensation: the loop gain, the F-term and the drift over the battery; with ADC (or an unknown source) a simulation ----
async function vcomp(E) {
    const out = { profiles: {} }, t = E.twins[0].p;
    if (!E.ocv) return Object.assign(out, { reason: 'noVoltage' });
    const vF = ocvOf(t, E.ocv.full), vE = ocvOf(t, E.ocv.end);
    out.gain = r3(1 - vE / vF, 4); out.ff = r3(vF / vE - 1, 4); out.vF = r3(vF, 2); out.vE = r3(vE, 2);
    for (const p of E.S.profiles) {
        const I = E.P[p]; if (!I.train.n) continue;
        const B = blocksOf(t, I.train), L = new Float64Array(B.m); for (let b = 0; b < B.m; b++) L[b] = t.qc * B.A[b] + t.qx * B.X[b] + t.qy * B.Y[b];
        const Lm = median(L), n = I.Hf / t.Href, dv = I.Hf / t.kv + n * n * (t.q0 + Lm) + t.qf * n + t.qs;
        const drift = E.M.drift.filter(x => x.profile === p), pred = drift.map(x => 100 * dv * (1 / x.v1 - 1 / x.v0));
        out.profiles[p] = { model: r3(100 * (dReqL(t, I.Hf, Lm, vE) - dReqL(t, I.Hf, Lm, vF)), 2), pred: r3(mean(pred), 2), log: r3(mean(drift.map(x => x.points)), 2), n: drift.length };
    }
    const meter = String(E.value('battery_meter', 0) || '').toUpperCase() || null;
    out.meter = meter;
    if (meter && meter !== 'ADC') return out;
    // ADC (or unknown): the closed loop with and without voltage compensation on the test flights (each twin for ADC, the main twin else)
    // the filter of the voltage (the default of 4.6 when the log does not show it: it acts only with voltage compensation)
    const twins = meter === 'ADC' ? E.twins : E.twins.slice(0, 1), res = [], pf = num(E.value('gov_pwr_filter', 0));
    out.pwrFilter = isNum(pf) ? pf : GTU.REG.gov_pwr_filter.default; out.pwrFilterSource = isNum(pf) ? 'value' : 'default';
    const vals = (v) => ({ global: { gov_pwr_filter: out.pwrFilter }, all: { gov_use_voltage_comp: v } });
    for (const tw of twins) {
        const a = [], b = [], d = [];
        for (const run of E.test) {
            const cfg = Object.assign({}, E.cfgOf(run), { voltageSource: 'ADC' }), tf = E.testFrom.get(run);
            const r0 = await GS.run(run, cfg, { plant: 'twin', twin: tw.p, scenario: { values: vals('OFF') }, record: FULL });
            const r1 = await GS.run(run, cfg, { plant: 'twin', twin: tw.p, scenario: { values: vals('ON') }, record: FULL });
            if (!r0.trace || !r1.trace) continue;
            const s0 = stats(run, r0.trace, { mx: E.mx, req: E.req, blocks: true, from: tf }), s1 = stats(run, r1.trace, { mx: E.mx, req: E.req });
            a.push(s0); b.push(s1);
            const err = (tr, bl) => { let s = 0, m = 0; const q = E.req(bl[0]); for (let i = bl[1]; i < bl[2]; i++) if (tr.profile[i] === bl[0] && inFlight(run, tr, i)) { const e = (tr.hs[i] - q) / q; s += e * e; m++; } return m ? 100 * Math.sqrt(s / m) : null; };
            for (const A of Object.values(s0.profiles)) for (const bl of A.blocks) { const x = err(r0.trace, bl), y = err(r1.trace, bl); if (isNum(x) && isNum(y)) d.push(x - y); }
        }
        const rate = E.used[0].rate;
        res.push({ key: tw.key, label: tw.label, boot: bootstrap(d), off: pool(a, rate), on: pool(b, rate) });
    }
    out.sim = Object.fromEntries(E.S.profiles.map(p => [p, { off: res[0].off[p] ? { eRms: r3(100 * res[0].off[p].eRms, 3), droop95: r3(res[0].off[p].droop95, 4) } : null, on: res[0].on[p] ? { eRms: r3(100 * res[0].on[p].eRms, 3), droop95: r3(res[0].on[p].droop95, 4) } : null }]));
    out.accept = meter === 'ADC' ? acceptOf(res) : null;
    return out;
}

// ---- a BAILOUT from a slow rotor (Fireball log 11 type), and the recorded ones ----
// the first BAILOUT (state 8) or RECOVERY (state 3) from sample from: the time at the maximum throttle until ACTIVE + afterS, the overshoot
function bailoutOf(run, tr, from, req, mx, state = 8) {
    const B = RULES.scnBailout, n = tr.u.length; let a = -1; for (let k = Math.max(0, from); k < n; k++) if (tr.state[k] === state) { a = k; break; }
    if (a < 0) return null;
    let e = a; while (e < n && tr.state[e] === state) e++;
    const p = tr.profile[a], q = req(p), w1 = Math.min(n, e + Math.round(B.afterS * run.rate)); let sat = 0, top = -Infinity;
    for (let j = a; j < w1; j++) { if (j >= e && tr.state[j] !== 4) break; if (tr.u[j] >= mx(p) - RULES.scnPower.near) sat++; if (j >= e) top = Math.max(top, (tr.hs[j] - q) / q); }
    return { i: a, share: r3(tr.hs[a] / q, 3), hs: Math.round(tr.hs[a]), satS: r3(sat / run.rate, 3), overshoot: isFinite(top) ? r3(100 * top, 2) : null };
}
// a synthetic switch from ACTIVE and back (c: { p, load, lvl, share, pos, waitS, off, state }): RUN, ACTIVE for holdS, the switch position pos
// (B.auto: AUTOROTATION; 0: HOLD) until the twin rotor is at share of the target (off: and the motor off for the ESC soft-start time), then
// RUN again: bailoutOf of the BAILOUT or the RECOVERY, with tB (s after the switch); null when the rotor does not get to share in waitS
async function switchRun(E, tw, c, values) {
    const B = RULES.scnBailout, SP = RULES.scnSpool, I = E.P[c.p], st = num(E.value('gov_startup_time', 0)) || 200, sp = num(E.value('gov_spoolup_time', 0)) || 100;
    const tA = SP.offS + 0.1 * st * 0.4 + 0.1 * sp + SP.afterS + B.holdS, sc = { ocv: c.lvl || undefined, values };
    const r1 = synth(E, c.p, tA + c.waitS - 0.5, (t) => t < SP.offS ? 0 : t < tA ? 1 : c.pos, c.load, c.lvl);
    const a = await GS.run(r1, r1.synthCfg, { plant: 'twin', twin: tw, scenario: sc, record: FULL });
    if (!a.trace) return null;
    let kB = -1, off = 0; const offN = GT.RULES.softOffS * r1.rate;
    for (let k = Math.round(tA * r1.rate); k < r1.n; k++) { off = a.trace.u[k] < GT.RULES.dOff ? off + 1 : 0; if (a.trace.hs[k] < c.share * I.Hf && (!c.off || off >= offN)) { kB = k; break; } }
    if (kB < 0) return null;
    const tB = r1.time[kB], r2 = synth(E, c.p, tB + B.runS, (t) => t < SP.offS ? 0 : t < tA ? 1 : t < tB ? c.pos : 1, c.load, c.lvl);
    const b = await GS.run(r2, r2.synthCfg, { plant: 'twin', twin: tw, scenario: sc, record: FULL });
    const x = b.trace ? bailoutOf(r2, b.trace, kB, E.req, E.mx, c.state) : null;
    return Object.assign({ tB: r3(tB - tA, 2) }, x || { none: true });
}
// the PID profile with the most training data, and the profile of the recorded BAILOUTs from a slow rotor
const mainProfile = (E) => E.S.profiles.reduce((a, q) => E.P[q].train.n > E.P[a].train.n ? q : a, E.S.profiles[0]);
async function bailout(E) {
    const B = RULES.scnBailout, out = { recorded: [], synthetic: null }, set = E.twins.concat(E.soft);
    const low = E.M.bailouts.filter(b => b.low), fromA = E.M.census.autorotations.filter(a => a.from === 'ACTIVE');
    const type = String(E.value('gov_throttle_type', 0) || '').toUpperCase(), timeout = num(E.value('gov_autorotation_timeout', 0));
    out.relevant = low.length > 0 || (type === 'FUNCTION' && fromA.length > 0 && timeout > 0);
    if (!out.relevant) return out;
    // the recorded ones: the closed loop of the log, each twin
    for (const b of low.filter(q => E.used.some(r => r.log === q.log))) {
        const each = [];
        for (const tw of set) { const x = await recordedBailout(E, tw.p, b, null); if (x && isNum(x.overshoot)) each.push(Object.assign({ key: tw.key }, x)); }
        out.recorded.push({ log: b.log, t: b.t, profile: b.profile, log_: { satS: b.satS, overshoot: isNum(b.overshoot) ? r3(100 * b.overshoot, 2) : null, share: b.share }, main: each.find(x => x.key === 'main') || null,
            satSet: range(each.map(x => x.satS)), overSet: range(each.map(x => x.overshoot)) });
    }
    // the synthetic one: RUN, ACTIVE for holdS, the middle position until the rotor is at share of the target, RUN again
    if (type !== 'FUNCTION' || !(timeout > 0)) return out;
    const c = slowCase(E), rows = [];
    for (const lvl of (E.ocv ? [E.ocv.full, E.ocv.end] : [null])) for (const tw of set) {
        const x = await switchRun(E, tw.p, Object.assign({}, c, { lvl }), undefined);
        if (x) rows.push(Object.assign({ key: tw.key, rest: r3(lvl, 2) }, x));
    }
    const ok = rows.filter(x => !x.none && isNum(x.overshoot)), main = ok.filter(x => x.key === 'main');
    out.synthetic = { profile: c.p, Hf: E.P[c.p].Hf, rows, none: !ok.length, noExit: rows.filter(x => !x.none && !isNum(x.overshoot)).length, share: main.length ? main[0].share : null, satS: main.length ? Math.max(...main.map(x => x.satS)) : null, overshoot: main.length ? Math.max(...main.map(x => x.overshoot || 0)) : null,
        satSet: range(ok.map(x => x.satS)), overSet: range(ok.map(x => x.overshoot)) };
    return out;
}
// a recorded BAILOUT b flown by the twin with values: bailoutOf from 1 s before it
async function recordedBailout(E, tw, b, values) {
    const run = E.used.find(r => r.log === b.log); if (!run) return null;
    const r = await sim(E, run, tw, values ? { values } : {}); if (!r.trace) return null;
    return bailoutOf(run, r.trace, Math.max(0, Math.round((b.t - (run.fromS || 0) - 1) * run.rate)), E.req, E.mx);
}
// the BAILOUT from a slow rotor (GC9): the PID profile and the share of the recorded ones (else RULES), the ground load of a spool-up
function slowCase(E) {
    const B = RULES.scnBailout, low = E.M.bailouts.filter(b => b.low), p = low.length && E.P[low[0].profile] ? low[0].profile : mainProfile(E);
    const g = E.M.spoolups.find(s => s.profile === p && !s.airborne), gl = g ? groundLoad(E, g) : null;
    return { key: 'slow', p, load: gl || { coll: 0, cyc: 0, yaw: 0 }, share: low.length ? Math.max(B.minShare, median(low.map(b => b.share))) : B.share, pos: B.auto,
        waitS: num(E.value('gov_autorotation_timeout', 0)) || 0, off: true, state: 8 };
}
// the cases of gov_recovery_time (it also sets the throttle rate of RECOVERY, BAILOUT and AUTOROTATION: flight_governor.c:1064-1068): a
// RECOVERY after HOLD and (FUNCTION with gov_autorotation_timeout) a BAILOUT from a turning rotor (turn of the target, the median hover load
// of the PID profile) and from a slow rotor, at F and E; and the recorded BAILOUTs from a slow rotor of logs (the training logs: the selection)
function recoveryCases(E, logs) {
    const B = RULES.scnBailout, type = String(E.value('gov_throttle_type', 0) || '').toUpperCase(), timeout = num(E.value('gov_autorotation_timeout', 0)), hold = num(E.value('gov_throttle_hold_timeout', 0));
    const p = mainProfile(E), s = E.P[p].train, hover = { coll: median(s.coll) || 0, cyc: median(s.cyc) || 0, yaw: median(s.yaw.map(Math.abs)) || 0 }, out = [];
    for (const lvl of (E.ocv ? [E.ocv.full, E.ocv.end] : [null])) {
        if (hold > 0) out.push({ key: 'hold', p, load: hover, lvl, share: B.turn, pos: 0, waitS: hold / 10, off: false, state: 3 });
        if (type === 'FUNCTION' && timeout > 0) out.push({ key: 'turn', p, load: hover, lvl, share: B.turn, pos: B.auto, waitS: timeout, off: false, state: 8 }, Object.assign(slowCase(E), { lvl }));
    }
    for (const b of E.M.bailouts.filter(b => b.low && logs.includes(b.log))) out.push({ key: 'log', log: b.log, t: b.t, p: b.profile });
    return out;
}
const caseRun = (E, tw, c, rec) => { const v = { global: { gov_recovery_time: rec } }; return c.key === 'log' ? recordedBailout(E, tw, c, v) : switchRun(E, tw, c, v); };
// a candidate case against the case at this time: the overshoot and the time at the maximum throttle do not increase by more than the tolerances
const caseOk = (b, c) => !b || b.none || !isNum(b.overshoot) || (!!c && !c.none && isNum(c.overshoot) && c.overshoot <= b.overshoot + RULES.scnBailout.over && c.satS <= b.satS + RULES.scnBailout.satS);

// ---------------------------------------------------------------------------------------------
// rows (gov_tune families)
// ---------------------------------------------------------------------------------------------

const ev = GTU.ev;
// the names that the simulations of a row use (gov_tune.simStale: the flags of the values of the simulated logs). CONTROL: ACTIVE flight
const CONTROL = ['gov_headspeed', 'gov_gain', 'gov_p_gain', 'gov_i_gain', 'gov_d_gain', 'gov_f_gain', 'gov_collective_ff_weight', 'gov_cyclic_ff_weight', 'gov_yaw_ff_weight',
    'gov_collective_curve', 'gov_p_limit', 'gov_i_limit', 'gov_d_limit', 'gov_f_limit', 'gov_rpm_filter', 'gov_ff_filter', 'gov_d_filter', 'gov_max_throttle', 'gov_min_throttle',
    'gov_use_voltage_comp', 'gov_pwr_filter', 'gov_tracking_time'];
const SWITCH = ['gov_spoolup_time', 'gov_use_pid_spoolup', 'gov_startup_time', 'gov_spooldown_time', 'gov_handover_throttle', 'gov_idle_throttle', 'gov_auto_throttle',
    'gov_autorotation_timeout', 'gov_throttle_hold_timeout', 'gov_recovery_time'];
const simNames = (name) => CONTROL.concat(SWITCH.includes(name) || ['gov_fallback_drop', 'gov_use_fallback_precomp'].includes(name) ? SWITCH.concat(['gov_fallback_drop', 'gov_use_fallback_precomp']) : []);
// a row of a model family: the flag of the simulated values (gov_tune.simStale, a row that simulates), the caveats of the tm twins, and the
// text: whole parts in their order while it has 6 sentences or less (STE Rule 6.6; a change 4, because toRecommendation adds 2). A part is
// a text or part(text, value, unit, o): a part with its number is also an evidence row (the CLI file shows the number); a text that does
// not fit goes to row.notes (the Governor tab shows them, the CLI file does not)
const part = (text, value, unit, o) => ({ text, value: isNum(value) ? value : null, unit: unit || null, o: o || {} });
function mk(S, ctx, name, p, o) {
    const cav = [], tm = S.twins.find(t => t.scan), nc = S.twins.filter(t => t.noCurrent).map(t => t.factor);
    if (tm) cav.push(TEXT.tm(tm.factor));
    if (nc.length) cav.push(TEXT.tmCurrent(nc));
    const max = o.status === 'change' ? 4 : 6, n = (x) => x.split(/(?<=[.!?])\s+(?=[A-Z"])/).length, keep = [], evs = [], notes = [];
    let k = 0, full = false;
    for (const x of (o.parts || []).filter(Boolean)) {
        const t = typeof x === 'string' ? x : x.text; if (!t) continue;
        if (typeof x !== 'string') evs.push(ev(t, x.value, x.unit, x.o));
        if (!full && k + n(t) <= max) { keep.push(t); k += n(t); continue; }
        full = true;
        if (typeof x === 'string') notes.push(t);
    }
    const r = Object.assign({ method: 'simulation', caveats: cav }, o, { text: keep.join(' '), evidence: evs.concat(o.evidence || []), notes });
    delete r.parts;
    const row = GTU.row(ctx, name, p, r);
    if (row.method === 'simulation') row.stale = GTU.mergeStale(row.stale, GTU.simStale(ctx, simNames(name), p > 0 ? p : null, (S.train || []).concat(S.test || [])));
    return row;
}
const setText = (S) => part(TEXT.set(S.twins.length), S.twins.length, 'models');
// the result of the robustness rule as a part: the effect on the test flights (unit: the words of the text; u: the unit of the number)
const acceptText = (a, unit, d, u, what) => !a ? [] : [part(a.pass ? TEXT.accept(a, unit, d, what) : a.n < RULES.scnAccept.minUnits ? TEXT.acceptNoData : TEXT.acceptNo, r3(a.mean, 4), u, { lo: r3(a.lo, 4), hi: r3(a.hi, 4), n: a.n })];
const naRows = (S, k) => (ctx) => GTU.pendingRows(ctx, k).map(r => Object.assign(r, { status: 'not-applicable', reason: S.reason, text: S.reason }));
const notRec = (S, ctx, name, p, rule, why) => mk(S, ctx, name, p, { topic: 'model', rule, method: 'model', status: 'not-recorded', reason: why, parts: [why] });

function powerRows(S, ctx) {
    const X = S.power, out = [], T = TEXT.power, V = S.ocv ? S.ocv.end : null;
    for (const p of ctx.profiles) {
        const x = X && X.profiles[p], why = !x ? TEXT.noProfile(p) : x.reason;
        if (why) { out.push(notRec(S, ctx, 'gov_headspeed', p, 'scnPower', why)); continue; }
        const evs = [ev(T.q95(V, x.Hf, x.qE[1], x.q95E[0], x.q95E[1]), x.qE[1], 'fraction', { lo: r3(x.q95E[0], 4), hi: r3(x.q95E[1], 4), n: x.blocks }),
            ev(T.q50(x.qE[0], x.qE[2]), x.qE[0], 'fraction'), ev(T.full(x.qF[1]), x.qF[1], 'fraction')];
        if (x.log && x.twinR) evs.push(ev(T.logSat(x.log.share, x.twinR.share), x.log.share, 'fraction'));
        if (isNum(x.q95Log)) evs.push(ev(T.logQ(x.q95Log, x.q95R), x.q95Log, 'fraction'));
        if (S.ocv) {
            evs.push(ev(`${T.satModel(V, x.E.share)} ${T.satNote}`, x.E.share, 'fraction', { lo: r3(x.E.shareSet[0], 5), hi: r3(x.E.shareSet[1], 5) }), ev(T.satModel(S.ocv.full, x.F.share), x.F.share, 'fraction', { lo: r3(x.F.shareSet[0], 5), hi: r3(x.F.shareSet[1], 5) }));
            for (const c of X.curve) if (c.profiles[p]) evs.push(ev(TEXT.curve(c.rest, c.profiles[p].share), c.profiles[p].share, 'fraction'));
        }
        if (isNum(x.hmaxMain)) evs.push(ev(`${T.max(x.hmaxMain, x.hmaxSet[0], x.hmaxSet[1])} ${T.thrust}`, x.hmaxMain, 'rpm', { lo: x.hmaxSet[0], hi: x.hmaxSet[1] }));
        if (isNum(x.hmaxSame[0])) evs.push(ev(T.same(x.hmaxSame[0], x.thrust), x.hmaxSame[0], 'rpm', { lo: x.sameSet[0], hi: x.sameSet[1] }));
        const t = [T.q95(V, x.Hf, x.qE[1], x.q95E[0], x.q95E[1])].concat(x.extra > 0 ? [part(T.extra(x.extra), x.extra, 'fraction'), T.reserve(x.reserveAdj)] : [T.reserve(x.reserveE)]);
        const more = [], sat = S.ocv ? part(T.sat(V, x.Eadj.share, x.Eadj.droop95), x.Eadj.share, 'fraction') : null;
        let status = 'keep', to = null, title = null;
        let opt = false;
        if (x.fails) {
            title = T.title(p); status = 'check';
            const good = !!(x.accept && x.accept.pass) && !(x.glitch && !x.glitch.ok), logSat = x.logSatS >= RULES.scnPower.minSatS, pass = good && logSat;
            // never status 'change': the headspeed is the decision of the pilot (user, 2026-10-15). A passing headspeed is an opt-in check
            opt = good;
            t.push(isNum(x.hmaxSet[0]) ? T.max(x.hmaxMain, x.hmaxSet[0], x.hmaxSet[1]) : `${T.noMax} ${T.noMaxWhy}`);
            if (pass) { t.push(T.stepEv(x.candidate)); more.push(part(T.yesSat(x.logSatS), x.logSatS, 's', { lo: RULES.scnPower.minSatS }), part(T.step(x.candidate), x.candidate, 'rpm')); }
            else if (good) t.push(part(T.noSat(x.logSatS), x.logSatS, 's', { lo: RULES.scnPower.minSatS }));
            // the periods at the maximum throttle of this PID profile in the logs of the model (check GT7: load, ACTIVE flight), the longest first,
            // each with its log and frame seconds (the evidence that the pilot can open in the log)
            const mine = new Set((S.train || []).concat(S.test || []));
            for (const q of ctx.M.periods.filter(q => q.profile === p && q.kind === 'max' && q.cause === 'load' && q.active && (!mine.size || mine.has(q.log))).sort((a, b) => b.s - a.s).slice(0, RULES.scnPower.periods))
                evs.push(ev(T.satPeriod(q), q.s, 's', { log: q.log, t0: q.t, t1: q.t1 }));
            if (x.glitch && !x.glitch.ok) t.push(T.glitchNo);
            if (x.glitch) evs.push(ev(T.glitch(x.candidate, x.glitch.limitRpm, x.glitch.maxRpm), x.glitch.maxRpm, 'rpm', { hi: x.glitch.limitRpm }));
            if (x.unique) evs.push(ev(T.unique(x.unique.from, x.unique.profile, x.unique.to), x.unique.from, 'rpm'));
            t.push(sat);
            if (x.accept) { more.push(...acceptText(x.accept, `points of time with the throttle more than ${pct(1 - RULES.scnPower.reserve, 0)} %`, 2, '%')); evs.push(ev(T.cand(x.candidate, x.accept.base, x.accept.cand), x.accept.cand, 'fraction')); }
            more.push(T.power);
        } else {
            t.push(T.ok, sat);
            if (isNum(x.hmaxSet[0]) && x.hmaxSet[0] > x.Hf) more.push(part(T.higher(x.hmaxSet[0]), x.hmaxSet[0], 'rpm'));
            if ((x.Eadj.share || 0) > 0) status = 'check';   // CLAUDE.md "Control limits": a period at the maximum throttle is not satisfactory
        }
        if (x.logMore) more.push(part(T.logMore, x.log.share - x.twinR.share, 'fraction'));
        if (opt) more.push(T.choice);
        const r = mk(S, ctx, 'gov_headspeed', p, { topic: 'model', rule: 'scnPower', status, to, title, parts: t.concat(more, [setText(S)]), evidence: evs });
        if (opt) { GTU.optIn(r, x.candidate, ctx); r.caveats = (r.caveats || []).concat([T.choiceNote]); }
        out.push(r);
    }
    return out;
}
function vcompRows(S, ctx) {
    const X = S.vcomp, out = [], T = TEXT.vcomp; if (!X || X.reason) return out;
    const meter = X.meter, esc = meter && meter !== 'ADC';
    for (const p of ctx.profiles) {
        const x = X.profiles[p] || {}, evs = [ev(T.gain(S.ocv.full, S.ocv.end, X.gain), X.gain, 'fraction'), ev(T.ff(X.ff), X.ff, 'fraction')];
        if (isNum(x.model)) evs.push(ev(T.driftModel(x.model, S.ocv.full, S.ocv.end), x.model, 'points'));
        if (isNum(x.pred) && x.n) evs.push(ev(T.drift(x.pred, x.log, x.n), x.pred, 'points', { n: x.n }));
        const s = X.sim && X.sim[p], t = [];
        let status = 'keep', to = null, reason = null;
        if (esc) { status = 'not-applicable'; reason = T.esc; t.push(T.esc, T.gain(S.ocv.full, S.ocv.end, X.gain), T.iterm); }
        else {
            t.push(T.gain(S.ocv.full, S.ocv.end, X.gain), T.ff(X.ff));
            if (s && s.off && s.on) { t.push((meter === 'ADC' ? T.adc : T.adcIf)(s.off.eRms, s.on.eRms)); evs.push(ev(T.droop(100 * s.off.droop95, 100 * s.on.droop95), s.on.droop95, 'fraction')); }
            if (meter === 'ADC' && X.accept) {
                if (X.accept.pass && String(ctx.val('gov_use_voltage_comp', p) || '').toUpperCase() !== 'ON') { status = 'change'; to = 'ON'; }
                t.push(...acceptText(X.accept, '% headspeed error', 2, '%'));
            } else if (!meter) t.push(T.unknown);
            if (X.pwrFilterSource === 'default') t.push(T.pwrDefault(X.pwrFilter));
        }
        out.push(mk(S, ctx, 'gov_use_voltage_comp', p, { topic: 'model', rule: 'scnVcomp', method: esc ? 'model' : 'simulation', status, to, reason, parts: t, evidence: evs }));
    }
    if (meter === 'ADC') out.push(mk(S, ctx, 'gov_pwr_filter', 0, { topic: 'model', rule: 'scnVcomp', method: 'model', status: 'keep', parts: [T.pwr] }));
    return out;
}
function spoolRows(S, ctx) {
    const X = S.spool, out = [], cur = ctx.current.byName.gov_spoolup_time[0], T = TEXT.spool;
    if (!X || X.reason) {
        const why = X && X.reason === 'noSpool' ? T.noSpool : TEXT.noModel;
        out.push(notRec(S, ctx, 'gov_spoolup_time', 0, 'scnSpool', why));
        for (const p of ctx.profiles) out.push(notRec(S, ctx, 'gov_use_pid_spoolup', p, 'scnSpool', why));
    } else {
        const c = X.current, logs = ctx.M.spoolups.filter(q => !q.excluded && !q.airborne && q.overshoot !== null && (!cur.logs || !cur.logs.length || cur.logs.includes(q.log))), os = logs.map(q => 100 * q.overshoot);
        const trust = S.validationSpool || [], t = [T.cur(c.value, c.main[1], c.set[0], c.set[1])], more = [T.levels];   // levels: a note (the numbers are in the evidence)
        // use: the values of the change, or of a check with opt-in CLI text (fewer test spool-ups than the rule needs, and each test spool-up of
        // each model has less overshoot). The values of a change of the PID spool-up are one group (the time needs the flags: all or none)
        const A = X.accept, pass = !!(A && A.pass), few = !!(X.candidate && A && !pass && A.n < RULES.scnAccept.minUnits && A.better);
        const use = !X.passNow && (pass || few) ? X.candidate : null, flagsTo = use ? use.flags : null;
        const chgP = use ? ctx.profiles.filter(p => flagsTo[p] && flagsTo[p] !== c.flags[p]) : [], chgT = !!use && use.value !== c.value;
        const grp = chgP.length + (chgT ? 1 : 0) > 1 ? { group: 'GC3:spoolup', groupSize: chgP.length + (chgT ? 1 : 0) } : {};
        const pidTo = !!use && profilesOn(use.flags) && !profilesOn(c.flags), need = pidTo ? [T.needPid(use.value, X.minCurrent)] : [];
        // a change with the PID spool-up: that value first (the 4 sentences of a change), not the smaller value without it
        if (pidTo) t.push(X.pidNow ? T.pidNow(c.value) : part(T.pid(X.minPid), X.minPid, '0.1 s'));
        if (os.length) t.push(T.log(median(os), Math.min(...os), Math.max(...os), os.length));
        if (trust.length) more.push(T.trust(trust));
        if (X.airborne) more.push(T.airborne);
        const evs = c.each.filter(e => e.key === 'main').map(e => ev(T.caseEv(e.profile, e.rest, e.os), e.os, '%'))
            .concat([ev(T.setEv, c.main[1], '%', { lo: r3(c.set[0], 2), hi: r3(c.set[1], 2), n: c.each.length })])
            .concat(trust.map(x => ev(T.trustEv(x), x.closed, '%', { log: x.log, t0: isNum(x.t) ? x.t : null })));
        // the test spool-ups of the main model at each voltage (the numbers of a check)
        if (A && A.units) for (const q of A.units) evs.push(ev(T.unitEv(q), q.cand, '%', { log: q.log, t0: q.t }));
        const acc = !A ? [] : few ? [part(T.few(A.n), A.n, 'spool-ups')] : acceptText(A, '% overshoot', 1, '%', 'spool-up');
        let status = 'keep', to = null, title = null;
        if (!X.passNow) {
            title = T.title; status = pass && !chgT ? 'keep' : pass ? 'change' : 'check'; if (status === 'change') to = use.value;
            t.push(T.cause);
            if (X.pidNow) { if (!pidTo) t.push(T.pidNow(c.value)); }
            else { t.push(isNum(X.minCurrent) ? part(T.min(X.minCurrent), X.minCurrent, '0.1 s') : T.none(RULES.scnSpool.max)); if (!pidTo && isNum(X.minPid) && X.minPid !== X.minCurrent) t.push(part(T.pid(X.minPid), X.minPid, '0.1 s')); }
            more.push(...acc, T.esc);
        } else { t.push(c.main[1] > RULES.scnSpool.overshoot ? T.withinTol(X.tol) : T.keep); if (isNum(X.minCurrent)) more.push(part(T.min(X.minCurrent), X.minCurrent, '0.1 s')); }
        const rt = mk(S, ctx, 'gov_spoolup_time', 0, Object.assign({ topic: 'model', rule: 'scnSpool', status, to, title, parts: t.concat(more, [setText(S)]), evidence: evs }, chgT ? grp : {}));
        if (chgT) rt.caveats.push(...need);
        if (chgT && few) GTU.optIn(rt, use.value, ctx);
        out.push(rt);
        for (const p of ctx.profiles) {
            const f = c.flags[p], chg = chgP.includes(p), u = [f === 'unknown' ? T.unknownPid(GTU.REG.gov_use_pid_spoolup.default) : T.keepPid(f)];
            if (!(X.own || []).includes(p)) u.push(T.otherLoad);
            if (!X.passNow && (X.pidNow || isNum(X.minPid))) u.push(X.pidNow ? T.pidNow(c.value) : part(T.pid(X.minPid), X.minPid, '0.1 s'));
            if (chg) u.push(...acc);
            const st = chg && pass ? 'change' : !X.passNow ? 'check' : 'keep';
            const r = mk(S, ctx, 'gov_use_pid_spoolup', p, Object.assign({ topic: 'model', rule: 'scnSpool', status: st, to: st === 'change' ? flagsTo[p] : null, title: st === 'check' ? T.title : null, parts: u }, chg ? grp : {}));
            if (chg) r.caveats.push(...need);
            if (chg && few) GTU.optIn(r, flagsTo[p], ctx);
            out.push(r);
        }
    }
    // the start of the motor and the throttle decrease (keep, with the numbers of the model)
    const m = S.mainParams, st = ctx.num('gov_startup_time', 0), sd = ctx.num('gov_spooldown_time', 0);
    out.push(mk(S, ctx, 'gov_startup_time', 0, { topic: 'model', rule: 'scnSpool', method: 'model', status: st === null ? 'not-recorded' : 'keep', parts: [isNum(st) && m ? T.startup(m.u0, st, m.u0 * st / 10) : '', T.keep] }));
    const hover = S.power && S.power.profiles ? median(Object.values(S.power.profiles).map(x => x.qF && x.qF[0]).filter(isNum)) : null;
    out.push(mk(S, ctx, 'gov_spooldown_time', 0, { topic: 'model', rule: 'scnSpool', method: 'model', status: sd === null ? 'not-recorded' : 'keep', parts: [isNum(sd) && isNum(hover) ? T.spooldown(sd, hover, hover * sd / 10) : '', T.keep] }));
    // a BAILOUT from a slow rotor
    const Bo = S.bailout, B = TEXT.bailout;
    if (Bo && Bo.relevant) {
        const t = [], evs = [], y = Bo.synthetic;
        if (y && !y.none) { t.push(B.model(y.share, y.Hf), B.res(y.satS, y.satSet[0], y.satSet[1], y.overshoot)); evs.push(ev(B.res(y.satS, y.satSet[0], y.satSet[1], y.overshoot), y.satS, 's', { lo: y.satSet[0], hi: y.satSet[1] }));
            if (y.noExit) evs.push(ev(B.noExit(y.noExit, y.rows.length), y.noExit, null)); }
        else if (y && y.none) t.push(B.none);
        for (const b of Bo.recorded) if (b.main) { const x = B.log(b.log, b.t, b.main, b.log_.satS, b.log_.overshoot); t.push(x); evs.push(ev(x, b.main.satS, 's', { lo: b.satSet[0], hi: b.satSet[1], log: b.log, t0: b.t })); }
        t.push(B.do);
        out.push(mk(S, ctx, 'gov_autorotation_timeout', 0, { topic: 'model:bailout', rule: 'scnBailout', status: 'check', title: B.title, parts: t, evidence: evs }));
    }
    return out;
}
function trackingRows(S, ctx) {
    const X = S.tracking, T = TEXT.tracking;
    if (!X || !X.profiles || !Object.keys(X.profiles).length) return [notRec(S, ctx, 'gov_tracking_time', 0, 'scnTracking', TEXT.noModel)];
    const t = [], evs = [], V = S.ocv ? S.ocv.end : null, P = Object.entries(X.profiles), ok = P.filter(([, x]) => !x.none);
    for (const [p, x] of P) {
        if (x.none) { t.push(T.noneP(+p)); continue; }
        evs.push(ev(T.accEv(+p, x.acc), x.acc, 'rpm/s', { lo: r3(x.accSet[0], 0), hi: r3(x.accSet[1], 0) }));
        if (isNum(x.slope)) evs.push(ev(T.slopeEv(+p, x.slope), x.slope, 'rpm/s'));
    }
    if (ok.length) t.push(T.acc(Math.min(...ok.map(([, x]) => x.acc)), V));
    if (isNum(X.value) && ok.some(([, x]) => isNum(x.slope))) t.push(T.slope(X.value, Math.max(...ok.filter(([, x]) => isNum(x.slope)).map(([, x]) => x.slope))));
    if (isNum(X.min)) { const [lp, lx] = P.filter(([, x]) => isNum(x.minSet[1])).reduce((a, q) => !a || q[1].minSet[1] > a[1].minSet[1] ? q : a, null);
        t.push(part(T.min(X.min, lx.minSet[0], lx.minSet[1]), X.min, '0.1 s', { lo: lx.minSet[0], hi: lx.minSet[1] }), T.limit(+lp, S.power && S.power.profiles[lp] ? S.power.profiles[lp].Hf : 'unknown')); }
    let status = 'keep', to = null;
    if (X.ok) t.push(T.ok);
    else if (X.accept) { t.push(...acceptText(X.accept, 's at the maximum throttle', 2, 's')); status = X.accept.pass ? 'change' : 'check'; if (X.accept.pass) to = X.candidate; }
    else if (P.some(([, x]) => x.none)) status = 'check';
    return [mk(S, ctx, 'gov_tracking_time', 0, { topic: 'model', rule: 'scnTracking', status, to, parts: t.concat([setText(S)]), evidence: evs })];
}
function fallbackRows(S, ctx) {
    const X = S.fallback, out = [], T = TEXT.fallback;
    if (!X || X.reason) {
        const why = X && X.reason === 'noEvent' ? T.none : TEXT.noModel;
        out.push(notRec(S, ctx, 'gov_recovery_time', 0, 'scnFallback', why));
        for (const p of ctx.profiles) for (const name of ['gov_fallback_drop', 'gov_use_fallback_precomp']) out.push(notRec(S, ctx, name, p, 'scnFallback', why));
        return out;
    }
    const all = X.events.all, best = X.events.best, n = X.times.reduce((s, r) => s + r.list.length, 0), k = X.times.reduce((s, r) => s + r.list.filter(x => x.kind !== 'random').length, 0);
    const changed = JSON.stringify(X.best) !== JSON.stringify(X.current), pass = !!(X.accept && X.accept.pass && X.problem);
    const what = (a) => fbWhat(a, X.current);
    const head = [T.base(all.min, all.n)].concat(changed ? [T.alt(what(X.best), best.min)] : [T.same]);
    const more = [part(T.times(n, k, n - k), n, 'errors')].concat(changed ? [part(T.total(all.loss, best.loss), best.loss, '% s'), part(T.under(all.under, best.under), best.under, 's')] : [], [TEXT.selection(S.train)]);
    const acc = changed && X.problem && X.accept ? acceptText(X.accept, '% s of total headspeed decrease', 2, '% s', 'error') : changed && !X.problem ? [T.noProblem] : [];
    const evTried = (X.tried || []).map(x => ev(T.tried(what(x.values) || NOW, x), x.loss, '% s', { n: x.n })), evs = evTried.slice();
    // the throttle decrease at the errors at the maximum throttle (the cue rule), the BAILOUT and RECOVERY cases of the recovery times
    if (all.cueN && isNum(all.cue) && isNum(best.cue)) evs.push(ev(T.cue(all.cue, best.cue, all.cueN), best.cue, 'fraction', { lo: all.cue, n: all.cueN }));
    const cueNo = (X.tried || []).some(x => x.cueOk === false && x.values.precomp && Object.values(x.values.precomp).includes('ON')) ? [T.cueNo()] : [];
    const rec = ((X.recovery || {}).tried || []).map(q => { const dO = Math.max(0, ...q.cand.map((c, j) => c && q.base[j] && isNum(c.overshoot) && isNum(q.base[j].overshoot) ? c.overshoot - q.base[j].overshoot : 0)),
        dS = Math.max(0, ...q.cand.map((c, j) => c && q.base[j] ? c.satS - q.base[j].satS : 0)); evs.push(ev(T.recCase(q.value, dO, dS), dO, '% points', { n: q.cand.length })); return q; });
    const recNo = rec.filter(q => !q.ok).map(q => T.recNo(q.value)), cons = X.accept && (X.accept.constraints || []).length ? [T.cons(X.accept.constraints[0].label)] : [];
    // the precomp and the drop of one PID profile: one group (all or none: the cue rule depends on the pair)
    const chg = {};
    // gov_recovery_time (global): the errors of all PID profiles
    const ch0 = pass && X.best.recovery !== null && String(X.best.recovery) !== String(X.current.recovery), a0 = X.assumed && X.assumed.recovery;
    out.push(mk(S, ctx, 'gov_recovery_time', 0, { topic: 'model', rule: 'scnFallback', status: ch0 ? 'change' : 'keep', to: ch0 ? X.best.recovery : null,
        parts: head.slice(0, 1).concat(a0 ? [T.assumed('gov_recovery_time', X.current.recovery, a0)] : [], head.slice(1), [T.cause], acc, cons, [T.rate], recNo, [T.recovery], more), evidence: evs }));
    // the drop and the precomp of PID profile p: the errors of p only (X.profiles[p] on all flights, X.accept.profiles[p] on the test flights).
    // A change needs the rule on the errors of p. With fewer test errors than the rule needs, and the rule passed on all errors: a check with
    // opt-in CLI text (review 2026-10-15: a PID profile with 2 errors does not get a change that the other PID profiles show)
    for (const p of ctx.profiles) {
        const y = X.profiles[p];
        if (!y || !y.base.n) { for (const name of ['gov_fallback_drop', 'gov_use_fallback_precomp']) out.push(mk(S, ctx, name, p, { topic: 'model', rule: 'scnFallback', status: 'keep', parts: [T.noEvent(p)] })); continue; }
        const Ap = X.accept && X.accept.profiles ? X.accept.profiles[p] || null : null, consP = Ap && Ap.constraints && Ap.constraints.length ? [T.cons(Ap.constraints[0].label)] : [];
        const passP = changed && X.problem && !!Ap && Ap.pass, few = changed && X.problem && pass && !!Ap && !Ap.pass && Ap.n < RULES.scnAccept.minUnits && !consP.length;
        const accP = !changed ? [] : !X.problem ? [T.noProblem] : !Ap ? acc : few ? [part(T.few(p, Ap.n), Ap.n, 'errors')] : acceptText(Ap, '% s of total headspeed decrease', 2, '% s', 'error');
        // the values that the rows do not know and the model takes from the configuration (the value of the row first)
        const asm = X.assumed || { drop: {}, precomp: {} }, said = (name) => [['gov_fallback_drop', X.current.drop[p], asm.drop[p]], ['gov_use_fallback_precomp', X.current.precomp[p], asm.precomp[p]]]
            .filter(q => q[2]).sort((a, b) => (b[0] === name) - (a[0] === name)).map(q => T.assumed(q[0], q[1], q[2]));
        const headP = [T.baseP(y.base.min, y.base.n, p), changed ? T.alt(what(X.best), y.best.min) : T.same];
        const moreP = (changed ? [part(T.total(y.base.loss, y.best.loss), y.best.loss, '% s', { n: y.best.n }), part(T.under(y.base.under, y.best.under), y.best.under, 's')] : []).concat([T.all, TEXT.selection(S.train)]);
        const evP = y.base.cueN && isNum(y.base.cue) && isNum(y.best.cue) ? [ev(T.cue(y.base.cue, y.best.cue, y.base.cueN), y.best.cue, 'fraction', { lo: y.base.cue, n: y.base.cueN })] : [ev(T.cueNone(p), 0, 'errors', { n: 0 })];
        const rowOf = (name, cur, to, extra) => { const diff = to !== null && to !== undefined && String(to) !== String(cur), ch = passP && diff, opt = few && diff;
            // a value that does not change: the result of the other value, with no text of a change that the app does not select. An opt-in
            // check: the reason (too few test errors) before the cause, so that the text shows it
            const r = mk(S, ctx, name, p, { topic: 'model', rule: 'scnFallback', status: ch ? 'change' : opt ? 'check' : 'keep', to: ch ? to : null,
                parts: headP.concat(opt ? accP : [], said(name), [T.cause], opt || (few && !diff) ? [] : accP, consP, extra || [], moreP), evidence: evP.concat(evTried) });
            if (opt) GTU.optIn(r, to, ctx);
            if (ch || opt) (chg[p] || (chg[p] = [])).push(r); return r; };
        out.push(rowOf('gov_fallback_drop', X.current.drop[p], X.best.drop[p], [T.drop].concat(cueNo)));
        out.push(rowOf('gov_use_fallback_precomp', X.current.precomp[p], X.best.precomp[p], cueNo.concat([T.recovery])));
    }
    for (const [p, l] of Object.entries(chg)) if (l.length > 1) for (const r of l) Object.assign(r, { group: `GC5:fallback:${p}`, groupSize: l.length });
    return out;
}
function trialRows(S, ctx) {
    const X = S.trial, out = [], T = TEXT.trial, vs = RULES.scnTrial.values, vCli = vs[vs.length - 1], G = ctx.M.glitch, q = (p) => G && G.byProfile ? G.byProfile[String(p)] : null;
    const glitch = (p) => ctx.M.fallbacks.some(f => f.atMax && f.profile === p) || (!!q(p) && q(p).k > 0 && ctx.M.prof[p] && ctx.M.prof[p].share >= RULES.scnTrial.minShare);
    for (const p of ctx.profiles) {
        const y = X && X.profiles[p], base = S.power && S.power.profiles[p], cur = ctx.num('gov_max_throttle', p), c = isNum(cur) ? cur : 100;
        if (!y || !base || !base.E) { out.push(notRec(S, ctx, 'gov_max_throttle', p, 'scnTrial', TEXT.noProfile(p))); continue; }
        // check G21 gives a change for p: the cost of its value in the model, a check with no CLI text of its own (no second set line)
        // (without a model result for that value: the same check with no cost, never the opt-in CLI text of the test below)
        const g = GTU.g21Change(G, p, ctx.maxThr(p));
        if (g) {
            const v = g.to, yv = y[v], evs = yv ? [ev(T.cost(v, yv.share, base.E.share, c), yv.share, 'fraction', { lo: r3(yv.shareSet[0], 5), hi: r3(yv.shareSet[1], 5) }),
                ev(T.droop(v, yv.droop95, base.E.droop95), yv.droop95, 'fraction', { lo: r3(yv.droopSet[0], 4), hi: r3(yv.droopSet[1], 4) })] : [];
            out.push(mk(S, ctx, 'gov_max_throttle', p, { topic: 'model', rule: 'scnTrial', status: 'check', title: T.g21Title(p, v),
                parts: [T.g21(v, g.test)].concat(yv ? [T.cost(v, yv.share, base.E.share, c), T.droop(v, yv.droop95, base.E.droop95)] : [T.g21NoModel], [T.exit]), evidence: evs,
                g21Cost: yv && isNum(yv.droop95) && isNum(base.E.droop95) ? { to: v, from: c, droop: r3(yv.droop95, 4), droopNow: r3(base.E.droop95, 4), share: r3(yv.share, 5), shareNow: r3(base.E.share, 5),
                    text: T.g21Cost(v, yv.droop95, base.E.droop95) } : null }));
            continue;
        }
        const evs = vs.filter(v => y[v]).map(v => ev(T.cost(v, y[v].share, base.E.share, c), y[v].share, 'fraction', { lo: r3(y[v].shareSet[0], 5), hi: r3(y[v].shareSet[1], 5) }))
            .concat(vs.filter(v => y[v]).map(v => ev(T.droop(v, y[v].droop95, base.E.droop95), y[v].droop95, 'fraction', { lo: r3(y[v].droopSet[0], 4), hi: r3(y[v].droopSet[1], 4) })));
        // CLAUDE.md "Control limits": a PID profile with a period at the maximum throttle is a check, not 'keep'
        const ok = !!(glitch(p) && (cur === null || cur > vCli) && y[vCli]), per = ctx.M.periods.filter(x => x.profile === p), atMax = per.length ? [part(T.atMax(per.length, per.reduce((a, x) => a + x.s, 0)), per.length, 'periods')] : [];
        // no sudden change at the maximum: "no error" needs minOkS at the maximum (check G21, health_gov g21Pool), else not measured;
        // sudden changes at the maximum that check G21 does not give as a change: their count, not "no error"
        const qp = q(p), minOk = HG.DEFAULT_RULES.G21.minOkS, some = !!qp && qp.k > 0, unmeasured = !some && !(qp && qp.atMaxS >= minOk);
        const why = unmeasured ? (qp && qp.atMaxS > 0 ? T.short(qp.atMaxS, minOk) : T.noTime) : null;
        const t = ok ? [T.do(vCli), T.cost(vCli, y[vCli].share, base.E.share, c), T.droop(vCli, y[vCli].droop95, base.E.droop95), T.exit].concat(atMax)
            : unmeasured ? [why].concat(atMax) : some ? [T.some(qp.k, qp.N)].concat(atMax) : [T.none].concat(atMax, [T.keep]);
        const r = mk(S, ctx, 'gov_max_throttle', p, Object.assign({ topic: 'model', rule: 'scnTrial', status: ok || per.length ? 'check' : unmeasured ? 'not-recorded' : 'keep',
            title: ok ? T.title(p) : per.length ? TEXT.power.atMaxTitle(p) : null, parts: t, evidence: evs }, !ok && unmeasured ? { reason: why } : {}));
        if (ok) GTU.optIn(r, vCli, ctx);
        out.push(r);
    }
    return out;
}
function bypassRows(S, ctx) {
    const X = S.bypass, T = TEXT.bypass;
    if (!X || X.reason) return [notRec(S, ctx, 'gov_bypass_throttle', 0, 'scnBypass', TEXT.noModel)];
    const t = [T.curve(X.Hf, X.profile, X.rest), T.use, (isNum(X.kLog) ? T.stickLog(X.kLog) : T.stick(RULES.scnBypass.mixerPerStick)), T.rate].concat(X.over ? [T.high(X.over)] : [], [setText(S)]);
    const evs = X.stick.map((c, j) => ev(T.point(c, X.values[j], X.lo[j], X.hi[j]), X.values[j], '0.5 %', { lo: X.lo[j], hi: X.hi[j] }));
    const r = mk(S, ctx, 'gov_bypass_throttle', 0, { topic: 'model', rule: 'scnBypass', method: 'model', status: 'check', title: T.title, parts: t, evidence: evs });
    GTU.optIn(r, X.values, ctx);
    return [r];
}
// all PID profiles of flags have the PID spool-up ON
const profilesOn = (flags) => !!flags && Object.values(flags).length > 0 && Object.values(flags).every(v => String(v).toUpperCase() === 'ON');

function families(S) {
    if (!S || S.reason) return Object.fromEntries(MINE.map(k => [k, naRows(S || { reason: TEXT.noModel }, k)]));
    return { power: (ctx) => powerRows(S, ctx).concat(vcompRows(S, ctx)), spoolup: (ctx) => spoolRows(S, ctx), tracking: (ctx) => trackingRows(S, ctx),
        fallback: (ctx) => fallbackRows(S, ctx), maxThrottle: (ctx) => trialRows(S, ctx), bypass: (ctx) => bypassRows(S, ctx) };
}
// the opt-in CLI text of the check rows in the recommendations
function finish(res) {
    for (const x of res.recommendations) {
        const r = res.rows.find(q => q.id === x.row);
        if (!r || !r.optIn || !r.optIn.cli.length || x.severity !== 'check') continue;
        Object.assign(x, { optIn: true, cli: r.optIn.cli, to: r.optIn.toCli, fromSets: r.optIn.fromSets, caveats: x.caveats.concat(r.optIn.caveats) });
    }
    return res;
}
// S without the internal arrays (the result for the app: numbers and plot data)
function summary(S) { return JSON.parse(JSON.stringify(S, (k, v) => ArrayBuffer.isView(v) ? Array.from(v) : typeof v === 'number' && !isFinite(v) ? null : v)); }

async function tune(runs, o = {}) {
    const rec = o.recovered || GP.recover(runs, { cli: o.cli || null }), base = o.base || GTU.tune(runs, { recovered: rec, cli: o.cli || null });
    const S = await evaluate(runs, Object.assign({}, o, { recovered: rec, base }));
    const res = finish(GTU.tune(runs, { recovered: rec, cli: o.cli || null, families: families(S) }));
    res.scenarios = summary(Object.assign({}, S, { mainParams: undefined }));
    res.notes = res.notes.concat(S.notes || []);
    return res;
}

module.exports = { RULES, TEXT, evaluate, families, finish, tune, summary, twinSet, softSet, dReq, bootstrap, acceptOf, glitchSets, glitchEvents, stats, profOf, scaleRun, maxHs, blocksOf };
if (require.main !== module) return;

// node tools/autotune/gov_scenarios.cjs <data dir> <result.json of analysis/governor-twin/dev.cjs> [--cli <dump>] [--disarm <json>] [--json <out>]:
// the scenario rows of a dev data directory with an identified twin
(async () => {
    const fs = require('fs'), path = require('path'), args = process.argv.slice(2), opt = (k) => { const j = args.indexOf(k); return j >= 0 ? args.splice(j, 2)[1] : null; };
    const cliFile = opt('--cli'), disarm = opt('--disarm'), jsonOut = opt('--json'), [dir, resFile] = args;
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')), events = {};
    if (disarm) { const d = JSON.parse(fs.readFileSync(disarm, 'utf8')); for (const s of meta.segments) events[s.log] = (d.us[s.log] || []).map(us => ({ t: (us - s.timeStartUs) / 1e6 + (s.fromS || 0), name: 'DISARM' })); }
    const runs = GD.load(dir, { bench: true, events }), cli = cliFile ? fs.readFileSync(cliFile, 'utf8') : null, R = JSON.parse(fs.readFileSync(resFile, 'utf8'));
    const params = GT.copy(R.model.params), model = { params, samples: (R.samples || []).map(s => GT.copy(params, s)), uncertainty: R.params, split: R.model.split, Href: R.model.Href, has: R.model.has };
    const validation = { status: R.status, checks: R.acceptance, tmScan: R.validation.tmScan, events: R.validation.events };
    const t0 = Date.now(), res = await tune(runs, { model, validation, cli, progress: (f, t) => process.stderr.write(`\r${t} ${(100 * f).toFixed(0)} %   `) });
    process.stderr.write('\n');
    const mine = res.rows.filter(r => /^model/.test(r.topic));
    console.log(GTU.table(mine));
    console.log(`timing ${JSON.stringify(res.scenarios.timing)} total ${(Date.now() - t0) / 1000} s`);
    if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ rows: mine, scenarios: res.scenarios, recommendations: res.recommendations.filter(x => mine.some(r => r.id === x.row)) }, null, 1));
})().catch((e) => { console.error(e); process.exit(1); });
