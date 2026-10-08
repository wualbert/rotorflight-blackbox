'use strict';

// Deterministic, constrained successive-halving search. All objective values,
// latency estimates and plots come from filter_replay on recorded samples.
// See docs/FILTER_AUTOTUNE.md for sources, assumptions and validation coverage.
const FT = require('./filter_tune.cjs');
const replay = require('./filter_replay.cjs');
const reconstruct = require('./filter_reconstruct.cjs');
const setup = require('./health_setup.cjs');
const AXES = ['roll', 'pitch', 'yaw'];
const RULES = Object.freeze({ window: 1024, leadS: 2, blockS: 30, noiseHz: 30,
    nyquistShare: 0.8, parityDb: 1, parityDelayMs: 0.3, maxAddMs: 0.5,
    maxControlLossDb: 0.5, maxAxisWorseDb: 0.25, minReductionDb: 3,
    minUnits: 3, minWindows: 5, minCoherence: 0.8, minHeldoutShare: 0.8,
    maxCandidates: 360, finalists: 12, budgetMs: 120000 });
const clone = o => JSON.parse(JSON.stringify(o));
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const db = (x, y) => 10 * Math.log10(Math.max(x, 1e-30) / Math.max(y, 1e-30));
const key = s => JSON.stringify(Object.keys(s).sort().map(k => [k, s[k]]));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const median = a => a.length ? a.slice().sort((a, b) => a - b)[a.length >> 1] : null;
const round = (x, d = 3) => Number.isFinite(x) ? +x.toFixed(d) : null;
function stats(a) { const m = mean(a); return { mean: m, se: a.length > 1 ? Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1) / a.length) : null, n: a.length }; }
const pidKey = (p, ax, what) => `p${p}:${ax}_${what}_cutoff`;
const publicValue = (k, v) => /gyro_lpf[12]_type/.test(k) ? FT.FW.LPF[v] : Array.isArray(v) ? v.join(',') : v;

function masks(item, opts) {
    if (item.mask) return item.mask;
    const w = item.w || item, phase = require('./health_phase.cjs'), more = require('./health_more.cjs');
    const ctx = { rate: w.rate, flightRule: { headspeed: opts.flightRpm || require('./lib.cjs').FLIGHT_RPM } };
    const ph = phase.phases(w, ctx), mask = phase.flightMask(w, ctx, ph);
    return more.normalMask(w, Object.assign({ flying: mask, phases: ph, header: w.flight.header, profile: w.profileAt, govState: w.govStateAt }, ctx)).mask;
}

function prepare(items, opts) {
    const cli = opts.cli ? typeof opts.cli === 'string' ? setup.parseCli(opts.cli) : opts.cli : null;
    let fit = opts.tailFit || null;
    if (!opts.gear && !fit && opts.logGear !== false) fit = FT.tailOrder(items, opts);
    const segments = [], windows = [], excluded = [], notes = [];
    for (const item of items) {
        const w = item.w || item;
        if (w.skipped || item.flight === false) continue;
        const raw = AXES.map((_, a) => w.extra && w.extra[`gyroRAW[${a}]`]);
        if (!raw.every(Boolean)) { excluded.push({ log: w.flight.log, reason: 'The log has no raw gyro data.' }); continue; }
        const cfg = FT.config(w.flight.header, { cli, gear: opts.gear, logGear: fit && fit.gear, actualRate: w.flight.actualRate });
        if (!(cfg.rates.logHz > 0)) { excluded.push({ log: w.flight.log, reason: 'The log has no sample rate.' }); continue; }
        cfg.rates.scale=reconstruct.schedulerScale(w.extra.time,cfg.rates.logHz,cfg.rates.scale);
        const model = FT.compile(cfg), firmware = w.flight.firmware || w.flight.header['Firmware revision'] || '';
        const unsupported = !/Rotorflight 4\.6\.0\b/.test(firmware);
        const mask = masks(item, opts), originalProfiles = w.profileAt || new Uint8Array(w.n);
        const firstProfile = item.armingProfile || opts.armingProfile || originalProfiles[0] || 0;
        const prof = Uint8Array.from(originalProfiles, p => p || firstProfile);
        const seg = { id: segments.length, w, cfg, model, raw, n: w.n, hs: w.hs, tail: w.extra.tailspeed,
            filt: w.gyro, time: w.extra.time, prof, mask, ratio: item.fullHeadSpeedRatio || null,
            firstProfile, firmware, unsupported, log: w.flight.log, file: w.flight.file, fromS: w.fromS || 0 };
        // fullHeadSpeed is a profile specification, not the changing governor
        // request. Never substitute govRequest for it.
        if (!seg.ratio) {
            const recovered = reconstruct.governorRatio(cfg, w, prof, cli);
            if (recovered) { seg.ratio = recovered.values; seg.ratioSource = recovered.source; }
        }
        if (model.leftOut.length || model.rpm.some((b, a) => cfg.s.RPM_FILTER !== false && FT.effectiveBanks(cfg.s)[a] === null) || (model.dynLpf && !seg.ratio)) {
            excluded.push({ log: seg.log, reason: model.dynLpf && !seg.ratio ? 'The dynamic low-pass filter needs the governor settings to calculate its headspeed ratio.' : 'The frequency of an active RPM notch filter is unknown.' }); continue;
        }
        const firstWindow = windows.length;
        const N = 2 ** Math.round(Math.log2(cfg.rates.logHz)), lead = Math.ceil(RULES.leadS * cfg.rates.logHz);
        for (let st = lead; st + N <= w.n; st += N) {
            const p = prof[st]; let valid = true;
            for (let i = st - lead; i < st + N; i++) {
                if (!mask[i] || prof[i] !== p || !Number.isFinite(raw[0][i] + raw[1][i] + raw[2][i] + w.hs[i])) { valid = false; break; }
                if (seg.time && i > st - lead && (seg.time[i] <= seg.time[i - 1] || seg.time[i] - seg.time[i - 1] > 1.8e6 / cfg.rates.logHz)) { valid = false; break; }
            }
            if (!valid) continue;
            const block = Math.floor((seg.fromS + st / cfg.rates.logHz) / RULES.blockS);
            const unit = `${seg.file || ''}:${seg.log}:${block}`;
            windows.push({ id: windows.length, seg, st, N, lead, profile: p, unit, block,
                hs: w.hs[st + (N >> 1)], rate: cfg.rates.logHz, held: false });
        }
        if (windows.length === firstWindow) {
            excluded.push({ log: seg.log, fromS: seg.fromS, toS: seg.fromS + seg.n / cfg.rates.logHz,
                reason: 'This flight period has no complete filter window.' });
            continue;
        }
        segments.push(seg);
    }
    // Block holdout is fixed before proposals, scoring or refinement. Keep the
    // entire block out of training, even when it contains a profile transition.
    const units = [...new Set(windows.map(w => w.unit))];
    units.forEach((u, i) => { for (const w of windows) if (w.unit === u) w.held = i % 4 === 3; });
    if (units.length >= 3 && !windows.some(w => w.held)) for (const w of windows) w.held = w.unit === units[units.length - 1];
    const ref = segments.length ? segments[segments.length - 1].cfg : null;
    const targetProfiles = {};
    for (const seg of segments) {
        seg.observers = {};
        for (const profile of new Set(windows.filter(w=>w.seg===seg).map(w=>w.profile))) {
            const ws = windows.filter(w=>w.seg===seg&&w.profile===profile), ps=paths(ws[0],{});
            seg.observers[profile] = ps.map((p,a)=>p.known?p:reconstruct.pidObserver(seg,ws,a)||p);
        }
        const ws=windows.filter(w=>w.seg===seg);
        seg.timingCalibration=reconstruct.calibrateTiming(seg,ws);
        reconstruct.seedHistory(seg,ws.map(w=>w.st-w.lead));
    }
    for (const w of windows) paths(w, {}).forEach((p, a) => {
        if (p.known) for (const kind of ['gyro', 'd']) targetProfiles[pidKey(w.profile, AXES[a], kind)] = p[`${kind}_cutoff`];
    });
    return { segments, windows, units, ref, targetProfiles, cli, fit, excluded, notes, opts, evaluations: 0, samples: 0 };
}

