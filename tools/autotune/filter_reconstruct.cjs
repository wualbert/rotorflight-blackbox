'use strict';

// Multichannel, multirate reconstruction from the firmware's observations.
// gyroRAW observes gyroADCd on the Blackbox tick; gyroADC observes the most
// recent filter tick. P observes the PID bandwidth limiter. Measurements are
// quantized, not exact floating-point states. See docs/FILTER_AUTOTUNE.md.
const FT = require('./filter_tune.cjs');
const R = require('./filter_replay.cjs');
const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

function schedulerScale(time, logHz, fallback = 1) {
    if (!time || time.length < 100) return fallback;
    // schedulerGetCycleTimeMultiplier measures the gyro interrupt clock, not
    // completed Blackbox frames per elapsed second. Delayed/skipped tasks must
    // not pull the notch's coefficient rate down. Timestamp quantization and
    // task latency make the median frame interval a robust clock estimate.
    const intervals = [];
    for(let i=1;i<time.length;i++) {
        const dt=time[i]-time[i-1];
        if(dt>0&&dt<2e6/logHz)intervals.push(dt);
    }
    if(intervals.length<100)return fallback;
    intervals.sort((a,b)=>a-b);
    const mid=intervals.length>>1, dt=intervals.length%2?intervals[mid]:(intervals[mid-1]+intervals[mid])/2;
    return clamp(1e6/(dt*logHz),.75,1.25);
}

function decimation(hz, rate) {
    if (!(hz > 0)) return [];
    return ['a', 'b'].map(k => FT.biquad('lpf', FT.FW.c['bessel4' + k] * hz, rate, FT.FW.q['bessel4' + k]));
}
function filter(x, sections) {
    const stages = sections.map(R.section);
    return Float64Array.from(x, v => { for (const s of stages) v = R.apply(s, v); return v; });
}
function invert(x, sections, ridge = 1e-9) {
    if (!sections.length) return Float64Array.from(x);
    // Regularized inverse of the original acquisition filter, with a reflected
    // extension to isolate circular boundaries from the scored interval.
    // This reconstructs INPUT only. Candidate OUTPUT always uses causal DSP.
    const pad = 512, n = 2 ** Math.ceil(Math.log2(x.length + 2 * pad)), p = FT.fftPlan(n);
    const re = new Float64Array(n), im = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        let j = i - pad;
        if (j < 0) j = -j;
        if (j >= x.length) j = Math.max(0, 2 * x.length - j - 2);
        re[i] = x[j];
    }
    FT.fft(p, re, im);
    for (let k = 0; k < n; k++) {
        const w = -2 * Math.PI * k / n, cr = Math.cos(w), ci = Math.sin(w), c2 = Math.cos(2*w), s2 = Math.sin(2*w);
        let hr = 1, hi = 0;
        for (const c of sections) {
            const br = c[0] + c[1]*cr + c[2]*c2, bi = c[1]*ci + c[2]*s2, ar = 1+c[3]*cr+c[4]*c2, ai = c[3]*ci+c[4]*s2, den = ar*ar+ai*ai;
            const vr = (br*ar+bi*ai)/den, vi = (bi*ar-br*ai)/den, next = hr*vr-hi*vi;
            hi = hr*vi+hi*vr; hr=next;
        }
        const den = hr*hr+hi*hi+ridge, a = re[k], b = im[k];
        re[k] = (a*hr+b*hi)/den; im[k] = -(b*hr-a*hi)/den;
    }
    FT.fft(p, re, im);
    return Float64Array.from({length:x.length},(_,i)=>re[i+pad]/n);
}

function governorRatio(cfg, w, profiles, cli) {
    if (!cli) return null;
    const mode = cli.global.gov_mode;
    if (['OFF', 'DIRECT', 0, 1].includes(mode)) return { values: new Float64Array(w.n).fill(1), source: 'firmware governor mode' };
    if (!['ELECTRIC', 'NITRO', 2, 3].includes(mode) || !cfg.s.motor_rpm_lpf || !Number.isFinite(cli.global.gov_rpm_filter) || !w.govStateAt) return null;
    const full = {};
    for (const p of new Set(profiles)) {
        const s = cli.profiles[p - 1], hz = s && s.gov_headspeed;
        if (!(hz >= 100 && hz <= 50000)) return null;
        full[p] = hz;
    }
    const rate = cfg.rates.pidHz, factor = rate / cfg.rates.logHz;
    const rpm = R.resample(w.hs, factor, 0, 0, w.n);
    const raw = invert(rpm, FT.lowpassSections(8, cfg.s.motor_rpm_lpf[0], rate));
    // govDataUpdate runs in the mixer subtask before motorUpdate; its raw RPM
    // is from the preceding motor subtask. Gear scaling commutes with both
    // linear filters, so RPM can be represented in headspeed units throughout.
    const delayed = Float64Array.from(raw, (v, i) => raw[Math.max(0, i - 1)]);
    const hs = filter(delayed, FT.lowpassSections(4, cli.global.gov_rpm_filter, rate));
    const values = Float64Array.from({length:w.n}, (_,i)=>w.govStateAt[i]>=2 && w.govStateAt[i]<=8 ? hs[Math.floor(i*factor)] / full[profiles[i]] : 1);
    return { values, source: 'reconstructed motor RPM and firmware governor PT2', fullHeadspeed: full };
}

