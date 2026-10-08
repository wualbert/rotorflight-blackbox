'use strict';

// Rotorflight release/4.6.0 (118e912): gyro_filter_impl.c, core.c, rpm_filter.c,
// dyn_notch_filter.c, sdft.c, filter.c and pid.c. GPL-3.0, like the firmware.
// Coefficients always use the firmware rate. Missing samples are reconstructed,
// never replaced by a different filter or a frequency-domain output correction.
const FT = require('./filter_tune.cjs');
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const UPDATE_TICK = [0, 0, 1, 2, 2, 2, 3, 4, 5];
const PID_TICK = [0, 0, 0, 0, 0, 0, 1, 1, 2];
const quantize = x => { const lo = Math.floor(x), d = x - lo; return d === 0.5 ? lo + (lo % 2 !== 0 ? 1 : 0) : Math.round(x); };

function section(c) { return { c, x1: 0, x2: 0, y1: 0, y2: 0 }; }
function apply(s, x) {
    const c = s.c, y = c[0] * x + c[1] * s.x1 + c[2] * s.x2 - c[3] * s.y1 - c[4] * s.y2;
    s.x2 = s.x1; s.x1 = x; s.y2 = s.y1; s.y1 = y;
    return y;
}

// The firmware's damped sliding DFT, including its batch schedule and four
// peak-processing steps. dynStep is shared with the audited port in filter_tune.
function dynamicPeriod(sampleCount) {
    const gcd=(a,b)=>b?gcd(b,a%b):a;
    return sampleCount>=FT.FW.dynTicks?sampleCount:sampleCount*FT.FW.dynTicks/gcd(sampleCount,FT.FW.dynTicks);
}

function dynamic(M, derivatives=false, updates=0) {
    if (!M.dyn.on) return null;
    const D = M.dyn, NS = FT.FW.sdftN, NB = NS / 2, count = D.count;
    const X = { MC: count, count, res: D.res, minHz: D.minHz, maxHz: D.maxHz,
        start: D.startBin, end: D.endBin, sampleCount: D.sampleCount, rcp: D.rcp,
        rN: Math.pow(FT.FW.sdftR, NS), batchSize: Math.floor((D.endBin - D.startBin + 1) / D.sampleCount),
        twr: new Float64Array(NB), twi: new Float64Array(NB),
        sre: new Float64Array(3 * NB), sim: new Float64Array(3 * NB), sx: new Float64Array(3 * NS),
        sidx: new Int32Array(3), acc: new Float64Array(3), avg: new Float64Array(3), data: new Float64Array(NB),
        pkBin: new Int32Array(count), pkVal: new Float64Array(count), cen: new Float64Array(3 * count), ints: new Int32Array(4),
        out: [0, 1, 2].map(() => ({ at: [], c: [] })) };
    let derivative = null, derivativeTick=0;
    const banks = [0, 1, 2].map(() => []);
    X.setDyn = (a, p, hz) => { if(derivative)derivative.coefficient(a,p,hz,derivativeTick); banks[a][p].c = FT.biquad('notch', hz, M.rates.filterHz, D.q + p * FT.FW.dynQAdvance); };
    for (let k = 0; k < NB; k++) { X.twr[k] = FT.FW.sdftR * Math.cos(2 * Math.PI * k / NS); X.twi[k] = FT.FW.sdftR * Math.sin(2 * Math.PI * k / NS); }
    for (let a = 0; a < 3; a++) for (let p = 0; p < count; p++) {
        const hz = (p + 0.5) * (D.maxHz - D.minHz) / count + D.minHz;
        X.cen[a * count + p] = hz;
        banks[a].push(section(FT.biquad('notch', hz, M.rates.filterHz, D.q + p * FT.FW.dynQAdvance)));
    }
    function update(tick,localTick=tick) {
        derivativeTick=localTick;
        const I = X.ints;
        if (I[3] === X.sampleCount) {
            I[3] = 0; if(derivative)derivative.average(localTick);
            for (let a = 0; a < 3; a++) { X.avg[a] = X.acc[a] * X.rcp; X.acc[a] = 0; }
            I[0] = FT.FW.dynTicks;
        }
        const bi = I[3], first = X.start + X.batchSize * bi, last = bi === X.sampleCount - 1;
        const end = last ? X.end + 1 : first + X.batchSize;
        for (let a = 0; a < 3; a++) {
            const o = a * NB, xo = a * NS, delta = X.avg[a] - X.rN * X.sx[xo + X.sidx[a]];
            if (last) { X.sx[xo + X.sidx[a]] = X.avg[a]; X.sidx[a] = (X.sidx[a] + 1) % NS; }
            const bin = k => { if(derivative)derivative.bin(k); const re = X.sre[o + k] + delta, im = X.sim[o + k];
                X.sre[o + k] = X.twr[k] * re - X.twi[k] * im;
                X.sim[o + k] = X.twr[k] * im + X.twi[k] * re; };
            for (let k = first; k < end; k++) bin(k);
            if (bi === 0 && X.start > 0) bin(X.start - 1);
            if (last && X.end < NB - 1) bin(X.end + 1);
        }
        I[3]++;
        if (I[0] > 0) { if(derivative&&I[1]===0)derivative.window(I[2]); FT._t.dynStep(X, tick); I[0]--; }
        // Tracks are diagnostic only. Bound their memory during long replay.
        for (const tr of X.out) if (tr.at.length > 1) { tr.at.splice(0, tr.at.length - 1); tr.c.splice(0, tr.c.length - count); }
    }
    // Logging does not reset this state machine. Advance its zero-input
    // initialization to the calibrated update count before recording any
    // derivatives. Only the bounded periodic control state is needed here.
    const period=dynamicPeriod(X.sampleCount), warm=updates<=X.sampleCount+period?updates:X.sampleCount+period+(updates-X.sampleCount)%period;
    for(let i=0;i<warm;i++)update(i);
    derivative=derivatives?derivatives(X,M.rates.filterHz,D.q):null;
    return { X, banks, update, derivative };
}