function paths(w, changes) {
    const cfg = w.seg.cfg, p = w.profile;
    return AXES.map((ax, a) => {
        const recorded = p > 0 && (p === w.seg.firstProfile ? cfg.pid.header[ax] : cfg.pid.cli[p] && cfg.pid.cli[p][ax]);
        const known = recorded && ['gyro_cutoff', 'd_cutoff', 'P', 'D'].every(k => Number.isFinite(recorded[k]));
        const base = known ? recorded : cfg.pid.header[ax];
        return { gyro_cutoff: changes[pidKey(p, ax, 'gyro')] === undefined ? base.gyro_cutoff : changes[pidKey(p, ax, 'gyro')],
            d_cutoff: changes[pidKey(p, ax, 'd')] === undefined ? base.d_cutoff : changes[pidKey(p, ax, 'd')],
            Kp: (base.P || 0) * require('./lib.cjs').SCALE.P[a], Kd: (base.D || 0) * require('./lib.cjs').SCALE.D[a],
            ...(known && base.stopGain ? {stopGain:base.stopGain} : {}), known: !!known };
    });
}

function settings(cfg, changes) { return FT.withSettings(cfg, Object.fromEntries(Object.entries(changes).filter(([k]) => !k.startsWith('p')))); }
const plans = new Map();
function spectrum(x, y, start, N, rate) {
    let plan = plans.get(N); if (!plan) plans.set(N, plan = FT.fftPlan(N));
    const K = N / 2 + 1, xr = new Float64Array(K), xi = new Float64Array(K), yr = new Float64Array(K), yi = new Float64Array(K);
    FT.twoSpectra(plan, x, y, start, xr, xi, yr, yi);
    const norm = 2 / (rate * plan.power);
    return { raw: Float64Array.from(xr, (v, k) => (v * v + xi[k] ** 2) * norm),
        y: Float64Array.from(yr, (v, k) => (v * v + yi[k] ** 2) * norm),
        re: Float64Array.from(xr, (v, k) => (v * yr[k] + xi[k] * yi[k]) * norm),
        im: Float64Array.from(xr, (v, k) => (v * yi[k] - xi[k] * yr[k]) * norm) };
}
function measurement(w, result, baseline = false) {
    const df = w.rate / w.N, lo = Math.ceil(RULES.noiseHz / df), hi = Math.floor(w.N / 2 * RULES.nyquistShare);
    return AXES.map((ax, a) => {
        const raw = w.seg.raw[a].subarray(w.st - w.lead, w.st + w.N);
        const S = spectrum(raw, result.y[a], w.lead, w.N, w.rate);
        const observed = Float32Array.from(result.y[a], replay.quantize), observation = spectrum(raw, observed, w.lead, w.N, w.rate);
        const matching = baseline ? spectrum(w.seg.filt[a].subarray(w.st-w.lead,w.st+w.N), observed, w.lead, w.N, w.rate) : null;
        const P = spectrum(result.out[a], result.out[a], w.lead, w.N, w.rate).y;
        let power = 0, pidPower = 0, nativeSpectrum = null;
        if (result.native) {
            const factor=result.native.factor, rate=result.native.rate, N=2**Math.floor(Math.log2(w.N*factor)), start=w.lead*factor;
            const G=spectrum(result.native.y[a],result.native.y[a],start,N,rate).y;
            // Hold between PID ticks is part of the native gyro timeline. Pick
            // the actual PID ticks before measuring controller output energy.
            const stride=Math.round(rate/w.seg.cfg.rates.pidHz), pidAt=Math.floor(replay.PID_TICK[Math.min(8,w.seg.cfg.rates.pidDenom)]/w.seg.cfg.rates.filtDenom);
            const pidSignal=Float32Array.from({length:Math.floor(result.native.out[a].length/stride)},(_,i)=>result.native.out[a][i*stride+pidAt]);
            const PN=2**Math.floor(Math.log2(w.N*factor/stride)), pdf=(rate/stride)/PN;
            const PP=spectrum(pidSignal,pidSignal,Math.floor(start/stride),PN,rate/stride).y;
            const nativeDf=rate/N;
            for(let k=Math.ceil(RULES.noiseHz/nativeDf);k<=Math.floor(N/2*RULES.nyquistShare);k++)power+=G[k]*nativeDf;
            for(let k=Math.ceil(RULES.noiseHz/pdf);k<=Math.floor(PN/2*RULES.nyquistShare);k++)pidPower+=PP[k]*pdf;
            nativeSpectrum={df:nativeDf,rate,gyro:G,pid:PP,pidDf:pdf};
        } else for (let k = lo; k <= hi; k++) { power += S.y[k] * df; pidPower += P[k] * df; }
        const PS = spectrum(raw, result.pidGyro[a], w.lead, w.N, w.rate), DS = spectrum(raw, result.d[a], w.lead, w.N, w.rate);
        let error = 0, heldError = 0, heldSamples = 0;
        for (let i = 0; i < w.N; i++) {
            const e=(w.seg.filt[a][w.st+i]-result.y[a][w.lead+i])**2;error+=e;
            if ((w.lead+i+(w.input&&w.input.holdoutPhase||0))%5===2) {heldError+=e;heldSamples++;}
        }
        return { power, pidPower, S, observation, matching, P, PS, DS, nativeSpectrum, error, heldError, heldSamples };
    });
}
function evaluate(P, changes, wins, keep = false, continuous = false) {
    const results = [], traced = new Set();
    const whole = new Map();
    if (continuous) for (const seg of new Set(wins.map(w=>w.seg))) {
        if (!seg.joined) seg.joined = reconstruct.join(seg, P.windows.filter(w=>w.seg===seg));
        const changed=Object.keys(changes).length>0, all=changed?Object.assign({},P.ref.s,changes):{}, cfg=settings(seg.cfg,all);
        const profiles=new Map(), pathAt=i=>{
            const p=seg.prof[i];
            if(!profiles.has(p))profiles.set(p,paths({seg,profile:p},changed?Object.assign({},P.targetProfiles,changes):{}));
            return profiles.get(p);
        };
        const out=replay.run(cfg,seg,pathAt,reconstruct.candidateInput(cfg,seg.joined));
        whole.set(seg,out);P.samples+=out.samples;
    }
    for (const w of wins) {
        const changed = Object.keys(changes).length > 0;
        const cfg = settings(w.seg.cfg, changed ? Object.assign({}, P.ref.s, changes) : {}), pid = paths(w, changed ? Object.assign({}, P.targetProfiles, changes) : {});
        // Reconstruct once, with the recorded configuration. All candidates
        // receive exactly the same input; never fit an input to a candidate.
        const inp = w.input || (w.input = reconstruct.reconstruct(w.seg.cfg, w.seg, w.st - w.lead, w.st + w.N, w.seg.observers[w.profile]));
        const full=whole.get(w.seg), start=w.st-w.lead, end=w.st+w.N;
        const out = full ? Object.fromEntries(['y','out','pidGyro','d'].map(k=>[k,full[k].map(x=>x.subarray(start,end))])) : replay.run(cfg, w.seg, pid, reconstruct.candidateInput(cfg, inp));
        if(full)out.native={...full.native,y:full.native.y.map(x=>x.subarray(start*inp.factor,end*inp.factor)),out:full.native.out.map(x=>x.subarray(start*inp.factor,end*inp.factor))};
        const m = measurement(w, out, !changed);
        const traceKey = `${w.seg.id}:${w.profile}`, save = keep && !traced.has(traceKey);
        if (save) traced.add(traceKey);
        results.push({ w, m, trace: save ? { y: out.y, out: out.out, native:out.native } : null }); if(!full)P.samples += out.samples;
    }
    P.evaluations++;
    return { changes, results };
}