// Identify an observer for recorded cyclic PID terms when that profile's
// configuration is absent from the header. This supplies reconstruction
// observations only: it does not promote estimated parameters to CLI values.
function pidObserver(seg, windows, axis) {
    if (!seg.w.D || !windows.length) return null;
    const rate = seg.cfg.rates.pidHz, factor = rate / seg.cfg.rates.logHz;
    const pick = windows.length <= 6 ? windows : Array.from({length:6},(_,i)=>windows[Math.floor((i+.5)*windows.length/6)]);
    const data = pick.map(w=>({w,gyro:R.resample(seg.filt[axis],factor,0,w.st-w.lead,w.st+w.N)}));
    const quantized = pick.every(w=>seg.filt[axis].subarray(w.st,w.st+w.N).every(Number.isInteger));
    const quantizedSetpoint = seg.w.sp && seg.w.sp[axis] && pick.every(w=>seg.w.sp[axis].subarray(w.st,w.st+w.N).every(Number.isInteger));
    const impulse = new Float64Array(1024); impulse[512] = 1;
    const noiseInput = quantized ? R.resample(impulse,factor,0,0,impulse.length) : null;
    function fit(cut, dcut, derivative) {
        let xy=0,xx=0,yy=0,n=0;
        const sections=[FT.firstOrderLpf(cut,rate)];
        if(derivative)sections.push(FT.difSection(dcut,rate).map((v,i)=>i<3?-v:v));
        for (const {w,gyro} of data) {
            const y=filter(gyro,sections);
            for(let i=w.lead;i<w.lead+w.N;i++) {
                const j=w.st-w.lead+i, x=derivative?y[Math.floor(i*factor)]:seg.w.sp[axis][j]-y[Math.floor(i*factor)];
                const z=(derivative?seg.w.D:seg.w.P)[axis][j];
                xy+=x*z;xx+=x*x;yy+=z*z;n++;
            }
        }
        // Bias-compensated least squares: gyroADC itself has one-unit
        // quantization. Account for its variance after interpolation and the
        // trial observer, rather than fitting that noise as true gyro motion.
        // The white rounding-noise approximation affects calibration only.
        let noiseVariance=0;
        if(noiseInput) {
            const y=filter(noiseInput,sections);
            for(let i=0;i<impulse.length;i++)noiseVariance+=y[Math.floor(i*factor)]**2/12;
            if(!derivative&&quantizedSetpoint)noiseVariance+=1/12;
        }
        const den=xx-n*noiseVariance,gain=den>0?xy/den:0;
        const error=Math.max(0,yy-2*gain*xy+gain*gain*xx);
        const correctedError=den>0?error-gain*gain*n*noiseVariance:error;
        return {gain,error,correctedError,noiseVariance,r2:yy?1-error/yy:0,rms:Math.sqrt(error/Math.max(n,1)),n};
    }
    function derivativeObserver() {
        if(!pick.some(w=>seg.w.D[axis].subarray(w.st,w.st+w.N).some(v=>v!==0)))return null;
        let best = null;
        const trial = (cut, dcut) => {
            const q = fit(cut, dcut, true);
            if (!best || q.correctedError < best.correctedError) best = {...q,cut,dcut};
        };
        for(let cut=0;cut<=250;cut+=10) for(let dcut=10;dcut<=250;dcut+=10) trial(cut,dcut);
        const initial=best;
        for(let cut=Math.max(0,initial.cut-8);cut<=Math.min(250,initial.cut+8);cut+=2)
            for(let dcut=Math.max(1,initial.dcut-8);dcut<=Math.min(250,initial.dcut+8);dcut+=2)trial(cut,dcut);
        const fine=best;
        for(let cut=Math.max(0,fine.cut-1);cut<=Math.min(250,fine.cut+1);cut++)
            for(let dcut=Math.max(1,fine.dcut-1);dcut<=Math.min(250,fine.dcut+1);dcut++)trial(cut,dcut);
        if(!(best.gain>0&&best.r2>.99&&best.rms<.001&&best.n>=3000))return null;
        // Only the combined D transfer is identified. Its two poles can be
        // exchanged, so this never supplies a P observation or CLI settings.
        return {gyro_cutoff:best.cut,d_cutoff:best.dcut,Kp:0,Kd:best.gain,known:true,observer:true,derivativeOnly:true,fit:{D:best}};
    }
    if(axis>1) {
        // pidApplyYawMode3/4 multiplies P by an asymmetric stop gain. Its
        // two coefficients are linear regression parameters at a given
        // gyro cutoff. An accepted fit supplies an observer, never CLI data.
        if(!seg.w.P||!seg.w.sp)return derivativeObserver();
        let best=null;
        const trial=cut=>{
            let aa=0,ab=0,bb=0,az=0,bz=0,zz=0,n=0,daa=0,dab=0,dbb=0;
            for(const {w,gyro} of data) {
                const y=filter(gyro,[FT.firstOrderLpf(cut,rate)]);
                for(let i=w.lead;i<w.lead+w.N;i++) {
                    const j=w.st-w.lead+i,e=seg.w.sp[axis][j]-y[Math.floor(i*factor)],t=clamp((e+10)/20,0,1);
                    const a=e*(1-t),b=e*t,z=seg.w.P[axis][j];
                    aa+=a*a;ab+=a*b;bb+=b*b;az+=a*z;bz+=b*z;zz+=z*z;n++;
                    const da=e<=-10?1:e>=10?0:.5-e/10,db=1-da;
                    daa+=da*da;dab+=da*db;dbb+=db*db;
                }
            }
            let noiseVariance=quantizedSetpoint?1/12:0;
            if(noiseInput){const y=filter(noiseInput,[FT.firstOrderLpf(cut,rate)]);for(let i=0;i<impulse.length;i++)noiseVariance+=y[Math.floor(i*factor)]**2/12;}
            const caa=aa-noiseVariance*daa,cab=ab-noiseVariance*dab,cbb=bb-noiseVariance*dbb,det=caa*cbb-cab*cab;
            if(!(caa>0&&cbb>0&&det>1e-8))return;
            const left=(az*cbb-bz*cab)/det,right=(bz*caa-az*cab)/det;
            if(!(left>0&&right>0&&Math.max(left,right)<3*Math.min(left,right)))return;
            const error=Math.max(0,zz-2*left*az-2*right*bz+left*left*aa+2*left*right*ab+right*right*bb);
            const correctedError=error-noiseVariance*(left*left*daa+2*left*right*dab+right*right*dbb);
            const q={cut,left,right,error,correctedError,noiseVariance,r2:zz?1-error/zz:0,rms:Math.sqrt(error/n),n};
            if(!best||q.correctedError<best.correctedError)best=q;
        };
        for(let cut=0;cut<=250;cut+=5)trial(cut);
        if(!best)return derivativeObserver();
        const center=best.cut;for(let cut=Math.max(0,center-4);cut<=Math.min(250,center+4);cut++)trial(cut);
        // Setpoint rounding is multiplied by the local P slope. The residual
        // bound includes that measured scale, unlike a fixed 0.001 bound.
        if(!(best.r2>.995&&best.rms<Math.sqrt(1e-6+Math.max(best.left,best.right)**2)/Math.sqrt(3)&&best.n>=3000))return derivativeObserver();
        let d=null;const tryD=cut=>{const q=fit(best.cut,cut,true);if(!d||q.correctedError<d.correctedError)d={...q,cut};};
        for(let cut=5;cut<=250;cut+=5)tryD(cut);
        const dc=d.cut;for(let cut=Math.max(1,dc-4);cut<=Math.min(250,dc+4);cut++)tryD(cut);
        const hasD=d.gain>0&&d.r2>.99&&d.rms<.001;
        const Kp=(best.left+best.right)/2;
        return {gyro_cutoff:best.cut,d_cutoff:hasD?d.cut:0,Kp,Kd:hasD?d.gain:0,stopGain:[best.left/Kp,best.right/Kp],known:true,observer:true,fit:{P:best,D:d}};
    }
    if(!seg.w.P||!seg.w.sp)return derivativeObserver();
    let best=null;
    const tryGyro=cut=>{const q=fit(cut,0,false);if(!best||q.correctedError<best.correctedError)best={...q,cut};};
    for(let cut=0;cut<=250;cut+=5)tryGyro(cut);
    const center=best.cut;
    for(let cut=Math.max(0,center-4);cut<=Math.min(250,center+4);cut++)tryGyro(cut);
    if(!(best.gain>0&&best.r2>.995&&best.rms<.001&&best.n>=3000))return derivativeObserver();
    let d=null;
    const tryD=cut=>{const q=fit(best.cut,cut,true);if(!d||q.correctedError<d.correctedError)d={...q,cut};};
    for(let cut=5;cut<=250;cut+=5)tryD(cut);
    const dc=d.cut;
    for(let cut=Math.max(1,dc-4);cut<=Math.min(250,dc+4);cut++)tryD(cut);
    if (d.gain === 0 && d.error === 0) d = {...d,cut:0,r2:1};
    if(!(d.r2>.99&&d.rms<.001))return derivativeObserver();
    return {gyro_cutoff:best.cut,d_cutoff:d.cut,Kp:best.gain,Kd:d.gain,known:true,observer:true,fit:{P:best,D:d}};
}

