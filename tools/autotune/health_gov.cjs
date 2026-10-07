'use strict';

/**
 * Governor, ESC and power checks (docs/TUNING_KNOWLEDGE.md sections 3, 6 and 10.2): D5, G0 to G13, and the governor
 * state accounting of a whole log.
 *
 *   analyse(w, ctx)          measurements of one whole-log segment (lib.segments with whole: true); no verdicts
 *   judge(flights, RULES)    findings from those measurements against the thresholds in RULES (DEFAULT_RULES)
 *
 * Units, checked against a 4.6.0 log: govSum, govP/I/D/F and motor[0] are fractions of full throttle x 1000
 * (0.1 % steps); in an unsaturated governed state motor[0] = govSum x vcomp to within one count. headspeed, govTarget
 * and govRequest in rpm, Vbat in 0.01 V, collective (setpoint[3], mixer[3]) in mixer units x 1000, 1000 = 12 deg.
 *
 * Firmware control law replicated in the measurement (governor.c 573-630, 932-977): error = (target - PT2(rpm,
 * gov_rpm_filter)) / gov_headspeed, pidSum = P + I + C + D + F, throttle = pidSum x vcomp, clamped to the ceiling.
 */

const lib = require('./lib.cjs');
const POWER = (() => { try { return require('./health_power.cjs'); } catch (e) { return null; } })(); // the firmware rule of the cell count (autoCells)

// Measurement parameters only. Nothing here decides good or bad; that is DEFAULT_RULES.
const RULE = {
    settleS: 1,                              // left out around profile switches and governor state changes
    firmware: { rpmFilterHz: 10, glitchDelta: 0.25, glitchLimit: 2, zeroMotor: 100, ffFilterHz: 5, nominalCell: 3.7 }, // governor.c constants
    glitchMergeS: 0.2,                       // glitch proxy samples closer than this are one event
    evidence: { beforeS: 1, afterS: 2, nearS: 0.5 },
    quiet: { blockS: 0.25, swing: 0.05 },    // collective moved less than this share of its range over three blocks
    // collective events on |collective| / one-sided travel max(|collectiveRange|) (0 = level pitch, 1 = full pitch either way)
    step: { windowS: 0.3, min: 0.15, bins: [0.15, 0.30, 0.45, 0.60], preS: 0.3, postS: 1, recoverMaxS: 3, band: 0.01 },
    ceiling: { fraction: 0.995, minSamples: 20, pile: 3, minRunS: 0.02 },
    cliCheck: { request: 1.02, ceilingCounts: 2 }, // a CLI value the log contradicts (request above gov_headspeed, motor[0] above gov_max_throttle) is not used
    unsat: { below: 0.98, minSum: 100, unity: 0.002, vcompOffShare: 0.99 }, // vcompOffShare: G7 takes vcomp as off (1) when this share of the ratios is 1
    // cell count, when ctx (a CLI battery_cell_count) does not give it: the rule of the firmware (battery.c batteryUpdatePresence,
    // health_power.cjs autoCells) on the resting voltage over the first startS seconds with the cell levels that the pilot set
    // (the log header vbatcellvoltage, else the CLI), so that no CLI dump is necessary; without those levels, the counts that put
    // the resting voltage within startCell V/cell: more than one such count = ambiguous, and per-cell verdicts are not given
    vbat: { stepS: 0.01, reportStep: 0.5, startS: 1, startCell: [3.6, 4.35], histogram: [2, 4.5, 0.01] },
    g2: { blockS: 2 },
    g9: { decimate: 8, N: 1024, maxHz: 12, bands: { I: [0.3, 3], P: [3, 10] } },
    g10: { N: 2048, wagBand: [5, 16] },
    g11: { blockS: 2, cover: 0.9 },
    g12: { perRev: 32, revolutions: 1024, headspeed: lib.FLIGHT_RPM, from: 0.5, to: 4.5, search: [0.6, 1.6], harmonic: 0.005, lines: 8 },
};

// Thresholds (section 10). source: firmware | doc | community | pipeline, unvalidated
const DEFAULT_RULES = {
    sig: 2,                                                                     // a value must pass its threshold by this many SE to be flagged
    D5: { step: 1.0, minCell: 3.0, minS: 0.5, source: 'pipeline, unvalidated' },
    G0: { source: 'firmware' },
    G1: { fallback: 1, source: 'firmware' },
    G2: { median: 0.01, band: 0.02, minS: 10, source: 'pipeline, unvalidated' },
    G3: { minStep: 0.30, good: 0.03, flag: 0.05, minEvents: 3, saturatedShare: 0.5, source: 'pipeline, unvalidated', note: 'minStep in |collective| / one-sided travel (1 = full pitch)' },
    G4: { minStep: 0.30, flag: 0.03, minEvents: 3, source: 'pipeline, unvalidated', note: 'minStep in |collective| / one-sided travel (1 = full pitch)' },
    G5: { minStep: 0.30, flag: 0.5, minEvents: 3, source: 'pipeline, unvalidated', note: 'minStep in |collective| / one-sided travel (1 = full pitch)' },
    G6: { median: 85, runS: 0.1, deficit: 0.02, source: 'doc' },
    G7: { source: 'firmware' },
    G8: { unityShare: 0.99, bounds: [0.80, 1.20], minN: 1000, source: 'firmware' },
    G9: { prominence: 5, minAmplitude: 0.001, maxCollectiveCoherence: 0.5, minWindows: 4, source: 'pipeline, unvalidated' }, // lines under 0.1 % of target, or explained by the collective, are reported, not flagged
    G10: { implicated: 0.5, ruledOut: 0.1, flatRpm: 10, minWindows: 8, source: 'pipeline, unvalidated' },
    G11: { perPack: 5, minBlocks: 10, source: 'pipeline, unvalidated' },
    G12: { tolerance: 0.005, minProminence: 3, source: 'pipeline, unvalidated' },
    G13: { minCell: 3.3, source: 'pipeline, unvalidated' },
};

const EXTRA = ['govTarget', 'govRequest', 'govSum', 'govP', 'govI', 'govD', 'govF', 'motor[0]', 'Vbat', 'mixer[3]', 'gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]'];
const STATES = ['OFF', 'IDLE', 'SPOOLUP', 'RECOVERY', 'ACTIVE', 'HOLD', 'FALLBACK', 'AUTOROTATION', 'BAILOUT', 'BYPASS'];
const ACTIVE = 4, WATCHED = [3, 6, 7, 8];

// ---------------------------------------------------------------------------------------------
// Helpers not in lib.cjs
// ---------------------------------------------------------------------------------------------

const r = (v, d = 4) => (typeof v === 'number' && isFinite(v)) ? +v.toFixed(d) : null;
const quantile = (sorted, p) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)))] : null;
const meanOf = (a) => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
const seOf = (a) => { if (a.length < 2) return null; const m = meanOf(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1) / a.length); };
const jackSe = (vals) => { const m = vals.length; if (m < 3) return null; const mu = meanOf(vals); return Math.sqrt((m - 1) / m * vals.reduce((s, v) => s + (v - mu) ** 2, 0)); };
const median = (a) => { const s = Array.from(a).sort((u, v) => u - v); return s[s.length >> 1] || 1e-300; };
const avg = (x, i0, i1) => { let s = 0; for (let i = i0; i < i1; i++) s += x[i]; return s / Math.max(1, i1 - i0); };

// pt2Filter (common/filter.c): two PT1 stages at the cutoff corrected for order 2
function pt2(x, fc, rate) { const c = fc * 1.553773974; return lib.pt1(lib.pt1(x, c, rate), c, rate); }

// radix-2 complex FFT in place, n a power of two
const twiddle = new Map();
function fft(re, im) {
    const n = re.length;
    if (!twiddle.has(n)) twiddle.set(n, { c: Float64Array.from({ length: n / 2 }, (_, k) => Math.cos(2 * Math.PI * k / n)), s: Float64Array.from({ length: n / 2 }, (_, k) => -Math.sin(2 * Math.PI * k / n)) });
    const { c, s } = twiddle.get(n);
    for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let len = 2; len <= n; len <<= 1) {
        const half = len >> 1, step = n / len;
        for (let i = 0; i < n; i += len) for (let k = 0; k < half; k++) {
            const a = i + k, b = a + half, wr = c[k * step], wi = s[k * step], tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
            re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
    }
}
const hannCache = new Map();
const hann = (N) => { if (!hannCache.has(N)) hannCache.set(N, Float64Array.from({ length: N }, (_, i) => 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1))))); return hannCache.get(N); };
// Hann-windowed, mean-removed transform of x[s .. s+N)
function transform(x, s, N) {
    const w = hann(N), re = new Float64Array(N), im = new Float64Array(N), m = avg(x, s, s + N);
    for (let i = 0; i < N; i++) re[i] = (x[s + i] - m) * w[i];
    fft(re, im); return { re, im };
}
// peak of a spectrum between two bins: position (refined), prominence = amplitude over the band median
function bandPeak(p, k0, k1) {
    let best = -1; for (let k = k0 + 1; k < k1; k++) if (p[k] >= p[k - 1] && p[k] >= p[k + 1] && (best < 0 || p[k] > p[best])) best = k;
    if (best < 0) return null;
    const band = Array.from(p.subarray(k0, k1 + 1)).sort((a, b) => a - b), med = band[band.length >> 1] || 1e-300;
    return { bin: lib.spectralPeak(p, best, best).bin, power: p[best], prominence: Math.sqrt(p[best] / med) };
}
// runs of a predicate over [0, n): [[i0, i1), ...]
function runs(n, on) { const out = []; for (let i = 0; i < n;) { if (!on(i)) { i++; continue; } let j = i; while (j < n && on(j)) j++; out.push([i, j]); i = j; } return out; }
const header = (h, k) => { const v = h && h[k]; if (Array.isArray(v)) return v.map(Number); if (typeof v === 'string') return v.split(',').map(Number); return typeof v === 'number' ? [v] : null; };