function compare(candidate, base, limits = RULES) {
    const baseline = new Map(base.results.map(r => [r.w.id, r])), byUnit = new Map();
    const axes = Array.from({ length: 3 }, () => ({ b: 0, c: 0, pb: 0, pc: 0 })), control = new Map();
    for (const r of candidate.results) {
        const b = baseline.get(r.w.id); if (!b) continue;
        let u = byUnit.get(r.w.unit); if (!u) byUnit.set(r.w.unit, u = { b: 0, c: 0 });
        for (let a = 0; a < 3; a++) {
            const A = axes[a], C = r.m[a], B = b.m[a]; A.b += B.power; A.c += C.power; A.pb += B.pidPower; A.pc += C.pidPower;
            // Normalize each axis by its baseline. A loud axis cannot hide a
            // worse quiet axis. PID weighting is used only for known profiles.
            const known = paths(r.w, {})[a].known && B.pidPower > 1e-12;
            u.b++; u.c += known ? C.pidPower / B.pidPower : C.power / Math.max(B.power, 1e-12);
            for (let path = 0; path < 3; path++) {
                if (path > 0 && !paths(r.w, {})[a].known) continue;
                const cs = path === 0 ? C.S : path === 1 ? C.PS : C.DS, bs = path === 0 ? B.S : path === 1 ? B.PS : B.DS;
                // A profile with low delay must not conceal a delay increase in
                // another profile. Keep control-band constraints separate.
                const ck = `${r.w.profile}:${path}:${a}`;
                let A = control.get(ck);
                if (!A) control.set(ck, A = { axis: AXES[a], path: ['gyro', 'P', 'D'][path], profile: r.w.profile,
                    ...Object.fromEntries(['re', 'im', 'br', 'bi', 'xx', 'yy', 'by'].map(k => [k, new Float64Array(5)])) });
                for (let j = 0; j < 5; j++) {
                const center = 10 + j * 5, df = r.w.rate / r.w.N;
                for (let k = Math.ceil((center - 2) / df); k <= Math.floor((center + 2) / df); k++) {
                    A.re[j] += cs.re[k]; A.im[j] += cs.im[k]; A.br[j] += bs.re[k]; A.bi[j] += bs.im[k];
                    A.xx[j] += bs.raw[k]; A.yy[j] += cs.y[k]; A.by[j] += bs.y[k];
                }
                }
            }
        }
    }
    let maxAddMs = -Infinity, maxLossDb = 0, checks = 0, at = null;
    control.forEach(A => { for (let j = 0; j < 5; j++) {
        const coh = (A.re[j] ** 2 + A.im[j] ** 2) / Math.max(1e-30, A.xx[j] * A.yy[j]);
        const coh0 = (A.br[j] ** 2 + A.bi[j] ** 2) / Math.max(1e-30, A.xx[j] * A.by[j]);
        if (coh < RULES.minCoherence || coh0 < RULES.minCoherence || A.xx[j] < 1e-6) continue;
        const re = A.re[j] * A.br[j] + A.im[j] * A.bi[j], im = A.im[j] * A.br[j] - A.re[j] * A.bi[j];
        const delay = -1000 * Math.atan2(im, re) / (2 * Math.PI * (10 + 5 * j));
        const loss = -db(A.re[j] ** 2 + A.im[j] ** 2, A.br[j] ** 2 + A.bi[j] ** 2);
        if (delay > maxAddMs) { maxAddMs = delay; at = { axis: A.axis, profile: A.profile, hz: 10 + j * 5, path: A.path }; }
        maxLossDb = Math.max(maxLossDb, loss); checks++;
    } });
    const values = [...byUnit.values()].map(u => db(u.c, u.b)), st = stats(values);
    const delta = axes.slice(0, 3).map((a, i) => ({ axis: AXES[i], db: db(a.c, a.b), pidDb: db(a.pc, a.pb), se: null }));
    const valid = checks >= 3 && maxAddMs <= limits.maxAddMs && maxLossDb <= RULES.maxControlLossDb && delta.every(a => a.db <= RULES.maxAxisWorseDb);
    return { db: st.mean, se: st.se, axes: delta, units: values, n: values.length, valid,
        delay: { maxAddMs: round(maxAddMs,6), maxLossDb: round(maxLossDb), checks, at, f11BaseMs: null, f11MaxMs: null } };
}

function parity(base, P) {
    const groups = new Map();
    for (const r of base.results) {
        const k = `${r.w.seg.file}:${r.w.seg.log}`; let g = groups.get(k);
        if (!g) groups.set(k, g = { log: r.w.seg.log, seconds: 0, axes: {}, agg: AXES.map(() => ({ observed: [0, 0, 0, 0], predicted: [0, 0, 0, 0], raw: [0, 0, 0, 0], error: 0, n: 0, windows: 0, heldError:0, priorError:0, heldSamples:0,
            spectrum: Object.fromEntries(['raw', 'logged', 'predicted', 'matchRe', 'matchIm'].map(k => [k, new Float64Array(r.w.N / 2 + 1)])), df: r.w.rate / r.w.N })) });
        g.seconds += r.w.N / r.w.rate;
        for (let a = 0; a < 3; a++) {
            const w = r.w, A = g.agg[a], raw = w.seg.raw[a].subarray(w.st - w.lead, w.st + w.N), logged = w.seg.filt[a].subarray(w.st - w.lead, w.st + w.N);
            const S = spectrum(raw, logged, w.lead, w.N, w.rate), df = w.rate / w.N;
            for (let k = 0; k < S.y.length; k++) {
                const sp = A.spectrum, obs = r.m[a].observation || r.m[a].S; sp.raw[k] += S.raw[k]; sp.logged[k] += S.y[k]; sp.predicted[k] += obs.y[k];
                const matching = r.m[a].matching;
                if (matching) { sp.matchRe[k] += matching.re[k]; sp.matchIm[k] += matching.im[k]; }
            }
            for (let k = Math.ceil(30 / df); k <= Math.floor(w.N / 2 * RULES.nyquistShare); k++) {
                const band = Math.min(3, Math.max(0, Math.floor(Math.log2(k * df / 30))));
                A.observed[band] += S.y[k] * df; A.predicted[band] += (r.m[a].observation || r.m[a].S).y[k] * df; A.raw[band] += S.raw[k] * df;
            }
            A.error += r.m[a].error; A.n += w.N; A.windows++;
            const diag=w.input&&w.input.diagnostics, val=diag&&diag.validation&&diag.validation[a];
            if(val&&diag.heldoutEvery) {A.heldError+=r.m[a].heldError;A.priorError+=val.priorError;A.heldSamples+=r.m[a].heldSamples;}
        }
    }
    for (const g of groups.values()) {
        for (let a = 0; a < 3; a++) {
            const A = g.agg[a], errors = A.observed.map((v, i) => v > A.windows * 0.15 ? db(A.predicted[i], v) : null).filter(v => v !== null);
            const max = errors.length ? Math.max(...errors.map(Math.abs)) : 0;
            const sp = A.spectrum, delays = [], lineErrors = [];
            for (let k = Math.ceil(10 / A.df); k <= Math.floor(30 / A.df); k++) {
                // This checks agreement between two outputs, not system
                // identification from gyroRAW. Adaptive notches need not keep
                // the raw/output coherence of a time-invariant filter.
                const coh = (sp.matchRe[k] ** 2 + sp.matchIm[k] ** 2) / Math.max(1e-30, sp.predicted[k] * sp.logged[k]);
                if (coh < RULES.minCoherence || sp.logged[k] / A.windows < 0.001) continue;
                const phase = Math.atan2(sp.matchIm[k], sp.matchRe[k]);
                delays.push(-phase * 1000 / (2 * Math.PI * k * A.df));
            }
            for (let k = Math.ceil(30 / A.df) + 3; k < (sp.raw.length - 3) * RULES.nyquistShare; k++) {
                if (!(sp.raw[k] > sp.raw[k - 1] && sp.raw[k] > sp.raw[k + 1] && sp.raw[k] > 5 * median([sp.raw[k - 3], sp.raw[k + 3], sp.raw[k - 2], sp.raw[k + 2]]))) continue;
                let observed = 0, predicted = 0; for (let j = k - 2; j <= k + 2; j++) { observed += sp.logged[j]; predicted += sp.predicted[j]; }
                if (observed * A.df / A.windows > 0.15) lineErrors.push(Math.abs(db(predicted, observed)));
            }
            const delayError = median(delays), lineError = median(lineErrors);
            const reconstructionDb = A.heldSamples ? db(A.heldError,Math.max(A.priorError,A.heldSamples/6)) : null;
            g.axes[AXES[a]] = { passed: max <= RULES.parityDb && A.windows >= RULES.minWindows && (lineError === null || lineError <= RULES.parityDb) && (delayError !== null && Math.abs(delayError) <= RULES.parityDelayMs) && (reconstructionDb===null||reconstructionDb<=RULES.parityDb),
                windows: A.windows, maxBandErrorDb: round(max), medianLineErrorDb: round(lineError), maxLineErrorDb: lineErrors.length ? round(Math.max(...lineErrors)) : null,
                delayErrorMs: round(delayError), delayMeasuredMs: null, delayPredictedMs: null, rmseDegS: round(Math.sqrt(A.error / A.n)), bandErrorsDb: errors.map(x => round(x)),
                reconstruction: A.heldSamples ? { samples:A.heldSamples, withheldRmsDegS:round(Math.sqrt(A.heldError/A.heldSamples)), interpolationRmsDegS:round(Math.sqrt(A.priorError/A.heldSamples)), errorChangeDb:round(reconstructionDb), passed:reconstructionDb<=RULES.parityDb } : null };
        }
        g.passed = AXES.every(a => g.axes[a].passed); delete g.agg;
    }
    return [...groups.values()];
}