function pObservation(pid,axis,p,setpoint) {
    if(!(pid.known&&pid.Kp>0))return null;
    let error=p/pid.Kp,slope=pid.Kp;
    if(axis===2) {
        if(!pid.stopGain)return null;
        const [lo,hi]=pid.stopGain.map(x=>x*pid.Kp),mid=(lo+hi)/2,curve=(hi-lo)/20;
        if(!(lo>0&&hi>0&&Math.max(lo,hi)<3*Math.min(lo,hi)))return null;
        if(p<-10*lo){error=p/lo;slope=lo;}
        else if(p>10*hi){error=p/hi;slope=hi;}
        else {error=2*p/(mid+Math.sqrt(mid*mid+4*curve*p));slope=mid+2*curve*error;}
    }
    return {value:setpoint-error,weight:1/(1+(0.001/slope)**2)};
}

function phaseState(cfg,updates) {
    const pid=Array(3).fill({gyro_cutoff:0,d_cutoff:0,Kp:0,Kd:0}), E=R.engine(cfg,pid,{dynamicUpdates:updates});
    const state=E.snapshot(),banks=E.model.rpm.flat().length;
    state.tick=updates*cfg.rates.filterHz/cfg.rates.pidHz;
    state.cursor=banks?(updates*Math.min(3,banks))%banks:0;
    return state;
}

function reconstructionBlocks(windows) {
    const blocks=[];
    for(let i=0;i<windows.length;) {
        const first=windows[i];let end=i+1;
        while(end<windows.length&&end-i<8&&windows[end].profile===first.profile&&windows[end].st===windows[end-1].st+windows[end-1].N)end++;
        blocks.push(windows.slice(i,end));i=end;
    }
    return blocks;
}

function calibrateTiming(seg,windows) {
    const M=FT.compile(seg.cfg);
    if(!M.dyn.on||!windows.length)return null;
    // blackboxResetIterationTimers resets only the logging counter. The
    // SDFT's sampleIndex/step/axis continue from before the first frame.
    // Identify that finite control phase with the recorded configuration,
    // before fitting any missing samples or proposing new filter settings.
    const eligible=windows.filter(w=>!w.held);
    if(!eligible.length)return null;
    const holdout=new Map();
    for(const block of reconstructionBlocks(windows))for(const w of block)holdout.set(w,w.st-block[0].st);
    const count=Math.min(12,eligible.length), pick=Array.from({length:count},(_,i)=>eligible[Math.floor((i+.5)*eligible.length/count)]);
    const data=pick.map(w=>({w,input:R.input(seg.cfg,seg,w.st-w.lead,w.st+w.N),pid:seg.observers[w.profile]}));
    const period=R.dynamicPeriod(M.dyn.sampleCount),trials=[];
    for(let phase=0;phase<period;phase++) {
        let score=0,samples=0;
        for(const {w,input,pid} of data) {
            const updates=period+phase+input.start*seg.cfg.rates.pidHz/seg.cfg.rates.logHz;
            const out=R.run(seg.cfg,seg,pid,{...input,state:phaseState(seg.cfg,updates)});
            for(let i=w.lead;i<w.lead+w.N;i++)if((i+holdout.get(w))%5!==2) {
                const j=input.start+i;samples++;
                for(let a=0;a<3;a++) {
                    score+=(out.y[a][i]-seg.filt[a][j])**2;
                    if(pid[a].known&&pid[a].Kd>0&&seg.w.D)score+=1e6*(out.d[a][i]-seg.w.D[a][j])**2;
                    const p=seg.w.P&&seg.w.sp&&pObservation(pid[a],a,seg.w.P[a][j],seg.w.sp[a][j]);
                    if(p)score+=(out.pidGyro[a][i]-p.value)**2*p.weight;
                }
            }
        }
        trials.push({phase,score,samples});
    }
    const ranked=trials.slice().sort((a,b)=>a.score-b.score),margin=ranked.length>1&&ranked[1].score>0?1-ranked[0].score/ranked[1].score:0;
    // A tiny minimum can be an interpolation/rounding artifact. The 2%
    // separation is a calibration design choice, not statistical confidence.
    const identified=margin>=.02,phase=identified?ranked[0].phase:0;
    seg.initialState=phaseState(seg.cfg,period+phase);
    return {phase,period,identified,relativeSeparation:margin,minimumSeparation:.02,windows:pick.length,trials};
}

