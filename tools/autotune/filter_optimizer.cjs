'use strict';

// Upstream NOMAD 4.5.1, not a reimplementation of MADS. All evaluations in
// one call use the same objective, constraints, sample set and integer domain.
// The outer topology search is separate and has no global convergence claim.
let runtime, active = false;
function minimize(o) {
    const { lower, upper, initial, evaluate } = o, n = initial && initial.length;
    const integer = o.integer !== false, maxEvaluations = o.maxEvaluations || 160;
    if (!n || !Array.isArray(lower) || !Array.isArray(upper) || lower.length !== n || upper.length !== n ||
        !initial.every((v,i)=>Number.isFinite(v) && Number.isFinite(lower[i]) && Number.isFinite(upper[i]) &&
            lower[i] <= v && v <= upper[i] && lower[i] < upper[i] && (!integer || [v,lower[i],upper[i]].every(Number.isInteger))) ||
        !Number.isInteger(maxEvaluations) || maxEvaluations < 1 || typeof evaluate !== 'function')
        throw Error('Invalid optimizer domain or evaluation budget.');
    if (active) throw Error('The optimizer is already running.');
    const constraints = o.constraints || 0;
    if (!Number.isInteger(constraints) || constraints < 0) throw Error('Invalid optimizer constraint count.');
    runtime = runtime || require('./optimizer/nomad.cjs');
    const started = Date.now(), timeMs = o.timeMs === undefined ? 120000 : o.timeMs;
    if (!(Number.isFinite(timeMs) && timeMs > 0)) throw Error('Invalid optimizer time budget.');
    let best = null, infeasible = null, evaluations = 0, failure = null, timeStop = false;
    const cache = new Map();
    const call = x => {
        const key = JSON.stringify(x);
        if (cache.has(key)) return cache.get(key);
        if (Date.now()-started >= timeMs) { timeStop = true; return false; }
        if (evaluations >= maxEvaluations) return false;
        evaluations++;
        let values;
        try { values = evaluate(x); } catch (e) { failure = e; return false; }
        if (values !== null && (!Array.isArray(values) || values.length !== constraints+1 || !values.every(Number.isFinite))) {
            failure = Error('The optimizer evaluation returned invalid values.'); return false;
        }
        cache.set(key,values);
        if (values) {
            const point = { x:x.slice(), values:values.slice(), violation:values.slice(1).reduce((a,c)=>a+Math.max(0,c)**2,0) };
            if (point.violation === 0) { if (!best || values[0] < best.values[0]) best = point; }
            else if (!infeasible || point.violation < infeasible.violation || point.violation === infeasible.violation && values[0] < infeasible.values[0]) infeasible = point;
        }
        return values;
    };
    // No surrogate subsolver is needed for these short deterministic replays.
    // MAX_EVAL also bounds cache hits on a finite grid. MAX_TIME bounds the
    // library between callbacks; callbacks themselves check the precise budget.
    const solverBudget=integer&&o.audit!==false?Math.max(1,maxEvaluations-2*n):maxEvaluations;
    const lines = [
        `DIMENSION ${n}`, `BB_INPUT_TYPE * ${integer?'I':'R'}`,
        'BB_OUTPUT_TYPE OBJ'+Array(constraints).fill(' PB').join(''),
        `LOWER_BOUND ( ${lower.join(' ')} )`, `UPPER_BOUND ( ${upper.join(' ')} )`,
        `X0 ( ${initial.join(' ')} )`, `MAX_BB_EVAL ${solverBudget}`,
        `MAX_EVAL ${10*maxEvaluations}`, `MAX_ITERATIONS ${10*maxEvaluations}`,
        `MAX_TIME ${Math.max(1,Math.ceil(timeMs/1000))}`, 'DISPLAY_DEGREE 0',
        'DIRECTION_TYPE ORTHO 2N', 'QUAD_MODEL_SEARCH false', 'NM_SEARCH false',
        'SEED 17'
    ];
    if (o.frame) {
        if (!Array.isArray(o.frame) || o.frame.length !== n || !o.frame.every(v=>Number.isFinite(v)&&v>0)) throw Error('Invalid optimizer initial frame.');
        lines.push(`INITIAL_FRAME_SIZE ( ${o.frame.join(' ')} )`);
    }
    const params=lines.join('\n')+'\n', bytes=runtime.lengthBytesUTF8(params)+1, ptr=runtime._malloc(bytes);
    let code, detail;
    active = true;
    try {
        runtime.evaluate = call;
        runtime.stringToUTF8(params,ptr,bytes);
        code=runtime._rf_nomad_optimize(ptr,constraints+1);
        detail=runtime.UTF8ToString(runtime._rf_nomad_message());
    } finally { runtime._free(ptr); runtime.evaluate=null; active=false; }
    if (failure) throw failure;
    if (code === -99 || code === -3) throw Error('NOMAD failed: '+detail);
    // A completed coordinate audit is a finite, explicit certificate for the
    // stated neighbourhood, independent of differentiability or MADS theorems.
    // It does not prove optimality along coupled directions or other topologies.
    const audit={kind:'integer coordinate neighbours',complete:false,passed:false,tested:0,neighbours:0};
    if (integer && best && o.audit !== false) {
        const center=best, neighbours=[];
        for(let i=0;i<n;i++)for(const d of [-1,1])if(center.x[i]+d>=lower[i]&&center.x[i]+d<=upper[i]) {
            const x=center.x.slice();x[i]+=d;neighbours.push(x);
        }
        audit.neighbours=neighbours.length; audit.center=center.x.slice();
        let improved=false;
        for(const x of neighbours) {
            const v=call(x);if(v===false)break;
            audit.tested++;
            if(v&&v.slice(1).every(c=>c<=0)&&v[0]<center.values[0])improved=true;
        }
        audit.complete=audit.tested===audit.neighbours; audit.passed=audit.complete&&!improved;
    }
    if(failure)throw failure;
    const stop = timeStop || code===-4 ? 'time budget' : /Maximum number|Max number|Maximum iteration/i.test(detail) || evaluations>=maxEvaluations || code===0 || code===-2 ? 'evaluation budget' :
        code===1 || code===-1 ? 'mesh limit' : code===-5 ? 'stopped' : 'library stop';
    return {algorithm:'NOMAD 4.5.1 MADS with progressive barrier',code,stop,detail,evaluations,ms:Date.now()-started,best,infeasible,audit};
}