function capabilities(P) {
    const available = P.segments.length > 0, ratio = available && P.segments.every(s => s.ratio);
    return [
        { names: 'gyro_lpf1_type, gyro_lpf1_static_hz, gyro_lpf2_type, gyro_lpf2_static_hz', status: 'In analysis', detail: 'All ten filter types, with NONE, and cutoff values.' },
        { names: 'gyro_notch1_hz, gyro_notch1_cutoff, gyro_notch2_hz, gyro_notch2_cutoff', status: 'In analysis', detail: 'The two notch filters, their frequencies, their Q values, and OFF.' },
        { names: 'DYN_NOTCH, dyn_notch_count, dyn_notch_q, dyn_notch_min_hz, dyn_notch_max_hz', status: 'In analysis', detail: 'ON and OFF, count, Q, and frequency limits.' },
        { names: 'RPM_FILTER, gyro_rpm_notch_preset, gyro_rpm_notch_min_hz, gyro_rpm_notch_source_*, gyro_rpm_notch_q_*, gyro_rpm_notch_center_*', status: 'In analysis', detail: 'Presets and all 16 banks for each axis, with known RPM sources.' },
        { names: 'gyro_lpf1_dyn_min_hz, gyro_lpf1_dyn_max_hz', status: ratio ? 'In analysis' : 'Missing setting', detail: ratio ? 'The cutoff follows the full headspeed ratio from the governor replay.' : 'The governor mode, RPM cutoffs and full profile headspeed are necessary to calculate this ratio.' },
        { names: '*_gyro_cutoff, *_d_cutoff', status: 'With known PID values', detail: 'The app uses each PID profile with known values and a known PID profile number.' },
        { names: 'gyro_decimation_hz', status: available && P.segments.every(s => Number.isFinite(s.cfg.s.gyro_decimation_hz)) ? 'In analysis' : 'Missing setting', detail: 'The app reconstructs the input to the firmware Bessel filter, then runs each new cutoff at the gyro rate.' },
        { names: 'gyro_hardware_lpf, gyro_to_use, gyro_sync_denom, filter_process_denom, pid_process_denom', status: 'No change', detail: 'The replay uses the recorded sensor and scheduler configuration.' },
        { names: 'motor_rpm_lpf', status: available && P.segments.every(s => s.cfg.s.motor_rpm_lpf) ? 'In analysis' : 'Missing setting', detail: 'With the recorded cutoff values, the app reconstructs motor RPM and tests new Bessel cutoffs.' },
        { names: 'esc_sensor_filter_cutoff', status: 'No change', detail: 'The ESC protocol and its update times are not recorded in these flight logs.' },
        { names: '*_b_cutoff, setpoint_boost_cutoff, iterm_relax_cutoff, offset_flood_relax_cutoff, *_precomp_cutoff, cyclic_cross_coupling_cutoff, yaw_dynamic_deadband_*', status: 'Other signals', detail: 'These filters change control commands or the I-term. Gyro replay cannot calculate their flight response.' },
        { names: 'acc_lpf_hz, gov_*_filter, vbat_lpf_hz, ibat_lpf_hz, *_cutoff (ADC), position_*_lpf, rssi_src_frame_lpf_period, input_filtering_mode', status: 'Other signals', detail: 'These filter other sensors or control loops. They do not filter the gyro feedback signal.' }
    ];
}

function candidates(P, current = {}) {
    const ref = settings(P.ref, current), s = ref.s, out = [], seen = new Set(), add = (family, change) => {
        const c = Object.assign({}, current, change), k = key(c);
        if (seen.has(k)) return; seen.add(k);
        if (invalid(P, c).length) return;
        out.push({ family, changes: c });
    };
    if (P.segments.every(seg => Number.isFinite(seg.cfg.s.gyro_decimation_hz))) for (const hz of [0, 150, 200, 250, 300, 350, 400, 500, 600, 800, 1000]) add('gyro decimation', { gyro_decimation_hz: hz });
    if (s.motor_rpm_lpf && P.segments.every(seg => seg.cfg.s.motor_rpm_lpf)) for (const hz of [10, 25, 50, 75, 100, 150, 200, 250]) {
        const values = s.motor_rpm_lpf.slice(); values[0] = hz;
        if (ref.gear && ref.gear.motorisedTail) values[1] = hz;
        add('motor RPM lowpass', { motor_rpm_lpf: values });
    }
    for (const slot of [1, 2]) {
        const type = `gyro_lpf${slot}_type`, hz = `gyro_lpf${slot}_static_hz`;
        add('lowpass', { [type]: 0 });
        for (let t = 1; t < FT.FW.LPF.length; t++) for (const f of [40, 60, 80, 100, 130, 170, 230, 320, 450, 700, 1000])
            add('lowpass', { [type]: t, [hz]: f, ...(slot === 1 ? { gyro_lpf1_dyn_min_hz: 0, gyro_lpf1_dyn_max_hz: 0 } : {}) });
    }
    add('dynamic notch', { DYN_NOTCH: false });
    add('dynamic notch', { dyn_notch_count: 0 });
    for (const count of [1, 2, 3, 4, 6, 8]) for (const q of [10, 20, 30, 50, 80, 100])
        add('dynamic notch', { DYN_NOTCH: true, dyn_notch_count: count, dyn_notch_q: q });
    for (const lo of [10, 20, 40, 70, 100, 150, 200]) for (const hi of [100, 180, 240, 350, 500]) if (hi > lo)
        add('dynamic notch', { DYN_NOTCH: true, dyn_notch_min_hz: lo, dyn_notch_max_hz: hi });
    add('RPM', { RPM_FILTER: false });
    for (const p of [1, 2, 3]) add('RPM', { RPM_FILTER: true, gyro_rpm_notch_preset: p });
    for (const f of [1, 10, 15, 20, 30, 50, 75, 100]) add('RPM', { gyro_rpm_notch_min_hz: f });
    const banks = FT.effectiveBanks(s), bankChanges = B => Object.assign({ RPM_FILTER: true, gyro_rpm_notch_preset: 0 },
        ...AXES.flatMap((ax, a) => ['source', 'q', 'center'].map(k => ({ [`gyro_rpm_notch_${k}_${ax}`]: Array.from({ length: 16 }, (_, j) => B[a][j] ? B[a][j][k] : 0) }))));
    if (banks.every(Boolean)) for (let a = 0; a < 3; a++) {
        banks[a].forEach((b, j) => {
            for (const q of [10, 20, 30, 50, 80, 120, 180, 250]) { const B = clone(banks); B[a][j].q = q; add('RPM banks', bankChanges(B)); }
            for (const center of [-150, -50, 0, 50, 150]) { const B = clone(banks); B[a][j].center = center; add('RPM centers', bankChanges(B)); }
            const B = clone(banks); B[a].splice(j, 1); add('RPM banks', bankChanges(B));
        });
        if (banks[a].length < 16) for (const src of [10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 21, 22, 23, 24, 25, 26, 27, 28]) {
            if (banks[a].some(b => b.source === src)) continue;
            const B = clone(banks); B[a].push({ source: src, q: 60, center: 0 }); add('RPM banks', bankChanges(B));
        }
    }
    // Proposals can use the raw spectrum. No proposal is ranked until replay.
    const peaks = [];
    for (const r of P.trainingBase.results) for (const m of r.m) {
        const S = m.nativeSpectrum ? m.nativeSpectrum.gyro : m.S.raw, df = m.nativeSpectrum ? m.nativeSpectrum.df : r.w.rate / r.w.N;
        for (let k = Math.ceil(30 / df); k < S.length * 0.8 - 1; k++) if (S[k] > S[k - 1] && S[k] > S[k + 1]) peaks.push({ hz: Math.round(k * df), power: S[k] });
    }
    peaks.sort((a, b) => b.power - a.power); const centers = [];
    for (const p of peaks) if (!centers.some(f => Math.abs(f - p.hz) < 8) && centers.length < 5) centers.push(p.hz);
    // Enable the tracker with a useful range in the SAME move. Coordinate-only
    // search cannot reach a resonance outside the currently disabled range.
    for (const f of centers) for (const count of [1, 2, 4]) for (const q of [30, 60, 100]) {
        const dyn = { DYN_NOTCH: true, dyn_notch_count: count, dyn_notch_q: q,
            dyn_notch_min_hz: clamp(Math.floor((f - 45) / 10) * 10, 40, 200), dyn_notch_max_hz: clamp(Math.ceil((f + 50) / 10) * 10, 100, 500) };
        add('dynamic design', dyn);
        for (const hz of [100, 200, 400]) add('combined', { ...dyn, gyro_lpf1_type: 1, gyro_lpf1_static_hz: hz, gyro_lpf1_dyn_min_hz: 0, gyro_lpf1_dyn_max_hz: 0 });
    }
    for (const slot of [1, 2]) {
        add('static notch', { [`gyro_notch${slot}_hz`]: 0, [`gyro_notch${slot}_cutoff`]: 0 });
        for (const f of centers) for (const q of [1, 2, 3, 5, 8, 15, 25]) add('static notch', { [`gyro_notch${slot}_hz`]: f, [`gyro_notch${slot}_cutoff`]: FT.notchCutoffFor(f, q) });
    }
    if (P.segments.every(s => s.ratio)) for (const min of [30, 60, 90, 120]) for (const max of [150, 250, 400, 700])
        add('dynamic lowpass', { gyro_lpf1_type: s.gyro_lpf1_type || 1, gyro_lpf1_static_hz: clamp(s.gyro_lpf1_static_hz || 100, min, max), gyro_lpf1_dyn_min_hz: min, gyro_lpf1_dyn_max_hz: max });
    const pp = new Map();
    for (const w of P.windows) if (!w.held && w.profile > 0) pp.set(w.profile, w);
    for (const [p, w] of pp) paths(w, current).forEach((path, a) => {
        if (!path.known) return;
        for (const kind of ['gyro', 'd']) {
            if (kind === 'd' && !(path.Kd > 0)) continue;
            for (const hz of kind === 'gyro' ? [0, 10, 20, 30, 40, 60, 80, 120, 180, 250] : [10, 20, 30, 40, 60, 80, 120, 180, 250])
                add('PID cutoffs', { [pidKey(p, AXES[a], kind)]: hz });
        }
    });
    // Round-robin families, and uniformly cover each family's parameter grid.
    const families = [...new Set(out.map(x => x.family))], interleaved = [];
    const lists = families.map(f => out.filter(x => x.family === f));
    for (let j = 0; j < Math.max(...lists.map(l => l.length)); j++) for (const list of lists) if (j < list.length) {
        // Multiplication by a coprime stride spreads types, axes and banks.
        let stride = 37; while (gcd(stride, list.length) !== 1) stride++;
        interleaved.push(list[(j * stride) % list.length]);
    }
    return interleaved;
}
function gcd(a, b) { while (b) { const t = b; b = a % b; a = t; } return a; }