// A direct-form-I stage with time-varying coefficients and RPM fading.
// The reverse operation is the exact transpose, including all state edges.
function stage(x, c, transpose = false, initial = null) {
    const n = x.length, y = new Float64Array(n);
    if (!transpose) {
        let x1 = initial?initial.x1:0, x2 = initial?initial.x2:0, y1 = initial?initial.y1:0, y2 = initial?initial.y2:0;
        for (let i = 0; i < n; i++) {
            const k = i * 6, v = c[k] * x[i] + c[k + 1] * x1 + c[k + 2] * x2 - c[k + 3] * y1 - c[k + 4] * y2;
            y[i] = x[i] + c[k + 5] * (v - x[i]);
            x2 = x1; x1 = x[i]; y2 = y1; y1 = v;
        }
    } else {
        const g = Float64Array.from(x, (v, i) => v * c[i * 6 + 5]);
        for (let i = n - 1; i >= 0; i--) {
            const k = i * 6, v = g[i];
            y[i] += (1 - c[k + 5]) * x[i] + c[k] * v;
            if (i > 0) { y[i - 1] += c[k + 1] * v; g[i - 1] -= c[k + 3] * v; }
            if (i > 1) { y[i - 2] += c[k + 2] * v; g[i - 2] -= c[k + 4] * v; }
        }
    }
    return y;
}
function chain(x, tape, transpose = false) {
    let y = x;
    if (transpose) for (let i = tape.length - 1; i >= 0; i--) y = stage(y, tape[i], true);
    else for (const c of tape) y = stage(y, c);
    return y;
}
function constant(c, n) {
    const tape = new Float64Array(n * 6);
    for (let i = 0; i < n; i++) { tape.set(c, i * 6); tape[i * 6 + 5] = 1; }
    return tape;
}
function cg(A, b, seed, iterations = 80) {
    const x = Float64Array.from(seed), Ax = A(x), r = Float64Array.from(b, (v, i) => v - Ax[i]), p = Float64Array.from(r);
    let rr = dot(r, r), initial = rr, used = 0;
    for (; used < iterations && rr > Math.max(1e-16, initial * 1e-10); used++) {
        const q = A(p), den = dot(p, q); if (!(den > 0)) break;
        const alpha = rr / den;
        for (let i = 0; i < x.length; i++) { x[i] += alpha * p[i]; r[i] -= alpha * q[i]; }
        const next = dot(r, r), beta = next / rr;
        for (let i = 0; i < x.length; i++) p[i] = r[i] + beta * p[i];
        rr = next;
    }
    return { x, iterations: used, residual: Math.sqrt(rr / Math.max(initial, 1e-30)) };
}

function drivers(cfg, seg, start, k) {
    const r = cfg.rates, factor = r.filterHz / r.logHz;
    // motorUpdate precedes rpmFilterUpdate on this scheduler subtask. It is
    // later than the filter input when both are represented by one tick here.
    const updateOffset = R.UPDATE_TICK[Math.min(8, r.pidDenom)] % r.filtDenom;
    const pos = start + k / factor + (updateOffset - r.offsetTicks) * r.logHz / r.gyroHz;
    const at = (x, fallback) => {
        if (!x) return fallback;
        const i = clamp(Math.floor(pos), 0, x.length - 1), j = Math.min(i + 1, x.length - 1), f = clamp(pos - i, 0, 1);
        return x[i] + (x[j] - x[i]) * f;
    };
    return [at(seg.hs, 0), at(seg.tail, 0), at(seg.ratio, NaN)];
}
// Differentiate the selected SDFT peaks; branch choices are fixed locally.
function recordDynamicJacobian(X,rate,q) {
    const N=FT.FW.sdftN,NB=N/2,events=[0,1,2].map(()=>Array.from({length:X.count},()=>[]));
    const avg=[],binAvg=new Int32Array(NB).fill(-1);let accStart=0,win=null;
    const twr=Array.from({length:NB},(_,k)=>Float64Array.from({length:N},(_,j)=>Math.pow(FT.FW.sdftR,j+1)*Math.cos(2*Math.PI*k*(j+1)/N)));
    const twi=Array.from({length:NB},(_,k)=>Float64Array.from({length:N},(_,j)=>Math.pow(FT.FW.sdftR,j+1)*Math.sin(2*Math.PI*k*(j+1)/N)));
    return {events,avg,average(tick){avg.push({start:accStart,end:tick+1});accStart=tick+1;},bin(k){binAvg[k]=avg.length-1;},window(a){
        win={sre:X.sre.slice(a*NB,(a+1)*NB),sim:X.sim.slice(a*NB,(a+1)*NB),at:binAvg.slice()};
    },coefficient(a,p,hz,tick){
        const b=X.pkBin[p],v0=X.data[b-1],v1=X.data[b],v2=X.data[b+1],den=2*(v0-2*v1+v2),num=v0-v2;
        const first=Math.max(0,avg.length-N-2),weights=new Float64Array(avg.length-first);
        if(win&&den!==0&&hz>X.minHz&&hz<X.maxHz) {
            const partial=[(den-2*num)/den**2,4*num/den**2,(-den-2*num)/den**2].map(x=>x*X.res);
            for(let z=0;z<3;z++) {
                const k=b+z-1,indices=k===NB-1?[[k,1],[k-1,-1]]:[[k,1],[k-1,-.5],[k+1,-.5]];
                let re=0,im=0;for(const [j,m] of indices){re+=m*win.sre[j];im+=m*win.sim[j];}
                for(const [j,m] of indices)for(let n=Math.max(first,win.at[j]-N+1);n<=win.at[j];n++) {
                    const age=win.at[j]-n;
                    weights[n-first]+=2*partial[z]*m*(re*twr[j][age]+im*twi[j][age]);
                }
            }
        }
        const eps=Math.max(.001,hz*1e-5),lo=FT.biquad('notch',hz-eps,rate,q+p*FT.FW.dynQAdvance),hi=FT.biquad('notch',hz+eps,rate,q+p*FT.FW.dynQAdvance);
        events[a][p].push({at:tick+1,first,weights,dc:lo.map((v,i)=>(hi[i]-v)/(2*eps))});
    },rcp:X.rcp};
}
function linearizeDynamic(C,tape,input,initial,record,axis,count) {
    const n=input.length,split=tape.length-count;
    const values=[input];
    for(let s=0;s<tape.length;s++)values.push(C.stage(values[s],tape[s],false,initial&&initial[s]));
    const events=record.events[axis],drives=events.map((list,j)=>{
        const x=values[split+j],y=values[split+j+1],state=initial&&initial[split+j];
        const d=new Float64Array(n);let at=0;
        for(let i=0;i<n;i++) {
            while(at+1<list.length&&list[at+1].at<=i)at++;
            if(!list.length||i<list[at].at)continue;
            const c=list[at].dc, xm1=i?x[i-1]:state?state.x1:0,xm2=i>1?x[i-2]:state?(i?state.x1:state.x2):0;
            const ym1=i?y[i-1]:state?state.y1:0,ym2=i>1?y[i-2]:state?(i?state.y1:state.y2):0;
            d[i]=c[0]*x[i]+c[1]*xm1+c[2]*xm2-c[3]*ym1-c[4]*ym2;
        }
        return d;
    });
    const allpole=tape.slice(split).map(c=>{const v=c.slice();for(let i=0;i<n;i++){v[i*6]=1;v[i*6+1]=v[i*6+2]=0;}return v;});
    function forward(x) {
        let y=C.chain(x,tape.slice(0,split));
        const means=Float64Array.from(record.avg,r=>{let s=0;for(let i=r.start;i<r.end;i++)s+=y[i];return s*record.rcp;});
        for(let j=0;j<count;j++) {
            const list=events[j],g=new Float64Array(n);
            for(let z=0;z<list.length;z++) {
                const e=list[z],end=z+1<list.length?Math.min(n,list[z+1].at):n;let f=0;
                for(let k=0;k<e.weights.length;k++)f+=e.weights[k]*means[k+e.first];
                for(let i=e.at;i<end;i++)g[i]=f*drives[j][i];
            }
            const v=C.stage(g,allpole[j]);y=C.stage(y,tape[split+j]);
            for(let i=0;i<n;i++)y[i]+=v[i];
        }
        return y;
    }
    function transpose(g) {
        let y=g;const extra=new Float64Array(n),means=new Float64Array(record.avg.length);
        for(let j=count-1;j>=0;j--) {
            const z=C.stage(y,allpole[j],true),list=events[j];
            for(let k=0;k<list.length;k++) {
                const e=list[k],end=k+1<list.length?Math.min(n,list[k+1].at):n;let f=0;
                for(let i=e.at;i<end;i++)f+=z[i]*drives[j][i];
                for(let i=0;i<e.weights.length;i++)means[e.first+i]+=f*e.weights[i];
            }
            y=C.stage(y,tape[split+j],true);
        }
        for(let k=0;k<record.avg.length;k++){const a=record.avg[k],v=means[k]*record.rcp;for(let i=a.start;i<a.end;i++)extra[i]+=v;}
        for(let i=0;i<n;i++)y[i]+=extra[i];
        return C.chain(y,tape.slice(0,split),true);
    }
    return {forward,transpose,output:values[values.length-1]};
}