// Filter topology (types, active slots, source numbers and tracker count) is
// fixed within each solve. Numeric parameters use firmware integer units.
function domain(P, seed) {
    const A=require('./filter_autotune.cjs'), FT=require('./filter_tune.cjs');
    const changes={...seed}, s={...P.ref.s,...seed}, axes=['roll','pitch','yaw'], variables=[];
    const add=(name,lo,hi,value,index)=>{
        if(Number.isInteger(value)&&Number.isInteger(lo)&&Number.isInteger(hi)&&lo<hi&&value>=lo&&value<=hi)
            variables.push({name,index,lo,hi,value});
    };
    const filterLimit=Math.floor(Math.min(1000,...P.segments.map(seg=>.45*seg.cfg.rates.filterHz)));
    if(s.gyro_decimation_hz>0&&P.segments.every(seg=>Number.isFinite(seg.cfg.s.gyro_decimation_hz)))
        add('gyro_decimation_hz',100,Math.min(1000,...P.segments.map(seg=>Math.round(.3*seg.cfg.rates.gyroHz))),s.gyro_decimation_hz);
    for(const slot of [1,2]) {
        if(s[`gyro_lpf${slot}_type`]>0&&s[`gyro_lpf${slot}_static_hz`]>0)
            add(`gyro_lpf${slot}_static_hz`,1,filterLimit,s[`gyro_lpf${slot}_static_hz`]);
        if(s[`gyro_notch${slot}_hz`]>0&&s[`gyro_notch${slot}_cutoff`]>0) {
            add(`gyro_notch${slot}_hz`,1,1000,s[`gyro_notch${slot}_hz`]);
            add(`gyro_notch${slot}_cutoff`,1,1000,s[`gyro_notch${slot}_cutoff`]);
        }
    }
    if(s.gyro_lpf1_type>0&&s.gyro_lpf1_dyn_min_hz>0&&P.segments.every(seg=>seg.ratio))
        for(const what of ['min','max'])add(`gyro_lpf1_dyn_${what}_hz`,1,1000,s[`gyro_lpf1_dyn_${what}_hz`]);
    if(s.DYN_NOTCH&&s.dyn_notch_count>0)
        for(const k of ['dyn_notch_q','dyn_notch_min_hz','dyn_notch_max_hz'])add(k,...FT.FW_RANGE[k],s[k]);
    if(s.RPM_FILTER) {
        add('gyro_rpm_notch_min_hz',1,100,s.gyro_rpm_notch_min_hz);
        const banks=FT.effectiveBanks(s);
        if(banks.every(Boolean)) {
            changes.gyro_rpm_notch_preset=0;
            axes.forEach((ax,a)=>['source','q','center'].forEach(k=>{
                const name=`gyro_rpm_notch_${k}_${ax}`;
                changes[name]=Array.from({length:16},(_,i)=>banks[a][i]?banks[a][i][k]:0);
                if(k!=='source')banks[a].forEach((b,i)=>add(name,...FT.FW_RANGE['rpm_notch_'+k],b[k],i));
            }));
        }
    }
    if(s.motor_rpm_lpf&&P.segments.every(seg=>seg.cfg.s.motor_rpm_lpf))
        for(const i of P.ref.gear&&P.ref.gear.motorisedTail?[0,1]:[0])if(s.motor_rpm_lpf[i]>0)add('motor_rpm_lpf',1,255,s.motor_rpm_lpf[i],i);
    const profiles=new Map();
    for(const w of P.windows)if(!w.held&&w.profile>0)profiles.set(w.profile,w);
    for(const [p,w] of profiles) A.paths(w,seed).forEach((path,a)=>{
        if(!path.known)return;
        if(path.gyro_cutoff>0)add(`p${p}:${axes[a]}_gyro_cutoff`,1,250,path.gyro_cutoff);
        if(path.Kd>0)add(`p${p}:${axes[a]}_d_cutoff`,1,250,path.d_cutoff);
    });
    const decode=x=>{
        const out={...changes};
        variables.forEach((v,i)=>{
            if(v.index===undefined)out[v.name]=x[i];
            else { if(out[v.name]===changes[v.name]||out[v.name]===undefined)out[v.name]=(changes[v.name]||s[v.name]).slice();out[v.name][v.index]=x[i]; }
        });
        return out;
    };
    const admissible=x=>{
        const c=decode(x),v={...s,...c};
        return !A.invalid(P,c).length && [1,2].every(i=>!v[`gyro_notch${i}_hz`]||v[`gyro_notch${i}_cutoff`]<v[`gyro_notch${i}_hz`]) &&
            (!v.gyro_lpf1_dyn_min_hz||v.gyro_lpf1_dyn_min_hz<=v.gyro_lpf1_dyn_max_hz);
    };
    return {variables,lower:variables.map(v=>v.lo),upper:variables.map(v=>v.hi),initial:variables.map(v=>v.value),
        frame:variables.map(v=>Math.max(1,Math.round(Math.min((v.hi-v.lo)/10,Math.max(5,v.value*.2))))),decode,admissible};
}

function topology(P,changes) {
    const FT=require('./filter_tune.cjs'),A=require('./filter_autotune.cjs'),s={...P.ref.s,...changes},profiles=new Map();
    for(const w of P.windows)if(!w.held&&w.profile>0&&!profiles.has(w.profile))
        profiles.set(w.profile,A.paths(w,changes).map(p=>[p.known,p.gyro_cutoff>0,p.Kd>0]));
    return JSON.stringify([s.gyro_decimation_hz>0,...[1,2].flatMap(i=>[s[`gyro_lpf${i}_type`],s[`gyro_lpf${i}_static_hz`]>0,s[`gyro_notch${i}_hz`]>0]),
        s.gyro_lpf1_dyn_min_hz>0,s.DYN_NOTCH,s.dyn_notch_count,s.RPM_FILTER,
        s.RPM_FILTER?FT.effectiveBanks(s).map(bank=>bank&&bank.map(b=>b.source)):null,[...profiles].sort((a,b)=>a[0]-b[0])]);
}

module.exports={minimize,domain,topology};