function invalid(P, changes) {
    const why = [];
    for (const [k, v] of Object.entries(changes)) {
        const range = FT.FW_RANGE[k] || (/^p\d+:.+_gyro_cutoff$/.test(k) ? [0, 250] : /^p\d+:.+_d_cutoff$/.test(k) ? [1, 250] : /^gyro_lpf1_dyn_/.test(k) ? [0, 1000] : null);
        if (range && (!Number.isInteger(v) || v < range[0] || v > range[1])) why.push(k);
    }
    for (const seg of P.segments) {
        const c = settings(seg.cfg, Object.assign({}, P.ref.s, changes)), s = c.s, M = FT.compile(c);
        if (M.leftOut.length || (M.dynLpf && !seg.ratio)) why.push('missing input');
        for (const slot of [1, 2]) if (s[`gyro_lpf${slot}_static_hz`] > Math.min(1000, 0.45 * c.rates.filterHz)) why.push('cutoff above firmware limit');
        // validateAndFixGyroConfig clamps a nonzero decimator to 100 Hz ..
        // round(0.3 * sensor rate). Do not evaluate a value that boot changes.
        if (s.gyro_decimation_hz && (s.gyro_decimation_hz < 100 || s.gyro_decimation_hz > Math.round(0.3 * c.rates.gyroHz))) why.push('decimation cutoff outside firmware rate limits');
        if (s.dyn_notch_min_hz >= s.dyn_notch_max_hz) why.push('dynamic notch range');
    }
    return why;
}

function validCliRow(r) {
    if (r.name === 'motor_rpm_lpf') { const values = String(r.to).split(',').map(Number); return values.length === 4 && values.every(x=>Number.isInteger(x)&&x>=0&&x<=255); }
    if (r.name === 'feature RPM_FILTER' || r.name === 'feature DYN_NOTCH') return typeof r.to === 'boolean';
    if (/^gyro_lpf[12]_type$/.test(r.name)) return FT.FW.LPF.includes(r.to);
    const array = /^gyro_rpm_notch_(source|q|center)_(roll|pitch|yaw)$/.exec(r.name);
    if (array) {
        const values = String(r.to).split(',').map(Number);
        return values.length === 16 && values.every(x => Number.isInteger(x) && (array[1] === 'source' ? x === 0 || x >= 10 && x <= 18 || x >= 20 && x <= 28 : array[1] === 'q' ? x >= 0 && x <= 255 : x >= -32768 && x <= 32767));
    }
    const range = FT.FW_RANGE[r.name] || (/^gyro_lpf1_dyn_(min|max)_hz$/.test(r.name) ? [0, 1000] : /^(roll|pitch|yaw)_(gyro|d)_cutoff$/.test(r.name) ? [0, 250] : null);
    return !!range && Number.isInteger(r.to) && r.to >= range[0] && r.to <= range[1] && (r.scope !== 'profile' || Number.isInteger(r.profile) && r.profile >= 1 && r.profile <= 6);
}

function sample(wins, n) {
    if (wins.length <= n) return wins.slice();
    // Even coverage of flight, profile, headspeed and time, with no randomness.
    const order = wins.slice().sort((a, b) => a.seg.id - b.seg.id || a.profile - b.profile || a.hs - b.hs || a.st - b.st);
    return Array.from({ length: n }, (_, j) => order[Math.floor((j + 0.5) * order.length / n)]);
}

function rowsFor(P, changes, full = false) {
    const rows = [], ref = P.ref;
    const all = full ? Object.assign({}, ref.s, P.targetProfiles, changes) : changes;
    for (const [k, v] of Object.entries(all)) {
        const pm = /^p(\d+):(roll|pitch|yaw)_(gyro|d)_cutoff$/.exec(k);
        if (pm) {
            const p = +pm[1], w = P.windows.slice().reverse().find(w => w.profile === p && paths(w, {})[AXES.indexOf(pm[2])].known);
            if (!w) continue;
            const from = paths(w, {})[AXES.indexOf(pm[2])][`${pm[3]}_cutoff`];
            if (full || from !== v) rows.push({ name: k.slice(k.indexOf(':') + 1), from, to: v, scope: 'profile', profile: p, source: p === w.seg.firstProfile ? 'header' : 'cli' });
        } else {
            if (v === null || v === undefined) continue;
            const writeBank = changes.gyro_rpm_notch_preset === 0 && ref.s.gyro_rpm_notch_preset !== 0 && /^gyro_rpm_notch_(source|q|center)_/.test(k);
            if (!full && !writeBank && same(ref.s[k], v)) continue;
            const feat = ['RPM_FILTER', 'DYN_NOTCH'].includes(k);
            rows.push({ name: feat ? `feature ${k}` : k, from: publicValue(k, ref.s[k]), to: publicValue(k, v), scope: 'global', source: ref.from[k] });
        }
    }
    return rows;
}
function commands(rows) {
    const out = [], global = rows.filter(r => r.scope === 'global');
    for (const r of global) out.push(r.name.startsWith('feature ') ? `feature ${r.to ? '' : '-'}${r.name.slice(8)}` : `set ${r.name} = ${r.to}`);
    for (const p of [...new Set(rows.filter(r => r.scope === 'profile').map(r => r.profile))].sort()) {
        out.push(`profile ${p - 1}`);
        for (const r of rows.filter(r => r.profile === p)) out.push(`set ${r.name} = ${r.to}`);
    }
    return out;
}