// ---------------------------------------------------------------------------------------------
// analyse
// ---------------------------------------------------------------------------------------------

function analyse(w, ctx) {
    const n = w.n, rate = ctx.rate || w.rate, x = w.extra || {}, t0 = w.fromS || 0, T = (i) => r(t0 + i / rate, 3), S = (k) => Math.round(k * rate);
    const flying = ctx.flying, prof = ctx.profile, gs = ctx.govState || null, h = ctx.header || {};
    const hs = w.hs, tgt = x.govTarget, req = x.govRequest, sum = x.govSum, mot = x['motor[0]'], vb = x.Vbat;
    const coll = x['mixer[3]'] || w.coll;
    const cr = header(h, 'collectiveRange'), range = cr && cr.length === 2 && cr[1] > cr[0] ? cr[1] - cr[0] : 2500;
    const travel = cr && cr.length === 2 && cr[1] > cr[0] ? Math.max(Math.abs(cr[0]), Math.abs(cr[1])) : 1250; // one-sided: |collective| runs 0..travel
    const out = { rate: r(rate, 2), seconds: r(n / rate, 1), missing: EXTRA.filter(k => !x[k]).concat(coll ? [] : ['collective']), govStateLogged: !!gs, collectiveRange: range, collectiveTravel: travel, notes: [] };
    if (!gs) out.notes.push('no GOVSTATE events: ACTIVE cannot be told from other states; all in-flight samples are used');

    let flyingN = 0; for (let i = 0; i < n; i++) flyingN += flying[i];
    out.flyingS = r(flyingN / rate, 1);
    const profiles = [...new Set(Array.from(prof).filter((p, i) => flying[i]))].sort((a, b) => a - b);
    out.profiles = profiles;

    // settled: away from profile switches and governor state changes
    const settled = new Uint8Array(n).fill(1), guard = S(RULE.settleS);
    for (let i = 1; i < n; i++) if (prof[i] !== prof[i - 1] || (gs && gs[i] !== gs[i - 1])) for (let j = Math.max(0, i - guard); j < Math.min(n, i + guard); j++) settled[j] = 0;
    const act = new Uint8Array(n); for (let i = 0; i < n; i++) act[i] = flying[i] && settled[i] && (!gs || gs[i] === ACTIVE) ? 1 : 0;

    // quiet collective: swing over this block and its neighbours below RULE.quiet.swing of the range
    const quiet = new Uint8Array(n);
    if (coll) { const B = S(RULE.quiet.blockS), nb = Math.ceil(n / B), lo = new Float64Array(nb).fill(Infinity), hi = new Float64Array(nb).fill(-Infinity);
        for (let i = 0; i < n; i++) { const b = (i / B) | 0; if (coll[i] < lo[b]) lo[b] = coll[i]; if (coll[i] > hi[b]) hi[b] = coll[i]; }
        for (let b = 0; b < nb; b++) { const a = Math.max(0, b - 1), c = Math.min(nb - 1, b + 1), sw = Math.max(hi[a], hi[b], hi[c]) - Math.min(lo[a], lo[b], lo[c]);
            if (sw < RULE.quiet.swing * range) for (let i = b * B; i < Math.min(n, (b + 1) * B); i++) quiet[i] = 1; } }

    // full headspeed per profile: gov_headspeed from the CLI (ctx.govHeadspeed), else the median govRequest (NORMAL
    // throttle type: request = gov_headspeed; lower with SWITCH/FUNCTION). The request never exceeds gov_headspeed, so a
    // logged request above the CLI value means the CLI dump is not this log's setup: the log value is used then.
    const full = {}, fullSource = {};
    for (const p of profiles) {
        const v = []; const src = req || tgt; if (src) for (let i = 0; i < n; i += 10) if (flying[i] && prof[i] === p && src[i] > 0) v.push(src[i]);
        v.sort((a, b) => a - b);
        const logged = v.length ? quantile(v, 0.5) : null, what = req ? 'govRequest median' : 'govTarget median', cliV = ctx.govHeadspeed && ctx.govHeadspeed[p];
        if (cliV && !(req && logged > RULE.cliCheck.request * cliV)) { full[p] = cliV; fullSource[p] = ctx.govHeadspeedSource || 'CLI gov_headspeed'; continue; }
        full[p] = logged;
        fullSource[p] = !v.length ? null : cliV ? `${what} ${logged} (CLI gov_headspeed ${cliV} is below the logged request: CLI not from this setup)` : `${what} (fallback: no gov_headspeed from the CLI)`;
    }
    const fullAny = Math.max(0, ...Object.values(full).filter(Boolean)) || null;
    out.fullHeadspeed = { value: full, source: fullSource };
    const fullAt = (i) => full[prof[i]] || fullAny;
    const byP = (fn) => Object.fromEntries(profiles.map(p => [p, fn(p)]));

    // --- governor states: time in each, transitions, entries into RECOVERY/FALLBACK/AUTOROTATION/BAILOUT with evidence
    const hsF = pt2(hs, RULE.firmware.rpmFilterHz, rate);
    const glitchAt = new Uint8Array(n); let glitchSamples = 0;
    for (let i = 0; i < n; i++) {
        const fh = fullAt(i), running = (mot && mot[i] > RULE.firmware.zeroMotor) || (!mot && hs[i] > 0);
        if (!fh || !running) continue;
        let k = 0;
        if (Math.abs(hs[i] - hsF[i]) > RULE.firmware.glitchDelta * fh) k = 1;
        else if (hs[i] > RULE.firmware.glitchLimit * fh) k = 2;
        else if (hs[i] === 0 && mot && mot[i] > RULE.firmware.zeroMotor) k = 3;
        if (k) { glitchAt[i] = k; glitchSamples++; }
    }
    const glitchEvents = [];
    for (const [a, b] of runs(n, (i) => glitchAt[i] > 0)) {
        const last = glitchEvents[glitchEvents.length - 1];
        if (last && a - last.i1 < S(RULE.glitchMergeS)) { last.i1 = b; last.samples += b - a; continue; }
        glitchEvents.push({ i0: a, i1: b, samples: b - a });
    }
    const KIND = ['', 'delta', 'limit', 'zero'];
    const glitchList = glitchEvents.map(e => { let dev = 0, at = e.i0, kinds = new Set(); for (let i = e.i0; i < e.i1; i++) { if (glitchAt[i]) kinds.add(KIND[glitchAt[i]]); const d = Math.abs(hs[i] - hsF[i]); if (d > dev) { dev = d; at = i; } }
        return { t: T(e.i0), value: r(dev / fullAt(at), 3), seconds: r((e.i1 - e.i0) / rate, 3), kinds: [...kinds], headspeed: r(hs[at], 0), filtered: r(hsF[at], 0), motor: mot ? mot[at] : null, state: gs ? gs[at] : null, profile: prof[at], flying: !!flying[at] }; });

    const states = { seconds: {}, secondsFlying: {}, transitions: [], entries: [], spoolups: [] };
    if (gs) {
        for (let i = 0; i < n; i++) { const k = STATES[gs[i]] || String(gs[i]); states.seconds[k] = (states.seconds[k] || 0) + 1 / rate; if (flying[i]) states.secondsFlying[k] = (states.secondsFlying[k] || 0) + 1 / rate; }
        for (const k in states.seconds) states.seconds[k] = r(states.seconds[k], 2);
        for (const k in states.secondsFlying) states.secondsFlying[k] = r(states.secondsFlying[k], 2);
        let since = 0;
        for (let i = 1; i <= n; i++) {
            if (i < n && gs[i] === gs[i - 1]) continue;
            if (gs[since] === 2) states.spoolups.push({ t: T(since), value: r((i - since) / rate, 2), to: i < n ? STATES[gs[i]] : null });
            if (i === n) break;
            states.transitions.push({ t: T(i), from: STATES[gs[i - 1]], to: STATES[gs[i]], profile: prof[i] });
            if (WATCHED.includes(gs[i])) {
                const b0 = Math.max(0, i - S(RULE.evidence.beforeS)), b1 = Math.max(b0 + 1, i - S(0.1)), a1 = Math.min(n, i + S(RULE.evidence.afterS));
                let lo = Infinity, hi = -Infinity, zero = 0; for (let j = Math.max(0, i - S(0.5)); j < a1; j++) { if (hs[j] < lo) lo = hs[j]; if (hs[j] > hi) hi = hs[j]; if (hs[j] === 0) zero++; }
                let near = 0, dev = 0; for (let j = Math.max(0, i - S(RULE.evidence.nearS)); j < Math.min(n, i + S(RULE.evidence.nearS)); j++) { if (glitchAt[j]) near++; dev = Math.max(dev, Math.abs(hs[j] - hsF[j])); }
                let end = i; while (end < n && gs[end] === gs[i]) end++;
                states.entries.push({ t: T(i), state: STATES[gs[i]], from: STATES[gs[i - 1]], value: r((end - i) / rate, 3), profile: prof[i], flying: !!flying[i],
                    headspeedBefore: r(avg(hs, b0, b1), 0), headspeedAt: r(hs[i], 0), headspeedMin: r(lo, 0), headspeedMax: r(hi, 0), zeroHeadspeedSamples: zero,
                    target: tgt ? r(tgt[i], 0) : null, motorBefore: mot ? r(avg(mot, b0, b1), 0) : null, motorAfter: mot ? r(avg(mot, i, Math.min(n, i + S(0.5))), 0) : null,
                    glitchSamplesNear: near, maxDeviation: r(dev / (fullAt(i) || 1), 3) });
            }
            since = i;
        }
    }
    out.states = states;

    // --- D5, G13: battery voltage
    if (vb) {
        const V = (i) => vb[i] / 100, lag = Math.max(1, S(RULE.vbat.stepS)), B = RULE.vbat;
        // resting voltage: median over the first startS seconds (not the maximum, which an upward glitch inflates)
        const v0 = median(Array.from({ length: Math.max(1, Math.min(n, S(B.startS))) }, (_, i) => V(i)));
        const fits = []; for (let k = Math.max(1, Math.ceil(v0 / B.startCell[1])); k <= Math.floor(v0 / B.startCell[0]); k++) fits.push(k);
        let cells, cellsSource, cellsAmbiguous = false;
        const L = !ctx.cells && POWER && typeof POWER.limitsOf === 'function' ? POWER.limitsOf(h, ctx.cliParsed || null) : null;
        const fw = L && /^(log header|CLI)/.test(L.source) && v0 >= 1 ? POWER.autoCells(v0, L.min, L.max) : null;
        if (ctx.cells) { cells = ctx.cells; cellsSource = ctx.cellsSource || 'CLI battery_cell_count'; }
        else if (fw) { cells = fw; cellsSource = `firmware rule (battery.c): resting ${r(v0, 2)} V at log start, ${L.min}-${L.max} V/cell (${L.source})`; }
        else { cells = fits.length ? fits.reduce((a, k) => Math.abs(v0 / k - 3.95) < Math.abs(v0 / a - 3.95) ? k : a) : Math.max(1, Math.round(v0 / 3.95));
            cellsAmbiguous = fits.length !== 1;
            cellsSource = `inferred, low confidence: resting ${r(v0, 2)} V at log start fits ${fits.length ? fits.join(' or ') : 'no'} cell count${fits.length === 1 ? '' : 's'} at ${B.startCell[0]}-${B.startCell[1]} V/cell${cellsAmbiguous ? ': ambiguous' : ''}`; }
        const steps = [];
        let maxStep = 0, maxStepAt = 0;
        for (let i = lag; i < n; i++) { const d = V(i) - V(i - lag); if (Math.abs(d) > Math.abs(maxStep)) { maxStep = d; maxStepAt = i; }
            if (Math.abs(d) >= RULE.vbat.reportStep) { const last = steps[steps.length - 1]; if (last && i - last.i < lag * 2) { if (Math.abs(d) > Math.abs(last.value)) Object.assign(last, { i, value: d }); } else steps.push({ i, value: d }); } }
        const inFlight = []; for (let i = 0; i < n; i++) if (flying[i]) inFlight.push(V(i));
        inFlight.sort((a, b) => a - b);
        let minAt = -1; for (let i = 0; i < n; i++) if (flying[i] && (minAt < 0 || vb[i] < vb[minAt])) minAt = i;
        const [h0, h1, hd] = B.histogram, hist = new Array(Math.round((h1 - h0) / hd) + 1).fill(0); // in-flight samples per 0.01 V/cell from h0 (clamped at both ends)
        for (const v of inFlight) hist[Math.min(hist.length - 1, Math.max(0, Math.floor((v / cells - h0) / hd + 1e-9)))]++;
        out.D5 = { cells, cellsSource, cellsAmbiguous, restingV: r(v0, 2), maxStep: r(maxStep, 2), maxStepT: T(maxStepAt), stepWindowS: RULE.vbat.stepS,
            steps: steps.slice(0, 200).map(s => ({ t: T(s.i), value: r(s.value, 2), volts: r(V(s.i), 2), flying: !!flying[s.i], motor: mot ? mot[s.i] : null })), stepsListed: steps.length,
            minCellInFlight: inFlight.length ? r(inFlight[0] / cells, 3) : null, minCellT: minAt >= 0 ? T(minAt) : null, n: inFlight.length, rate: r(rate, 2),
            cellHistogram: { from: h0, step: hd, counts: hist } };
        out.G13 = inFlight.length ? { cells, cellsSource, cellsAmbiguous, p1Cell: r(quantile(inFlight, 0.01) / cells, 3), p5Cell: r(quantile(inFlight, 0.05) / cells, 3), medianCell: r(quantile(inFlight, 0.5) / cells, 3), minCell: r(inFlight[0] / cells, 3),
            startV: r(V(Math.max(0, flying.indexOf(1))), 2), endV: r(V(n - 1 - Array.from(flying).reverse().indexOf(1)), 2), n: inFlight.length, seconds: r(inFlight.length / rate, 1) } : { skipped: 'not flown' };
    } else { out.D5 = { skipped: 'no Vbat field' }; out.G13 = { skipped: 'no Vbat field' }; }

    // --- G0: is the PID governor running?
    if (sum && x.govI) {
        let nz = 0, nzI = 0; for (let i = 0; i < n; i++) if (flying[i]) { if (sum[i] !== 0) nz++; if (x.govI[i] !== 0) nzI++; }
        out.G0 = { flyingSamples: flyingN, govSumNonZero: nz, govINonZero: nzI, mode: !flyingN ? null : (nz === 0 && nzI === 0 ? 'DIRECT/LIMIT' : 'PID (ELECTRIC/NITRO)') };
    } else out.G0 = { skipped: 'no govSum or govI field' };
    const governed = out.G0.mode === 'PID (ELECTRIC/NITRO)';

    // --- G1: fallback and glitch proxies
    out.G1 = { fallbackEntries: states.entries.filter(e => e.state === 'FALLBACK').map(e => ({ t: e.t, value: e.value, headspeedAt: e.headspeedAt, headspeedMax: e.headspeedMax, glitchSamplesNear: e.glitchSamplesNear, profile: e.profile })),
        fallbackKnown: !!gs, glitchSamples, glitchEvents: glitchList.length, events: glitchList.slice(0, 200), glitchInFlight: glitchList.filter(e => e.flying).length, headspeedMax: r(hs.reduce((a, v) => v > a ? v : a, 0), 0),
        criterion: `|hs - PT2(hs, ${RULE.firmware.rpmFilterHz} Hz)| > ${RULE.firmware.glitchDelta} x gov_headspeed, hs > ${RULE.firmware.glitchLimit} x gov_headspeed, or hs = 0 with motor[0] > ${RULE.firmware.zeroMotor}` };

    // reference headspeed: target in a governed log, per-profile median otherwise
    const medHs = byP(p => { const v = []; for (let i = 0; i < n; i += 5) if (act[i] && prof[i] === p) v.push(hs[i]); v.sort((a, b) => a - b); return quantile(v, 0.5); });
    const ref = (i) => governed && tgt ? tgt[i] : medHs[prof[i]];
    const err = new Float64Array(n); for (let i = 0; i < n; i++) { const t = ref(i); err[i] = t > 0 ? (hs[i] - t) / t : 0; }
    out.reference = governed && tgt ? 'govTarget' : 'per-profile median headspeed';

    // --- G2: steady headspeed error
    out.G2 = { byProfile: byP(p => {
        const v = [], B = S(RULE.g2.blockS), blocks = [];
        for (let b = 0; b + B <= n; b += B) { const bv = []; for (let i = b; i < b + B; i++) if (act[i] && quiet[i] && prof[i] === p) bv.push(err[i]); for (const e of bv) v.push(e); if (bv.length >= B / 2) { bv.sort((a, c) => a - c); blocks.push(quantile(bv, 0.5)); } }
        if (!v.length) return { n: 0, seconds: 0 };
        v.sort((a, b) => a - b);
        const bs = blocks.slice().sort((a, b) => a - b);
        return { median: r(quantile(v, 0.5), 5), p5: r(quantile(v, 0.05), 5), p95: r(quantile(v, 0.95), 5), se: r(blocks.length > 1 ? 1.2533 * Math.sqrt(bs.reduce((s, e) => s + (e - meanOf(bs)) ** 2, 0) / (bs.length - 1)) / Math.sqrt(bs.length) : null, 5),
            n: v.length, blocks: blocks.length, seconds: r(v.length / rate, 1), reference: out.reference, fullHeadspeed: full[p] };
    }) };

    // ceiling per profile: gov_max_throttle from the CLI (ctx.maxThrottle, %), unless motor[0] went above it in this log
    // (the CLI dump is then not this log's setup); else the highest motor[0] if it plateaus there; else 1000, assumed
    const ceiling = {}, ceilingSource = {};
    for (const p of profiles) {
        let top = -Infinity; const count = new Map();
        if (mot) for (let i = 0; i < n; i++) if (flying[i] && prof[i] === p && (!gs || gs[i] === ACTIVE)) { count.set(mot[i], (count.get(mot[i]) || 0) + 1); if (mot[i] > top) top = mot[i]; }
        const cliV = ctx.maxThrottle && ctx.maxThrottle[p];
        if (cliV && !(mot && top > cliV * 10 + RULE.cliCheck.ceilingCounts)) { ceiling[p] = cliV * 10; ceilingSource[p] = ctx.maxThrottleSource || 'CLI gov_max_throttle'; continue; }
        const why = cliV ? `; CLI gov_max_throttle ${cliV} % not used: motor[0] reached ${top}` : '; no gov_max_throttle from the CLI';
        if (!mot) continue;
        // a clamp piles samples up on one value: the highest value counts, if it holds several times more samples than the values just below
        const cnt = count.get(top) || 0, below = [1, 2, 3].reduce((a, k) => a + (count.get(top - k) || 0), 0) / 3;
        if (cnt >= RULE.ceiling.minSamples && cnt >= RULE.ceiling.pile * below) { ceiling[p] = top; ceilingSource[p] = `guessed from the highest motor[0] (${cnt} samples, ${r(below, 1)} per value below)${why}`; }
        else { ceiling[p] = 1000; ceilingSource[p] = `assumed 1000 (highest ${top} reached ${cnt} times, ${r(below, 1)} per value below)${why}`; }
    }
    const atCeil = (i) => mot && ceiling[prof[i]] && mot[i] >= RULE.ceiling.fraction * ceiling[prof[i]];

    // --- G3, G4, G5: collective events on |collective|, per profile, direction and step size
    if (coll && tgt !== undefined) {
        const a = Float64Array.from(coll, v => Math.abs(v) / travel), W = S(RULE.step.windowS), pre = S(RULE.step.preS), post = S(RULE.step.postS), recMax = S(RULE.step.recoverMaxS), events = [];
        const terms = { F: x.govF, P: x.govP, I: x.govI, D: x.govD, sum, motor: mot };
        for (const dir of [1, -1]) {
            let lastE = -1; // the onset search starts after the previous event's extreme: that extreme can lie before i, and the same event was found again
            for (let i = pre; i + W < n - post;) {
                if (dir * (a[i + W] - a[i]) < RULE.step.min) { i++; continue; }
                let o = Math.max(i - W, lastE + 1, 0); for (let j = o; j <= i + W; j++) if (dir * a[j] < dir * a[o]) o = j;
                let e = o; for (let j = o; j < Math.min(n, o + 3 * W); j++) if (dir * a[j] > dir * a[e]) e = j;
                lastE = e;
                let on = o; while (on < e && dir * (a[on] - a[o]) < 0.1 * RULE.step.min) on++;
                const size = dir * (a[e] - a[o]);
                i = Math.max(i + 1, e + 1);
                if (size < RULE.step.min || on - pre < 0 || on + post >= n) continue;
                let ok = true; for (let j = on - pre; j < on + post && ok; j++) if (!act[j] || prof[j] !== prof[on]) ok = false;
                if (!ok) continue;
                let droop = -Infinity, droopAt = on, over = -Infinity, overAt = on;
                for (let j = on; j < on + post; j++) { if (-err[j] > droop) { droop = -err[j]; droopAt = j; } if (err[j] > over) { over = err[j]; overAt = j; } }
                const peakAt = dir > 0 ? droopAt : overAt, peak = dir > 0 ? droop : over;
                let rec = null, censored = false;
                if (peak <= RULE.step.band) rec = 0;
                else { let j = peakAt; while (j < Math.min(n, peakAt + recMax) && act[j] && Math.abs(err[j]) > RULE.step.band) j++;
                    if (Math.abs(err[j]) <= RULE.step.band) rec = (j - peakAt) / rate; else { rec = (j - peakAt) / rate; censored = true; } }
                let sat = false; for (let j = on - pre; j < on + post; j++) if (atCeil(j)) { sat = true; break; }
                const delta = {}; for (const k in terms) if (terms[k]) delta[k] = (avg(terms[k], on, on + post) - avg(terms[k], on - pre, on)) / 1000;
                const share = delta.sum && Math.abs(delta.sum) > 1e-3 ? Object.fromEntries(['F', 'P', 'I', 'D'].filter(k => delta[k] !== undefined).map(k => [k, r(delta[k] / delta.sum, 3)])) : null;
                let bin = -1; for (let b = 0; b < RULE.step.bins.length; b++) if (size >= RULE.step.bins[b]) bin = b;
                events.push({ t: T(on), dir: dir > 0 ? 'rise' : 'drop', profile: prof[on], size: r(size, 3), bin, from: r(a[o], 3), to: r(a[e], 3), target: r(ref(on), 0), preError: r(avg(err, on - pre, on), 4),
                    droop: r(droop, 4), droopT: T(droopAt), overshoot: r(over, 4), overshootT: T(overAt), value: r(peak, 4), recoveryS: r(rec, 3), censored, saturated: sat,
                    delta: Object.fromEntries(Object.entries(delta).map(([k, v]) => [k, r(v, 4)])), share });
            }
        }
        events.sort((p, q) => p.t - q.t);
        const bins = RULE.step.bins.map((lo, b) => [lo, RULE.step.bins[b + 1] || null]);
        const agg = (list) => {
            const col = (k) => list.map(e => e[k]).filter(v => v !== null), shares = (k) => list.map(e => e.share && e.share[k]).filter(v => typeof v === 'number');
            const rec = list.map(e => e.recoveryS).filter(v => v !== null);
            return { n: list.length, droop: r(meanOf(col('droop')), 4), droopSe: r(seOf(col('droop')), 4), droopMax: r(Math.max(...col('droop')), 4), overshoot: r(meanOf(col('overshoot')), 4), overshootSe: r(seOf(col('overshoot')), 4),
                recoveryS: r(meanOf(rec), 3), recoverySe: r(seOf(rec), 3), censored: list.filter(e => e.censored).length, saturated: list.filter(e => e.saturated).length,
                share: Object.fromEntries(['F', 'P', 'I', 'D'].map(k => [k, { mean: r(meanOf(shares(k)), 3), se: r(seOf(shares(k)), 3), n: shares(k).length }])) };
        };
        const G345 = { unit: `|collective| / one-sided travel ${travel}`, bins, events: events.slice(0, 500), eventsTotal: events.length, byProfile: byP(p => ({ rise: bins.map((_, b) => agg(events.filter(e => e.profile === p && e.dir === 'rise' && e.bin === b))), drop: bins.map((_, b) => agg(events.filter(e => e.profile === p && e.dir === 'drop' && e.bin === b))) })) };
        out.G3 = out.G4 = out.G5 = G345; // one measurement serves the three checks
        out.authority = { byProfile: byP(p => { const ev = events.filter(e => e.profile === p && e.dir === 'rise'); return agg(ev).share; }), note: 'share of the change of govSum over the first second of a collective rise carried by each term' };
    } else { const why = { skipped: coll ? 'no govTarget field' : 'no collective field' }; out.G3 = out.G4 = out.G5 = why; out.authority = why; }

    let vcomp = null; // G8 finds it, G7 uses it
    // --- G8: voltage compensation, motor[0]/govSum where nothing clamps
    if (mot && sum) {
        const vF = vb ? pt2(Float64Array.from(vb, v => v / 100), RULE.firmware.ffFilterHz, rate) : null, cells = out.D5.cells;
        const ratio = [], pred = [], vcRaw = []; let unity = 0;
        for (let i = 0; i < n; i += 2) {
            if (!act[i] || sum[i] < RULE.unsat.minSum || mot[i] >= RULE.unsat.below * (ceiling[prof[i]] || 1000)) continue;
            const q = mot[i] / sum[i]; ratio.push(q); if (Math.abs(q - 1) <= RULE.unsat.unity) unity++;
            if (vF && cells) { const u = cells * RULE.firmware.nominalCell / vF[i]; pred.push(Math.min(1.2, Math.max(0.8, u))); vcRaw.push(q / u); }
        }
        const sorted = ratio.slice().sort((a, b) => a - b);
        let corr = null;
        if (pred.length === ratio.length && ratio.length > 10) { const mr = meanOf(ratio), mp = meanOf(pred); let sxy = 0, sxx = 0, syy = 0; for (let k = 0; k < ratio.length; k++) { sxy += (ratio[k] - mr) * (pred[k] - mp); sxx += (pred[k] - mp) ** 2; syy += (ratio[k] - mr) ** 2; } corr = sxx && syy ? sxy / Math.sqrt(sxx * syy) : null; }
        out.G8 = { n: ratio.length, median: r(quantile(sorted, 0.5), 4), p5: r(quantile(sorted, 0.05), 4), p95: r(quantile(sorted, 0.95), 4), unityShare: r(ratio.length ? unity / ratio.length : null, 4),
            predictedMedian: pred.length ? r(quantile(pred.slice().sort((a, b) => a - b), 0.5), 4) : null, corrWithPredicted: r(corr, 3),
            predictedFrom: vb ? `clamp(${cells} x ${RULE.firmware.nominalCell} V / PT2(Vbat), 0.8, 1.2)` : null };
        // vcomp gain per sample for G7 (throttle = govSum x vcomp, then clamped): 1 when compensation is off; on, the firmware
        // formula clamp(cells x 3.7 / PT2(Vbat, 5 Hz), 0.8, 1.2) scaled by the median measured/formula ratio, which absorbs a
        // wrong cell count; without Vbat, the median unsaturated ratio
        if (!ratio.length) vcomp = null;
        else if (unity / ratio.length >= RULE.unsat.vcompOffShare) { vcomp = () => 1; out.G8.vcompUsed = 'off: 1'; }
        else if (vF && cells && vcRaw.length) { const cal = quantile(vcRaw.slice().sort((a, b) => a - b), 0.5); vcomp = (i) => Math.min(1.2, Math.max(0.8, cal * cells * RULE.firmware.nominalCell / vF[i]));
            out.G8.vcompUsed = `on: clamp(${r(cal, 4)} x ${cells} x ${RULE.firmware.nominalCell} V / PT2(Vbat), 0.8, 1.2)`; }
        else { const med = quantile(sorted, 0.5); vcomp = () => med; out.G8.vcompUsed = `on: constant ${r(med, 4)} (median unsaturated ratio, no Vbat)`; }
        // unit check: govSum = P + I + D + F (C is below one count)
        if (x.govP && x.govI && x.govD && x.govF) { let s = 0, m = 0; for (let i = 0; i < n; i += 5) if (act[i]) { s += (sum[i] - x.govP[i] - x.govI[i] - x.govD[i] - x.govF[i]) ** 2; m++; } out.units = { sumResidualRms: r(m ? Math.sqrt(s / m) : null, 2), n: m }; }
    } else out.G8 = { skipped: 'no motor[0] or govSum field' };

    // --- G6, G7: throttle headroom and the sum beyond the ceiling
    if (mot) {
        out.G6 = { byProfile: byP(p => {
            const v = []; let top = 0; for (let i = 0; i < n; i++) if (act[i] && prof[i] === p) { v.push(mot[i]); if (atCeil(i)) top++; }
            if (!v.length) return { n: 0 };
            v.sort((a, b) => a - b);
            const list = runs(n, (i) => flying[i] && prof[i] === p && atCeil(i)).filter(([a, b]) => b - a >= S(RULE.ceiling.minRunS)).map(([a, b]) => {
                let def = 0; for (let i = a; i < b; i++) def += tgt ? (tgt[i] - hs[i]) / (tgt[i] || 1) : 0;
                return { t: T(a), value: r((b - a) / rate, 3), deficit: tgt ? r(def / (b - a), 4) : null, collective: coll ? r(avg(coll, a, b) / 1000, 3) : null }; });
            return { ceiling: ceiling[p], ceilingSource: ceilingSource[p], medianPct: r(quantile(v, 0.5) / 10, 1), p95Pct: r(quantile(v, 0.95) / 10, 1), atCeilingShare: r(top / v.length, 4), n: v.length, seconds: r(v.length / rate, 1), runs: list.slice(0, 200), runsTotal: list.length };
        }) };
        // demand after voltage compensation (govSum x vcomp) beyond the output; govSum is logged before vcomp, motor[0] after
        out.G7 = !sum ? { skipped: 'no govSum field' } : !vcomp ? { skipped: 'voltage compensation unknown (G8 has no unsaturated sample)' } : { vcomp: out.G8.vcompUsed, byProfile: byP(p => { const d = []; for (let i = 0; i < n; i++) if (flying[i] && prof[i] === p && atCeil(i) && (!gs || gs[i] === ACTIVE)) d.push((sum[i] * vcomp(i) - mot[i]) / 1000);
            d.sort((a, b) => a - b); return d.length ? { mean: r(meanOf(d), 4), p95: r(quantile(d, 0.95), 4), max: r(d[d.length - 1], 4), n: d.length } : { n: 0 }; }) };
    } else { out.G6 = { skipped: 'no motor[0] field' }; out.G7 = out.G6; }

    // gains in effect: govP against the firmware error, govF against |collective|^2
    if (x.govP && tgt && governed) {
        out.gains = { header: header(h, 'govPID'), headerOrder: 'P, I, D, F, gain', byProfile: byP(p => {
            const sel = [], e = new Float64Array(n), c2 = new Float64Array(n);
            for (let i = 0; i < n; i++) { const fh = full[p] || 1; e[i] = (tgt[i] - hsF[i]) / fh; c2[i] = coll ? (coll[i] / 1000) ** 2 : 0; if (act[i] && prof[i] === p && Math.abs(x.govP[i]) < 190 && i % 3 === 0) sel.push(i); }
            const P = Float64Array.from(x.govP, v => v / 1000), F = x.govF ? Float64Array.from(x.govF, v => v / 1000) : null;
            const fp = lib.fitLine(e, P, sel), ff = F && coll ? lib.fitLine(pt2(c2, RULE.firmware.ffFilterHz, rate), F, sel) : null;
            return { KKp: fp ? r(fp.k, 3) : null, KKpR2: fp ? r(fp.r2, 3) : null, KKfCollW: ff ? r(ff.k, 4) : null, KKfR2: ff ? r(ff.r2, 3) : null, n: sel.length };
        }) };
    }

    // The ESC measures the motor against the frame, so the logged headspeed carries -sign x yaw rate / 6 (rpm per deg/s)
    // whatever the governor does. The sign (rotor direction) is the one that removes the most yaw-band power.
    const frame = { sign: 0, powerRatio: 1 };
    {
        const [f0, f1] = RULE.g10.wagBand, hB = lib.bandpass(hs, f0, f1, rate), gB = lib.bandpass(w.gyro[2], f0, f1, rate), P = [0, 0, 0];
        let sxy = 0, sxx = 0;
        for (let i = 0; i < n; i += 2) if (act[i]) { for (let k = 0; k < 3; k++) P[k] += (hB[i] + (k - 1) * gB[i] / 6) ** 2; sxy += hB[i] * gB[i]; sxx += gB[i] * gB[i]; }
        const best = P[0] < P[1] && P[0] < P[2] ? 0 : P[2] < P[1] ? 2 : 1;
        Object.assign(frame, { sign: best - 1, powerRatio: r(P[best] / (P[1] || 1e-300), 3), slope: r(sxx ? -6 * sxy / sxx : null, 3) });
    }
    out.frameRotation = Object.assign(frame, { note: 'headspeed corrected = logged + sign x gyroADC[2] / 6; slope = -6 x regression of band-passed headspeed on yaw rate (1 = pure frame rotation with sign +1)' });
    const hsC = Float64Array.from(hs, (v, i) => v + frame.sign * w.gyro[2][i] / 6);

    // --- G9: spectrum of the headspeed error per profile (frame rotation removed), jackknife over windows
    {
        const D = RULE.g9.decimate, N = RULE.g9.N, fs = rate / D, df = fs / N, kMax = Math.ceil(RULE.g9.maxHz / df) + 1, m = Math.floor(n / D);
        const e = new Float64Array(m), cD = new Float64Array(m), okD = new Uint8Array(m), pD = new Uint8Array(m);
        if (coll) for (let k = 0; k < m; k++) cD[k] = Math.abs(avg(coll, k * D, (k + 1) * D));
        for (let k = 0; k < m; k++) { let s = 0, ok = 1; for (let i = k * D; i < (k + 1) * D; i++) { const t = ref(i); s += t > 0 ? (hsC[i] - t) / t : 0; if (!act[i] || prof[i] !== prof[k * D]) ok = 0; } e[k] = s / D; okD[k] = ok; pD[k] = prof[k * D]; }
        out.G9 = { hzPerBin: r(df, 4), windowS: r(N / fs, 2), reference: out.reference, frameSign: frame.sign, byProfile: byP(p => {
            const wins = [];
            for (let s = 0; s + N <= m; s += N / 2) { let ok = true; for (let k = s; k < s + N && ok; k++) if (!okD[k] || pD[k] !== p) ok = false; if (!ok) continue;
                const { re, im } = transform(e, s, N), C = transform(cD, s, N), pw = new Float64Array(kMax + 1), pc = new Float64Array(kMax + 1), xr = new Float64Array(kMax + 1), xi = new Float64Array(kMax + 1);
                for (let k = 0; k <= kMax; k++) { pw[k] = re[k] ** 2 + im[k] ** 2; pc[k] = C.re[k] ** 2 + C.im[k] ** 2; xr[k] = re[k] * C.re[k] + im[k] * C.im[k]; xi[k] = im[k] * C.re[k] - re[k] * C.im[k]; }
                wins.push({ s, pw, pc, xr, xi }); }
            const res = { windows: wins.length, seconds: r(wins.length * N / fs / 2, 1) };
            if (!wins.length) return res;
            const total = new Float64Array(kMax + 1), tc = new Float64Array(kMax + 1), tr = new Float64Array(kMax + 1), ti = new Float64Array(kMax + 1);
            for (const wv of wins) for (let k = 0; k <= kMax; k++) { total[k] += wv.pw[k]; tc[k] += wv.pc[k]; tr[k] += wv.xr[k]; ti[k] += wv.xi[k]; }
            // share of the error at a bin that the collective explains (magnitude-squared coherence); a forced response is no oscillation
            const cohC = (k) => coll && tc[k] > 0 ? (tr[k] ** 2 + ti[k] ** 2) / (total[k] * tc[k]) : null;
            const wsum = hann(N).reduce((a, v) => a + v, 0);
            for (const [name, [f0, f1]] of Object.entries(RULE.g9.bands)) {
                const k0 = Math.max(1, Math.round(f0 / df)), k1 = Math.min(kMax, Math.round(f1 / df)), pk = bandPeak(total, k0, k1);
                if (!pk) { res[name] = null; continue; }
                const jk = wins.length >= 3 ? wins.map(wv => { const L = Float64Array.from(total, (v, k) => v - wv.pw[k]), q = bandPeak(L, k0, k1); return q ? { hz: q.bin * df, prom: q.prominence } : { hz: pk.bin * df, prom: 1 }; }) : null;
                res[name] = { band: [f0, f1], hz: r(pk.bin * df, 3), hzSe: jk ? r(jackSe(jk.map(v => v.hz)), 3) : null, prominence: r(pk.prominence, 2), prominenceSe: jk ? r(jackSe(jk.map(v => v.prom)), 2) : null,
                    amplitude: r(2 * Math.sqrt(pk.power / wins.length) / wsum, 5), collectiveCoherence: r(cohC(Math.round(pk.bin)), 3), n: wins.length }; // amplitude: fraction of target, sinusoid
            }
            return res;
        }) };
    }

    // --- G10: coherence of headspeed and yaw gyro at the yaw wag peak
    {
        const N = RULE.g10.N, df = rate / N, [f0, f1] = RULE.g10.wagBand, k0 = Math.round(f0 / df), k1 = Math.round(f1 / df), yawErr = Float64Array.from(w.gyro[2], (v, i) => v - w.sp[2][i]);
        out.G10 = { hzPerBin: r(df, 3), band: [f0, f1], byProfile: byP(p => {
            const wins = [];
            for (let s = 0; s + N <= n; s += N / 2) { let ok = true; for (let i = s; i < s + N && ok; i += 4) if (!act[i] || prof[i] !== p) ok = false; if (!ok) continue;
                const H = transform(hsC, s, N), H0 = transform(hs, s, N), G = transform(w.gyro[2], s, N), E = transform(yawErr, s, N), o = {};
                for (const q of ['hh', 'gg', 're', 'im', 'ee', 'h0', 'r0', 'i0']) o[q] = new Float64Array(k1 + 2);
                for (let k = k0 - 1; k <= k1 + 1; k++) { o.hh[k] = H.re[k] ** 2 + H.im[k] ** 2; o.gg[k] = G.re[k] ** 2 + G.im[k] ** 2; o.ee[k] = E.re[k] ** 2 + E.im[k] ** 2; o.re[k] = H.re[k] * G.re[k] + H.im[k] * G.im[k]; o.im[k] = H.re[k] * G.im[k] - H.im[k] * G.re[k];
                    o.h0[k] = H0.re[k] ** 2 + H0.im[k] ** 2; o.r0[k] = H0.re[k] * G.re[k] + H0.im[k] * G.im[k]; o.i0[k] = H0.re[k] * G.im[k] - H0.im[k] * G.re[k]; }
                wins.push(o); }
            if (wins.length < 2) return { windows: wins.length };
            const tot = (skip) => { const t = {}; for (const q in wins[0]) t[q] = new Float64Array(k1 + 2);
                wins.forEach((o, j) => { if (j === skip) return; for (const q in t) for (let k = k0 - 1; k <= k1 + 1; k++) t[q][k] += o[q][k]; }); return t; };
            const A = tot(-1), pk = bandPeak(A.ee, k0, k1), kb = pk ? Math.round(pk.bin) : k0;
            const coh = (t, k) => (t.re[k] ** 2 + t.im[k] ** 2) / (t.hh[k] * t.gg[k] || 1e-300);
            let cmax = 0, cmaxK = k0; for (let k = k0; k <= k1; k++) if (coh(A, k) > cmax) { cmax = coh(A, k); cmaxK = k; }
            const jk = wins.length >= 3 ? wins.map((_, j) => coh(tot(j), kb)) : null, wsum = hann(N).reduce((a, v) => a + v, 0);
            return { windows: wins.length, wagHz: r(kb * df, 2), wagProminence: pk ? r(pk.prominence, 2) : null, coherence: r(coh(A, kb), 3), coherenceSe: jk ? r(jackSe(jk), 3) : null,
                coherenceRaw: r((A.r0[kb] ** 2 + A.i0[kb] ** 2) / (A.h0[kb] * A.gg[kb] || 1e-300), 3), frameSign: frame.sign,
                maxCoherence: r(cmax, 3), maxCoherenceHz: r(cmaxK * df, 2), headspeedAmplitude: r(2 * Math.sqrt(A.hh[kb] / wins.length) / wsum, 2), yawAmplitude: r(2 * Math.sqrt(A.gg[kb] / wins.length) / wsum, 2) };
        }) };
    }

    // --- G11: steady throttle against time and battery voltage
    if (mot) {
        const B = S(RULE.g11.blockS), blocks = [];
        for (let b = 0; b + B <= n; b += B) { let c = 0; for (let i = b; i < b + B; i++) if (act[i] && quiet[i] && prof[i] === prof[b]) c++; if (c < RULE.g11.cover * B) continue;
            blocks.push({ p: prof[b], t: (b + B / 2) / rate, m: avg(mot, b, b + B) / 10, v: vb ? avg(vb, b, b + B) / 100 : null, c: coll ? Math.abs(avg(coll, b, b + B)) / 1000 : 0 }); }
        const fit = (list, key, ps) => { if (list.length < ps.length + 5) return null;
            const X = list.map(o => [...ps.map(p => o.p === p ? 1 : 0), o[key], o.c, o.c * o.c]), s = lib.solve(X, list.map(o => o.m));
            return s ? { slope: s.beta[ps.length], se: s.se[ps.length], r2: s.r2, n: list.length } : null; };
        const pack = out.flyingS;
        const pooled = fit(blocks, 't', profiles.filter(p => blocks.some(o => o.p === p))), pooledV = vb ? fit(blocks, 'v', profiles.filter(p => blocks.some(o => o.p === p))) : null;
        out.G11 = { blocks: blocks.length, blockS: RULE.g11.blockS, packS: pack, model: 'motor% ~ profile + x + |coll| + coll^2',
            perSecond: pooled ? r(pooled.slope, 5) : null, perSecondSe: pooled ? r(pooled.se, 5) : null, perPack: pooled ? r(pooled.slope * pack, 2) : null, perPackSe: pooled ? r(pooled.se * pack, 2) : null,
            perVolt: pooledV ? r(pooledV.slope, 3) : null, perVoltSe: pooledV ? r(pooledV.se, 3) : null, r2: pooled ? r(pooled.r2, 3) : null,
            byProfile: byP(p => { const f = fit(blocks.filter(o => o.p === p), 't', [p]); return f ? { perSecond: r(f.slope, 5), perSecondSe: r(f.se, 5), perPack: r(f.slope * pack, 2), perPackSe: r(f.se * pack, 2), n: f.n } : { n: blocks.filter(o => o.p === p).length }; }) };
    } else out.G11 = { skipped: 'no motor[0] field' };

    // --- G12: main-rotor lines of the raw gyro against the logged headspeed
    const raw = [0, 1, 2].map(k => x[`gyroRAW[${k}]`]);
    if (raw.every(Boolean)) {
        const O = RULE.g12, ON = O.perRev * O.revolutions, d = O.perRev / ON, R = lib.byRevolution(hs, rate, raw, O.perRev), kf = Math.round(O.from / d), kt = Math.round(O.to / d), wins = [];
        for (let s = 0; s + ON <= R.M; s += ON / 2) {
            let ok = true; for (let i = s; i < s + ON && ok; i += 64) { const j = R.index[i]; if (!flying[j] || hs[j] < O.headspeed) ok = false; } if (!ok) continue;
            const pw = new Float32Array(kt - kf + 1);
            for (let k = 0; k < 3; k++) { const { re, im } = transform(R.columns[k], s, ON); for (let b = kf; b <= kt; b++) pw[b - kf] += re[b] ** 2 + im[b] ** 2; }
            wins.push(pw);
        }
        if (wins.length) {
            const total = new Float64Array(kt - kf + 1); for (const pw of wins) for (let b = 0; b < total.length; b++) total[b] += pw[b];
            const at = (o) => Math.round(o / d) - kf, s0 = at(O.search[0]), s1 = at(O.search[1]);
            const main = (p) => { let b = s0; for (let k = s0; k <= s1; k++) if (p[k] > p[b]) b = k; const med = median(p.subarray(Math.max(0, b - 100), b + 100));
                return { order: (lib.spectralPeak(p, b, b).bin + kf) * d, prominence: Math.sqrt(p[b] / med) }; };
            const m1 = main(total), jk = wins.length >= 3 ? wins.map(pw => main(Float64Array.from(total, (v, b) => v - pw[b])).order) : null;
            const harm = [2, 3, 4].map(k => { const c = at(k * m1.order); if (c + 12 >= total.length) return null; let b = c - 12; for (let j = c - 12; j <= c + 12; j++) if (total[j] > total[b]) b = j;
                const med = median(total.subarray(Math.max(0, b - 100), b + 100)); return { k, order: r((b + kf) * d, 4), prominence: r(Math.sqrt(total[b] / med), 1) }; }).filter(Boolean);
            const peaks = []; for (let b = 12; b < total.length - 12; b++) { let top = true; for (let j = b - 12; j <= b + 12 && top; j++) if (total[j] > total[b]) top = false; if (top) peaks.push(b); }
            peaks.sort((p, q) => total[q] - total[p]);
            const lines = peaks.slice(0, O.lines).map(b => { const o = (lib.spectralPeak(total, b, b).bin + kf) * d / m1.order; return { order: r(o, 4), harmonic: Math.abs(o - Math.round(o)) < O.harmonic ? Math.round(o) : null, amplitude: r(Math.sqrt(total[b] / wins.length / 3) / (ON / 4), 2) }; });
            out.G12 = { windows: wins.length, revolutions: O.revolutions, orderPerBin: d, mainOrder: r(m1.order, 5), mainOrderSe: jk ? r(jackSe(jk), 5) : null, mainProminence: r(m1.prominence, 1), harmonics: harm, lines,
                note: 'mainOrder = the strongest line between orders 0.6 and 1.6 of the logged headspeed; 1 when poles and gear ratio are right. lines are in multiples of mainOrder' };
        } else out.G12 = { windows: 0, skipped: `no window of ${O.revolutions} revolutions in flight above ${O.headspeed} rpm` };
    } else out.G12 = { skipped: 'no gyroRAW fields' };

    return out;
}