function forward(cfg, seg, start, native, pid, capture = false) {
    const step = cfg.rates.filtDenom, n = Math.floor(native[0].length / step), E = R.engine(cfg, pid, { capture: capture ? n : 0, derivatives:capture?recordDynamicJacobian:null, centers: seg.dynamicSeeds && seg.dynamicSeeds.get(start), state:stateAt(seg,start) });
    const y = native.map(() => new Float64Array(n)), pg = native.map(() => new Float64Array(n)), d = native.map(() => new Float64Array(n));
    for (let k = 0; k < n; k++) {
        E.tick(native.map(x => x[k * step]), ...drivers(cfg, seg, start, k));
        for (let a = 0; a < 3; a++) { y[a][k] = E.gyro[a]; pg[a][k] = E.pidGyro[a]; d[a][k] = E.dterm[a]; }
    }
    return { tape: E.tape, y, pg, d, derivative: E.dynamic&&E.dynamic.derivative };
}
const record = (cfg, seg, start, native, pid) => forward(cfg, seg, start, native, pid, true).tape;

function stateAt(seg,start) {
    const saved=seg.replayStates&&seg.replayStates.get(start);
    if(saved)return saved;
    if(!seg.initialState)return undefined;
    return start===0?seg.initialState:phaseState(seg.cfg,seg.initialState.dynamicUpdates+start*seg.cfg.rates.pidHz/seg.cfg.rates.logHz);
}

function seedHistory(seg, starts) {
    if (!FT.compile(seg.cfg).dyn.on) return;
    const wanted = new Set(starts), input = R.input(seg.cfg, seg, 0, seg.n);
    const E = R.engine(seg.cfg, Array(3).fill({gyro_cutoff:0,d_cutoff:0,Kp:0,Kd:0}),{state:seg.initialState});
    seg.dynamicSeeds = new Map();
    for (let k = 0; k < input.raw[0].length; k++) {
        const i = k / input.factor;
        if (wanted.has(i)) seg.dynamicSeeds.set(i, Float64Array.from(E.dynamic.X.cen));
        E.tick(input.raw.map(x=>x[k]), ...drivers(seg.cfg, seg, 0, k));
    }
}