function cliFile(res, meta = {}) {
    if (!res.model.passed || res.recommended.status !== 'recommended') return '';
    if ((meta.recommendations || res.recommendations || []).some(r => (r.blockedBy || []).length)) return '';
    const rows = res.recommended.fullRows || res.recommended.rows, clean = x => String(x == null ? '' : x).replace(/[^\x20-\x7e]/g, '_');
    // Keep the complete provenance without exceeding the firmware CLI line
    // buffer. Sanitize first, then prefix every wrapped line as a comment.
    const comment = text => {
        let rest = clean(text); const lines = [];
        while (rest.length > 190) {
            const space = rest.lastIndexOf(' ', 190), end = space > 0 ? space : 190;
            lines.push('# ' + rest.slice(0, end)); rest = rest.slice(end).trimStart();
        }
        lines.push('# ' + rest); return lines;
    };
    if (rows.some(r => !['header', 'cli'].includes(r.source) || !validCliRow(r))) return '';
    const profiles = [...new Set(rows.filter(r => r.scope === 'profile').map(r => r.profile))];
    const boot = meta.bootProfile || res.bootProfile;
    if (profiles.length && !(boot >= 1 && boot <= 6)) return '';
    const out = ['# Save the output of diff all before loading this file.', '# Rotorflight filter autotune',
        ...comment('Craft: ' + (meta.craft || res.craft || '')), ...comment('File: ' + (meta.fileName || res.fileName || '')),
        ...comment('Firmware: ' + (res.firmware || '')), ...comment('Generated: ' + (meta.date || new Date().toISOString())),
        ...comment(res.selection && res.selection.text || 'Flight data: ' + (res.logs || []).map(li=>'log '+(li+1)).join(', ')),
        ...comment('Recorded configurations: ' + (res.recordedConfigurations && res.recordedConfigurations.length ?
            [...new Set(res.recordedConfigurations.map(q=>q.id || 'unknown'))].join(', ') : res.configuration ? res.configuration.id : 'selected flight inputs')),
        '# PID profiles: ' + (profiles.length ? profiles.join(', ') : 'global filters only'),
        '# Replay noise change: ' + res.recommended.predicted.totalDb + ' dB',
        '# Maximum added time delay: ' + delayLimit(res.limits && res.limits.maxAddMs) + ' ms.',
        res.mode==='simulation' ? '# Rule: replay agreement and the delay, gain-loss and per-axis noise limits.'
            : '# Rule: replay agreement, noise reduction, control-band delay and reserved flight periods.',
        '# This replay predicts filtering of the recorded input. It does not predict a new closed-loop flight.'];
    if (res.model.reconstructed) out.push('# Firmware multichannel reconstruction; every fifth gyro output was reserved for validation.');
    for(const q of res.recordedConfigurations || [])out.push(...comment('Log '+(q.log+1)+', '+q.t0.toFixed(2)+' to '+q.t1.toFixed(2)+' s: configuration '+(q.id||'unknown')+', PID profile '+(q.profile||'unknown')+'.'));
    for (const rec of meta.recommendations || res.recommendations || []) if (rec.stale) out.push(...comment('Values possibly not current: ' + rec.stale.text));
    out.push('batch start');
    let p = null;
    for (const row of rows) {
        if (row.scope === 'profile' && p !== row.profile) { p = row.profile; out.push(`profile ${p - 1}`); }
        out.push(...comment(clean(row.name) + ': ' + clean(row.from) + ' -> ' + clean(row.to)));
        if (row.stale) out.push(...comment('Values possibly not current: ' + row.stale.text));
        out.push(row.name.startsWith('feature ') ? `feature ${row.to ? '' : '-'}${row.name.slice(8)}` : `set ${row.name} = ${row.to}`);
    }
    if (profiles.length) out.push(`profile ${boot - 1}`);
    out.push('save', '');
    return out.join('\n');
}

function curves(base, cand) {
    if (!base.results.length) return null;
    const first = base.results[0].w, K = first.N / 2 + 1, f = Float64Array.from({ length: K }, (_, k) => k * first.rate / first.N), out = { f, windows: 0 };
    const cb = new Map(cand.results.map(r => [r.w.id, r]));
    for (const ax of AXES) out[ax] = Object.fromEntries(['raw', 'logged', 'predicted', 'candidate', 'pidOut', 'pidOutCandidate'].map(k => [k, new Float64Array(K)]));
    for (const b of base.results) {
        if (b.w.rate !== first.rate || b.w.N !== first.N) continue;
        const c = cb.get(b.w.id); if (!c) continue;
        out.windows++;
        AXES.forEach((ax, a) => {
            const w = b.w, L = spectrum(w.seg.raw[a], w.seg.filt[a], w.st, w.N, w.rate).y;
            const src = { raw: b.m[a].S.raw, logged: L, predicted: b.m[a].S.y, candidate: c.m[a].S.y, pidOut: b.m[a].P, pidOutCandidate: c.m[a].P };
            for (const [k, y] of Object.entries(src)) for (let j = 0; j < K; j++) out[ax][k][j] += y[j] * (k.startsWith('pid') ? 1e6 : 1);
        });
    }
    for (const ax of AXES) for (const y of Object.values(out[ax])) for (let k = 0; k < K; k++) y[k] /= out.windows || 1;
    return out;
}

function delayLimit(value) {
    if (value === undefined || value === null) return RULES.maxAddMs;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 20)
        throw Error('The maximum added delay must be a number from 0 to 20 ms.');
    return value;
}

function parameterTable(P, changes = {}) {
    const DS = require('./datasets.cjs'), last = P.segments[P.segments.length - 1], h = last.w.flight.header;
    const rows = rowsFor(P, changes, true).map(row => {
        const key = row.scope === 'profile' ? `p${row.profile}:${row.name}` : row.name.replace(/^feature /, '');
        const choices = /^gyro_lpf[12]_type$/.test(key) ? FT.FW.LPF.slice() : /^feature /.test(row.name) ? [false, true] : null;
        const count = /^gyro_rpm_notch_(source|q|center)_/.test(key) ? 16 : key === 'motor_rpm_lpf' ? 4 : null;
        return { ...row, key, choices, count, editable: ['header','cli'].includes(row.source),
            range: FT.FW_RANGE[key] || (/^p\d+:/.test(key) ? [/_d_cutoff$/.test(key) ? 1 : 0,250] : null) };
    });
    for (const [key,value] of Object.entries(P.ref.s)) if (value == null)
        rows.push({key,name:key,scope:'global',from:null,to:null,editable:false,reason:'The recorded value is unknown.'});
    const recorded = DS.headerValues(h).values, seen = new Set(rows.map(row=>row.key));
    const reference = (key,name,scope,profile,value,reason) => {
        if (seen.has(key)) return;
        seen.add(key); rows.push({key,name,scope,profile,from:value == null ? null : value,to:value == null ? null : value,editable:false,reason});
    };
    for (const name of ['gyro_hardware_lpf','gyro_to_use','gyro_sync_denom','filter_process_denom','pid_process_denom','esc_sensor_filter_cutoff']) {
        const value = recorded[name] === undefined ? h[name] === undefined ? P.cli && P.cli.global[name] : h[name] : recorded[name];
        reference(name,name,'global',null,value,'The replay retains this sensor or timing setting.');
    }
    for (const w of P.windows) for (const ax of AXES) for (const kind of ['gyro','d']) {
        const name=ax+'_'+kind+'_cutoff', p=paths(w,{})[AXES.indexOf(ax)];
        reference(pidKey(w.profile,ax,kind),name,'profile',w.profile,p[kind+'_cutoff'],'The recorded PID path is incomplete. Its cutoffs stay unchanged.');
    }
    const values = {...(P.cli && P.cli.global || {}),...recorded,...(P.opts.configuration && P.opts.configuration.values || {})};
    for (const name of new Set([...DS.table().filter(row=>!row.pattern).map(row=>row.name),...Object.keys(values)])) {
        if (!/(cutoff|_lpf|_filter|_notch)/.test(name) || /_cutoff_percent$/.test(name)) continue;
        if (/^gyro_rpm_filter_bank_/.test(name) && !Object.keys(values).some(key=>key===name || key.startsWith(name+'['))) continue;
        const scope=DS.scopeOf(name), profile=scope==='profile' ? last.firstProfile : null, key=profile ? 'p'+profile+':'+name : name;
        if (seen.has(key.replace(/\[\d+\]$/,''))) continue;
        const count={iterm_relax_cutoff:3,setpoint_boost_cutoff:4}[name], array=count && Array.from({length:count},(_,i)=>values[name+'['+i+']']);
        const value=values[name] == null && array && array.every(v=>v!=null) ? array : values[name];
        reference(key,name,scope,profile,value,'This filter belongs to another signal path. The gyro replay retains its recorded value.');
    }
    return rows;
}

