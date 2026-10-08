'use strict';
// Use the existing report analysers and thresholds on recorded and replayed
// outputs. Keep the full time axis and each profile's identity and flight mask.
const setup=require('./health_setup.cjs'),more=require('./health_more.cjs'),loop=require('./health_loop.cjs');
const R=require('./filter_replay.cjs'),C=require('./filter_reconstruct.cjs'),FT=require('./filter_tune.cjs');
const AXES=['roll','pitch','yaw'];
const TITLES={C11:'D-term noise',F1:'Gyro low-pass filter',F2:'Low-pass cutoff',F3:'Notch width',F4:'D-term cutoff',F5:'RPM line coverage',F6:'RPM notch attenuation',F7:'Vibration source',F8:'Dynamic notch',F9:'RPM frequency limits',F10:'D-term and control noise',F11:'Gyro filter delay'};
function header(seg,cfg,paths) {
    const h={...seg.w.flight.header},s=cfg.s;
    Object.assign(h,{gyro_soft_type:s.gyro_lpf1_type,gyro_soft2_type:s.gyro_lpf2_type,gyro_lowpass_hz:s.gyro_lpf1_static_hz,gyro_lowpass2_hz:s.gyro_lpf2_static_hz,
        gyro_lowpass_dyn_hz:[s.gyro_lpf1_dyn_min_hz,s.gyro_lpf1_dyn_max_hz],gyro_notch_hz:[s.gyro_notch1_hz,s.gyro_notch2_hz],gyro_notch_cutoff:[s.gyro_notch1_cutoff,s.gyro_notch2_cutoff]});
    for(const name of ['dyn_notch_count','dyn_notch_q','dyn_notch_min_hz','dyn_notch_max_hz','gyro_rpm_notch_preset','gyro_rpm_notch_min_hz'])h[name]=s[name];
    for(const name of ['RPM_FILTER','DYN_NOTCH'])h.features=s[name] ? (h.features||0)|(1<<setup.FEATURE_BITS[name]) : (h.features||0)&~(1<<setup.FEATURE_BITS[name]);
    const banks=FT.effectiveBanks(s);
    AXES.forEach((ax,a)=>{
        for(const field of ['source','q','center'])h[`gyro_rpm_notch_${field}_${ax}`]=Array.from({length:16},(_,i)=>s.RPM_FILTER&&banks[a]&&banks[a][i]?banks[a][i][field]:0);
        if(paths[a].known)h[ax+'BW']=[paths[a].gyro_cutoff,paths[a].d_cutoff,...(h[ax+'BW']||[]).slice(2)];
    });
    return h;
}
function findings(P,changes,app) {
    const A=require('./filter_autotune.cjs'),all=[];
    for(const seg of P.segments) {
        const scored=P.windows.filter(w=>w.seg===seg);
        if(!scored.length)continue;
        const target=changes!==null, changed=target&&Object.keys(changes).length>0, cfg=changed?A.settings(seg.cfg,{...P.ref.s,...changes}):seg.cfg,byProfile=new Map();
        const paths=p=>{if(!byProfile.has(p))byProfile.set(p,A.paths({seg,profile:p},changed?{...P.targetProfiles,...changes}:{}));return byProfile.get(p);};
        let output=null;
        if(target){if(!seg.joined)seg.joined=C.join(seg,scored);output=R.run(cfg,seg,i=>paths(seg.prof[i]),C.candidateInput(cfg,seg.joined));}
        for(const profile of new Set(scored.map(w=>w.profile))) {
            const windows=scored.filter(q=>q.profile===profile),n=Math.max(...windows.map(q=>q.st+q.N)),ps=paths(profile),h=header(seg,cfg,ps),mask=new Uint8Array(n);
            for(const q of windows) for(let i=q.st;i<q.st+q.N;i++)mask[i]=seg.mask[i]&&seg.prof[i]===profile?1:0;
            const w={...seg.w,n,gyro:target?output.y:seg.w.gyro,flight:{...seg.w.flight,header:h},
                D:target?output.d.map((d,a)=>ps[a].known?d:null):seg.w.D};
            const ctx={app,header:h,rate:w.rate,flying:mask,flyingAll:mask,profile:seg.prof,govState:w.govStateAt,gear:cfg.gear,onlyFilters:true};
            const sm=setup.analyse(w,ctx),mm=more.analyse(w,ctx),f={log:seg.log,start:seg.w.flight.start,header:h};
            const fs=setup.judge([{...f,metrics:sm}]).concat(more.judge([{...f,metrics:mm}]),loop.judge([{...f,metrics:loop.analyse(w,ctx)}]));
            for (const ax of AXES) if (!fs.some(q=>q.id==='F4'&&(q.axis===ax||q.profile===ax)))
                fs.push({id:'F4',axis:ax,log:seg.log,severity:'skipped',text:'The recorded D-term cutoff is unknown.'});
            for(const finding of fs.filter(x=>/^F\d+$/.test(x.id)||x.id==='C11')) {
                const replayable=finding.id!=='F10'||finding.axis==='yaw'&&ps[2].known;
                const axis=finding.axis || (AXES.includes(finding.profile) ? finding.profile : null);
                all.push({...finding,axis,profile,segment:seg.id,configuration:seg.w.recordedConfiguration && seg.w.recordedConfiguration.id || null,fromS:seg.fromS,toS:seg.fromS+n/seg.w.rate,replayable,
                    // Mixer/servo feedback is not recreated by a gyro-only replay.
                    ...(target&&!replayable?{severity:'skipped',value:null,se:null,text:axis==='yaw'?'The recorded yaw PID path is incomplete. The replay cannot confirm this check.':'The gyro replay does not calculate a new mixer or servo output.'}:{})});
            }
        }
    }
    return all;
}
const bad=f=>f.severity==='flag'||f.severity==='error';
function group(list) {
    const out=new Map();
    for(const f of list){const k=[f.id,f.log,f.segment,f.profile,f.axis||''].join(':');if(!out.has(k))out.set(k,[]);out.get(k).push(f);}
    return out;
}
function summary(list) {
    if(!list||!list.length)return {status:'Not evaluated',issues:0,findings:[]};
    const issues=list.filter(bad).length;
    return {status:issues?'Issue':list.every(f=>f.severity==='skipped')?'Not evaluated':list.some(f=>f.thin||/^no finding:/.test(f.text||''))?'Insufficient data':list.every(f=>f.severity==='ok')?'Pass':'Information',issues,findings:list};
}
function compare(P,changes,opts={}) {
    const before=P.checklistBefore||(P.checklistBefore=findings(P,null,opts.app)),after=findings(P,changes,opts.app),B=group(before),N=group(after),rows=[];
    for(const key of new Set([...B.keys(),...N.keys()])) {
        const b=summary(B.get(key)),a=summary(N.get(key)),f=(B.get(key)||N.get(key))[0];
        const outcome=a.status==='Not evaluated'||a.status==='Insufficient data'?'Not evaluated':b.issues&& !a.issues?'Cleared in replay':b.issues&&a.issues?'Remains':!b.issues&&a.issues?'New issue':'Unchanged';
        rows.push({key,id:f.id,title:TITLES[f.id],log:f.log,configuration:f.configuration,profile:f.profile,axis:f.axis||null,fromS:f.fromS,toS:f.toS,before:b,after:a,outcome});
    }
    rows.push({key:'F7',id:'F7',title:TITLES.F7,before:{status:'Not evaluated',issues:0,findings:[]},after:{status:'Not evaluated',issues:0,findings:[]},outcome:'Not evaluated',detail:'The recorded vibration source remains the same input to this replay.'});
    return {rows,summary:{cleared:rows.filter(r=>r.outcome==='Cleared in replay').length,remaining:rows.filter(r=>r.outcome==='Remains').length,newIssues:rows.filter(r=>r.outcome==='New issue').length,notEvaluated:rows.filter(r=>r.outcome==='Not evaluated').length},
        source:'health_setup, health_more and health_loop: original analyse/judge rules',sameRules:true};
}
module.exports={compare,findings,header,summary};