// The first differences of the slope penalize unsupported high-frequency
// interpolation. A small ridge fixes unobservable DC/state null spaces.
// Measurement weights use Blackbox's one-unit gyro/setpoint rounding and
// 0.001 PID rounding. They do not depend on a candidate configuration.
function solveAxis(cfg, seg, axis, start, end, seed, tape, pid, options, prior = seed) {
    const r = cfg.rates, n = seed.length, frames = end - start, gpl = Math.round(r.gyroHz / r.logHz), step = r.filtDenom;
    const nf = Math.floor(n / step), ff = Math.round(r.filterHz / r.logHz), pp = Math.round(r.filterHz / r.pidHz);
    const obs = [], gyroWeight = new Float64Array(nf), gyroData = new Float64Array(nf), rawWeight = new Float64Array(n), rawData = new Float64Array(n);
    const regularization = options.regularization === undefined ? 0.015 : options.regularization;
    const hold = options.holdout !== false, burn = Math.ceil(Math.min(1, frames / r.logHz / 3) * r.logHz);
    for (let i = 0; i < frames; i++) {
        const j = i * gpl + r.offsetTicks;
        if (j < n) { rawWeight[j] = 1; rawData[j] = seg.raw[axis][start + i]; }
        // Leave every fifth gyro observation out, over the entire window.
        // Candidate selection never changes this split.
        if (i >= burn && (!hold || i % 5 !== 2)) { gyroWeight[i * ff] = 1; gyroData[i * ff] = seg.filt[axis][start + i]; }
    }
    if (pid.known && (axis < 2 || pid.stopGain) && pid.Kp > 0 && seg.w && seg.w.P && seg.w.sp) {
        const np = Math.floor(nf / pp), weight = new Float64Array(np), data = new Float64Array(np);
        for (let i = burn; i < frames; i++) {
            const j = Math.floor(i * ff / pp);
            const observation=pObservation(pid,axis,seg.w.P[axis][start+i],seg.w.sp[axis][start+i]);
            if(observation){weight[j]=observation.weight;data[j]=observation.value;}
        }
        obs.push({ weight, data, tape: [constant(FT.firstOrderLpf(pid.gyro_cutoff, r.pidHz), np)] });
    }
    if (pid.known && pid.Kd > 0 && seg.w && seg.w.D) {
        const np = Math.floor(nf / pp), weight = new Float64Array(np), data = new Float64Array(np);
        for (let i = burn; i < frames; i++) if (!hold || i % 5 !== 2) {
            const j = Math.floor(i * ff / pp);
            weight[j] = 1e6; data[j] = seg.w.D[axis][start + i];
        }
        const dif = FT.difSection(pid.d_cutoff, r.pidHz).map((v, i) => i < 3 ? -v * pid.Kd : v);
        obs.push({ weight, data, tape: [constant(FT.firstOrderLpf(pid.gyro_cutoff, r.pidHz), np), constant(dif, np)] });
    }
    const down = x => Float64Array.from({ length: nf }, (_, i) => x[i * step]);
    // Nonzero filter states contribute an affine output independent of the
    // unknown input. Remove it from the data term, not from the forward path.
    let bias=new Float64Array(nf);
    if(options.initialStages)for(let j=0;j<tape.length;j++)bias=stage(bias,tape[j],false,options.initialStages[j]);
    if(options.jac){const linear=options.jac.forward(down(seed));bias=Float64Array.from(linear,(v,i)=>options.jac.output[i]-v);}
    for(const ob of obs)ob.bias=chain(Float64Array.from({length:ob.weight.length},(_,i)=>bias[i*pp]),ob.tape);
    function feedback(x, data) {
        const filtered = options.jac?options.jac.forward(down(x)):chain(down(x), tape), g = Float64Array.from(filtered, (v, i) => gyroWeight[i] * (data ? gyroData[i]-bias[i] : v));
        for (const ob of obs) {
            const p = Float64Array.from({ length: ob.weight.length }, (_, i) => filtered[i * pp]);
            const y = chain(p, ob.tape), q = Float64Array.from(y, (v, i) => ob.weight[i] * (data ? ob.data[i]-ob.bias[i] : v));
            const z = chain(q, ob.tape, true);
            for (let i = 0; i < z.length; i++) g[i * pp] += z[i];
        }
        const z = options.jac?options.jac.transpose(g):chain(g, tape, true), result = new Float64Array(n);
        for (let i = 0; i < nf; i++) result[i * step] += z[i];
        for (let i = 0; i < n; i++) result[i] += rawWeight[i] * (data ? rawData[i] : x[i]);
        return result;
    }
    function penalty(x, out) {
        for (let i = 1; i < n - 1; i++) {
            const v = regularization * (x[i - 1] - 2 * x[i] + x[i + 1]);
            out[i - 1] += v; out[i] -= 2 * v; out[i + 1] += v;
        }
        for (let i = 0; i < n; i++) out[i] += 1e-7 * x[i];
        return out;
    }
    const damping=options.jac ? 0.1 : 0;
    const rhs = penalty(prior, feedback(seed, true));for(let i=0;i<n;i++)rhs[i]+=damping*seed[i];
    const operator = x => {const y=penalty(x, feedback(x, false));for(let i=0;i<n;i++)y[i]+=damping*x[i];return y;};
    const prefix = Math.min(n, options.fixedPrefix || 0);
    let solved;
    if(prefix) {
        // Earlier committed samples are constants, not new unknowns. Solve
        // for the remaining samples after subtracting the fixed contribution.
        const fixed=new Float64Array(n);fixed.set(seed.subarray(0,prefix));
        const fixedEffect=operator(fixed), target=Float64Array.from(rhs,(v,i)=>i<prefix?0:v-fixedEffect[i]);
        const freeSeed=Float64Array.from(seed,(v,i)=>i<prefix?0:v);
        solved=cg(x=>{const y=operator(x);y.fill(0,0,prefix);return y;},target,freeSeed,options.iterations||80);
        solved.x.set(fixed.subarray(0,prefix));
    } else solved = cg(operator, rhs, seed, options.iterations || 80);
    return { ...solved, burn, holdout: hold };
}