function manualChanges(P, supplied) {
    if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)) throw Error('The edited filter values are not valid.');
    const schema = new Map(parameterTable(P).map(r=>[r.key,r])), changes = {};
    for (const [key,value] of Object.entries(supplied)) {
        const row=schema.get(key);
        if (!row || !row.editable) throw Error('This filter value cannot be edited: '+key);
        let v=value;
        if (row.choices) {
            if (/^gyro_lpf/.test(key)) v=typeof v === 'number' ? v : FT.FW.LPF.indexOf(v);
            else if (v === 'true' || v === 'false') v=v === 'true';
        } else if (row.count) {
            if (typeof v === 'string') {
                if (!v.split(',').every(x=>/^-?\d+$/.test(x.trim()))) throw Error('The filter array must contain integers: '+key);
                v=v.split(',').map(Number);
            }
            if (!Array.isArray(v)) throw Error('The filter array is not valid: '+key);
        } else {
            if (typeof v === 'string' && !/^-?\d+$/.test(v.trim())) throw Error('The filter value must be an integer: '+key);
            if (typeof v === 'string') v=Number(v);
        }
        if (!validCliRow({...row,to:publicValue(key,v)})) throw Error('The filter value is outside its firmware range: '+key);
        changes[key]=v;
    }
    const errors=invalid(P,changes);
    if (errors.length) throw Error('The edited configuration cannot be replayed: '+[...new Set(errors)].join(', '));
    return Object.assign({},P.ref.s,P.targetProfiles,changes);
}

function tune(items, opts = {}) {
    const started = Date.now(), progress = (text, fraction) => { if (opts.progress) opts.progress(text, fraction); };
    progress('The app prepares the flight samples.', 0.02);
    const limits = { maxAddMs: delayLimit(opts.maxAddMs) }, judge = (a,b) => compare(a,b,limits), manual = opts.simulate !== undefined;
    const P = opts.prepared || prepare(items, opts);
    P.evaluations=0; P.samples=0;
    const result = { version: 2, mode: manual ? 'simulation' : 'autotune', limits, method: 'constrained successive halving, firmware-rate time-domain replay',
        capabilities: capabilities(P), bench: P.excluded, notes: P.notes, model: { passed: false, parity: [], leftOut: [], rules: { bandDb: RULES.parityDb, delayMs: RULES.parityDelayMs } },
        recommended: { status: 'no flight log', reasons: [], rows: [], cli: [], validation: {} }, curves: null,
        units: { kind: 'block', n: P.units.length }, tailFit: P.fit ? Object.assign({}, P.fit, { used: P.segments.some(s => s.cfg.gear && s.cfg.gear.source === 'log notch') }) : null };
    if (!P.windows.length) { result.recommended.reasons.push('There are no complete flight windows with the required filter inputs.'); result.ms = { total: Date.now() - started }; return result; }
    const training = P.windows.filter(w => !w.held), heldout = P.windows.filter(w => w.held);
    const short = sample(training, opts.screenWindows || 8), medium = sample(training, 24);
    let reconstructedWindows=0;
    if (!P.reconstructed) for (const seg of P.segments) reconstruct.reconstructWindows(seg,P.windows.filter(w=>w.seg===seg),()=>{
        reconstructedWindows++;
        if(reconstructedWindows%8===0||reconstructedWindows===P.windows.length)progress(`The app calculates gyro samples for flight window ${reconstructedWindows} of ${P.windows.length}.`,0.03+0.07*reconstructedWindows/P.windows.length);
    });
    P.reconstructed=true;
    if (opts.onPrepared) opts.onPrepared(P);
    const edited=manual ? manualChanges(P,opts.simulate) : null;
    const baseShort = evaluate(P, {}, short), baseMedium = evaluate(P, {}, medium);
    P.trainingBase = baseShort;
    const ref = P.ref, budget = opts.budgetMs || RULES.budgetMs, searchStart = Date.now();
    const tried = [], seen = new Set(), finalists = [], maxCandidates = opts.maxCandidates || RULES.maxCandidates;
    let proposals = manual ? [] : candidates(P), incumbent = {}, timedOut = false;
    for (let roundNo = 0; !manual && roundNo < 3; roundNo++) {
        const scored = [];
        for (const proposal of proposals.slice(0, maxCandidates)) {
            const k = key(proposal.changes); if (seen.has(k)) continue; seen.add(k);
            if (Date.now() - searchStart > budget) { timedOut = true; break; }
            let c, sc;
            try { c = evaluate(P, proposal.changes, short); sc = judge(c, baseShort); } catch (e) { tried.push({ family: proposal.family, reason: String(e.message) }); continue; }
            tried.push({ family: proposal.family, db: round(sc.db), valid: sc.valid });
            if (sc.valid && sc.db < -0.05) scored.push({ ...proposal, score: sc });
            if (tried.length % 10 === 0) progress(`The app replayed ${tried.length} filter sets.`, Math.min(0.65, 0.1 + 0.55 * (Date.now() - searchStart) / budget));
        }
        scored.sort((a, b) => a.score.db - b.score.db);
        const promoted = [];
        for (const q of scored.slice(0, 12)) { const ev = evaluate(P, q.changes, medium), sc = judge(ev, baseMedium); if (sc.valid) promoted.push({ ...q, score: sc }); }
        promoted.sort((a, b) => a.score.db - b.score.db);
        finalists.push(...promoted.slice(0, RULES.finalists).map(q => ({ ...q, round: roundNo })));
        if (!promoted.length || timedOut) break;
        incumbent = promoted[0].changes; proposals = candidates(P, incumbent);
    }
    progress('The app tests the best sets on all training windows.', 0.7);
    const baseTrain = evaluate(P, {}, training, true, true), ranked = [];
    let bestFull = null;
    // Keep a feasible simpler design from each search round. Ranking only the
    // most aggressive refinements can discard every feasible fallback when a
    // sparsely sampled profile exposes extra delay at the full-data stage.
    const ordered = finalists.sort((a, b) => a.score.db - b.score.db), full = [], fullSeen = new Set();
    const addFull = q => { if (q && !fullSeen.has(key(q.changes)) && full.length < RULES.finalists) { fullSeen.add(key(q.changes)); full.push(q); } };
    for (let r = 0; r < 3; r++) addFull(ordered.find(q => q.round === r));
    for (const family of new Set(ordered.map(q => q.family))) addFull(ordered.find(q => q.family === family));
    for (const q of ordered) addFull(q);
    for (const q of full) {
        const ev = evaluate(P, q.changes, training, true, true), sc = judge(ev, baseTrain);
        if (sc.valid) { ranked.push({ ...q, score: sc }); if (!bestFull || sc.db < bestFull.score.db) bestFull = { ...q, score: sc, ev }; }
    }
    ranked.sort((a, b) => a.score.db - b.score.db);
    if (manual) { const ev=evaluate(P,edited,training,true,true); bestFull={changes:edited,score:judge(ev,baseTrain),ev}; }
    const chosen = bestFull || { changes: {}, score: judge(baseTrain, baseTrain), ev: baseTrain };
    // The choice is now frozen. Holdout cannot select a different candidate.
    progress('The app checks the fixed set on the reserved flight periods.', 0.9);
    const baseHeld = evaluate(P, {}, heldout, true, true), testHeld = evaluate(P, chosen.changes, heldout, true, true), hold = judge(testHeld, baseHeld);
    const improvedBlocks = hold.units.filter(d => d < 0).length;
    const holdPassed = hold.valid && hold.db < 0 && improvedBlocks / hold.units.length >= RULES.minHeldoutShare;
    const allBase = { results: baseTrain.results.concat(baseHeld.results) }, allCand = { results: chosen.ev.results.concat(testHeld.results) };
    const par = parity(allBase, P), combined = judge(allCand, allBase), reasons = [];
    const unsupported = P.segments.some(s => s.unsupported);
    if (unsupported) reasons.push('This firmware version has no confirmed replay model.');
    if (new Set(P.segments.map(s => s.w.flight.craft).filter(Boolean)).size > 1) reasons.push('The selected logs contain more than one helicopter.');
    if (P.excluded.length) reasons.push('Some selected logs cannot be replayed with their recorded filter inputs.');
    if (!par.every(p => p.passed)) reasons.push('The recorded filter configuration does not agree with the replay on all axes.');
    if (P.units.length < RULES.minUnits || heldout.length < RULES.minWindows) reasons.push('There are not sufficient flight periods to select the values and test them with different data.');
    if (!manual && !(chosen.score.db <= -RULES.minReductionDb)) reasons.push('No tested set decreases vibration by 3 dB or more within the time delay and control-band limits.');
    if (!manual && !(combined.se !== null && combined.db + 2 * combined.se < 0)) reasons.push('The decrease is not more than two standard errors across flight periods.');
    if (!chosen.score.valid || !combined.valid) reasons.push('The proposed values exceed the time delay or control-band limits.');
    if (manual ? !hold.valid : !holdPassed) reasons.push('The selected values do not give a satisfactory result in the different flight periods.');
    const rows = rowsFor(P, chosen.changes), fullRows = rowsFor(P, chosen.changes, true);
    if (fullRows.some(r => !['header', 'cli'].includes(r.source)) || ['RPM_FILTER', 'DYN_NOTCH'].some(k => typeof ref.s[k] !== 'boolean')) reasons.push('Some filter values are not recorded. The app cannot make a complete CLI configuration.');
    if (fullRows.some(r => !validCliRow(r))) reasons.push('The filter configuration contains a value outside the firmware CLI range.');
    const reconstructed = P.segments.some(s => s.cfg.rates.logHz !== s.cfg.rates.filterHz || s.cfg.rates.offsetTicks !== 0);
    const coverage = P.segments.map(s => ({ log: s.log, firmware: s.firmware, gyroHz:s.cfg.rates.gyroHz, logHz: s.cfg.rates.logHz, filterHz: s.cfg.rates.filterHz, pidHz: s.cfg.rates.pidHz,
            rawOffsetUs: s.cfg.rates.offsetTicks / s.cfg.rates.gyroHz * 1e6, schedulerMultiplier:s.cfg.rates.scale, timingCalibration:s.timingCalibration,
            reconstructed: s.cfg.rates.logHz !== s.cfg.rates.filterHz || s.cfg.rates.offsetTicks !== 0 }));
    Object.assign(result, { ms: { total: Date.now() - started, search: Date.now() - searchStart, exactEvaluations: P.evaluations, screened: 0, simulations: P.evaluations, timedOut },
        craft: P.segments[P.segments.length - 1].w.flight.craft || '', fileName: P.segments[P.segments.length - 1].file || '',
        firmware: P.segments[P.segments.length - 1].firmware, bootProfile: P.cli && P.cli.selectedProfile !== null ? P.cli.selectedProfile + 1 : opts.armingProfile || P.segments[P.segments.length - 1].firstProfile || null,
        search: { tested: tried.length, families: [...new Set(tried.map(t => t.family))], finalistCount: ranked.length, replayedSamples: P.samples, trainingWindows: training.length, heldoutWindows: heldout.length },
        current: { settings: ref.s, from: ref.from }, model: { ...result.model, passed: !unsupported && !P.excluded.length && par.every(p => p.passed), parity: par,
            coverage, reconstructed, reconstructionMethod:'firmware multichannel reconstruction', continuousValidation:true, gear: ref.gear,
            observers:P.segments.map(s=>({log:s.log,profiles:s.observers})),
            notes: reconstructed ? ['The app reconstructs gyro samples with the recorded gyro and PID signals. The sample fit omits every fifth gyro output. Finalists run continuously through each log.'] : [] },
        recommended: { status: reasons.length ? 'not recommended' : 'recommended', reasons, params: chosen.changes, rows, fullRows,
            cli: reasons.length ? [] : commands(rows), predicted: { totalDb: round(combined.db), se: round(combined.se), axes: combined.axes }, delay: combined.delay,
            validation: { holdout: { unit: '30 s flight block', blocks: hold.n, windows: heldout.length, meanDb: round(hold.db), se: round(hold.se),
                improvedBlocks, requiredShare: RULES.minHeldoutShare, passed: holdPassed, selectedBeforeHoldout: !manual,
                withinLimits:hold.valid,delay:hold.delay,axes:hold.axes } } },
        curves: opts.curves === false ? null : curves(allBase, allCand), candidates: ranked.map(q => ({ family: q.family, db: round(q.score.db), changes: q.changes })) });
    // One trace per interval/profile; its spectrum uses exactly this window
    // at the recorded sample rate, rather than the flight-wide average.
    result.traces = [];
    for (const b of allBase.results) {
        const w = b.w, traceKey = `${w.seg.id}:${w.profile}`;
        if (result.traces.some(t => t.key === traceKey) || result.traces.length >= 18) continue;
        const c = allCand.results.find(r => r.w.id === w.id); if (!c || !b.trace || !c.trace) continue;
        const t = Float64Array.from({ length: w.N }, (_, i) => w.seg.time ? (w.seg.time[w.st + i] - w.seg.time[0]) / 1e6 + w.seg.fromS : w.seg.fromS + (w.st + i) / w.rate);
        result.traces.push({ key: traceKey, log: w.seg.log, profile: w.profile, configuration:w.seg.w.recordedConfiguration && w.seg.w.recordedConfiguration.id || null, heldout: w.held, t,
            pidKnown: paths(w, {}).every(p => p.known), rate:w.rate,
            spectrum:curves({results:[b]}, {results:[c]}),
            raw: w.seg.raw.map(x => x.slice(w.st, w.st + w.N)), logged: w.seg.filt.map(x => x.slice(w.st, w.st + w.N)),
            baseline: b.trace.y.map(x => x.slice(w.lead)), candidate: c.trace.y.map(x => x.slice(w.lead)),
            pidBaseline: b.trace.out.map(x => Float32Array.from(x.subarray(w.lead), v => v * 1000)), pidCandidate: c.trace.out.map(x => Float32Array.from(x.subarray(w.lead), v => v * 1000)) });
        if(b.trace.native&&c.trace.native) {
            const factor=b.trace.native.factor, nativeStart=w.lead*factor, n=w.N*factor;
            const nt=Float64Array.from({length:n},(_,i)=>t[Math.floor(i/factor)]+(i%factor)/(w.rate*factor*w.seg.cfg.rates.scale)-w.seg.cfg.rates.offsetTicks/w.seg.cfg.rates.gyroHz/w.seg.cfg.rates.scale);
            result.traces[result.traces.length-1].native={t:nt,rate:b.trace.native.rate,
                baseline:b.trace.native.y.map(x=>x.slice(nativeStart)),candidate:c.trace.native.y.map(x=>x.slice(nativeStart)),
                pidBaseline:b.trace.native.out.map(x=>Float32Array.from(x.subarray(nativeStart),v=>v*1000)),pidCandidate:c.trace.native.out.map(x=>Float32Array.from(x.subarray(nativeStart),v=>v*1000))};
        }
    }
    result.parameters=parameterTable(P,chosen.changes);
    progress('The app compares the filter checks before and after replay.',0.97);
    result.checklist=require('./filter_checklist.cjs').compare(P,chosen.changes,{app:opts.app});
    result.checklist.confirmed=result.model.passed;
    progress('The filter replay is complete.', 1);
    result.cliFile = cliFile(result);
    return result;
}