function engine(cfg, pid, options = {}) {
    const M = FT.compile(cfg), fs = M.rates.filterHz, R = M.rates;
    const configKey=JSON.stringify(cfg.s), saved=options.state&&options.state.configKey===configKey?options.state:null;
    const phase=options.state?options.state.tick:options.phase||0;
    if (!(fs > 0 && R.pidHz > 0 && fs >= R.pidHz)) throw new Error('The filter and PID rates are not valid.');
    if (M.leftOut.length) throw new Error('The frequency of an active RPM notch filter is unknown.');
    const fpl = Math.round(fs / R.pidHz), scale = clamp(R.scale || 1, 0.75, 1.25);
    const lpf = [0, 1, 2].map(() => M.statics.map(st => ({ st, sections: M.sectionsOf(st, fs).map(section) })));
    const rpm = M.rpm.map(list => list.map(b => ({ b, filter: section(FT.biquad('notch', M.rpmMinHz, fs, b.q)), fade: 0 })));
    let dynamicUpdates=options.state&&Number.isFinite(options.state.dynamicUpdates)?options.state.dynamicUpdates:options.dynamicUpdates||0;
    const flat = rpm.flat(), D = dynamic(M,options.derivatives,saved?0:dynamicUpdates), gyro = new Float64Array(3), pidGyro = new Float64Array(3), out = new Float64Array(3), dterm = new Float64Array(3);
    if (D && options.centers && options.centers.length === D.X.cen.length) {
        D.X.cen.set(options.centers);
        for (let a = 0; a < 3; a++) for (let p = 0; p < D.X.count; p++) D.banks[a][p].c = FT.biquad('notch', D.X.cen[a * D.X.count + p], fs, M.dyn.q + p * FT.FW.dynQAdvance);
    }
    // Coefficient tape for the reconstruction solver. Capture before applying
    // the filters, including the RPM fader, rather than approximating an LTI
    // response. The nonlinear SDFT is rerun after each reconstruction step.
    const stages = [0, 1, 2].map(a => rpm[a].map(b => ({ filter: b.filter, bank: b }))
        .concat(lpf[a].flatMap(s => s.sections.map(filter => ({ filter }))))
        .concat(D ? D.banks[a].map(filter => ({ filter })) : []));
    const tape = options.capture ? stages.map(list => list.map(() => new Float64Array(options.capture * 6))) : null;
    const paths = pid.map(p => ({ p, gyro: section(FT.firstOrderLpf(p.gyro_cutoff, R.pidHz)), d: section(FT.difSection(p.d_cutoff, R.pidHz)) }));
    const upd = Math.floor(UPDATE_TICK[Math.min(8, R.pidDenom)] / R.filtDenom);
    const pidAt = Math.floor(PID_TICK[Math.min(8, R.pidDenom)] / R.filtDenom);
    let cursor = 0, lastLpf = -Infinity, tick = 0;
    const dynamicStateKeys=['sre','sim','sx','sidx','acc','avg','data','pkBin','pkVal','cen','ints'];
    if(saved) {
        cursor=saved.cursor;lastLpf=saved.lastLpf;
        for(let a=0;a<3;a++)for(let j=0;j<stages[a].length;j++) {
            const dst=stages[a][j],src=saved.stages[a][j];
            dst.filter.c=src.c.slice();
            for(const k of ['x1','x2','y1','y2'])dst.filter[k]=src[k];
            if(dst.bank)dst.bank.fade=src.fade;
        }
        if(D&&saved.dynamic)for(const k of dynamicStateKeys)D.X[k].set(saved.dynamic[k]);
    }
    return { model: M, gyro, pidGyro, out, dterm, dynamic: D, tape, snapshot() {
        // The complete gyro pipeline and SDFT machine, before the next tick.
        // PID observers warm up locally; final PID replay remains continuous.
        return {configKey,tick:phase+tick,cursor,lastLpf,dynamicUpdates,
            stages:stages.map(list=>list.map(s=>({c:s.filter.c.slice(),x1:s.filter.x1,x2:s.filter.x2,y1:s.filter.y1,y2:s.filter.y2,fade:s.bank?s.bank.fade:1}))),
            dynamic:D?Object.fromEntries(dynamicStateKeys.map(k=>[k,D.X[k].slice()])):null};
    }, setPid(next) {
        for (let a=0;a<3;a++) {
            paths[a].p=next[a];
            paths[a].gyro.c=FT.firstOrderLpf(next[a].gyro_cutoff,R.pidHz);
            paths[a].d.c=FT.difSection(next[a].d_cutoff,R.pidHz);
        }
    }, tick(raw, hs, tail, ratio) {
        const clock=tick+phase;
        if (tape) for (let a = 0; a < 3; a++) for (let j = 0; j < stages[a].length; j++) {
            const s = stages[a][j], t = tape[a][j], at = tick * 6;
            t.set(s.filter.c, at); t[at + 5] = s.bank ? s.bank.fade : 1;
        }
        for (let a = 0; a < 3; a++) {
            let x = raw[a];
            // Keep the state even while faded out (rpmFilterGyro always applies).
            for (const b of rpm[a]) x += (apply(b.filter, x) - x) * b.fade;
            for (const st of lpf[a]) for (const s of st.sections) x = apply(s, x);
            if (D) { D.X.acc[a] += x; for (const s of D.banks[a]) x = apply(s, x); }
            gyro[a] = x;
        }
        if (clock % fpl === pidAt) for (let a = 0; a < 3; a++) {
            const p = paths[a], g = apply(p.gyro, gyro[a]);
            pidGyro[a] = g;
            dterm[a] = apply(p.d, -g) * p.p.Kd;
            out[a] = -g * p.p.Kp + dterm[a];
        }
        if (clock % fpl === upd) {
            if (M.dynLpf && clock / (fs * scale) - lastLpf >= 0.005 - 1e-12) {
                if (!Number.isFinite(ratio)) throw new Error('The dynamic low-pass filter needs the full headspeed ratio.');
                const hz = clamp(ratio * cfg.s.gyro_lpf1_static_hz, cfg.s.gyro_lpf1_dyn_min_hz, cfg.s.gyro_lpf1_dyn_max_hz);
                const cs = FT.lowpassSections(cfg.s.gyro_lpf1_type, hz, fs);
                for (const list of lpf) for (const st of list) if (st.st.name === 'LPF1') st.sections.forEach((s, k) => { s.c = cs[k]; });
                lastLpf = clock / (fs * scale);
            }
            if (D) D.update(clock,tick);
            // Retain the subtask clock even when dynamic notches are OFF;
            // a candidate that enables them must use the same time origin.
            dynamicUpdates++;
            for (let j = 0; j < Math.min(3, flat.length); j++) {
                const b = flat[cursor], freq = (b.b.ref === 'tail' ? tail : hs) * b.b.mult;
                b.fade = clamp((freq - M.rpmMinHz) / (M.rpmFadeHz - M.rpmMinHz), 0, 1);
                b.filter.c = FT.biquad('notch', clamp(freq, M.rpmMinHz, M.rpmMaxHz), fs * scale, b.b.q);
                cursor = (cursor + 1) % flat.length;
            }
        }
        tick++;
        return gyro;
    } };
}