function reconstruct(cfg, seg, start, end, pid, options = {}) {
    options = { ...options };
    const automaticRegularization = options.regularization === undefined;
    // Independent PID observations make the high-rate inverse much better
    // conditioned. A known but weak P gain does not: its one-permille rounding
    // can imply several degrees/s of gyro uncertainty. Require a usable D
    // channel or P resolution of one degree/s or better for weaker smoothing.
    const informative = a => {
        const p=seg.w&&seg.w.P&&seg.w.sp&&pObservation(pid[a],a,0,0);
        return pid[a].known && seg.w && ((seg.w.D && pid[a].Kd > 0 && pid[a].d_cutoff > 0) || (p&&p.weight>=0.5));
    };
    const regularizationFor = a => automaticRegularization ? (informative(a) ? 0.003 : 0.015) : options.regularization;
    if (options.iterations === undefined) options.iterations = 80;
    const r = cfg.rates, factor = r.filterHz / r.logHz, nativeFactor = r.gyroHz / r.logHz;
    if (nativeFactor === 1 && r.offsetTicks === 0 && !Number.isFinite(cfg.s.gyro_decimation_hz) && !cfg.s.motor_rpm_lpf) {
        const inp = R.input(cfg, seg, start, end);
        return { ...inp, native: inp.raw, nativeHz: r.gyroHz, diagnostics: { method: 'recorded native samples', heldoutEvery: 0, rounds: 0, axes: [] } };
    }
    const offset = r.offsetTicks / nativeFactor;
    const prior = seg.raw.map(x => R.resample(x, nativeFactor, offset, start, end));
    let native = options.initialNative ? options.initialNative.map(x=>Float64Array.from(x)) : prior;
    let reference = null;
    const axes = [], rounds = options.rounds || (FT.compile(cfg).dyn.on ? 16 : 1);
    let completedRounds = 0;
    function merit(x, out) {
        return x.map((v, a) => {
            let score = 0;
            const burn = Math.ceil(Math.min(1, (end - start) / r.logHz / 3) * r.logHz);
            for (let i = burn; i < end - start; i++) {
                if (options.holdout === false || i % 5 !== 2) {
                    score += (out.y[a][i * factor] - seg.filt[a][start + i]) ** 2;
                    if (pid[a].known && pid[a].Kd > 0 && seg.w && seg.w.D) score += 1e6 * (out.d[a][i * factor] - seg.w.D[a][start + i]) ** 2;
                }
                if (pid[a].known && pid[a].Kp > 0 && seg.w && seg.w.P && seg.w.sp) {
                    const observation=pObservation(pid[a],a,seg.w.P[a][start+i],seg.w.sp[a][start+i]);
                    if(observation)score += (out.pg[a][i * factor] - observation.value) ** 2 * observation.weight;
                }
                const j = i * nativeFactor + r.offsetTicks;
                score += (v[j] - seg.raw[a][start + i]) ** 2;
            }
            const reg = regularizationFor(a);
            for (let i = 1; i < v.length - 1; i++) score += reg * ((v[i - 1] - prior[a][i - 1]) - 2 * (v[i] - prior[a][i]) + (v[i + 1] - prior[a][i + 1])) ** 2;
            return score;
        });
    }
    for (let iteration = 0; iteration < rounds; iteration++) {
        const base = forward(cfg, seg, start, native, pid, true), tape = base.tape, bestScore = merit(native, base);
        if (!reference) reference = base;
        const proposal = native.map((x, a) => {
            const regularization = regularizationFor(a);
            const initial=stateAt(seg,start);
            const jac=iteration>=8&&base.derivative?linearizeDynamic({stage,chain},tape[a],Float64Array.from({length:x.length/r.filtDenom},(_,i)=>x[i*r.filtDenom]),initial&&initial.stages[a],base.derivative,a,FT.compile(cfg).dyn.count):null;
            const solved = solveAxis(cfg, seg, a, start, end, x, tape[a], pid[a], {...options,jac,regularization,iterations:regularization<0.01?160:options.iterations,initialStages:initial&&initial.stages[a]}, prior[a]);
            axes[a] = { iterations: solved.iterations, residual: solved.residual, heldout: solved.holdout, regularization };
            return solved.x;
        });
        const best = native.slice();
        for (const alpha of rounds === 1 ? [1] : Array.from({length:iteration<8?6:12},(_,j)=>2**-j)) {
            const trial = native.map((x, a) => Float64Array.from(x, (v, i) => v + alpha * (proposal[a][i] - v)));
            const score = merit(trial, forward(cfg, seg, start, trial, pid));
            for (let a = 0; a < 3; a++) if (score[a] < bestScore[a]) { best[a] = trial[a]; bestScore[a] = score[a]; }
        }
        // Peak selection is discontinuous. A single step length over several
        // seconds can stall because different intervals cross different peak
        // boundaries. For stalled axes, try the same proposed direction on
        // 250 ms intervals. Every accepted change reduces the original fit
        // objective after a complete nonlinear replay; withheld outputs are
        // never used to select these steps.
        const stalled=best.map((x,a)=>x===native[a]);
        if(iteration>=8&&stalled.some(Boolean)) {
            const chunk=Math.round(.25*r.gyroHz);
            for(let lo=options.fixedPrefix||0;lo<native[0].length;lo+=chunk) {
                const hi=Math.min(lo+chunk,native[0].length),anchor=best.slice();
                for(const alpha of [1,.5,.25,.125,.0625,.03125]) {
                    const trial=best.map((x,a)=>{
                        if(!stalled[a])return x;
                        const y=anchor[a].slice();
                        for(let i=lo;i<hi;i++)y[i]+=alpha*(proposal[a][i]-native[a][i]);
                        return y;
                    });
                    const score=merit(trial,forward(cfg,seg,start,trial,pid));
                    for(let a=0;a<3;a++)if(stalled[a]&&score[a]<bestScore[a]){best[a]=trial[a];bestScore[a]=score[a];}
                }
            }
        }
        completedRounds++;
        if(best.every((x,a)=>x===native[a])){if(iteration<8){iteration=7;continue;}break;}
        native = best;
    }
    // Invert the *recorded* decimator once. Candidate decimators all consume
    // this fixed sensor-rate input, never a separately fitted reconstruction.
    let sensor = null, decimationClosure = null;
    if (Number.isFinite(cfg.s.gyro_decimation_hz)) {
        const sections = decimation(cfg.s.gyro_decimation_hz, r.gyroHz);
        sensor = native.map(x => invert(x, sections));
        const recovered = sensor.map(x => filter(x, sections));
        decimationClosure = recovered.map((x, a) => {
            let error = 0, n = 0;
            for (let i = Math.floor(r.gyroHz); i < x.length; i++) { error += (x[i] - native[a][i]) ** 2; n++; }
            return Math.sqrt(error / Math.max(n, 1));
        });
        native = recovered;
        if(options.fixedPrefix&&options.initialNative)for(let a=0;a<3;a++)native[a].set(options.initialNative[a].subarray(0,options.fixedPrefix));
    }
    let rpm = null;
    if (cfg.s.motor_rpm_lpf) {
        const rpmFactor = r.pidHz / r.logHz;
        const recover = (x, index) => x ? invert(R.resample(x, rpmFactor, 0, start, end), FT.lowpassSections(8, cfg.s.motor_rpm_lpf[index], r.pidHz)) : null;
        rpm = { hs: recover(seg.hs, 0), tail: cfg.gear && cfg.gear.motorisedTail ? recover(seg.tail, 1) : null, original: cfg.s.motor_rpm_lpf.slice() };
    }
    const check = forward(cfg, seg, start, native, pid);
    const validation = native.map((_,a)=>{
        let error=0, priorError=0, samples=0, rawError=0;
        for(let i=Math.min(Math.ceil(2*r.logHz),end-start-1);i<end-start;i++) if(i%5===2) {
            const measured=seg.filt[a][start+i];
            error+=(check.y[a][i*factor]-measured)**2;
            priorError+=(reference.y[a][i*factor]-measured)**2;
            const j=i*nativeFactor+r.offsetTicks;
            rawError+=(native[a][j]-seg.raw[a][start+i])**2;samples++;
        }
        return {error,priorError,rawError,samples};
    });
    return { start, end, factor, offset, raw: native.map(x => Float64Array.from({ length: Math.floor(x.length / r.filtDenom) }, (_, i) => x[i * r.filtDenom])),
        native, sensor, rpm, centers: seg.dynamicSeeds && seg.dynamicSeeds.get(start), state:stateAt(seg,start), nativeHz: r.gyroHz, originalDecimationHz: cfg.s.gyro_decimation_hz, reconstruction: true,
        observations: options.observations ? {reference:reference.y,predicted:check.y} : null,
        diagnostics: { method: 'firmware multichannel reconstruction', heldoutEvery: options.holdout === false ? 0 : 5, rounds:completedRounds, axes, decimationClosure, validation } };
}

