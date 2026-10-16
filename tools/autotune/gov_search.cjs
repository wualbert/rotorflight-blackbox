'use strict';

/**
 * Governor autotune: the continuous search families of docs/GOVERNOR_AUTOTUNE.md section 7 (precomp, gains, filters, limits) on the
 * identified governor twin (gov_fit) with the native governor in closed loop (gov_sim). The search is async (gov_sim.run); the
 * families of gov_tune are synchronous, so the search runs first and the families read its result from ctx.sim:
 *
 *   const S = await search(runs, { model, validation, configs | recovered + cli, budgetMs, nomad, progress });
 *   gov_tune.tune(runs, { recovered, cli, model, sim: S, families: FAMILIES })
 *
 *   search(runs, o)  runs: gov_data runs of one file (flight runs are used). o:
 *     model        gov_fit.identify result: params, samples (bootstrap and jackknife parameter sets), split, status
 *     validation   gov_fit.validate result (status, checks, tmScan): 'rejected' stops the search; a failed tmBand adds the tm-scan winner
 *                  to the twin set
 *     configs      gov_sim.configOf(runs, recovered, { cli }) (else made from o.recovered / o.cli)
 *     families     the families to search (default all: precomp, gains, filters, limits)
 *     nomad        false: no NOMAD refinement. NOMAD stops after RULES.nomad.evaluations points (repeatable on each computer); budgetMs
 *                  (RULES.nomad.budgetMs) is a safety limit only: a stop there gives the note nomadTime. deadline and minMs are not used
 *     progress(f, text)
 *   -> S { status 'ok' | 'unavailable', reason, twins, split, profiles { p: { trainS, testS } }, current, baseline, windows, margin,
 *          stages { precomp, gains, filters, nomad, limits }, accept { family: { profiles: { p: decision }, global: decision } },
 *          final (accepted values), plot, notes, timing, ms }
 *   FAMILIES { precomp, gains, filters, limits }(ctx)  the rows of gov_tune (row format of gov_tune.row), from ctx.sim. The values of one
 *                accepted (or opt-in) decision are one group (advice.cjs group: all or none); a row that simulates has the flags of the
 *                simulated values (gov_tune.simStale)
 *
 * Order (SPEC 7, selection on the training flights with the main twin): 1. precomp: the feedforward design (designPrecomp: the steady extra
 * throttle of the twin, gov_gain fixed), verified on the training flights (over95, thrHF, J); 2. gains: I grid, P grid, D {0, current, +},
 * then P, I and D together (scale) for a PID profile whose values do not pass M; 3. filters (global): gov_rpm_filter (never up: the twin has
 * no RPM noise; the FALLBACK glitch reference of each cutoff is reported), gov_ff_filter, gov_d_filter (only with a D-gain); 4. NOMAD
 * (filter_optimizer.minimize, P and I of each PID profile, RULES.nomad): the library calls the evaluation synchronously, and a simulation is
 * async, so each new point stops the library and it runs again from the start with the cache (deterministic: the same points); 5. limits:
 * the terms of the selected values (termsOf) on all flights; a limit reached outside saturation gets a larger value.
 *
 * Objective and constraints. The metrics are those of gov_sim.metrics, in 10-s blocks of logged ACTIVE samples (the same blocks for each
 * candidate: paired). J = (e_rms + 0.5 droop95 + 0.5 over95 + 0.25 thrHF) with each term divided by its baseline value, divided by 2.25
 * (J = 1 at the baseline). Constraints: the margin test M, satShare <= baseline + satTol, iLimitOutsideSat <= baseline + iLimTol.
 * Acceptance, each family in the order above on the values accepted before it: with each twin of the uncertainty set (the main twin, up to
 * RULES.twins.max bootstrap / jackknife twins at the extremes of tm, load, kv and te, the tm-scan winner when tmBand fails, and tm x 0.7 and
 * x 1.4 when the logs have no battery current: critique C13), on the test flights, a paired block-bootstrap improvement of J > z SE and
 * >= minPct (the same blocks for the values before the change and the candidate), the satShare and iLimitOutsideSat constraints, and M:
 * satisfactory for a change of the gains, not worse (worseTol) for the other families. At the end-of-pack OCV (scenario E, main twin, all
 * flights) satShare <= baseline (1 + satRelE) + satTol. The interval of the effect is the range of imp ± z SE over the set. A change that
 * makes M satisfactory is still a recommendation only with the improvement of J (fix: reported; the rows of gains that do not pass M are
 * 'check' with these values). Without battery current, a change that increases an effective gain (K Kp, K Ki, K Kd) is a 'check' with
 * opt-in CLI text: the logs do not give the authority of the throttle on the headspeed (critique C13).
 *
 * Margin test M: a hover window of a recorded flight for each PID profile (logged ACTIVE, low collective activity, mean throttle under
 * 1 - headroom; training flights first, else a test flight: the window gives an operating point, not a test metric), the flight from its
 * arm to the window, the mixer inputs held at their window means for settleS, then +step collective for stepS. The step response is the
 * error with the step less the error of the same run without the step (no settling of the flight before the window). With P, I and D x2
 * (6 dB), each error peak must be less than ratio x the peak before it, from the first peak of the expected sign; an oscillation on the slow
 * I-term recovery does not cross 0, so each swing between successive extrema must also be less than ratio x the swing before it (decay).
 */

const GS = require('./gov_sim.cjs');
const GT = require('./gov_twin.cjs');
const GP = require('./gov_params.cjs');
const TUNE = require('./gov_tune.cjs');
const PH_FLIGHT = require('./gov_data.cjs').PHASES.indexOf('flight');

const RULES = {
    // id: the rule number in the texts and the CLI file. source: in the words of the pilot (advice.cjs RULES.source)
    objective: { id: 'GS1', source: 'Rotorflight documentation, and a toolkit rule, no flight test', // GOVERNOR_AUTOTUNE.md 7, models_and_guidance 7.1
        w: { eRms: 1, droop95: 0.5, over95: 0.5, thrHF: 0.25 }, floor: { eRms: 0.05, droop95: 0.05, over95: 0.05, thrHF: 0.05 }, // floor: % (a smaller baseline value is noise)
        // satRelE: at the end-of-pack OCV (E) the saturated share can be larger by this share of its baseline
        satTol: 0.002, satRelE: 0.1, iLimTol: 0.0005, minGain: 0.01, minActiveS: 10, blockS: 10, windowS: 1, worst: 0.05, hfHz: 5, satEps: 0.005, iLimitEps: 0.005,
        text: 'The tuning value J adds the headspeed error, the largest decreases and increases of the headspeed, and the fast throttle changes. The analysis divides each part by its value at this time.' },
    // factor: the gains of the test (6 dB); ratio: the largest ratio of successive error peaks; step: the collective steps (the first with the
    // throttle reserve headroom on the main twin); floor: % of the target, a smaller peak is not a peak; rel: a pair counts only if its first
    // peak is this share of the first peak or more; collStd: the largest standard deviation of the collective in the window
    margin: { id: 'GS2', source: 'Rotorflight documentation, and a toolkit rule, no flight test', factor: 2, ratio: 0.5, step: [0.2, 0.1], stepS: 2, afterS: 3, settleS: 2, preS: 0.5,
        floor: 0.05, rel: 0.1, peaks: 4, scanS: 0.25, collStd: 0.15, headroom: 0.1, activeS: 1, worseTol: 0.05, points: 1500,   // points: the plot of the step response   // worseTol: a change of another family can keep a ratio that is not satisfactory, if it does not increase it by more than this share
        get text() { return `With the P-gain, the I-gain and the D-gain multiplied by ${this.factor} and no feedforward, a collective step must not cause an oscillation of the headspeed. Each error peak must be less than ${this.ratio * 100} % of the error peak before it.`; } },
    // curve: the range of gov_collective_curve; intTol, intAbs: the integer values can have this much more RMS error than the continuous fit
    // (relative, and absolute in throttle units);
    // overTol, hfTol: the largest increase of over95 and thrHF (relative) on the training flights
    precomp: { id: 'GS3', source: 'toolkit rule, no flight test', curve: [5, 40], maxSamples: 20000, intTol: 0.02, intAbs: 0.0005, overTol: 0.1, hfTol: 0.1,
        text: 'The feedforward values must give the throttle that is necessary in the governor model for the collective, the cyclic and the yaw.' },
    // grid: the multipliers of the I-gain and the P-gain; dStep: the D-gain step of the grid {0, current, +}; uniformTol: P and I multiplied by
    // the same value within this share give a "gov_gain" change
    // scale: P, I and D multiplied together, only for a PID profile whose values fail the margin test after the single grids
    gains: { id: 'GS4', source: 'Rotorflight documentation, and a toolkit rule, no flight test', grid: [0.5, 0.7, 1.4, 2], scale: [0.7, 0.5, 0.35, 0.25, 0.18, 0.12], dStep: 10, uniformTol: 0.02,
        text: 'The governor model flies the recorded flights with each gain. The analysis selects the gain with the smallest tuning value J and a satisfactory margin test.' },
    // grid: the multipliers of the filter cutoffs (Hz, integers); glitch: the firmware glitch limit, a share of the full headspeed
    // glitch: the firmware glitch limit, a share of the full headspeed; fallbackS: the time around a logged FALLBACK that the glitch reference leaves out
    filters: { id: 'GS5', source: 'firmware 4.6.0, and a toolkit rule, no flight test', grid: [0.5, 0.7, 1.4, 2], glitch: 0.25, fallbackS: 1,   // flight_governor.c:576, 588
        text: 'The governor model compares the filter cutoffs. The RPM signal of the governor model has no vibration. Thus, the analysis does not increase the cutoff of "gov_rpm_filter".' },
    // margin: the new limit is the largest term outside saturation multiplied by 1 + margin; minS: the time at a limit outside saturation that
    // gives a change; termMargin: a term within this of its limit is at its limit (gov_tune RULES.terms.margin); iStep: the I limit step (%)
    limits: { id: 'GS6', source: 'firmware 4.6.0, and a toolkit rule, no flight test', margin: 0.2, minS: 0.05, termMargin: 0.0015, iStep: 5,   // flight_governor.c:935-938
        text: 'A term of the governor must be at its limit only when the throttle is at its limit.' },
    // boot: bootstrap samples; z: the improvement must be more than z standard errors; minPct: and this % or more; q: the interval
    accept: { id: 'GS7', source: 'toolkit rule, no flight test', boot: 1000, z: 2, minPct: 1, minBlocks: 5, q: [0.05, 0.95], seed: 20261015,
        get text() { return `A change must decrease the tuning value J of the test flights by more than ${this.z} standard errors and by ${this.minPct} % or more. The limits must be satisfactory with all versions of the governor model.`; } },
    // max: the bootstrap / jackknife twins of the uncertainty set; noCurrent: the tm factors of the set without battery current (critique C13)
    twins: { max: 6, noCurrent: [0.7, 1.4] },
    // chooseShare: the part of budgetMs for the selection after the NOMAD evaluations (the margin test with each twin); choose: the best
    // evaluated points of each PID profile that the selection examines
    // evaluations: NOMAD stops after this many new points, so the same logs give the same gains on each computer (review 2026-10-15:
    // a time budget gave P 56, 60/47 and 59/49 on three runs of one Gaui dump); the time is only a safety limit, and a stop at the time
    // limit gives the note nomadTime
    nomad: { budgetMs: 90000, evaluations: 24, maxEvaluations: 60, range: [0.5, 2], chooseShare: 0.3, choose: 4 },
    endCell: 3.7,                             // V per cell of the end-of-pack OCV without a recorded rest voltage after a flight
};
const RULE_KEYS = { objective: 'gsObjective', margin: 'gsMargin', precomp: 'gsPrecomp', gains: 'gsGains', filters: 'gsFilters', limits: 'gsLimits', accept: 'gsAccept' };
// the rows use gov_tune.toRecommendation, which reads the rule of a row from gov_tune RULES: add these rules there
for (const [k, key] of Object.entries(RULE_KEYS)) if (!TUNE.RULES[key]) TUNE.RULES[key] = RULES[k];

const NAMES = {
    precomp: ['gov_f_gain', 'gov_collective_ff_weight', 'gov_cyclic_ff_weight', 'gov_yaw_ff_weight', 'gov_collective_curve'],
    gains: ['gov_gain', 'gov_p_gain', 'gov_i_gain', 'gov_d_gain'],
    filters: ['gov_rpm_filter', 'gov_ff_filter', 'gov_d_filter'],
    limits: ['gov_p_limit', 'gov_i_limit', 'gov_d_limit', 'gov_f_limit'],
};
const GLOBAL = new Set(NAMES.filters);
const PROFILE_NAMES = [].concat(NAMES.precomp, NAMES.gains, NAMES.limits, ['gov_headspeed', 'gov_max_throttle', 'gov_min_throttle']);
const ORDER = ['precomp', 'gains', 'filters', 'limits'];
const TERM = { P: 'gov_p_limit', I: 'gov_i_limit', D: 'gov_d_limit', F: 'gov_f_limit' };