function texts(res) {
    const R = res.recommended, good = R.status === 'recommended', p = R.predicted || {}, h = R.validation && R.validation.holdout;
    const rows = (R.rows || []).map(r => ({ ...r, text: `Set \`${r.name}\` to \`${r.to}\`.` }));
    return { status: R.status, summary: `The app replayed ${res.search ? res.search.tested : 0} filter sets on recorded gyro samples.`,
        recommendation: good && res.mode === 'simulation' ? 'The changed values pass the replay limits. Examine the checks and signals before export.' : good ? `The recommended set decreases the vibration in the replay by ${round(-p.totalDb, 2)} ± ${round(p.se, 2)} dB. Examine all filter values below.` : R.reasons.join('\n'),
        parity: res.model.passed ? 'The recorded configuration agrees with the replay on all measured axes.' : 'The recorded configuration does not agree with the replay on all axes.',
        delay: R.delay ? `The largest measured increase in filter time delay is ${R.delay.maxAddMs} ms. The limit is ${res.limits ? res.limits.maxAddMs : RULES.maxAddMs} ms.` : '',
        validation: h && res.mode === 'simulation' ? 'The changed values use all selected flight periods. These periods are not an independent test after manual changes.' : h ? `The app uses ${h.blocks} flight periods only for the last test. It selects the values with the other periods. These values change vibration by ${h.meanDb} dB in those periods.` : '',
        why: R.reasons, rows };
}

module.exports = { RULES, tune, texts, delayLimit, parameterTable, manualChanges, prepare, paths, settings, evaluate, compare, parity, capabilities, candidates, invalid, rowsFor, commands, cliFile, validCliRow };