function reconstructWindows(seg, windows, progress = () => {}) {
    if(!windows.length)return;
    const nf=seg.cfg.rates.gyroHz/seg.cfg.rates.logHz, ff=seg.cfg.rates.filterHz/seg.cfg.rates.logHz;
    const pf=seg.cfg.rates.pidHz/seg.cfg.rates.logHz;
    // Commit blocks in chronological order. A later inverse must neither
    // refit its already reconstructed history nor seed its adaptive notches
    // from a different, raw-only trajectory.
    const history=seg.raw.map(x=>R.resample(x,nf,seg.cfg.rates.offsetTicks/nf,0,seg.n));
    const stream=R.engine(seg.cfg,Array(3).fill({gyro_cutoff:0,d_cutoff:0,Kp:0,Kd:0}),{state:seg.initialState});
    const wanted=new Set(windows.map(w=>w.st-w.lead));
    let cursor=0,committedEnd=0;
    seg.replayStates=new Map();
    if(stream.dynamic)seg.dynamicSeeds=new Map();
    function remember(frame) {
        if(!wanted.has(frame))return;
        seg.replayStates.set(frame,stream.snapshot());
        if(stream.dynamic)seg.dynamicSeeds.set(frame,Float64Array.from(stream.dynamic.X.cen));
    }
    function advance(end) {
        for(;cursor<end*ff;cursor++) {
            const frame=cursor/ff;
            remember(frame);
            stream.tick(history.map(x=>x[cursor*seg.cfg.rates.filtDenom]),...drivers(seg.cfg,seg,0,cursor));
        }
        remember(end);
    }
    for(const group of reconstructionBlocks(windows)) {
        const first=group[0],final=group[group.length-1];
        const start=first.st-first.lead,last=final.st+final.N;
        advance(start);
        const fixedPrefix=Math.max(0,committedEnd-start)*nf;
        const initialNative=history.map(x=>x.subarray(start*nf,last*nf));
        const block=reconstruct(seg.cfg,seg,start,last,seg.observers[first.profile],{observations:true,initialNative,fixedPrefix});
        for(const k of ['native','sensor','raw'])if(block[k])block[k]=block[k].map(x=>Float32Array.from(x));
        for(let a=0;a<3;a++)history[a].set(block.native[a],start*nf);
        committedEnd=last;
        for(const w of group) {
            const from=w.st-w.lead,to=w.st+w.N,relative=from-start,stop=to-start;
            const slice=(key,rate)=>block[key]?block[key].map(x=>x.subarray(relative*rate,stop*rate)):null;
            const diagnostics={...block.diagnostics};
            if(block.observations) diagnostics.validation=[0,1,2].map(a=>{
                let error=0,priorError=0,samples=0,rawError=0;
                for(let l=w.st-start;l<stop;l++) if(l%5===2) {
                    const obs=seg.filt[a][start+l];error+=(block.observations.predicted[a][l*ff]-obs)**2;
                    priorError+=(block.observations.reference[a][l*ff]-obs)**2;
                    rawError+=(block.native[a][l*nf+seg.cfg.rates.offsetTicks]-seg.raw[a][start+l])**2;samples++;
                }
                return {error,priorError,rawError,samples};
            });
            w.input={start:from,end:to,factor:ff,offset:block.offset,native:slice('native',nf),sensor:slice('sensor',nf),raw:slice('raw',ff),nativeHz:block.nativeHz,
                originalDecimationHz:block.originalDecimationHz,reconstruction:block.reconstruction,holdoutPhase:relative%5,diagnostics,
                centers:seg.dynamicSeeds&&seg.dynamicSeeds.get(from),rpm:block.rpm?{hs:block.rpm.hs.subarray(relative*pf,stop*pf),tail:block.rpm.tail&&block.rpm.tail.subarray(relative*pf,stop*pf)}:null};
            progress(w);
        }
    }
    advance(committedEnd);
    for(const w of windows) {
        w.input.state=seg.replayStates.get(w.input.start);
        w.input.phase=w.input.start*ff;
        if(seg.dynamicSeeds)w.input.centers=seg.dynamicSeeds.get(w.input.start);
    }
}

function candidateInput(cfg, inp) {
    let out = inp;
    if (inp.sensor && cfg.s.gyro_decimation_hz !== inp.originalDecimationHz) {
        const native = inp.sensor.map(x => filter(x, decimation(cfg.s.gyro_decimation_hz, inp.nativeHz)));
        out = { ...out, raw: native.map(x => Float64Array.from({length:Math.floor(x.length / cfg.rates.filtDenom)},(_,i)=>x[i*cfg.rates.filtDenom])) };
    }
    if (inp.rpm && cfg.s.motor_rpm_lpf) out = { ...out, drivers: {
        hs: filter(inp.rpm.hs, FT.lowpassSections(8, cfg.s.motor_rpm_lpf[0], cfg.rates.pidHz)),
        tail: inp.rpm.tail ? filter(inp.rpm.tail, FT.lowpassSections(8, cfg.s.motor_rpm_lpf[1], cfg.rates.pidHz)) : null } };
    return out;
}

function join(seg, windows) {
    if (!windows.length) throw new Error('There are no complete flight windows to replay.');
    const cfg=seg.cfg,r=cfg.rates,end=Math.max(...windows.map(w=>w.st+w.N)),nativeFactor=r.gyroHz/r.logHz;
    let native=seg.raw.map(x=>R.resample(x,nativeFactor,r.offsetTicks/nativeFactor,0,end));
    // Warmup estimates fill the surrounding trajectory. Scored observations
    // have priority where estimates overlap. The resulting input is frozen
    // before any candidate is selected or evaluated on the reserved blocks.
    for(const scored of [false,true]) for(const w of windows) {
        const start=scored?w.st:w.st-w.lead, first=(start-w.input.start)*nativeFactor, last=(w.st+w.N-w.input.start)*nativeFactor;
        for(let a=0;a<3;a++)native[a].set(w.input.native[a].subarray(first,last),start*nativeFactor);
    }
    let sensor=null;
    if(Number.isFinite(cfg.s.gyro_decimation_hz)) {
        const sections=decimation(cfg.s.gyro_decimation_hz,r.gyroHz);
        sensor=native.map(x=>Float32Array.from(invert(x,sections)));
        native=sensor.map(x=>filter(x,sections));
    }
    const raw=native.map(x=>Float32Array.from({length:Math.floor(x.length/r.filtDenom)},(_,i)=>x[i*r.filtDenom]));
    let rpm=null;
    if(cfg.s.motor_rpm_lpf) {
        const recover=(x,a)=>x?Float32Array.from(invert(R.resample(x,r.pidHz/r.logHz,0,0,end),FT.lowpassSections(8,cfg.s.motor_rpm_lpf[a],r.pidHz))):null;
        rpm={hs:recover(seg.hs,0),tail:cfg.gear&&cfg.gear.motorisedTail?recover(seg.tail,1):null};
    }
    return {start:0,end,raw,sensor,rpm,state:seg.initialState,nativeHz:r.gyroHz,factor:r.filterHz/r.logHz,offset:r.offsetTicks/nativeFactor,originalDecimationHz:cfg.s.gyro_decimation_hz,reconstruction:true};
}

module.exports = { reconstruct, reconstructWindows, candidateInput, join, seedHistory, schedulerScale, governorRatio, pidObserver, pObservation, calibrateTiming, phaseState, reconstructionBlocks, decimation, filter, invert, drivers, stage, chain, constant, cg, record, forward, solveAxis, recordDynamicJacobian, linearizeDynamic };