// ---------------------------------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------------------------------

function judge(flights, RULES = DEFAULT_RULES) {
    const R = RULES, sig = R.sig === undefined ? 2 : R.sig, out = [], pct = (v, d = 1) => v === null || v === undefined ? '-' : (100 * v).toFixed(d) + ' %';
    const add = (id, severity, log, profile, value, se, n, threshold, text) => out.push({ id, severity, log, profile, value: value === undefined ? null : value, se: se === undefined ? null : se, n: n === undefined ? null : n, threshold, source: (R[id] || {}).source || null, text });
    const above = (v, se, thr) => v > thr && (se === null || se === undefined || v - sig * se > thr); // significantly above
    const direct = new Set();

    for (const f of flights) {
        const m = f.metrics, L = f.log;
        // D5
        if (m.D5.skipped) add('D5', 'skipped', L, null, null, null, 0, R.D5, m.D5.skipped);
        else {
            const d = m.D5, big = d.steps.filter(s => Math.abs(s.value) > R.D5.step), cellText = `${d.cells} cells, ${d.cellsSource}`;
            // samples below minCell per cell, from the in-flight histogram (bins of d.cellHistogram.step V/cell)
            const H = d.cellHistogram, belowN = H ? H.counts.reduce((a, c, k) => a + (H.from + (k + 1) * H.step <= R.D5.minCell + 1e-9 ? c : 0), 0) : null;
            const belowS = belowN !== null && d.rate ? belowN / d.rate : null, low = !d.cellsAmbiguous && belowS !== null && belowS >= (R.D5.minS || 0);
            if (big.length) add('D5', 'flag', L, null, d.maxStep, null, big.length, R.D5,
                `${big.length} Vbat steps above ${R.D5.step} V in ${d.stepWindowS * 1000} ms (largest ${d.maxStep} V at ${d.maxStepT} s, first at ${big.slice(0, 5).map(s => s.t + ' s').join(', ')}); min in flight ${d.minCellInFlight} V/cell at ${d.minCellT} s (${cellText}). Sag or telemetry glitch: do not interpret power here`);
            if (low) add('D5', 'flag', L, null, r(belowS, 2), null, belowN, R.D5,
                `${r(belowS, 2)} s in flight below ${R.D5.minCell} V/cell (${belowN} samples, >= ${R.D5.minS} s; min ${d.minCellInFlight} V/cell at ${d.minCellT} s; ${cellText}). Deep sag: do not interpret power here`);
            if (!big.length && !low) add('D5', d.cellsAmbiguous ? 'note' : 'ok', L, null, d.maxStep, null, d.n, R.D5, `largest Vbat step ${d.maxStep} V per ${d.stepWindowS * 1000} ms` + (d.cellsAmbiguous ? `; per-cell voltage not judged: ${cellText}` : `, min ${d.minCellInFlight} V/cell in flight, ${r(belowS, 2)} s below ${R.D5.minCell} V/cell (${cellText})`));
        }
        // G13
        if (m.G13.skipped) add('G13', 'skipped', L, null, null, null, 0, R.G13, m.G13.skipped);
        else if (m.G13.cellsAmbiguous) add('G13', 'note', L, null, null, null, m.G13.n, R.G13.minCell, `no finding: cell count ambiguous (${m.G13.cellsSource}); Vbat in flight ${m.G13.startV} -> ${m.G13.endV} V. The log does not record the cell count`);
        else add('G13', m.G13.p1Cell < R.G13.minCell ? 'flag' : 'ok', L, null, m.G13.p1Cell, null, m.G13.n, R.G13.minCell,
            `p1 of Vbat in flight ${m.G13.p1Cell} V/cell (min ${m.G13.minCell}, median ${m.G13.medianCell}; ${m.G13.cells} cells, ${m.G13.cellsSource || ''}; ${m.G13.startV} -> ${m.G13.endV} V)`);
        // G0
        if (m.G0.skipped) add('G0', 'skipped', L, null, null, null, 0, null, m.G0.skipped);
        else if (m.G0.mode === 'DIRECT/LIMIT') { direct.add(L); add('G0', 'note', L, null, 0, null, m.G0.flyingSamples, null, 'govSum and govI are 0 in flight: DIRECT or LIMIT, no PID governor. G2-G6 and G9 skipped; headspeed judged against its per-profile median'); }
        else add('G0', 'ok', L, null, m.G0.govSumNonZero, null, m.G0.flyingSamples, null, `PID governor running (govSum non-zero in ${m.G0.govSumNonZero} of ${m.G0.flyingSamples} in-flight samples)`);
        // G1
        const fb = m.G1.fallbackEntries;
        if (fb.length >= R.G1.fallback) add('G1', 'flag', L, null, fb.length, null, fb.length, R.G1.fallback,
            `${fb.length} FALLBACK entr${fb.length > 1 ? 'ies' : 'y'} at ${fb.map(e => `${e.t} s (${e.value} s long, headspeed ${e.headspeedAt}, max ${e.headspeedMax}, ${e.glitchSamplesNear} glitch-proxy samples within 0.5 s)`).join('; ')}. RPM signal lost or glitching`);
        if (m.G1.glitchInFlight > 0) add('G1', 'note', L, null, m.G1.glitchInFlight, null, m.G1.glitchSamples, null,
            `${m.G1.glitchInFlight} glitch-proxy events in flight (${m.G1.criterion}; the logged headspeed is filtered differently from the governor's, so this is a proxy), first at ${m.G1.events.filter(e => e.flying).slice(0, 5).map(e => `${e.t} s (${pct(e.value)})`).join(', ')}; max logged headspeed ${m.G1.headspeedMax}`);
        if (!fb.length && !m.G1.glitchInFlight) add('G1', m.G1.fallbackKnown ? 'ok' : 'note', L, null, 0, null, null, R.G1.fallback, m.G1.fallbackKnown ? 'no FALLBACK, no glitch proxy in flight' : 'no glitch proxy in flight; FALLBACK unknown (no GOVSTATE events)');

        const skipDirect = (id) => { if (direct.has(L)) { add(id, 'skipped', L, null, null, null, 0, R[id], 'DIRECT/LIMIT (G0)'); return true; } return false; };
        // G2
        if (!skipDirect('G2')) for (const [p, g] of Object.entries(m.G2.byProfile)) {
            if (!g.n || g.seconds < R.G2.minS) { add('G2', 'note', L, +p, g.median, g.se, g.n, R.G2, `no finding: ${g.seconds || 0} s of steady ACTIVE flight < ${R.G2.minS} s`); continue; }
            const bad = above(Math.abs(g.median), g.se, R.G2.median) || g.p5 < -R.G2.band || g.p95 > R.G2.band;
            add('G2', bad ? 'flag' : 'ok', L, +p, g.median, g.se, g.n, R.G2, `steady headspeed error median ${pct(g.median, 2)} +- ${pct(g.se, 2)}, p5..p95 ${pct(g.p5, 2)}..${pct(g.p95, 2)} over ${g.seconds} s (vs ${g.reference})`);
        }
        // G6, G7
        if (m.G6.skipped) add('G6', 'skipped', L, null, null, null, 0, R.G6, m.G6.skipped);
        else if (!skipDirect('G6')) for (const [p, g] of Object.entries(m.G6.byProfile)) {
            if (!g.n) continue;
            const sat = g.runs.filter(q => q.value >= R.G6.runS && q.deficit !== null && q.deficit > R.G6.deficit), high = g.medianPct > R.G6.median;
            add('G6', sat.length || high ? 'flag' : 'ok', L, +p, g.medianPct, null, g.n, R.G6,
                `median throttle ${g.medianPct} % (p95 ${g.p95Pct} %), ${pct(g.atCeilingShare, 2)} of ACTIVE time at the ceiling ${g.ceiling} (${g.ceilingSource}); ${sat.length} runs >= ${R.G6.runS * 1000} ms at the ceiling with headspeed > ${pct(R.G6.deficit, 0)} below target${sat.length ? ' at ' + sat.slice(0, 5).map(q => `${q.t} s (${q.value} s, ${pct(q.deficit)})`).join(', ') : ''}${sat.length ? '. Saturation, not a gain problem' : ''}${high ? '. Throttle above the 75-85 % guideline: little headroom' : ''}`);
            const g7 = m.G7.byProfile && m.G7.byProfile[p];
            if (g7 && g7.n) add('G7', g7.mean > 0 ? 'note' : 'ok', L, +p, g7.mean, null, g7.n, 0, `at the ceiling the governor asks ${pct(g7.mean)} more than the output (govSum x vcomp - motor[0]; p95 ${pct(g7.p95)}, max ${pct(g7.max)}) over ${g7.n} samples; vcomp ${m.G7.vcomp}`);
        }
        // G8
        if (m.G8.skipped) add('G8', 'skipped', L, null, null, null, 0, R.G8, m.G8.skipped);
        else if (m.G8.n < R.G8.minN) add('G8', 'note', L, null, m.G8.median, null, m.G8.n, R.G8, `no finding: ${m.G8.n} unsaturated samples < ${R.G8.minN}`);
        else {
            const off = m.G8.unityShare >= R.G8.unityShare, outOf = m.G8.p5 < R.G8.bounds[0] - 0.01 || m.G8.p95 > R.G8.bounds[1] + 0.01;
            add('G8', outOf ? 'flag' : 'note', L, null, m.G8.median, null, m.G8.n, R.G8, off ? `voltage compensation off: motor[0]/govSum = 1 within ${RULE.unsat.unity} in ${pct(m.G8.unityShare)} of ${m.G8.n} unsaturated samples`
                : `voltage compensation on: motor[0]/govSum median ${m.G8.median} (p5 ${m.G8.p5}, p95 ${m.G8.p95}), correlation with the gain predicted from Vbat ${m.G8.corrWithPredicted} (predicted median ${m.G8.predictedMedian})${outOf ? '; outside the firmware bounds 0.80-1.20: the ratio is not vcomp alone' : ''}`);
        }
        // G9
        if (!skipDirect('G9')) for (const [p, g] of Object.entries(m.G9.byProfile)) for (const band of Object.keys(RULE.g9.bands)) {
            const b = g[band];
            if (!b || g.windows < R.G9.minWindows) { add('G9', 'note', L, +p, b ? b.prominence : null, null, g.windows, R.G9.prominence, `no finding (${band}-type band): ${g.windows} windows of ${m.G9.windowS} s < ${R.G9.minWindows}`); continue; }
            const big = b.amplitude >= (R.G9.minAmplitude || 0), forced = b.collectiveCoherence !== null && b.collectiveCoherence >= R.G9.maxCollectiveCoherence;
            const flag = big && !forced && above(b.prominence, b.prominenceSe, R.G9.prominence), edge = !flag && b.prominence >= R.G9.prominence;
            add('G9', flag ? 'flag' : edge ? 'note' : 'ok', L, +p, b.prominence, b.prominenceSe, b.n, R.G9.prominence,
                `headspeed error peak at ${b.hz} +- ${b.hzSe} Hz in ${b.band[0]}-${b.band[1]} Hz (${band}-type), prominence ${b.prominence} +- ${b.prominenceSe}, amplitude ${pct(b.amplitude, 2)} of target, coherence with collective ${b.collectiveCoherence}, ${b.n} windows${flag ? (band === 'P' ? ': governor P or gain too high' : ': governor I too high') : edge ? (forced ? ': follows the collective, a forced response' : big ? ': above the threshold but not by ' + sig + ' SE' : `: prominent but under ${pct(R.G9.minAmplitude, 2)} of target`) : ''}`);
        }
        // G10
        for (const [p, g] of Object.entries(m.G10.byProfile)) {
            if (g.windows < R.G10.minWindows) { add('G10', 'note', L, +p, g.coherence === undefined ? null : g.coherence, null, g.windows, R.G10, `no finding: ${g.windows} windows < ${R.G10.minWindows}`); continue; }
            const impl = above(g.coherence, g.coherenceSe, R.G10.implicated), out0 = g.coherence <= R.G10.ruledOut && g.headspeedAmplitude <= R.G10.flatRpm;
            add('G10', impl ? 'flag' : out0 ? 'ok' : 'note', L, +p, g.coherence, g.coherenceSe, g.windows, R.G10,
                `coherence of headspeed (frame rotation removed, sign ${g.frameSign}; ${g.coherenceRaw} before) and yaw gyro at the yaw peak ${g.wagHz} Hz: ${g.coherence} +- ${g.coherenceSe} (max ${g.maxCoherence} at ${g.maxCoherenceHz} Hz); headspeed ${g.headspeedAmplitude} rpm, yaw ${g.yawAmplitude} deg/s there${impl ? ': governor implicated' : out0 ? ': governor ruled out' : ''}`);
        }
        // G11
        if (m.G11.skipped) add('G11', 'skipped', L, null, null, null, 0, R.G11, m.G11.skipped);
        else if (m.G11.blocks < R.G11.minBlocks || m.G11.perPack === null) add('G11', 'note', L, null, m.G11.perPack, m.G11.perPackSe, m.G11.blocks, R.G11.perPack, `no finding: ${m.G11.blocks} steady blocks of ${m.G11.blockS} s`);
        else add('G11', above(m.G11.perPack, m.G11.perPackSe, R.G11.perPack) ? 'flag' : 'ok', L, null, m.G11.perPack, m.G11.perPackSe, m.G11.blocks, R.G11.perPack,
            `steady throttle trend ${m.G11.perPack} +- ${m.G11.perPackSe} % points over ${m.G11.packS} s in flight (${m.G11.perVolt === null ? '-' : m.G11.perVolt + ' +- ' + m.G11.perVoltSe} % per V), at equal collective, ${m.G11.blocks} blocks`);
        // G12
        if (m.G12.skipped) add('G12', 'skipped', L, null, null, null, 0, R.G12, m.G12.skipped);
        else if (m.G12.mainProminence < R.G12.minProminence) add('G12', 'note', L, null, m.G12.mainOrder, m.G12.mainOrderSe, m.G12.windows, R.G12, `no finding: strongest line near 1P at order ${m.G12.mainOrder}, prominence ${m.G12.mainProminence} < ${R.G12.minProminence}`);
        else { const dev = Math.abs(m.G12.mainOrder - 1), bad = dev > R.G12.tolerance && (m.G12.mainOrderSe === null || dev - sig * m.G12.mainOrderSe > R.G12.tolerance);
            add('G12', bad ? 'flag' : 'ok', L, null, m.G12.mainOrder, m.G12.mainOrderSe, m.G12.windows, R.G12.tolerance,
                `main rotor line at ${m.G12.mainOrder} +- ${m.G12.mainOrderSe} x logged headspeed/60 (prominence ${m.G12.mainProminence}; harmonics ${m.G12.harmonics.map(q => q.k + 'P ' + q.order).join(', ')})${bad ? `: headspeed reads ${(1 / m.G12.mainOrder).toFixed(3)} x the rotor, check motor_poles and gear ratio` : ''}`); }
    }

    // G3, G4, G5 and the authority split: events pooled over flights, per profile and step size
    const ev = [];
    for (const f of flights) if (!direct.has(f.log) && f.metrics.G3 && f.metrics.G3.events) for (const e of f.metrics.G3.events) ev.push(Object.assign({ log: f.log }, e));
    const skippedAll = flights.every(f => !f.metrics.G3 || f.metrics.G3.skipped);
    if (skippedAll) for (const id of ['G3', 'G4', 'G5']) add(id, 'skipped', null, null, null, null, 0, R[id], flights.length ? flights[0].metrics.G3.skipped || 'DIRECT' : 'no flights');
    const profiles = [...new Set(ev.map(e => e.profile))].sort((a, b) => a - b), logsOf = (l) => [...new Set(l.map(e => e.log))];
    const stat = (l, k) => { const v = l.map(e => e[k]).filter(q => q !== null); return { mean: meanOf(v), se: seOf(v), n: v.length }; };
    for (const p of profiles) {
        const rise = ev.filter(e => e.profile === p && e.dir === 'rise' && e.size >= R.G3.minStep), drop = ev.filter(e => e.profile === p && e.dir === 'drop' && e.size >= R.G4.minStep);
        // G3
        if (rise.length < R.G3.minEvents) add('G3', 'note', logsOf(rise), p, null, null, rise.length, R.G3, `no finding: ${rise.length} collective rises >= ${pct(R.G3.minStep, 0)} of one-sided collective travel < ${R.G3.minEvents}`);
        else {
            const d = stat(rise, 'droop'), sat = rise.filter(e => e.saturated).length, fs = rise.map(e => e.share && e.share.F).filter(v => typeof v === 'number');
            const sev = above(d.mean, d.se, R.G3.flag) ? 'flag' : d.mean > R.G3.good ? 'note' : 'ok', satd = sat / rise.length >= R.G3.saturatedShare;
            add('G3', sev, logsOf(rise), p, r(d.mean, 4), r(d.se, 4), d.n, R.G3,
                `droop ${pct(d.mean, 2)} +- ${pct(d.se, 2)} over ${d.n} rises >= ${pct(R.G3.minStep, 0)} of one-sided collective travel (worst ${pct(Math.max(...rise.map(e => e.droop)), 2)} at log ${rise.reduce((a, b) => b.droop > a.droop ? b : a).log} ${rise.reduce((a, b) => b.droop > a.droop ? b : a).t} s); ${sat} at the throttle ceiling; F carries ${pct(meanOf(fs), 0)} +- ${pct(seOf(fs), 0)} of the added govSum`
                + (sev !== 'ok' ? (satd ? '. Most events saturate: headroom (G6), not F' : meanOf(fs) < 0.5 ? '. F carries less than half: F too low (GOVT)' : '') : ''));
            // overshoot on rise: the "headspeed temporarily too high" signature of F too high
            const o = stat(rise, 'overshoot');
            if (above(o.mean, o.se, R.G4.flag)) add('G4', 'flag', logsOf(rise), p, r(o.mean, 4), r(o.se, 4), o.n, R.G4, `headspeed overshoots ${pct(o.mean, 2)} +- ${pct(o.se, 2)} on collective rises (load onset), F carries ${pct(meanOf(fs), 0)} of the added govSum: F too high (GOVT)`);
            // G5
            const rc = rise.map(e => e.recoveryS === null ? null : e.recoveryS).filter(v => v !== null), cen = rise.filter(e => e.censored).length, rm = meanOf(rc), rs = seOf(rc);
            add('G5', above(rm, rs, R.G5.flag) ? 'flag' : 'ok', logsOf(rise), p, r(rm, 3), r(rs, 3), rc.length, R.G5.flag, `recovery to within ${pct(RULE.step.band, 0)} of target ${r(rm, 3)} +- ${r(rs, 3)} s after the droop peak over ${rc.length} rises (${cen} not recovered within ${RULE.step.recoverMaxS} s, counted at that time)`);
        }
        // G4 on unload
        if (drop.length < R.G4.minEvents) add('G4', 'note', logsOf(drop), p, null, null, drop.length, R.G4, `no finding: ${drop.length} collective drops >= ${pct(R.G4.minStep, 0)} of one-sided collective travel < ${R.G4.minEvents}`);
        else { const o = stat(drop, 'overshoot');
            add('G4', above(o.mean, o.se, R.G4.flag) ? 'flag' : 'ok', logsOf(drop), p, r(o.mean, 4), r(o.se, 4), o.n, R.G4, `overshoot after collective drops ${pct(o.mean, 2)} +- ${pct(o.se, 2)} over ${o.n} events (max ${pct(Math.max(...drop.map(e => e.overshoot)), 2)})`); }
    }
    return out;
}

module.exports = { EXTRA, RULE, DEFAULT_RULES, STATES, analyse, judge, pt2 };