// Windowed sinc reconstructs only the measured band. Cached weights for the
// rational rate conversion also handle the blackbox/filter scheduler offset.
function resample(raw, factor, offset, start, end, taps = 24) {
    const n = Math.max(0, Math.round((end - start) * factor)), y = new Float64Array(n), phases = new Map();
    for (let k = 0; k < n; k++) {
        const pos = start + k / factor - offset, base = Math.floor(pos), frac = pos - base;
        if (Math.abs(frac) < 1e-10) { y[k] = raw[clamp(base, 0, raw.length - 1)]; continue; }
        const key = Math.round(frac * 1e8); let weights = phases.get(key);
        if (!weights) {
            weights = new Float64Array(2 * taps); let sum = 0;
            for (let j = 0; j < weights.length; j++) { const d = j - taps + 1 - frac;
                const w = Math.sin(Math.PI * d) / (Math.PI * d) * (0.5 + 0.5 * Math.cos(Math.PI * d / taps)); weights[j] = w; sum += w; }
            for (let j = 0; j < weights.length; j++) weights[j] /= sum;
            phases.set(key, weights);
        }
        let v = 0; for (let j = 0; j < weights.length; j++) v += weights[j] * raw[clamp(base + j - taps + 1, 0, raw.length - 1)];
        y[k] = v;
    }
    return y;
}
const at = (x, pos, fallback = 0) => {
    if (!x) return fallback;
    const i = clamp(Math.floor(pos), 0, x.length - 1), j = Math.min(i + 1, x.length - 1), f = clamp(pos - i, 0, 1);
    return x[i] + (x[j] - x[i]) * f;
};