const N = (l) => l + 1;
const isNum = (v) => typeof v === 'number' && isFinite(v);
const r = (v, d = 3) => isNum(v) ? +v.toFixed(d) : null;
const fmt = (v, d = 1) => isNum(v) ? String(+v.toFixed(d)) : 'unknown';
const prof = (p) => p > 0 ? `PID profile ${p}` : 'PID profile unknown';
const clampInt = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(v)));
const range = (name) => (TUNE.REG[name] || { range: [0, 250] }).range;
const copy = (v) => ({ global: Object.assign({}, v.global), profiles: Object.fromEntries(Object.entries(v.profiles).map(([p, o]) => [p, Object.assign({}, o)])) });
const vkey = (v) => JSON.stringify([Object.keys(v.global).sort().map(k => [k, v.global[k]]), Object.keys(v.profiles).sort().map(p => [p, Object.keys(v.profiles[p]).sort().map(k => [k, v.profiles[p][k]])])]);
function quantile(a, q) { if (!a.length) return null; const s = Float64Array.from(a).sort(), x = q * (s.length - 1), i = Math.floor(x); return i + 1 < s.length ? s[i] + (x - i) * (s[i + 1] - s[i]) : s[i]; }
const median = (a) => quantile(a, 0.5);
function rng(seed) { let s = seed >>> 0; return () => { s = s + 0x6D2B79F5 >>> 0; let t = s; t = Math.imul(t ^ t >>> 15, t | 1); t ^= t + Math.imul(t ^ t >>> 7, t | 61); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }

// ---------------------------------------------------------------------------------------------
// texts (STE)
// ---------------------------------------------------------------------------------------------

const pc = (x, d = 1) => fmt(100 * x, d);
const TEXT = {
    noModel: 'The governor model is not available. Thus, the analysis does not calculate this value.',
    unknownProfile: 'PID profile unknown. Thus, the analysis does not calculate this value.',
    rejected: 'The governor model does not agree with the test flights. Thus, the analysis does not calculate this value.',
    noSplit: 'The analysis must have flights to select the values and test flights, with the governor in ACTIVE. The logs do not have these flights.',
    noState: (log) => `Log ${N(log)} does not record the governor conditions ("GOVERNOR_STATE"). Thus, the governor model does not use this log.`,
    excluded: (log, why) => `The governor model does not use log ${N(log)}. ${why}`,
    few: (p, s) => `The flights to select the values have ${fmt(s, 0)} s in ACTIVE with ${prof(p)}. The minimum is ${RULES.objective.minActiveS} s. Thus, the analysis does not calculate this value.`,
    twins: (n, tm) => `The analysis tests each change with ${n} versions of the governor model${tm ? `. One version has ${tm} times the rotor time constant ("tm")` : ''}.`,
    twinsCurrent: (fs) => `The log does not record the battery current ("Ibat"). Thus, the set also has versions with ${fs.join(' and ')} times the rotor time constant ("tm").`,
    noWindow: (p) => `The flights have no hover period with ${prof(p)} for the margin test. Thus, the analysis does not change the gains of ${prof(p)}.`,
    // acceptance
    change: (name, to) => `The governor model recommends "${name}" ${to}.`,
    same: (x) => `In the test flights, the tuning value J does not change (${x.n} periods of ${RULES.objective.blockS} s).`,
    imp: (x) => `In the test flights, the tuning value J decreases by ${fmt(x.imp, 1)} % (${fmt(x.lo, 1)} % to ${fmt(x.hi, 1)} %, standard error ${fmt(x.se, 1)} %, ${x.n} periods of ${RULES.objective.blockS} s).`,
    worse: (x) => `In the test flights, the tuning value J increases by ${fmt(-x.imp, 1)} % (${fmt(-x.hi, 1)} % to ${fmt(-x.lo, 1)} %, ${x.n} periods of ${RULES.objective.blockS} s).`,
    twinRange: (lo, hi) => `With the versions of the governor model and ${RULES.accept.z} standard errors, the change of J is ${fmt(-hi, 1)} % to ${fmt(-lo, 1)} %.`,
    twinWorst: (v, t) => `With the version "${t}" of the governor model, the change of J is ${fmt(v, 1)} %. This is the smallest decrease of the set.`,
    keep: 'Thus, the analysis keeps the value at this time.',
    why: {
        none: 'The governor model finds no value with a smaller tuning value J in the flights that select the values.',
        small: () => `The decrease of J is not more than ${RULES.accept.z} standard errors, or it is less than ${RULES.accept.minPct} %.`,
        twin: (t) => `With the version "${t}" of the governor model, the decrease of J is not more than ${RULES.accept.z} standard errors, or it is less than ${RULES.accept.minPct} %.`,
        blocks: () => `The test flights have less than ${RULES.accept.minBlocks} periods in ACTIVE.`,
        sat: (t) => `With the version "${t}" of the governor model, the throttle is at its maximum for more time.`,
        iLim: (t) => `With the version "${t}" of the governor model, the I-term is at its limit for more time. The throttle is not at its limit.`,
        margin: (t) => `With the version "${t}" of the governor model, the margin test is not satisfactory.`,
        satE: (v, b, c) => `At ${fmt(v, 1)} V at the end of a flight, the throttle is at its maximum for ${pc(c, 2)} % of the time in ACTIVE. The value at this time gives ${pc(b, 2)} %.`,
        verify: 'In the flights that select the values, the new feedforward increases the largest headspeed increases or the fast throttle changes too much.',
        rpmUp: 'The RPM signal of the governor model has no vibration. Thus, the analysis does not increase the cutoff.',
        dZero: 'The value of "gov_d_gain" is 0 in all PID profiles. Thus, "gov_d_filter" has no effect.',
        dLog: 'The log cannot show the governor D-term. Only the governor model can show the effect of this value.',
    },
    // margin test
    marginPass: (p, x) => `In the margin test of ${prof(p)}, the largest ratio of an error peak to the error peak before it is ${fmt(x, 2)}. The limit is ${RULES.margin.ratio}.`,
    marginNow: (p, x) => `With the gains at this time, the largest ratio of the error peaks in the margin test of ${prof(p)} is ${fmt(x, 2)}. The limit is ${RULES.margin.ratio}.`,
    marginNew: (p, x, t) => `With the recommended gains, the largest ratio of the error peaks in the margin test of ${prof(p)} is ${fmt(x, 2)} (version "${t}" of the governor model). The limit is ${RULES.margin.ratio}.`,
    marginOpt: (p, x, t) => `With the gains of this check, the largest ratio of the error peaks in the margin test of ${prof(p)} is ${fmt(x, 2)} (version "${t}" of the governor model). The limit is ${RULES.margin.ratio}.`,
    marginFail: (p, x, t) => `With the gains at this time, the margin test of ${prof(p)} is not satisfactory. With the version "${t}" of the governor model, the ratio of the error peaks is ${x === null ? 'unknown' : fmt(x, 2)}.`,
    fixed: 'The new values also give a satisfactory margin test with all versions of the governor model.',
    proposal: (c) => `The values ${Object.entries(c).map(([k, v]) => `"${k}" ${v}`).join(', ').replace(/, ([^,]+)$/, ' and $1')} give a satisfactory margin test with all versions of the governor model.`,
    marginStep: (w) => `The margin test uses log ${N(w.log)} at ${fmt(w.t, 1)} s and a collective step of ${fmt(w.step, 2)}.`,
    pNoise: (a, b) => `In the log, the fast changes of the P-term are ${pc(a, 2)} % (RMS at more than ${RULES.objective.hfHz} Hz). With the new gains, they are ${pc(b, 2)} % or less.`,
    pNoiseNote: 'The governor model has no vibration of the RPM signal. This value includes the vibration.',
    // precomp
    design: (p, rms, r2v) => `For ${prof(p)}, the error of these feedforward values is ${pc(rms, 2)} % (RMS, R2 ${fmt(r2v, 3)}) against the throttle of the governor model.`,
    designNow: (rms) => `With the values at this time, the error is ${pc(rms, 2)} % (RMS).`,
    designRange: (name, lo, hi) => `With the versions of the governor model, the value of "${name}" is ${fmt(lo, 0)} to ${fmt(hi, 0)}.`,
    keepGain: 'The analysis keeps "gov_gain" and changes only the other gains.',
    otherGains: 'The analysis keeps this value and changes only the other gains of this PID profile.',
    uniform: (m) => `The analysis multiplies the P-gain and the I-gain by the same value (${fmt(m, 2)}). Thus, it changes "gov_gain" and keeps the other gains.`,
    fKeep: (to) => `With the new "gov_gain", the value ${to} of "gov_f_gain" keeps the same feedforward.`,
    // gains and filters
    gridJ: (name, v, from) => `Change of the tuning value J with "${name}" ${v} against ${from}, in the flights that select the values.`,
    noCurrent: 'The log does not record the battery current ("Ibat"). Thus, the margin test of a larger gain is possibly not correct, and the app does not select this change.',
    // filters
    glitch: (fc, x, lim) => `With ${fc} Hz, the largest difference between the headspeed and the filtered headspeed is ${fmt(x, 0)} rpm in ACTIVE. The FALLBACK limit is ${fmt(lim, 0)} rpm.`,
    glitchNote: 'A lower cutoff of "gov_rpm_filter" makes this difference larger. The log records a filtered headspeed. Thus, the difference of the raw RPM signal is possibly larger.',
    rpmRecord: 'To record the raw RPM signal, set "debug_mode" to RPM_SOURCE for one flight.',
    // limits
    lim: (t, L, out, inn) => `With the new values, the governor ${t} is at its limit (${fmt(L * 100, 0)} %) for ${fmt(out, 2)} s with the throttle not at a limit. It is at its limit for ${fmt(inn, 2)} s with the throttle at a limit.`,
    limNone: (t, mx, L) => `With the new values, the governor ${t} is not at its limit (${fmt(L * 100, 0)} %). The largest ${t} is ${pc(mx, 1)} %.`,
    limIn: 'The term is at its limit only with the throttle at a limit. Thus, the limit has no effect on the headspeed error.',
    limCheck: 'The term is at its limit with the throttle not at a limit. Examine the limit.',
    limOut: (t) => `Time at the limit with the throttle not at a limit (${t}).`, limIn2: (t) => `Time at the limit with the throttle at a limit (${t}).`, limMax: (t) => `Largest ${t} with the throttle not at a limit.`,
    termName: { P: 'P-term', I: 'I-term', D: 'D-term', F: 'F-term' },
    // NOMAD
    nomad: (k, ms) => `NOMAD compares ${k} sets of gains in ${fmt(ms / 1000, 0)} s. This does not show that the selected values are the best possible values.`,
    // no NOMAD (stages.nomad.skipped): the gains come from the grids of stage 2 only
    nomadTime: (k) => `NOMAD stopped at its time limit after ${k} sets of gains. Thus, if you do the analysis again, the gains can be different.`,
    nomadNone: 'The app did not have time to compare more sets of gains with NOMAD. Thus, the app selected each gain from a small set of values only.',
    progress: { base: 'The governor model flies the recorded flights with the values at this time.', precomp: 'The governor model calculates the feedforward values.',
        gains: 'The governor model compares the gains.', filters: 'The governor model compares the filters.', nomad: 'The app uses NOMAD to select the gains.',
        limits: 'The governor model examines the term limits.', accept: 'The governor model compares the changes with the test flights.' },
};

// ---------------------------------------------------------------------------------------------
// metrics in 10-s blocks (gov_sim.metrics, paired between candidates)
// ---------------------------------------------------------------------------------------------

// u less its zero-phase first-order low-pass at hz (gov_sim.metrics)
function lowpass(U, hz, rate) {
    const n = U.length, a = 1 - Math.exp(-2 * Math.PI * hz / rate), lp = new Float64Array(n);
    if (!n) return lp;
    lp[0] = U[0]; for (let k = 1; k < n; k++) lp[k] = lp[k - 1] + a * (U[k] - lp[k - 1]);
    for (let k = n - 2; k >= 0; k--) lp[k] = lp[k + 1] + a * (lp[k] - lp[k + 1]);
    return lp;
}
// the PID profile of each sample (the governor profile changes of the configuration, as gov_sim.run)
function profOf(x) {
    if (x.prof) return x.prof;
    const ev = x.cfg.changes && x.cfg.start ? x.cfg : GS.profileEvents(x.run, null), n = x.run.n, out = new Uint8Array(n), ch = ev.changes || [];
    let cur = ev.start, j = 0;
    for (let k = 0; k < n; k++) { while (j < ch.length && ch[j].k <= k) cur = ch[j++].profile; out[k] = cur; }
    return (x.prof = out);
}
// the limits of each PID profile (fractions) for the metrics: max throttle and I limit with the values of the scenario
function limitsOf(x, values) {
    const out = {};
    for (const [p, s] of Object.entries(x.cfg.profiles || {})) {
        const v = Object.assign({}, x.cfg.cli && x.cfg.cli.profiles && x.cfg.cli.profiles[p], values.profiles[p]);
        out[p] = { mx: (isNum(v.gov_max_throttle) ? v.gov_max_throttle : s.gov_max_throttle) / 100, mn: (isNum(v.gov_min_throttle) ? v.gov_min_throttle : s.gov_min_throttle) / 100,
            il: (isNum(v.gov_i_limit) ? v.gov_i_limit : s.gov_i_limit) / 100 };
    }
    return out;
}
// the blocks of one simulation: RULES.objective.blockS of logged ACTIVE samples of one PID profile and one part (0 training, 1 test); in a
// block, the samples in which the simulation is in ACTIVE give e (% of the target), hf (u above hfHz), sat, iLim and the 1-s windows
function blocksOf(x, tr, lim) {
    const run = x.run, n = run.n, st = run.state, rate = run.rate, Q = RULES.objective, W = Math.max(1, Math.round(Q.windowS * rate)), BN = Math.max(1, Math.round(Q.blockS * rate));
    const U = tr.u, lp = lowpass(U, Q.hfHz, rate), open = new Map(), blocks = [];
    for (let k = 0; k < n; k++) {
        if (st[k] !== 4) continue;
        const p = tr.profile[k], part = k >= x.testFrom ? 1 : 0, key = p * 2 + part;
        let B = open.get(key);
        if (!B || B.m >= BN) { B = { p, part, log: run.log, t0: r(run.time[k], 2), m: 0, n: 0, e2: 0, hf2: 0, sat: 0, il: 0, dro: [], ove: [], wn: 0, wmin: 0, wmax: 0, last: -2 }; open.set(key, B); blocks.push(B); }
        B.m++;
        const T = tr.target[k];
        if (tr.state[k] !== 4 || !(T > 0)) { B.wn = 0; continue; }
        const e = (tr.hs[k] - T) / T * 100, hf = U[k] - lp[k], L = lim[p] || {};
        B.n++; B.e2 += e * e; B.hf2 += hf * hf;
        if (isNum(L.mx) && U[k] >= L.mx - Q.satEps) B.sat++;
        else if (isNum(L.il) && Math.abs(tr.I[k]) >= L.il - Q.iLimitEps) B.il++;
        if (B.last !== k - 1) B.wn = 0;
        B.last = k;
        if (B.wn === 0) { B.wmin = e; B.wmax = e; } else { if (e < B.wmin) B.wmin = e; if (e > B.wmax) B.wmax = e; }
        if (++B.wn === W) { B.dro.push(Math.max(0, -B.wmin)); B.ove.push(Math.max(0, B.wmax)); B.wn = 0; }
    }
    return blocks.map(B => ({ p: B.p, part: B.part, log: B.log, t0: B.t0, m: B.m, n: B.n, e2: B.e2, hf2: B.hf2, sat: B.sat, il: B.il, dro: B.dro, ove: B.ove, rate }));
}
const worst = (w) => { if (!w.length) return 0; const s = w.slice().sort((a, b) => b - a), m = Math.max(1, Math.ceil(RULES.objective.worst * s.length)); let t = 0; for (let i = 0; i < m; i++) t += s[i]; return t / m; };
// pooled metrics of blocks (gov_sim.metrics names)
function agg(blocks) {
    let n = 0, e2 = 0, hf2 = 0, sat = 0, il = 0, s = 0; const dro = [], ove = [];
    for (const B of blocks) { n += B.n; e2 += B.e2; hf2 += B.hf2; sat += B.sat; il += B.il; s += B.n / B.rate; for (const v of B.dro) dro.push(v); for (const v of B.ove) ove.push(v); }
    return { n, seconds: s, eRms: n ? Math.sqrt(e2 / n) : 0, droop95: worst(dro), over95: worst(ove), thrHF: n ? Math.sqrt(hf2 / n) * 100 : 0, satShare: n ? sat / n : 0, iLimitOutsideSat: n ? il / n : 0 };
}
// J of c relative to b (1 at b)
function jRel(c, b) {
    const Q = RULES.objective; let s = 0, w = 0;
    for (const k of Object.keys(Q.w)) { s += Q.w[k] * Math.max(c[k] || 0, Q.floor[k]) / Math.max(b[k] || 0, Q.floor[k]); w += Q.w[k]; }
    return s / w;
}
const ok = (c, b) => c.satShare <= b.satShare + RULES.objective.satTol && c.iLimitOutsideSat <= b.iLimitOutsideSat + RULES.objective.iLimTol;
const metricsOut = (m) => ({ seconds: r(m.seconds, 1), eRms: r(m.eRms), droop95: r(m.droop95), over95: r(m.over95), thrHF: r(m.thrHF), satShare: r(m.satShare, 5), iLimitOutsideSat: r(m.iLimitOutsideSat, 5) });

// paired block bootstrap: base and cand are aligned block lists; profiles: the PID profiles pooled (weights: their ACTIVE samples).
// -> { imp (% decrease of J), se, lo, hi, n (blocks) }
function paired(base, cand, profiles, o = {}) {
    const A = RULES.accept, rand = rng(o.seed || A.seed), groups = profiles.map(p => base.map((b, i) => b.p === p ? i : -1).filter(i => i >= 0)).filter(g => g.length);
    const stat = (sel) => {
        let num = 0, den = 0;
        for (const g of sel) { const b = agg(g.map(i => base[i])), c = agg(g.map(i => cand[i])); if (!b.n) continue; num += b.n * jRel(c, b); den += b.n; }
        return den ? 100 * (1 - num / den) : 0;
    };
    const n = groups.reduce((s, g) => s + g.length, 0), imp = stat(groups), reps = [];
    for (let k = 0; k < (o.boot || A.boot); k++) reps.push(stat(groups.map(g => g.map(() => g[Math.floor(rand() * g.length)]))));
    const m = reps.reduce((s, v) => s + v, 0) / reps.length, se = Math.sqrt(reps.reduce((s, v) => s + (v - m) ** 2, 0) / Math.max(1, reps.length - 1));
    return { imp: r(imp, 3), se: r(se, 3), lo: r(quantile(reps, A.q[0]), 3), hi: r(quantile(reps, A.q[1]), 3), n };
}
// the acceptance rule on a paired result
const passes = (x) => x.n >= RULES.accept.minBlocks && x.imp > RULES.accept.z * x.se && x.imp >= RULES.accept.minPct;
// b -> c increases an effective gain (K Kp, K Ki or K Kd)
const raises = (b, c) => ['gov_p_gain', 'gov_i_gain', 'gov_d_gain'].some(k => c.gov_gain * c[k] > b.gov_gain * b[k] + 1e-9);

// ---------------------------------------------------------------------------------------------
// the twin set, the margin test, the feedforward design
// ---------------------------------------------------------------------------------------------

// the battery current of the model (gov_fit has, else the twin parameters)
const hasCurrent = (model) => model && model.has ? !!model.has.current : !!(model && model.params && model.params.current);
// the main twin, up to RULES.twins.max samples at the extremes of tm, load scale, kv and te, the tm-scan winner when tmBand fails, and
// without battery current tm x RULES.twins.noCurrent (critique C13: the logs do not give the authority without current)
function twinSet(model, validation, hover) {
    const main = GT.copy(model.params), out = [{ name: 'main', p: main }], seen = new Set();
    const loadOf = (p) => GT.load(p, p.Href, hover.coll, hover.cyc, hover.yaw);
    const S = (model.samples || []).map(s => GT.copy(main, s)).filter(p => isNum(p.tm) && isNum(p.kv));
    const pick = [];
    for (const f of [(p) => p.tm, loadOf, (p) => p.kv, (p) => p.te]) {
        if (!S.length) break;
        let lo = 0, hi = 0; S.forEach((p, i) => { if (f(p) < f(S[lo])) lo = i; if (f(p) > f(S[hi])) hi = i; });
        pick.push(lo, hi);
    }
    for (const i of pick) if (!seen.has(i) && seen.size < RULES.twins.max) { seen.add(i); out.push({ name: `sample ${i + 1}`, p: S[i] }); }
    const tb = validation && (validation.checks || []).find(c => c.rule === 'tmBand');
    let tmFactor = null;
    if (tb && !tb.pass && (validation.tmScan || []).length) {
        const best = validation.tmScan.filter(q => isNum(q.band)).reduce((a, q) => !a || q.band < a.band ? q : a, null);
        if (best) { tmFactor = best.factor; out.push({ name: `tm x${best.factor}`, p: GT.copy(main, { tm: main.tm * best.factor }) }); }
    }
    const noCurrent = hasCurrent(model) ? [] : RULES.twins.noCurrent.filter(f => f !== tmFactor);
    for (const f of noCurrent) out.push({ name: `tm x${f}`, p: GT.copy(main, { tm: main.tm * f }) });
    return { list: out.map(t => Object.assign(t, { tm: r(t.p.tm, 4), kv: r(t.p.kv, 1), te: r(t.p.te, 4), load: r(loadOf(t.p), 3) })), tmFactor, noCurrent };
}

// a hover window of PID profile p for the margin test: logged ACTIVE, profile p, the mean throttle under 1 - headroom, low collective activity,
// and the steady duty of the main twin with the collective step under 1 - headroom. Training flights first, the earliest window
function windowOf(items, p, twin, values) {
    const M = RULES.margin;
    for (const x of items) {
        const run = x.run, n = run.n, rate = run.rate, st = run.state, lab = profOf(x), C = run.coll, u = run.u;
        if (!st || !C || !u) continue;
        const sN = Math.round((M.settleS + M.activeS) * rate), aN = Math.round((M.stepS + M.afterS) * rate), stp = Math.max(1, Math.round(M.scanS * rate)), hN = Math.round(M.settleS * rate);
        const bad = new Int32Array(n + 1), c1 = new Float64Array(n + 1), c2 = new Float64Array(n + 1), u1 = new Float64Array(n + 1), ph = run.phase;
        for (let k = 0; k < n; k++) {
            bad[k + 1] = bad[k] + (st[k] !== 4 || lab[k] !== p || (ph && ph[k] !== PH_FLIGHT) ? 1 : 0);
            c1[k + 1] = c1[k] + C[k]; c2[k + 1] = c2[k] + C[k] * C[k]; u1[k + 1] = u1[k] + u[k];
        }
        for (let k = sN; k + aN <= n; k += stp) {
            if (bad[k + aN] - bad[k - sN] || (u1[k] - u1[k - sN]) / sN >= 1 - M.headroom) continue;
            const m = (c1[k] - c1[k - hN]) / hN, v = (c2[k] - c2[k - hN]) / hN - m * m;
            if (v > M.collStd * M.collStd) continue;
            let cyc = 0, yaw = 0, roll = 0, pitch = 0;
            for (let j = k - hN; j < k; j++) { roll += run.roll[j]; pitch += run.pitch[j]; yaw += run.yaw[j]; cyc += Math.hypot(run.roll[j], run.pitch[j]); }
            const H = isNum(values.profiles[p] && values.profiles[p].gov_headspeed) ? values.profiles[p].gov_headspeed : run.request ? run.request[k] : twin.Href;
            for (const step of M.step) {
                const d = GT.steady(twin, { H, coll: m + step, cyc: cyc / hN, yaw: Math.abs(yaw / hN), ocv: run.vbat ? run.vbat[k] : undefined }).d;
                // sign: the first error of the step (a larger load: the headspeed decreases)
                const sign = GT.load(twin, H, m + step, cyc / hN, yaw / hN) >= GT.load(twin, H, m, cyc / hN, yaw / hN) ? -1 : 1;
                if (d < 1 - M.headroom) return { x, k, log: run.log, t: r((run.fromS || 0) + run.time[k], 2), step, sign, coll: m, roll: roll / hN, pitch: pitch / hN, yaw: yaw / hN, rate, profile: p };
            }
        }
    }
    return null;
}
// the runs of the margin test: the flight to the end of the window, the mixer held at the window means from settleS before the step, with
// the collective step (step true) or without it (the reference: the difference of the two errors is the step response, without the
// settling of the flight before the window)
function stepRun(w, step = true) {
    const run = w.x.run, M = RULES.margin, k0 = w.k, sN = Math.round(M.settleS * w.rate), n = Math.min(run.n, k0 + Math.round((M.stepS + M.afterS) * w.rate)), out = Object.assign({}, run);
    for (const [key, v] of Object.entries(run)) if (ArrayBuffer.isView(v) && v.length === run.n) out[key] = v.subarray(0, n);
    out.n = n;
    for (const [a, val] of [['roll', w.roll], ['pitch', w.pitch], ['yaw', w.yaw], ['coll', w.coll]]) { const arr = Float32Array.from(out[a]); arr.fill(val, k0 - sN, n); out[a] = arr; }
    if (step) out.coll.fill(w.coll + w.step, k0, k0 + Math.round(M.stepS * w.rate));
    return out;
}
// the successive peaks of e - e0 in [a, b) (alternate signs, hysteresis floor), from the first excursion of the sign sign0 (the expected
// response: the tail of the response before a. With sign0 0: either sign), and the largest ratio of successive peaks
function decay(e, a, b, e0, sign0 = 0) {
    const M = RULES.margin, pk = []; let sign = 0, ext = 0;
    for (let k = a; k < b && pk.length < M.peaks; k++) {
        const v = e[k] - e0;
        if (!sign) { if (Math.abs(v) >= M.floor && (!sign0 || v * sign0 > 0)) { sign = v > 0 ? 1 : -1; ext = v; } continue; }
        if (sign * v > sign * ext) ext = v;
        else if (sign * v < -M.floor) { pk.push(ext); sign = -sign; ext = v; }
    }
    if (sign && pk.length < M.peaks) pk.push(ext);
    let ratio = 0;
    for (let i = 0; i + 1 < pk.length; i++) if (Math.abs(pk[i]) >= Math.max(M.floor, M.rel * Math.abs(pk[0]))) ratio = Math.max(ratio, Math.abs(pk[i + 1]) / Math.abs(pk[i]));
    // an oscillation on a slow change (the I-term recovery) does not cross e0: the swings between successive extrema (each extremum confirmed
    // by a reversal of more than the floor). The ratio for each half cycle: the square root of the ratio of swings one cycle apart (the slow
    // change adds to one direction and subtracts from the other), with two swings only their ratio; the same as the peak ratio about e0
    const ex = []; let s2 = 0, x2 = 0;
    for (let k = a; k < b && ex.length <= M.peaks; k++) {
        const v = e[k] - e0;
        if (!s2) { if (Math.abs(v) >= M.floor && (!sign0 || v * sign0 > 0)) { s2 = v > 0 ? 1 : -1; x2 = v; } continue; }
        if (s2 * v > s2 * x2) x2 = v;
        else if (s2 * (x2 - v) > M.floor) { ex.push(x2); s2 = -s2; x2 = v; }
    }
    const sw = []; for (let i = 0; i + 1 < ex.length; i++) sw.push(Math.abs(ex[i + 1] - ex[i]));
    let swing = 0; const lag = sw.length >= 3 ? 2 : 1;
    for (let i = 0; i + lag < sw.length; i++) if (sw[i] >= Math.max(M.floor, M.rel * sw[0])) swing = Math.max(swing, Math.pow(sw[i + lag] / sw[i], 1 / lag));
    return { ratio: Math.max(ratio, swing), peaks: pk.map(v => r(v, 3)), swing: r(swing, 3), extrema: ex.map(v => r(v, 3)) };
}
// the step response: the error (% of the target) with the step less the error of the reference run (tb); the governor must stay in ACTIVE
function ratioOf(tr, w, tb) {
    const M = RULES.margin, k0 = w.k, a = k0 - Math.round(M.preS * w.rate), kOff = k0 + Math.round(M.stepS * w.rate), n = tr.hs.length, e = new Float64Array(n);
    const err = (x, k) => (x.hs[k] - x.target[k]) / x.target[k] * 100;
    for (let k = a; k < n; k++) {
        if (tr.state[k] !== 4 || !(tr.target[k] > 0) || tb && (tb.state[k] !== 4 || !(tb.target[k] > 0))) return { ratio: null, pass: false, peaks: [], left: true };
        e[k] = err(tr, k) - (tb ? err(tb, k) : 0);
    }
    let e0 = 0; if (!tb) for (let k = a; k < k0; k++) e0 += e[k] / (k0 - a);
    const on = decay(e, k0, kOff, e0, w.sign || 0), off = decay(e, kOff, n, e0, -(w.sign || 0)), ratio = Math.max(on.ratio, off.ratio);
    return { ratio: r(ratio, 3), pass: ratio < RULES.margin.ratio, peaks: [on.peaks, off.peaks], left: false };
}
// the step response for the plot: the error (% of the target) with the step less the error of the reference run, from preS before the step to
// the end, at RULES.margin.points points or less. { t (frame seconds: fromS + the run time, the clock of the log viewer), e }
function stepResponse(ta, tb, w) {
    const f = w.x && w.x.run && w.x.run.fromS || 0;
    const M = RULES.margin, a = Math.max(0, w.k - Math.round(M.preS * w.rate)), n = ta.hs.length, step = Math.max(1, Math.ceil((n - a) / M.points)), t = [], e = [];
    for (let k = a; k < n; k += step) {
        const ok = ta.target[k] > 0 && tb.target[k] > 0;
        t.push(r(f + ta.t[k], 4)); e.push(ok ? r((ta.hs[k] - ta.target[k]) / ta.target[k] * 100 - (tb.hs[k] - tb.target[k]) / tb.target[k] * 100, 4) : null);
    }
    return { t, e };
}
// the values of the margin test: P, I and D of PID profile p x factor (when one is over its range: gov_gain x factor), and the F-term off
// (gov_f_gain 0: the test is of the feedback loop, and the feedforward does not compensate the step)
function doubled(values, p) {
    const k = RULES.margin.factor, v = copy(values), q = v.profiles[p] || {}, G = ['gov_p_gain', 'gov_i_gain', 'gov_d_gain'];
    if (G.some(g => !isNum(q[g]))) return null;
    q.gov_f_gain = 0;
    if (G.every(g => Math.round(q[g] * k) <= range(g)[1])) { for (const g of G) q[g] = Math.round(q[g] * k); return v; }
    if (!isNum(q.gov_gain) || Math.round(q.gov_gain * k) > range('gov_gain')[1]) return null;
    q.gov_gain = Math.round(q.gov_gain * k);
    return v;
}

// non-negative least squares of y on up to 3 features (all subsets): { x, sse }
function nnls3(XtX, Xty, yy) {
    let best = null;
    for (let mask = 1; mask < 8; mask++) {
        const idx = [0, 1, 2].filter(i => mask >> i & 1), k = idx.length, A = idx.map(i => idx.map(j => XtX[i * 3 + j])), b = idx.map(i => Xty[i]);
        // Gauss elimination
        const M = A.map((row, i) => row.concat([b[i]]));
        let sing = false;
        for (let c = 0; c < k; c++) {
            let piv = c; for (let i = c + 1; i < k; i++) if (Math.abs(M[i][c]) > Math.abs(M[piv][c])) piv = i;
            if (!(Math.abs(M[piv][c]) > 1e-14)) { sing = true; break; }
            [M[c], M[piv]] = [M[piv], M[c]];
            for (let i = 0; i < k; i++) if (i !== c) { const f = M[i][c] / M[c][c]; for (let j = c; j <= k; j++) M[i][j] -= f * M[c][j]; }
        }
        if (sing) continue;
        const sol = idx.map((_, i) => M[i][k] / M[i][i]);
        if (sol.some(v => v < 0)) continue;
        const x = [0, 0, 0]; idx.forEach((i, j) => { x[i] = sol[j]; });
        let sse = yy; for (let i = 0; i < 3; i++) { sse -= 2 * x[i] * Xty[i]; for (let j = 0; j < 3; j++) sse += x[i] * x[j] * XtX[i * 3 + j]; }
        if (!best || sse < best.sse) best = { x, sse: Math.max(0, sse) };
    }
    return best || { x: [0, 0, 0], sse: yy };
}
// the feedforward design (SPEC 5): fit K Kf (wc |coll|^(curve/10) + wx cyc + wy |yaw|) to the steady extra throttle of the twin
// (sL(load) - sL(0)) / V at headspeed H and voltage V, on the load samples [{ coll, cyc, yaw }]; integer values with gov_gain fixed.
// cur: the CLI values at this time (gov_gain, gov_f_gain, the weights, the curve). -> { curve, eff [c, x, y], values, rms, r2, rmsNow }
function designPrecomp(twin, samples, H, V, cur) {
    const Q = RULES.precomp, n = samples.length, y = new Float64Array(n), base = GT.load(twin, H, 0, 0, 0);
    if (!n || !(V > 0) || !(H > 0)) return null;
    let ym = 0; for (let i = 0; i < n; i++) { const s = samples[i]; y[i] = (GT.load(twin, H, s.coll, s.cyc, s.yaw) - base) / V; ym += y[i] / n; }
    let yy = 0, sst = 0; for (let i = 0; i < n; i++) { yy += y[i] * y[i]; sst += (y[i] - ym) ** 2; }
    const ffOf = (v, s) => (v.gov_gain / 100) * (v.gov_f_gain / 100) * (v.gov_collective_ff_weight / 100 * Math.pow(Math.abs(s.coll), v.gov_collective_curve / 10) + v.gov_cyclic_ff_weight / 100 * s.cyc + v.gov_yaw_ff_weight / 100 * Math.abs(s.yaw));
    const rmsOf = (v) => { let e = 0; for (let i = 0; i < n; i++) e += (ffOf(v, samples[i]) - y[i]) ** 2; return Math.sqrt(e / n); };
    let best = null;
    for (let c = Q.curve[0]; c <= Q.curve[1]; c++) {
        const XtX = new Float64Array(9), Xty = new Float64Array(3);
        for (let i = 0; i < n; i++) {
            const s = samples[i], f = [Math.pow(Math.abs(s.coll), c / 10), s.cyc, Math.abs(s.yaw)];
            for (let a = 0; a < 3; a++) { Xty[a] += f[a] * y[i]; for (let b = 0; b < 3; b++) XtX[a * 3 + b] += f[a] * f[b]; }
        }
        const fit = nnls3(XtX, Xty, yy);
        if (!best || fit.sse < best.sse - 1e-12 || Math.abs(fit.sse - best.sse) <= 1e-12 && Math.abs(c - cur.gov_collective_curve) < Math.abs(best.curve - cur.gov_collective_curve)) best = { curve: c, eff: fit.x, sse: fit.sse };
    }
    const rmsC = Math.sqrt(best.sse / n), G = cur.gov_gain, fr = range('gov_f_gain'), wr = range('gov_cyclic_ff_weight');
    if (!(G > 0)) return null;
    // integer f_gain (nearest to the value at this time first) and weights in range, within intTol of the continuous RMS error
    const fs = []; for (let f = Math.max(1, fr[0]); f <= fr[1]; f++) fs.push(f);
    fs.sort((a, b) => Math.abs(a - cur.gov_f_gain) - Math.abs(b - cur.gov_f_gain) || a - b);
    let pick = null;
    for (const f of fs) {
        const w = best.eff.map(a => Math.round(a * 1e6 / (G * f)));
        if (w.some(x => x < wr[0] || x > wr[1])) continue;
        const v = { gov_gain: G, gov_f_gain: f, gov_collective_ff_weight: w[0], gov_cyclic_ff_weight: w[1], gov_yaw_ff_weight: w[2], gov_collective_curve: best.curve }, e = rmsOf(v);
        if (!pick || e < pick.rms) pick = { v, rms: e };
        if (e <= rmsC * (1 + Q.intTol) + Q.intAbs) break;
    }
    if (!pick) return null;
    const now = ['gov_f_gain', 'gov_collective_ff_weight', 'gov_cyclic_ff_weight', 'gov_yaw_ff_weight', 'gov_collective_curve'].every(k => isNum(cur[k])) ? rmsOf(cur) : null;
    return { curve: best.curve, eff: best.eff.map(v => r(v, 6)), values: pick.v, rms: r(pick.rms, 6), rmsFit: r(rmsC, 6), r2: sst > 0 ? r(1 - pick.rms * pick.rms * n / sst, 4) : null, rmsNow: r(now, 6), n, H, V: r(V, 3) };
}

// ---------------------------------------------------------------------------------------------
// the governor terms of a simulation (limits): P and D from the error of the governor headspeed (PT2 of the twin headspeed at
// gov_rpm_filter), F from the mixer (PT2 at gov_ff_filter), I as simulated; at their limit outside and in saturation
// ---------------------------------------------------------------------------------------------
function termsOf(x, tr, values) {
    const run = x.run, n = run.n, L = run.loopsPerFrame || 1, hz = run.pidHz, st = run.state, cl = x.cfg.cli || { global: {}, profiles: {} };
    const g = Object.assign({}, cl.global, values.global), VM = new Map(), V = (p) => VM.get(p) || (VM.set(p, Object.assign({}, cl.profiles[p], values.profiles[p])), VM.get(p));
    const hsG = GP.pt2(tr.hs, g.gov_rpm_filter, hz, L), raw = new Float64Array(n), mT = RULES.limits.termMargin, eps = RULES.objective.satEps;
    for (let k = 0; k < n; k++) { const v = V(tr.profile[k]); raw[k] = (v.gov_gain / 100) * (v.gov_f_gain / 100) * (v.gov_collective_ff_weight / 100 * Math.pow(Math.abs(run.coll[k]), v.gov_collective_curve / 10) +
        v.gov_cyclic_ff_weight / 100 * Math.hypot(run.roll[k], run.pitch[k]) + v.gov_yaw_ff_weight / 100 * Math.abs(run.yaw[k])); }
    const F = GP.pt2(raw, g.gov_ff_filter, hz, L);
    // the D differentiator (common_filter.c difFilter) at gov_d_filter / 10 Hz
    const fd = Math.min((g.gov_d_filter || 0) / 10, hz / 2), W = Math.tan(Math.PI * fd / hz), da = fd > 0 ? (W - 1) / (W + 1) : 0, db = fd > 0 ? 2 * hz * W / (W + 1) : 0;
    let x1 = 0, y1 = 0;
    const acc = {}, get = (p) => acc[p] || (acc[p] = Object.fromEntries(Object.keys(TERM).map(t => [t, { outS: 0, inS: 0, maxOut: 0, max: 0, lim: null }])));
    for (let k = 0; k < n; k++) {
        const p = tr.profile[k], v = V(p), K = v.gov_gain / 100, Hf = v.gov_headspeed, e = Hf > 0 ? (tr.target[k] - hsG[k]) / Hf : 0;
        let d = 0; for (let q = 0; q < L; q++) { d = db * (e - x1) - da * y1; x1 = e; y1 = d; }
        if (st[k] !== 4 || tr.state[k] !== 4) continue;
        const terms = { P: K * v.gov_p_gain / 10 * e, I: tr.I[k], D: K * v.gov_d_gain / 1000 * d, F: F[k] }, A = get(p), dt = 1 / run.rate;
        const sat = tr.u[k] >= v.gov_max_throttle / 100 - eps || tr.u[k] <= v.gov_min_throttle / 100 + eps;
        for (const t of Object.keys(TERM)) {
            const lim = v[TERM[t]] / 100, a = Math.abs(terms[t]), T = A[t];
            T.lim = lim; if (a > T.max) T.max = a;
            if (!sat && a > T.maxOut) T.maxOut = a;
            if (lim > 0 && a >= lim - mT) { if (sat) T.inS += dt; else T.outS += dt; }
        }
    }
    return acc;
}

// ---------------------------------------------------------------------------------------------
// the search
// ---------------------------------------------------------------------------------------------

function unavailable(reason, extra) { return Object.assign({ status: 'unavailable', reason, accept: {}, stages: {}, notes: [reason] }, extra || {}); }

async function search(runs, o = {}) {
    const t0 = Date.now(), Q = RULES.objective, model = o.model, val = o.validation || null, progress = typeof o.progress === 'function' ? o.progress : () => {};
    const fams = o.families || ORDER, timing = {};
    if (!model || !model.params) return unavailable(TEXT.noModel);
    if ((val && val.status === 'rejected') || model.status === 'failed') return unavailable(TEXT.rejected);
    const configs = o.configs || GS.configOf(runs, o.recovered || GP.recover(runs, { cli: o.cli || null }), { cli: o.cli || null });
    const notes = [], use = [];
    for (const run of (runs || []).filter(q => q && q.class === 'flight')) {
        const cfg = configs[GS.keyOf(run)];
        if (!cfg || cfg.excluded) { notes.push(TEXT.excluded(run.log, cfg ? cfg.excluded : TEXT.noModel)); continue; }
        if (!run.state) { notes.push(TEXT.noState(run.log)); continue; }
        use.push({ run, cfg, key: GS.keyOf(run) });
    }
    // the split of gov_fit: test logs, or the last testShare of the motor-running samples of each flight
    const sp = model.split || { mode: 'logs', testLogs: [] };
    for (const x of use) {
        if (sp.mode !== 'tail') { x.testFrom = (sp.testLogs || []).includes(x.run.log) ? 0 : x.run.n; continue; }
        const u = x.run.u || [], on = []; for (let k = 0; k < x.run.n; k++) if (u[k] > 0.02) on.push(k);
        x.testFrom = on.length ? on[Math.floor(on.length * (1 - (sp.testShare || 0.4)))] : x.run.n;
    }
    const train = use.filter(x => x.testFrom > 0), test = use.filter(x => x.testFrom < x.run.n);
    if (!train.length || !test.length) return unavailable(TEXT.noSplit, { notes: notes.concat([TEXT.noSplit]) });
    // the values at this time: the CLI values of the newest flight log of each PID profile (and of the global names)
    const current = { global: {}, profiles: {} };
    for (const x of use.slice().sort((a, b) => a.run.log - b.run.log || a.run.segment - b.run.segment)) {
        const c = x.cfg.cli || { global: {}, profiles: {} };
        for (const k of GLOBAL) if (isNum(c.global[k])) current.global[k] = c.global[k];
        for (const [p, v] of Object.entries(c.profiles || {})) { const t = current.profiles[p] || (current.profiles[p] = {}); for (const k of PROFILE_NAMES) if (isNum(v[k])) t[k] = v[k]; }
    }
    // the median hover inputs of the training flights (load scale of the twin set)
    const hov = { coll: [], cyc: [], yaw: [] };
    for (const x of train) { const run = x.run; for (let k = 0; k < x.testFrom; k += 50) if (run.state[k] === 4) { hov.coll.push(run.coll[k]); hov.cyc.push(Math.hypot(run.roll[k], run.pitch[k])); hov.yaw.push(Math.abs(run.yaw[k])); } }
    const hover = { coll: median(hov.coll) || 0, cyc: median(hov.cyc) || 0, yaw: median(hov.yaw) || 0 };
    const TW = twinSet(model, val, hover), twins = TW.list;
    if (twins.length > 1) notes.push(TEXT.twins(twins.length, TW.tmFactor));
    if (TW.noCurrent.length) notes.push(TEXT.twinsCurrent(TW.noCurrent));

    // simulations: the block metrics (and the terms) of one run, one twin, one set of values; cached
    const cache = new Map();
    let sims = 0, simMs = 0;
    async function sim(x, ti, values, opt = {}) {
        const k = `${ti}|${x.key}|${opt.ocv || ''}|${opt.terms ? 1 : 0}|${vkey(values)}`;
        if (cache.has(k)) return cache.get(k);
        const ts = Date.now(), res = await GS.run(x.run, x.cfg, { plant: 'twin', twin: twins[ti].p, scenario: { values, ocv: opt.ocv }, record: { points: 1e9 } });
        sims++; simMs += Date.now() - ts;
        const out = res.excluded ? { excluded: res.excluded, blocks: [] } : { blocks: blocksOf(x, res.trace, limitsOf(x, values)), terms: opt.terms ? termsOf(x, res.trace, values) : null };
        cache.set(k, out);
        return out;
    }
    const simAll = async (items, ti, values, opt) => { const out = []; for (const x of items) out.push(await sim(x, ti, values, opt)); return out; };
    const blocks = (outs, part) => [].concat(...outs.map(q => q.blocks.filter(b => part === undefined || b.part === part)));
    const byP = (bl, p) => bl.filter(b => b.p === p);

    // the baseline: the values at this time in every log
    progress(0.02, TEXT.progress.base);
    const base = copy(current), b0 = blocks(await simAll(train, 0, base), 0), bT = blocks(await simAll(test, 0, base), 1);
    const profiles = {}, list = [];
    for (const p of [...new Set(b0.concat(bT).map(b => b.p))].sort((a, b) => a - b)) {
        const m0 = agg(byP(b0, p)), m1 = agg(byP(bT, p));
        profiles[p] = { trainS: r(m0.seconds, 1), testS: r(m1.seconds, 1), searched: p > 0 && m0.seconds >= Q.minActiveS && !!current.profiles[p] };
        if (profiles[p].searched) list.push(p);
    }
    const baseTrain = Object.fromEntries(list.map(p => [p, agg(byP(b0, p))]));
    const S = { status: 'ok', reason: null, twins: twins.map(t => ({ name: t.name, tm: t.tm, kv: t.kv, te: t.te, load: t.load })), tmFactor: TW.tmFactor, noCurrent: TW.noCurrent, hasCurrent: hasCurrent(model), split: { mode: sp.mode, testLogs: sp.testLogs || [], train: train.map(x => x.run.log), test: test.map(x => x.run.log) },
        profiles, current, hover: { coll: r(hover.coll), cyc: r(hover.cyc), yaw: r(hover.yaw) }, baseline: { train: {}, test: {} }, windows: {}, margin: { current: {} }, stages: {}, accept: {}, final: null, plot: null, notes, timing };
    for (const p of Object.keys(profiles)) { S.baseline.train[p] = metricsOut(agg(byP(b0, +p))); S.baseline.test[p] = metricsOut(agg(byP(bT, +p))); }
    // the logged P-term above hfHz (RMS, logged ACTIVE flight) of each PID profile: the RPM signal noise in the P-term and the fast headspeed
    // changes. The twin has no RPM noise: a larger P-gain multiplies the noise part, the other part decreases (gains rows: the bound)
    S.pNoise = {};
    for (const x of use) {
        const run = x.run, P = run.govP; if (!P) continue;
        const lab = profOf(x), lp = lowpass(P, Q.hfHz, run.rate), ph = run.phase;
        for (let k = 0; k < run.n; k++) if (run.state[k] === 4 && (!ph || ph[k] === PH_FLIGHT) && isNum(P[k])) { const a = S.pNoise[lab[k]] || (S.pNoise[lab[k]] = { s2: 0, n: 0 }); a.s2 += (P[k] - lp[k]) ** 2; a.n++; }
    }
    for (const a of Object.values(S.pNoise)) { a.rms = r(Math.sqrt(a.s2 / Math.max(1, a.n)), 5); delete a.s2; }

    // training J of values (main twin): { p: { J, ok, m } } and the pooled J of the profiles
    async function evalTrain(values) {
        const bl = blocks(await simAll(train, 0, values), 0), out = {};
        for (const p of list) { const m = agg(byP(bl, p)), b = baseTrain[p]; out[p] = { J: r(jRel(m, b), 5), ok: ok(m, b), m: metricsOut(m) }; }
        return out;
    }
    const pooled = (ev) => { let s = 0, w = 0; for (const p of list) { s += baseTrain[p].n * ev[p].J; w += baseTrain[p].n; } return w ? s / w : 1; };

    // the margin test windows (main twin) and M of values for each twin
    const ordered = train.concat(test.filter(x => !train.includes(x)));
    const win = {};
    for (const p of list) { const w = windowOf(ordered, p, twins[0].p, current); if (w) { w.run = stepRun(w); w.ref = stepRun(w, false); win[p] = w; S.windows[p] = { log: w.log, t: w.t, step: w.step, coll: r(w.coll) }; } else notes.push(TEXT.noWindow(p)); }
    async function margin(ti, values, p) {
        const w = win[p]; if (!w) return null;
        const k = `M|${ti}|${p}|${vkey(values)}`;
        if (cache.has(k)) return cache.get(k);
        const dv = doubled(values, p);
        let out = { ratio: null, pass: false, reason: 'range' };
        if (dv) {
            const o2 = { plant: 'twin', twin: twins[ti].p, scenario: { values: dv }, record: { points: 1e9 } }, a = await GS.run(w.run, w.x.cfg, o2), b = await GS.run(w.ref, w.x.cfg, o2);
            if (!a.excluded && !b.excluded) out = ratioOf(a.trace, w, b.trace);
        }
        cache.set(k, out);
        return out;
    }
    // M on every twin: { pass, worst ratio, twin of the worst }
    async function marginAll(values, p) {
        let worstR = -1, at = null, pass = true;
        for (let ti = 0; ti < twins.length; ti++) { const m = await margin(ti, values, p); if (!m) return null; const v = m.ratio === null ? Infinity : m.ratio; if (!m.pass) pass = false; if (v > worstR) { worstR = v; at = twins[ti].name; } }
        return { pass, ratio: isFinite(worstR) ? worstR : null, twin: at };
    }
    for (const p of list) S.margin.current[p] = await marginAll(base, p);
    // a change of another family than the gains: satisfactory, or not more than worseTol over the ratio of the values before it
    const marginOk = (m, mb) => !m || m.pass || !!mb && !mb.pass && isNum(m.ratio) && isNum(mb.ratio) && m.ratio <= mb.ratio * (1 + RULES.margin.worseTol);

    // scenario E: the end-of-pack OCV (the lowest rest voltage after a flight, else RULES.endCell per cell); satShare in E (main twin) of
    // values against the baseline, on the training flights at the OCV of the training flights (selection) or on all flights at the OCV of all
    // flights (acceptance: a test flight does not select a value)
    const endOf = (items) => {
        let v = Infinity;
        for (const x of items) { const run = x.run, vb = run.vbat, u = run.u; if (!vb || !u) continue; const a = []; for (let k = run.n - 1; k >= 0 && k >= run.n - 2 * run.rate; k--) if (u[k] <= 0.02 && vb[k] > 0) a.push(vb[k]); if (a.length > 10) v = Math.min(v, median(a)); }
        if (isFinite(v)) return v;
        const c = use.map(x => x.cfg.cells).find(k => k > 0);   // else RULES.endCell per cell (SPEC 7, scenario E)
        return c && twins[0].p.voltage ? c * RULES.endCell : null;
    };
    const endOcv = endOf(use), endTrain = endOf(train);
    S.endOcv = r(endOcv, 2); S.endOcvTrain = r(endTrain, 2);
    async function eSat(items, values, ref, p, ocv = endOcv) {
        if (!ocv) return null;
        const b = agg(byP(blocks(await simAll(items, 0, ref, { ocv })), p)), c = agg(byP(blocks(await simAll(items, 0, values, { ocv })), p));
        return b.n ? { base: r(b.satShare, 5), cand: r(c.satShare, 5), ok: c.satShare <= b.satShare * (1 + Q.satRelE) + Q.satTol, ocv: r(ocv, 2) } : null;
    }

    // the search state: the values of each stage (the doc order)
    const state = copy(base);
    // choose for each PID profile: options [{ values, ev }] (ev of evalTrain). Feasible (sat, iLim), the smallest J that passes M on each twin
    // and the satShare check in E (training flights), and at least minGain under the stage value (no minimum when the stage value fails M)
    async function choose(p, opts, cur, most = Infinity) {
        const curM = await marginAll(cur.values, p), need = curM && !curM.pass;
        const cand = opts.filter(q => q.ev[p] && q.ev[p].ok && (need || q.ev[p].J < cur.ev[p].J - Q.minGain)).sort((a, b) => a.ev[p].J - b.ev[p].J).slice(0, most);
        for (const q of cand) { const m = await marginAll(q.values, p), e = m && m.pass ? await eSat(train, q.values, base, p, endTrain) : null; if (m && m.pass && (!e || e.ok)) return q; }
        return null;
    }

    // --- 1. precomp: the feedforward design for each PID profile, verified on the training flights
    if (fams.includes('precomp')) {
        const ts = Date.now(); progress(0.08, TEXT.progress.precomp);
        const st = S.stages.precomp = { profiles: {} }, cand = copy(state);
        for (const p of list) {
            const cur = state.profiles[p], smp = [], vb = [];
            for (const x of train) { const run = x.run, lab = profOf(x); for (let k = 0; k < x.testFrom; k++) if (run.state[k] === 4 && lab[k] === p) { smp.push({ coll: run.coll[k], cyc: Math.hypot(run.roll[k], run.pitch[k]), yaw: run.yaw[k] }); if (run.vbat) vb.push(run.vbat[k]); } }
            const stride = Math.max(1, Math.ceil(smp.length / RULES.precomp.maxSamples)), s = smp.filter((_, i) => i % stride === 0);
            const V = twins[0].p.voltage && vb.length ? median(vb) : twins[0].p.V0, H = cur.gov_headspeed;
            const d = designPrecomp(twins[0].p, s, H, V, cur);
            if (!d) { st.profiles[p] = { reason: 'design' }; continue; }
            // the spread over the twin set (weights at the chosen f_gain)
            const spread = {}, wn = ['gov_collective_ff_weight', 'gov_cyclic_ff_weight', 'gov_yaw_ff_weight'], add = (k, v) => { const a = spread[k] || (spread[k] = [d.values[k], d.values[k]]); a[0] = Math.min(a[0], v); a[1] = Math.max(a[1], v); };
            for (let ti = 1; ti < twins.length; ti++) {
                const q = designPrecomp(twins[ti].p, s, H, V, cur);
                if (q) { wn.forEach((k, j) => add(k, q.eff[j] * 1e6 / (cur.gov_gain * d.values.gov_f_gain))); add('gov_collective_curve', q.curve); }
            }
            st.profiles[p] = Object.assign({ spread: Object.fromEntries(Object.entries(spread).map(([k, a]) => [k, [r(a[0], 1), r(a[1], 1)]])) }, d);
            Object.assign(cand.profiles[p], d.values);
        }
        if (vkey(cand) !== vkey(state)) {
            const ev = await evalTrain(cand), evS = await evalTrain(state);
            for (const p of list) {
                const x = st.profiles[p]; if (!x || !x.values) continue;
                const m = ev[p].m, b = evS[p].m, Rp = RULES.precomp;
                x.train = { J: ev[p].J, Jnow: evS[p].J, metrics: m };
                x.verified = ev[p].ok && m.over95 <= Math.max(b.over95, Q.floor.over95) * (1 + Rp.overTol) && m.thrHF <= Math.max(b.thrHF, Q.floor.thrHF) * (1 + Rp.hfTol) && ev[p].J <= evS[p].J;
                if (x.verified) Object.assign(state.profiles[p], x.values); else x.reason = 'verify';
            }
        }
        timing.precompMs = Date.now() - ts;
    }

    // --- 2. gains: I grid, P grid, D grid {0, current, +}, then P, I and D together for a PID profile that fails the margin test; one
    // simulation set for all PID profiles; the choice of each PID profile from its own J
    if (fams.includes('gains')) {
        const ts = Date.now(), G = ['gov_p_gain', 'gov_i_gain', 'gov_d_gain'], st = S.stages.gains = { grids: {} }; progress(0.2, TEXT.progress.gains);
        for (const name of ['gov_i_gain', 'gov_p_gain', 'gov_d_gain', 'scale']) {
            const evS = await evalTrain(state), tried = [{ values: copy(state), ev: evS }], sel = [];
            for (const p of list) if (name !== 'scale' || !(await marginAll(state, p) || { pass: true }).pass) sel.push(p);
            const mults = name === 'gov_d_gain' ? ['zero', 'plus'] : name === 'scale' ? RULES.gains.scale : RULES.gains.grid;
            const apply = (v, p, m) => {
                const q = v.profiles[p], names = name === 'scale' ? G : [name];
                for (const k of names) { const c = q[k], hi = range(k)[1]; if (!isNum(c)) return false;
                    q[k] = m === 'zero' ? 0 : m === 'plus' ? Math.min(hi, Math.max(2 * c, c + RULES.gains.dStep)) : clampInt(c * m, c > 0 && k !== 'gov_d_gain' ? 1 : 0, hi); }
                return names.some(k => q[k] !== state.profiles[p][k]);
            };
            for (const m of sel.length ? mults : []) { const v = copy(state); let any = false; for (const p of sel) if (apply(v, p, m)) any = true; if (any) tried.push({ values: v, ev: await evalTrain(v), m }); }
            const g = st.grids[name] = { profiles: {} };
            for (const p of sel) {
                const q = await choose(p, tried.slice(1), tried[0]), shown = (t) => name === 'scale' ? `${t.values.profiles[p].gov_p_gain}/${t.values.profiles[p].gov_i_gain}` : t.values.profiles[p][name];
                // J against the values of this stage (the value at this time of this name: 1)
                g.profiles[p] = { from: shown(tried[0]), tested: tried.map(t => ({ value: shown(t), J: t.ev[p] && tried[0].ev[p] ? r(t.ev[p].J / tried[0].ev[p].J, 5) : null, ok: t.ev[p] ? t.ev[p].ok : null })) };
                if (q) { for (const k of G) state.profiles[p][k] = q.values.profiles[p][k]; g.profiles[p].to = shown(q); g.profiles[p].J = q.ev[p].J; }
            }
        }
        st.ms = Date.now() - ts;
    }
    // --- 3. filters (global): a common grid of gov_rpm_filter and gov_ff_filter; gov_d_filter only with a D-gain; pooled J of the PID profiles
    if (fams.includes('filters')) {
        const ts = Date.now(); progress(0.45, TEXT.progress.filters);
        const st = S.stages.filters = { grids: {}, glitch: {} }, dOn = list.some(p => state.profiles[p].gov_d_gain > 0);
        for (const name of NAMES.filters) {
            const c = state.global[name];
            if (!isNum(c) || (name === 'gov_d_filter' && !dOn)) { st.grids[name] = { skipped: name === 'gov_d_filter' ? 'dZero' : 'unknown' }; continue; }
            const at = (p, m) => clampInt(c * m, 1, range(name)[1]), evS = await evalTrain(state), tried = [{ value: c, values: copy(state), ev: evS, J: pooled(evS) }];
            for (const m of RULES.filters.grid) { const x = at(0, m); if (tried.some(t => t.value === x)) continue; const v = copy(state); v.global[name] = x; const ev = await evalTrain(v); tried.push({ value: x, values: v, ev, J: pooled(ev) }); }
            const allowed = tried.slice(1).filter(t => (name !== 'gov_rpm_filter' || t.value < c) && list.every(p => t.ev[p].ok) && t.J < tried[0].J - Q.minGain).sort((a, b) => a.J - b.J);
            let pick = null;
            for (const t of allowed) { let pass = true; for (const p of list) if (!marginOk(await marginAll(t.values, p), await marginAll(state, p))) { pass = false; break; } if (pass) { pick = t; break; } }
            st.grids[name] = { from: c, tested: tried.map(t => ({ value: t.value, J: r(t.J / tried[0].J, 5), ok: list.every(p => t.ev[p].ok) })) };
            if (pick) { state.global[name] = pick.value; st.grids[name].to = pick.value; }
        }
        // the FALLBACK glitch reference: the largest |hs - PT2(hs, fc)| in logged ACTIVE flight against the glitch limit of the PID profile of the
        // sample (RULES.filters.glitch x gov_headspeed), not within fallbackS of a logged FALLBACK (the logged glitches), for each value of the grid
        const c = state.global.gov_rpm_filter;
        if (isNum(c)) for (const fc of [...new Set([c, base.global.gov_rpm_filter].concat(RULES.filters.grid.map(m => clampInt(c * m, 1, 250))))].filter(isNum).sort((a, b) => a - b)) {
            let best = null;
            for (const x of use) {
                const run = x.run, f = GP.pt2(run.hs, fc, run.pidHz, run.loopsPerFrame || 1), lab = profOf(x), F = Math.round(RULES.filters.fallbackS * run.rate), near = new Uint8Array(run.n);
                for (let k = 0; k < run.n; k++) if (run.state[k] === 6) near.fill(1, Math.max(0, k - F), Math.min(run.n, k + F));
                for (let k = 0; k < run.n; k++) {
                    const hf = (current.profiles[lab[k]] || {}).gov_headspeed;
                    if (run.state[k] !== 4 || near[k] || !(hf > 0)) continue;
                    const d = Math.abs(run.hs[k] - f[k]), lim = RULES.filters.glitch * hf;
                    if (!best || d / lim > best.share) best = { maxRpm: r(d, 0), limitRpm: r(lim, 0), share: r(d / lim, 3), at: { log: run.log, t: r((run.fromS || 0) + run.time[k], 2) } };
                }
            }
            if (best) st.glitch[fc] = best;
        }
        st.ms = Date.now() - ts;
    }
    // --- 4. NOMAD: a joint refinement of P and I of each PID profile (integer), inside the time budget
    if (fams.includes('gains') && o.nomad !== false && list.length) {
        const ts = Date.now(), cap = isNum(o.budgetMs) ? o.budgetMs : RULES.nomad.budgetMs;
        // NOMAD always does RULES.nomad.evaluations points, so the gains do not depend on the speed of the computer (a skip at the
        // deadline did on the app, 2026-10-15); budgetMs is a safety limit only (a stop there gives the note nomadTime). o.deadline and
        // minMs are not used for this decision
        const budget = cap;
        timing.nomadBudgetMs = Math.round(budget);
        progress(0.55, TEXT.progress.nomad);
        const vars = []; for (const p of list) for (const name of ['gov_p_gain', 'gov_i_gain']) { const c = state.profiles[p][name]; if (isNum(c) && c > 0) vars.push({ p, name, c, lo: Math.max(1, Math.ceil(c * RULES.nomad.range[0])), hi: Math.min(range(name)[1], Math.floor(c * RULES.nomad.range[1])) }); }
        const usable = vars.filter(v => v.hi > v.lo);
        if (usable.length && budget > 0 && !(S.stages.nomad && S.stages.nomad.skipped)) {
            const opt = require('./filter_optimizer.cjs'), ncache = new Map(), STOP = { stop: true }, evals = [];
            const valuesOf = (xv) => { const v = copy(state); usable.forEach((q, i) => { v.profiles[q.p][q.name] = xv[i]; }); return v; };
            const evaluate = async (xv) => {
                const v = valuesOf(xv), ev = await evalTrain(v), cons = [-Infinity, -Infinity, -Infinity];
                for (const p of list) { const b = baseTrain[p], m = ev[p].m; cons[0] = Math.max(cons[0], m.satShare - b.satShare - Q.satTol); cons[1] = Math.max(cons[1], m.iLimitOutsideSat - b.iLimitOutsideSat - Q.iLimTol);
                    const M = await margin(0, v, p); cons[2] = Math.max(cons[2], M ? (M.ratio === null ? 1 : Math.min(10, M.ratio) - RULES.margin.ratio) : 0); }
                evals.push({ values: v, ev });
                return [pooled(ev)].concat(cons);
            };
            let res = null, pending = null, timedOut = false;
            for (;;) {
                const left = budget * (1 - RULES.nomad.chooseShare) - (Date.now() - ts);
                if (evals.length >= RULES.nomad.evaluations) { res = res || { stop: 'evaluations' }; break; }
                if (left <= 0) { timedOut = true; break; }
                try {
                    res = opt.minimize({ lower: usable.map(v => v.lo), upper: usable.map(v => v.hi), initial: usable.map(v => v.c), constraints: 3, maxEvaluations: RULES.nomad.maxEvaluations, timeMs: left, audit: false,
                        evaluate: (xv) => { const k = xv.join(','); if (ncache.has(k)) return ncache.get(k); pending = xv.slice(); throw STOP; } });
                    break;
                } catch (e) { if (e !== STOP) throw e; ncache.set(pending.join(','), await evaluate(pending)); }
            }
            // each PID profile: the evaluated point with the smallest J that passes the constraints, if it is minGain under the grid value
            const evS = await evalTrain(state), changed = [];
            for (const p of list) {
                const q = await choose(p, evals, { values: copy(state), ev: evS }, RULES.nomad.choose);
                if (q) { for (const v of usable.filter(v => v.p === p)) state.profiles[p][v.name] = q.values.profiles[p][v.name]; changed.push(p); }
            }
            S.stages.nomad = { evaluations: evals.length, ms: Date.now() - ts, stop: timedOut ? 'time budget' : res ? res.stop : 'evaluations', changed, variables: usable.map(v => ({ profile: v.p, name: v.name, from: v.c, lo: v.lo, hi: v.hi, to: state.profiles[v.p][v.name] })) };
            notes.push(TEXT.nomad(evals.length, Date.now() - ts));
            if (timedOut) notes.push(TEXT.nomadTime(evals.length));
        }
    }
    // the uniform change of P and I (and D): gov_gain, with gov_f_gain that keeps the feedforward (SPEC 5: keep gov_gain unless uniform)
    if (fams.includes('gains')) for (const p of list) {
        const c = current.profiles[p], s = state.profiles[p];
        if (!isNum(c.gov_p_gain) || !(c.gov_p_gain > 0) || !(c.gov_i_gain > 0) || !isNum(c.gov_gain)) continue;
        const mp = s.gov_p_gain / c.gov_p_gain, mi = s.gov_i_gain / c.gov_i_gain, md = c.gov_d_gain > 0 ? s.gov_d_gain / c.gov_d_gain : mi;
        if (Math.abs(mp - 1) < 1e-9 || Math.abs(mp - mi) > RULES.gains.uniformTol * mp || Math.abs(md - mi) > RULES.gains.uniformTol * mi) continue;
        const g = Math.round(c.gov_gain * mp), f = isNum(s.gov_f_gain) ? Math.round(s.gov_f_gain * c.gov_gain / g) : null;
        if (g < 1 || g > range('gov_gain')[1] || f !== null && (f < 0 || f > range('gov_f_gain')[1]) || Math.abs(g * c.gov_p_gain / (c.gov_gain * s.gov_p_gain) - 1) > RULES.gains.uniformTol) continue;
        S.stages.gains.uniform = Object.assign(S.stages.gains.uniform || {}, { [p]: { factor: r(mp, 3), gain: g } });
    }
    // --- 5. limits: the terms with the selected values on all flights; a limit reached outside saturation gets a larger value
    if (fams.includes('limits')) {
        const ts = Date.now(); progress(0.7, TEXT.progress.limits);
        const st = S.stages.limits = { profiles: {} }, acc = {};
        for (const q of await simAll(use, 0, state, { terms: true })) for (const [p, A] of Object.entries(q.terms || {})) {
            const B = acc[p] || (acc[p] = {});
            for (const [t, T] of Object.entries(A)) { const X = B[t] || (B[t] = { outS: 0, inS: 0, maxOut: 0, max: 0, lim: T.lim }); X.outS += T.outS; X.inS += T.inS; X.maxOut = Math.max(X.maxOut, T.maxOut); X.max = Math.max(X.max, T.max); }
        }
        for (const p of list) {
            const B = acc[p] || {}, out = st.profiles[p] = {};
            for (const [t, name] of Object.entries(TERM)) {
                const X = B[t]; if (!X) continue;
                const L = state.profiles[p][name];
                out[t] = { name, lim: X.lim, outS: r(X.outS, 3), inS: r(X.inS, 3), maxOut: r(X.maxOut, 4), max: r(X.max, 4) };
                if (X.outS >= RULES.limits.minS && isNum(L) && L < 100 && X.lim > 0) {
                    const to = t === 'I' ? Math.min(100, L + RULES.limits.iStep) : Math.min(100, Math.max(L + 1, Math.ceil(100 * X.maxOut * (1 + RULES.limits.margin))));
                    out[t].to = to; state.profiles[p][name] = to;
                }
            }
        }
        st.ms = Date.now() - ts;
    }

    // --- 6. acceptance on the test flights: each family in the doc order on the accepted values. With each twin of the set: the paired block
    // bootstrap (the same blocks), the constraints and the margin test; the throttle at the end-of-pack voltage (main twin)
    progress(0.8, TEXT.progress.accept);
    const ta = Date.now();
    let accepted = copy(base);
    const touched = (fam) => NAMES[fam];
    for (const fam of ORDER.filter(f => fams.includes(f))) {
        const D = S.accept[fam] = { profiles: {}, global: null }, global = fam === 'filters', cand = copy(accepted);
        const changed = [];
        if (global) { for (const name of touched(fam)) if (isNum(state.global[name]) && state.global[name] !== accepted.global[name]) { cand.global[name] = state.global[name]; changed.push(0); } }
        else for (const p of list) {
            const u = fam === 'gains' && S.stages.gains && S.stages.gains.uniform && S.stages.gains.uniform[p], a = accepted.profiles[p], c = cand.profiles[p];
            // a uniform change: gov_gain, and gov_f_gain that keeps the accepted feedforward
            if (u) { c.gov_gain = u.gain; if (isNum(a.gov_f_gain) && a.gov_gain > 0) c.gov_f_gain = clampInt(a.gov_f_gain * a.gov_gain / u.gain, 0, range('gov_f_gain')[1]); }
            else for (const name of touched(fam)) if (isNum(state.profiles[p][name])) c[name] = state.profiles[p][name];
            if (Object.keys(c).some(k => c[k] !== a[k])) changed.push(p);
        }
        if (!changed.length) continue;
        const ps = global ? list : [...new Set(changed)], decide = {};
        for (const p of (global ? [0] : ps)) {
            const pl = p === 0 ? list : [p], sel = (bl) => bl.filter(b => pl.includes(b.p)), twin = [], why = [];
            let x = null;
            for (let ti = 0; ti < twins.length; ti++) {
                const b1 = blocks(await simAll(test, ti, accepted), 1), c1 = blocks(await simAll(test, ti, cand), 1), y = paired(sel(b1), sel(c1), pl);
                if (ti === 0) x = y;
                for (const q of pl) { const b = agg(byP(b1, q)), c = agg(byP(c1, q)); if (b.n && !ok(c, b)) why.push(c.satShare > b.satShare + Q.satTol ? TEXT.why.sat(twins[ti].name) : TEXT.why.iLim(twins[ti].name)); }
                twin.push({ twin: twins[ti].name, imp: y.imp, se: y.se, pass: passes(y) });
            }
            // the margin test with each twin: satisfactory for a change of the gains; else not worse than before the change (marginOk). fix: the
            // change makes a margin test satisfactory that is not satisfactory before it (a result, not a reason to accept: SPEC 7)
            const marg = {}, mBase = {};
            for (const q of pl) { const m = await marginAll(cand, q), mb = await marginAll(accepted, q); marg[q] = m; mBase[q] = mb; if (fam === 'gains' ? m && !m.pass : !marginOk(m, mb)) why.push(TEXT.why.margin(m.twin)); }
            const fix = pl.some(q => mBase[q] && !mBase[q].pass) && pl.every(q => !marg[q] || marg[q].pass);
            const eS = {};
            for (const q of pl) { const e = await eSat(use, cand, accepted, q); if (!e) continue; eS[q] = e; if (!e.ok) why.push(TEXT.why.satE(endOcv, e.base, e.cand)); }
            // the robustness rule: the bootstrap of every twin passes; the interval: imp ± z SE over the set
            const z = RULES.accept.z, okT = twin.filter(t => isNum(t.imp) && isNum(t.se)), worstT = okT.reduce((a, t) => !a || t.imp < a.imp ? t : a, null), fail = twin.find(t => !t.pass);
            if (x.n < RULES.accept.minBlocks) why.push(TEXT.why.blocks());
            else if (!passes(x)) why.push(TEXT.why.small());
            else if (fail) why.push(TEXT.why.twin(fail.twin));
            decide[p] = Object.assign({}, x, { accepted: !fail && !why.length, fix, why: [...new Set(why)], eSat: eS, twins: twin, twinLo: okT.length ? r(Math.min(...okT.map(t => t.imp - z * t.se)), 3) : null,
                twinHi: okT.length ? r(Math.max(...okT.map(t => t.imp + z * t.se)), 3) : null, worst: worstT ? { twin: worstT.twin, imp: worstT.imp } : null, margin: marg,
                changes: p === 0 ? Object.fromEntries(touched(fam).filter(n => cand.global[n] !== accepted.global[n]).map(n => [n, cand.global[n]])) : Object.fromEntries(Object.keys(cand.profiles[p]).filter(n => cand.profiles[p][n] !== accepted.profiles[p][n]).map(n => [n, cand.profiles[p][n]])) });
        }
        // without battery current, a larger effective gain is not accepted: an opt-in check (critique C13); the next families use the values
        // at this time
        if (fam === 'gains' && !S.hasCurrent) for (const p of ps) { const d = decide[p]; if (d && d.accepted && raises(accepted.profiles[p], cand.profiles[p])) Object.assign(d, { accepted: false, optIn: true, why: [TEXT.noCurrent] }); }
        if (global) { D.global = decide[0]; if (decide[0].accepted) accepted = cand; }
        else for (const p of ps) { D.profiles[p] = decide[p]; if (decide[p].accepted) Object.assign(accepted.profiles[p], decide[p].changes); }
    }
    timing.acceptMs = Date.now() - ta;
    S.final = accepted;
    S.searched = state;
    for (const p of list) S.margin.final = Object.assign(S.margin.final || {}, { [p]: await marginAll(accepted, p) });
    // the plot of the margin test: the step response (main twin, P, I and D x factor, no F-term) with the values at this time and with the
    // accepted values when its gains are not the same
    S.marginPlot = {};
    for (const p of list) {
        const w = win[p]; if (!w) continue;
        const resp = async (values) => {
            const dv = doubled(values, p); if (!dv) return null;
            const o2 = { plant: 'twin', twin: twins[0].p, scenario: { values: dv }, record: { points: 1e9 } }, a = await GS.run(w.run, w.x.cfg, o2), b = await GS.run(w.ref, w.x.cfg, o2);
            return a.excluded || b.excluded ? null : stepResponse(a.trace, b.trace, w);
        };
        // the accepted gains, else the gains of an opt-in check (no battery current)
        const od = S.accept.gains && S.accept.gains.profiles[p], opt = !!(od && od.optIn), same = G5.every(k => accepted.profiles[p][k] === base.profiles[p][k]);
        const v1 = !same ? accepted : opt ? (() => { const v = copy(accepted); Object.assign(v.profiles[p], od.changes); return v; })() : null;
        const m0 = await resp(base), m1 = v1 ? await resp(v1) : null;
        if (m0) S.marginPlot[p] = { log: w.log, step: w.step, t: m0.t, base: m0.e, final: m1 ? m1.e : null, opt: same && opt };
    }

    // --- 7. plot data: the values at this time against the accepted values (else the searched values) on the longest test flight (t in frame
    // seconds: fromS + the run time, the clock of the log viewer)
    const shown = vkey(accepted) !== vkey(base) ? accepted : state, tl = test.slice().sort((a, b) => (b.run.n - b.testFrom) - (a.run.n - a.testFrom))[0];
    if (tl) {
        const pts = { points: 2000 }, A = await GS.run(tl.run, tl.cfg, { plant: 'twin', twin: twins[0].p, scenario: { values: base }, record: pts }), B = await GS.run(tl.run, tl.cfg, { plant: 'twin', twin: twins[0].p, scenario: { values: shown }, record: pts });
        const bT2 = blocks(await simAll(test, 0, base), 1), cT2 = blocks(await simAll(test, 0, shown), 1);
        S.plot = { log: tl.run.log, segment: tl.run.segment || 0, candidate: shown === accepted ? 'accepted' : 'searched',
            trace: A.trace && B.trace ? { t: Array.from(A.trace.t, v => r((tl.run.fromS || 0) + v, 3)), hs: Array.from(tl.run.hs.filter((_, i) => i % A.trace.stride === 0)), hsBase: Array.from(A.trace.hs), hsCand: Array.from(B.trace.hs),
                target: Array.from(A.trace.target), uBase: Array.from(A.trace.u), uCand: Array.from(B.trace.u), state: Array.from(A.trace.state) } : null,
            table: list.map(p => { const b = agg(byP(bT2, p)), c = agg(byP(cT2, p)); return { profile: p, base: metricsOut(b), cand: metricsOut(c), J: b.n ? r(jRel(c, b), 4) : null }; }) };
    }
    timing.sims = sims; timing.simMs = simMs;
    S.ms = Date.now() - t0;
    progress(1, TEXT.progress.accept);
    return S;
}

// ---------------------------------------------------------------------------------------------
// rows (gov_tune.row format), read from ctx.sim
// ---------------------------------------------------------------------------------------------

const ev = (text, value, unit, o) => TUNE.ev(text, value, unit, o);
const sentences = (s) => (String(s).match(/[.!?](?=\s|$)/g) || []).length;
const impText = (d) => Math.abs(d.imp) < 0.05 && Math.abs(d.lo) < 0.05 && Math.abs(d.hi) < 0.05 ? TEXT.same(d) : d.imp >= 0 ? TEXT.imp(d) : TEXT.worse(d);
// the effect on the test flights (main twin) and the twin set: the change of J of the twin with the smallest decrease, the interval imp ± z SE
function accEvidence(d) {
    const out = [ev(impText(d), d.imp, '%', { lo: d.lo, hi: d.hi, se: d.se, n: d.n })];
    if (isNum(d.twinLo) && d.worst) out.push(ev(`${TEXT.twinWorst(-d.worst.imp, d.worst.twin)} ${TEXT.twinRange(d.twinLo, d.twinHi)}`, r(-d.worst.imp, 3), '%', { lo: r(-d.twinHi, 3), hi: r(-d.twinLo, 3), n: d.twins.length }));
    return out;
}
// the margin test: the window; with the recommended gains (when the gains of PID profile p change) and with the gains at this time
const G5 = ['gov_gain', 'gov_p_gain', 'gov_i_gain', 'gov_d_gain', 'gov_f_gain'];
const gainsChange = (S, p) => !!S.final && G5.some(k => (S.final.profiles[p] || {})[k] !== (S.current.profiles[p] || {})[k]);
function marginEvidence(S, p) {
    const out = [], m = S.margin.current[p], mf = S.margin.final && S.margin.final[p], w = S.windows[p];
    if (w) out.push(ev(TEXT.marginStep(w), w.step, null, { log: w.log, t0: w.t }));
    if (mf && gainsChange(S, p)) out.push(ev(TEXT.marginNew(p, mf.ratio, mf.twin), mf.ratio, 'ratio'));
    if (m) out.push(ev(m.pass ? TEXT.marginNow(p, m.ratio) : TEXT.marginFail(p, m.ratio, m.twin), m.ratio, 'ratio'));
    return out;
}
// the decision that gives the recommended value of each name of each PID profile (the last accepted family that changes it, or an opt-in
// decision), and the size of each decision: the changes that the acceptance tests together are one group (advice.cjs group: all or none)
const OWNERS = new WeakMap();
function ownersOf(S) {
    if (OWNERS.has(S)) return OWNERS.get(S);
    const own = new Map(), size = new Map();
    for (const f of ORDER) { const A = S.accept && S.accept[f]; if (!A) continue;
        for (const [p, d] of Object.entries(A.profiles || {}).concat(A.global ? [['0', A.global]] : [])) if (d && (d.accepted || d.optIn)) for (const n of Object.keys(d.changes)) own.set(`${p}|${n}`, { key: `GS:${f}:${p}`, d }); }
    for (const x of own.values()) size.set(x.key, (size.get(x.key) || 0) + 1);
    const out = { own, size }; OWNERS.set(S, out); return out;
}
// the names that each simulation of the search uses (the flags of gov_tune.simStale)
const USED = [].concat(NAMES.precomp, NAMES.gains, NAMES.filters, NAMES.limits, ['gov_headspeed', 'gov_max_throttle', 'gov_min_throttle']);
// the rows of family fam for each of its names and PID profiles (ctx.profiles; 0 for a global name). A change: the change, the effect on
// the test flights, its range over the twin set and the reason or the main result of the family (four sentences: gov_tune.toRecommendation
// adds two). Else: the effect, its range, the main result, two reasons and "keep" (six sentences). The other numbers are evidence
function familyRows(ctx, fam) {
    const S = ctx.sim, I = TUNE.MODEL_INFO[fam], out = [];
    if (!S) return TUNE.pendingRows(ctx, fam);
    const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
    const decisionOf = (f, p) => { const A = S.accept && S.accept[f]; return !A ? null : p ? A.profiles[p] || null : A.global; };
    for (const name of NAMES[fam]) for (const p of GLOBAL.has(name) ? [0] : ctx.profiles) {
        const o = { topic: 'model', family: TUNE.REG[name].family, rule: RULE_KEYS[fam], method: I.method, evidence: [], status: 'keep' }, t = [], why = [];
        // opt: a change of the model that is a check with opt-in CLI text (no battery current, a larger gain)
        let opt = null;
        const done = (x) => {
            const ch = o.status === 'change', order = ch || opt !== null ? [TEXT.change(name, ch ? o.to : opt), t[0], why[0], t[1], t[2], t[3]] : [t[0], why[0], t[1], t[2], why[1], t[3], why[2]], body = [];
            let k = 0; for (const s of order) if (s && k + sentences(s) <= (ch ? 4 : opt !== null ? 6 : 5)) { body.push(s); k += sentences(s); }
            if (!ch && opt === null) body.push(TEXT.keep);
            const ow = S.status === 'ok' && (o.status === 'change' || opt !== null) ? ownersOf(S).own.get(`${p}|${name}`) : null, n = ow ? ownersOf(S).size.get(ow.key) : 0;
            if (n > 1) Object.assign(o, { group: ow.key, groupSize: n });
            const row = TUNE.row(ctx, name, p, Object.assign(o, x || {}, { text: body.join(' ') }));
            if (S.status === 'ok') row.stale = TUNE.mergeStale(row.stale, TUNE.simStale(ctx, USED, p > 0 ? p : null, S.split.train.concat(S.split.test)));
            if (opt !== null) TUNE.optIn(row, opt, ctx);
            out.push(row);
        };
        if (S.status !== 'ok') { why.push(S.reason); done({ reason: S.reason }); continue; }
        const g = GLOBAL.has(name), P = g ? null : S.profiles[p];
        if (!g && (!P || !P.searched)) { why.push(p > 0 ? TEXT.few(p, P ? P.trainS : 0) : TEXT.unknownProfile); done(); continue; }
        const cur = p ? (S.current.profiles[p] || {})[name] : S.current.global[name], fin = p ? (S.final.profiles[p] || {})[name] : S.final.global[name];
        // the decision that gives the value: the last accepted family that changes this name, else the candidate of this family (a change of
        // the gains covers each gain: a uniform change is a change of gov_gain)
        const covers = (d) => !!d && (own(d.changes, name) || fam === 'gains' && Object.keys(d.changes).some(k => NAMES.gains.includes(k)));
        let D = null; for (const f of ORDER) { const d = decisionOf(f, p); if (d && d.accepted && own(d.changes, name)) D = d; }
        const changed = isNum(fin) && fin !== cur;
        if (!D) { const d = decisionOf(fam, p); if (covers(d)) D = d; }
        if (changed) { o.status = 'change'; o.to = fin; }
        if (D) {
            o.evidence.push(...accEvidence(D)); t.push(impText(D));
            if (isNum(D.twinLo) && !(Math.abs(D.twinLo) < 0.05 && Math.abs(D.twinHi) < 0.05)) t.push(TEXT.twinRange(D.twinLo, D.twinHi));
            if (D.fix && D.accepted) { why.push(TEXT.fixed); o.rule = RULE_KEYS.margin; } else if (!changed) why.push(...(D.fix ? [TEXT.proposal(D.changes)] : []), ...D.why);
        }
        if (fam === 'precomp') {
            const x = S.stages.precomp && S.stages.precomp.profiles[p];
            if (x && x.values) {
                t.push(TEXT.design(p, x.rms, x.r2)); o.evidence.push(ev(TEXT.design(p, x.rms, x.r2), x.rms, 'fraction', { n: x.n }));
                if (isNum(x.rmsNow)) o.evidence.push(ev(TEXT.designNow(x.rmsNow), x.rmsNow, 'fraction'));
                if (x.spread && x.spread[name]) o.evidence.push(ev(TEXT.designRange(name, x.spread[name][0], x.spread[name][1]), x.values[name], null, { lo: x.spread[name][0], hi: x.spread[name][1] }));
                if (name === 'gov_f_gain') t.push(changed && D === decisionOf('gains', p) ? TEXT.fKeep(fin) : TEXT.keepGain);
                if (x.reason === 'verify' && !changed) why.push(TEXT.why.verify);
            }
        }
        if (fam === 'gains') {
            const st = S.stages.gains || {}, g = st.grids && st.grids[name], u = st.uniform && st.uniform[p], m = S.margin.current[p], mf = S.margin.final && S.margin.final[p];
            if (g && g.profiles[p]) for (const q of g.profiles[p].tested) if (isNum(q.J) && q.value !== g.profiles[p].from) o.evidence.push(ev(TEXT.gridJ(name, q.value, g.profiles[p].from), r(100 * (q.J - 1), 2), '%'));
            if (u && changed && (name === 'gov_gain')) t.push(TEXT.uniform(u.factor));
            // the noise bound of a larger P-term gain (K Kp) from the logged P-term
            const c0 = S.current.profiles[p] || {}, c1 = S.final.profiles[p] || {}, k0 = c0.gov_gain * c0.gov_p_gain, k1 = c1.gov_gain * c1.gov_p_gain, pn = S.pNoise && S.pNoise[p];
            if (pn && isNum(pn.rms) && k0 > 0 && k1 > k0 && (name === 'gov_gain' || name === 'gov_p_gain')) o.evidence.push(ev(`${TEXT.pNoise(pn.rms, pn.rms * k1 / k0)} ${TEXT.pNoiseNote}`, r(pn.rms * k1 / k0, 5), 'fraction', { n: pn.n }));
            o.evidence.push(...marginEvidence(S, p));
            if (m && !m.pass) { t.push(TEXT.marginFail(p, m.ratio, m.twin)); if (!changed && mf && !mf.pass) { o.status = 'check'; o.title = `Margin test not satisfactory (${prof(p)})`; o.rule = RULE_KEYS.margin; } }
            if (!S.windows[p]) why.push(TEXT.noWindow(p));
            // an accepted change of the gains that keeps this value: say so (the J change of the row is that of the other gains)
            if (!changed && D && D.accepted) why.unshift(name === 'gov_gain' ? TEXT.keepGain : TEXT.otherGains);

        }
        if (fam === 'filters') {
            const st = S.stages.filters || { grids: {}, glitch: {} }, g = st.grids[name];
            if (g && g.skipped === 'dZero') { o.status = 'not-applicable'; why.push(TEXT.why.dZero); done({ reason: TEXT.why.dZero }); continue; }
            if (name === 'gov_d_filter') t.push(TEXT.why.dLog);
            if (g && g.tested) for (const q of g.tested) if (isNum(q.J) && q.value !== g.from) o.evidence.push(ev(TEXT.gridJ(name, q.value, g.from), r(100 * (q.J - 1), 2), '%'));
            if (name === 'gov_rpm_filter') {
                t.push(TEXT.why.rpmUp, TEXT.glitchNote); o.record = TEXT.rpmRecord;
                for (const [fc, q] of Object.entries(st.glitch || {})) o.evidence.push(ev(TEXT.glitch(fc, q.maxRpm, q.limitRpm), q.maxRpm, 'rpm', { hi: q.limitRpm, log: q.at ? q.at.log : null, t0: q.at ? q.at.t : null }));
            }
        }
        if (fam === 'limits') {
            const tk = Object.keys(TERM).find(k => TERM[k] === name), x = S.stages.limits && S.stages.limits.profiles[p] && S.stages.limits.profiles[p][tk], tn = TEXT.termName[tk];
            if (x) {
                t.push(x.outS > 0 || x.inS > 0 ? TEXT.lim(tn, x.lim, x.outS, x.inS) : TEXT.limNone(tn, x.max, x.lim));
                o.evidence.push(ev(TEXT.limOut(tn), x.outS, 's'), ev(TEXT.limIn2(tn), x.inS, 's'), ev(TEXT.limMax(tn), x.maxOut, 'fraction'));
                if (x.outS >= RULES.limits.minS && !changed) { why.unshift(TEXT.limCheck); o.status = 'check'; o.title = `The governor ${tn} at its limit (${prof(p)})`; }
                else if (x.inS > 0 && !(x.outS > 0)) t.push(TEXT.limIn);
            }
        }
        // an opt-in decision (no battery current, a larger gain: critique C13) that changes this name: a check with the opt-in CLI text
        const ow = ownersOf(S).own.get(`${p}|${name}`);
        if (!changed && ow && ow.d.optIn && isNum(ow.d.changes[name]) && ow.d.changes[name] !== cur) {
            opt = ow.d.changes[name]; o.status = 'check'; o.title = `Larger governor gain (${prof(p)})`; o.record = TUNE.TEXT.record.ibatRecord;
            if (ow.d !== D) { o.evidence.push(...accEvidence(ow.d)); t.unshift(impText(ow.d)); }
            const mm = ow.d.margin && ow.d.margin[p]; if (mm) o.evidence.push(ev(TEXT.marginOpt(p, mm.ratio, mm.twin), mm.ratio, 'ratio'));
            // the noise bound of the larger P-term gain of the check
            const c0 = S.current.profiles[p] || {}, c1 = Object.assign({}, c0, ow.d.changes), k0 = c0.gov_gain * c0.gov_p_gain, k1 = c1.gov_gain * c1.gov_p_gain, pn = S.pNoise && S.pNoise[p];
            if (pn && isNum(pn.rms) && k0 > 0 && k1 > k0 && (name === 'gov_gain' || name === 'gov_p_gain')) o.evidence.push(ev(`${TEXT.pNoise(pn.rms, pn.rms * k1 / k0)} ${TEXT.pNoiseNote}`, r(pn.rms * k1 / k0, 5), 'fraction', { n: pn.n }));
            for (let j = 0; j < t.length; j++) if (t[j] === TEXT.keepGain) t[j] = TEXT.fKeep(opt);
            why.splice(0, why.length, TEXT.noCurrent);
        }
        if (!changed && !D && !why.length && (fam === 'precomp' || fam === 'gains')) why.push(TEXT.why.none);
        done();
    }
    return out;
}
const FAMILIES = { precomp: (ctx) => familyRows(ctx, 'precomp'), gains: (ctx) => familyRows(ctx, 'gains'), filters: (ctx) => familyRows(ctx, 'filters'), limits: (ctx) => familyRows(ctx, 'limits') };

module.exports = { RULES, RULE_KEYS, TEXT, NAMES, search, FAMILIES, familyRows, designPrecomp, nnls3, twinSet, windowOf, stepRun, ratioOf, decay, doubled, blocksOf, agg, jRel, paired, passes, termsOf, lowpass };
if (require.main !== module) return;

// node tools/autotune/gov_search.cjs <craft dir of analysis/governor-twin/out> <data dir> [--cli <dump>] [--no-nomad] [--budget ms] [--json <out>]:
// the search with the twin of result.json (dev harness)
(async () => {
    const fs = require('fs'), path = require('path'), GD = require('./gov_data.cjs');
    const args = process.argv.slice(2), opt = (k) => { const j = args.indexOf(k); return j >= 0 ? args.splice(j, 2)[1] : null; }, flag = (k) => { const j = args.indexOf(k); if (j >= 0) args.splice(j, 1); return j >= 0; };
    const cliFile = opt('--cli'), json = opt('--json'), budget = opt('--budget'), noNomad = flag('--no-nomad'), [out, dir] = args;
    const meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')), craft = path.basename(dir), dis = path.join(path.dirname(out), `disarm_${craft}.json`), events = {};
    if (fs.existsSync(dis)) { const d = JSON.parse(fs.readFileSync(dis, 'utf8')); for (const s of meta.segments) events[s.log] = (d.us[s.log] || []).map(us => ({ t: (us - s.timeStartUs) / 1e6 + (s.fromS || 0), name: 'DISARM' })); }
    const runs = GD.load(dir, { bench: true, events }), cli = cliFile ? fs.readFileSync(cliFile, 'utf8') : null, recovered = GP.recover(runs, { cli }), configs = GS.configOf(runs, recovered, { cli });
    const R = JSON.parse(fs.readFileSync(path.join(out, 'result.json'), 'utf8')), main = GT.copy(R.model.params);
    const model = { params: main, samples: (R.samples || []).map(s => GT.copy(main, s)), split: R.model.split, Href: R.model.Href, has: R.model.has, status: 'identified' };
    const validation = { status: R.status, checks: R.acceptance || [], tmScan: (R.validation && R.validation.tmScan) || [] };
    const S = await search(runs, { model, validation, configs, nomad: !noNomad, budgetMs: budget ? +budget : undefined, progress: (f, t) => process.stderr.write(`\r${(100 * f).toFixed(0)} % ${t}`.padEnd(90)) });
    process.stderr.write('\n');
    const res = TUNE.tune(runs, { recovered, cli, model, sim: S, families: FAMILIES });
    for (const row of res.rows.filter(q => q.topic === 'model' && ORDER.some(f => NAMES[f].includes(q.name)))) console.log(`${row.name.padEnd(26)} ${String(row.profile === null ? '-' : row.profile).padEnd(2)} ${row.status.padEnd(14)} ${String(row.current && row.current.value).padEnd(6)} -> ${String(row.to === null ? '' : row.to).padEnd(5)} ${row.text}`);
    console.log(JSON.stringify({ twins: S.twins, profiles: S.profiles, windows: S.windows, margin: S.margin, timing: S.timing, ms: S.ms, baseline: S.baseline, table: S.plot && S.plot.table }, null, 1));
    if (json) fs.writeFileSync(json, JSON.stringify({ S: Object.assign({}, S, { plot: S.plot && Object.assign({}, S.plot, { trace: undefined }) }), rows: res.rows.filter(q => q.topic === 'model') }, (k, v) => k === 'window' ? undefined : v, 1));
})().catch((e) => { console.error(e); process.exit(1); });