function input(cfg, seg, start = 0, end = seg.n) {
    const R = cfg.rates, factor = R.filterHz / R.logHz, offset = R.offsetTicks * R.logHz / R.gyroHz;
    return { start, end, factor, offset, raw: seg.raw.map(x => resample(x, factor, offset, start, end)),
        reconstruction: factor !== 1 || offset !== 0 };
}

function run(cfg, seg, pid, inp = input(cfg, seg)) {
    const variablePid = typeof pid === 'function';
    const E = engine(cfg, variablePid ? pid(inp.start) : pid, { centers: inp.centers, state:inp.state, phase:inp.phase }), n = inp.end - inp.start, y = [0, 1, 2].map(() => new Float32Array(n));
    const out = y.map(() => new Float32Array(n)), d = y.map(() => new Float32Array(n)), pidGyro = y.map(() => new Float32Array(n)), x = new Float64Array(3);
    const nf=inp.raw[0].length, native={y:y.map(()=>new Float32Array(nf)),out:y.map(()=>new Float32Array(nf)),rate:cfg.rates.filterHz,factor:inp.factor};
    let next = 0;
    let activePid = variablePid ? pid(inp.start) : pid;
    for (let k = 0; k < inp.raw[0].length; k++) {
        if (variablePid) { const p=pid(inp.start+Math.floor(k/inp.factor)); if(p!==activePid){E.setPid(p);activePid=p;} }
        const updateOffset = UPDATE_TICK[Math.min(8, cfg.rates.pidDenom)] % cfg.rates.filtDenom;
        const pos = inp.start + k / inp.factor + (updateOffset - cfg.rates.offsetTicks) * cfg.rates.logHz / cfg.rates.gyroHz;
        for (let a = 0; a < 3; a++) x[a] = inp.raw[a][k];
        const rpmAt = Math.floor(k * cfg.rates.pidHz / cfg.rates.filterHz);
        E.tick(x, inp.drivers ? inp.drivers.hs[rpmAt] : at(seg.hs, pos), inp.drivers && inp.drivers.tail ? inp.drivers.tail[rpmAt] : at(seg.tail, pos), at(seg.ratio, pos, NaN));
        for(let a=0;a<3;a++){native.y[a][k]=E.gyro[a];native.out[a][k]=E.out[a];}
        if (k === Math.floor(next * inp.factor + 1e-8) && next < n) {
            for (let a = 0; a < 3; a++) { y[a][next] = E.gyro[a]; pidGyro[a][next] = E.pidGyro[a]; out[a][next] = E.out[a]; d[a][next] = E.dterm[a]; }
            next++;
        }
    }
    return { y, pidGyro, out, d, native, input: inp, samples: inp.raw[0].length };
}

module.exports = { engine, input, run, resample, section, apply, quantize, dynamicPeriod, UPDATE_TICK, PID_TICK };
