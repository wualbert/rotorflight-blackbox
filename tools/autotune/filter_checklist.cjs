'use strict';
// Use the existing report analysers and thresholds on recorded and replayed
// outputs. Keep the full time axis and each profile's identity and flight mask.
const setup=require('./health_setup.cjs'),more=require('./health_more.cjs'),loop=require('./health_loop.cjs');
const R=require('./filter_replay.cjs'),C=require('./filter_reconstruct.cjs'),FT=require('./filter_tune.cjs');
const AXES=['roll','pitch','yaw'];
const TITLES={C11:'D-term noise',F1:'Gyro low-pass filter',F2:'Low-pass cutoff',F3:'Notch width',F4:'D-term cutoff',F5:'RPM line coverage',F6:'RPM notch attenuation',F7:'Vibration source',F8:'Dynamic notch',F9:'RPM frequency limits',F10:'D-term and control noise',F11:'Gyro filter delay'};
const basis=id=>['F1','F2','F3','F4'].includes(id)?'configuration':['F5','F8','F9'].includes(id)?'recorded input':'replay';
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
function findings(P,changes,app,opts={}) {
    const A=require('./filter_autotune.cjs'),all=[];
    for(const seg of P.segments) {
        const scored=P.windows.filter(w=>w.seg===seg);
        if(!scored.length)continue;
        const target=changes!==null, changed=target&&Object.keys(changes).length>0, cfg=changed?A.settings(seg.cfg,{...P.ref.s,...changes}):seg.cfg,byProfile=new Map();
        const paths=p=>{if(!byProfile.has(p))byProfile.set(p,A.paths({seg,profile:p},changed?{...P.targetProfiles,...changes}:{}));return byProfile.get(p);};
        let output=null;
        if(target){
            output=opts.outputs && opts.outputs.get(seg);
            if(!output){if(!seg.joined)seg.joined=C.join(seg,scored);output=R.run(cfg,seg,i=>paths(seg.prof[i]),C.candidateInput(cfg,seg.joined));}
        }
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
                const axis=finding.axis || (AXES.includes(finding.profile) ? finding.profile : null);
                const replayable=finding.id==='F10' ? axis==='yaw'&&ps[2].known : finding.id==='C11' ? !!(ps[AXES.indexOf(axis)]||{}).known : true;
                all.push({...finding,axis,profile,segment:seg.id,configuration:seg.w.recordedConfiguration && seg.w.recordedConfiguration.id || null,fromS:seg.fromS,toS:seg.fromS+n/seg.w.rate,replayable,
                    // Mixer/servo feedback is not recreated by a gyro-only replay.
                    ...(target&&!replayable?{severity:'skipped',value:null,se:null,text:finding.id==='C11'||axis==='yaw'?'The recorded PID path is incomplete. The replay cannot confirm this check.':'The gyro replay does not calculate a new mixer or servo output.'}:{})});
            }
        }
    }
    return all;
}
const bad=f=>f.severity==='flag'||f.severity==='error';
function group(list) {
    const out=new Map();
    for(const f of list){const k=[f.id,f.log,f.segment,f.profile,f.axis||'',f.notchSource==null?'':f.notchSource].join(':');if(!out.has(k))out.set(k,[]);out.get(k).push(f);}
    return out;
}
function summary(list) {
    if(!list||!list.length)return {status:'Not evaluated',issues:0,findings:[]};
    const issues=list.filter(bad).length;
    return {status:issues?'Issue':list.some(f=>f.severity==='skipped')?'Not evaluated':list.some(f=>f.thin||/^no (?:finding|result):/i.test(f.text||''))?'Insufficient data':list.every(f=>f.severity==='ok')?'Pass':'Information',issues,findings:list};
}
function trend(id,before,after) {
    if(id==='F5') {
        const b=before.flatMap(f=>f.lines||[]),a=after.flatMap(f=>f.lines||[]);
        if(a.some(l=>!b.some(p=>Math.abs(l.order/p.order-1)<=setup.RULE.line.sameOrder)))return 'worse';
        return a.length<b.length?'improved':null;
    }
    if(!['F6','C11','F10','F11'].includes(id)||before.length!==1||after.length!==1)return null;
    const b=before[0],a=after[0];if(!Number.isFinite(b.value)||!Number.isFinite(a.value))return null;
    const delta=(a.value-b.value)*(id==='F6'?-1:1);
    const known=[b.se,a.se].every(s=>Number.isFinite(s)&&s>=0),margin=known?2*Math.hypot(b.se,a.se):0;
    if(delta>Math.max(1e-9,margin))return 'worse';
    return known&&delta<-Math.max(1e-9,margin)?'improved':null;
}
function counts(rows) {
    return {cleared:rows.filter(r=>r.outcome==='Cleared in replay').length,remaining:rows.filter(r=>r.outcome==='Remains').length,
        improved:rows.filter(r=>r.outcome==='Remains'&&r.trend==='improved').length,
        newIssues:rows.filter(r=>r.outcome==='New issue').length,notEvaluated:rows.filter(r=>r.outcome==='Not evaluated').length};
}
function compareFindings(before,after,opts={}) {
    const B=group(before),N=group(after),baseline=opts.baseline && group(opts.baseline),rows=[];
    for(const key of new Set([...B.keys(),...N.keys()])) {
        const b=summary(B.get(key)),a=summary(N.get(key)),f=(B.get(key)||N.get(key))[0];
        const reproduced=!baseline || summary(baseline.get(key)).issues>0;
        let outcome=a.status==='Not evaluated'||a.status==='Insufficient data'?'Not evaluated':b.issues&& !a.issues?'Cleared in replay':b.issues&&a.issues?'Remains':!b.issues&&a.issues?'New issue':'Unchanged';
        let detail=f.id==='F5'?'This check requires an RPM notch near each strong raw gyro line. Other filters do not change this coverage check.':'';
        if(outcome==='Cleared in replay'&&(!reproduced||opts.unchanged)) {
            outcome='Not evaluated';
            detail='The replay with recorded values does not show this problem. This check cannot confirm a correction.';
        }
        rows.push({key,id:f.id,title:TITLES[f.id],log:f.log,segment:f.segment,configuration:f.configuration,profile:f.profile,axis:f.axis||null,notchSource:f.notchSource,
            fromS:f.fromS,toS:f.toS,before:b,after:a,outcome,basis:basis(f.id),replayable:f.replayable!==false,detail,
            trend:b.issues&&a.issues&&reproduced?trend(f.id,baseline?baseline.get(key)||[]:B.get(key)||[],N.get(key)||[]):null});
    }
    rows.push({key:'F7',id:'F7',title:TITLES.F7,replayable:false,before:{status:'Not evaluated',issues:0,findings:[]},after:{status:'Not evaluated',issues:0,findings:[]},outcome:'Not evaluated',detail:'The recorded vibration source remains the same input to this replay.'});
    return {rows,summary:counts(rows),
        source:'health_setup, health_more and health_loop: original analyse/judge rules',sameRules:true};
}
function verify(check,model) {
    for(const row of check.rows) {
        const independent=row.basis==='configuration'||row.basis==='recorded input';
        const groups=(model.parity||[]).filter(p=>p.log===row.log);
        const matched=groups.length>0&&groups.every(p=>row.axis&&p.axes?p.axes[row.axis]&&p.axes[row.axis].passed:p.passed);
        row.confirmed=independent||row.replayable!==false&&model.supported!==false&&(model.passed||matched);
        if(independent)row.confirmationReason=row.basis==='configuration'?'This check uses the filter parameters. A signal replay is not necessary.':'This check uses the filter parameters and recorded inputs. A signal replay is not necessary.';
        else if(!row.confirmed&&row.replayable!==false) {
            row.calculatedOutcome=row.outcome;row.outcome='Not evaluated';
            row.confirmationReason='The replay does not agree with the recorded output for this check. The calculated signal result is not confirmed.';
        }
    }
    check.confirmed=model.passed;check.summary=counts(check.rows);
    return check;
}
function compare(P,changes,opts={}) {
    const before=P.checklistBefore||(P.checklistBefore=findings(P,null,opts.app));
    return compareFindings(before,findings(P,changes,opts.app,opts),{...opts,unchanged:!Object.keys(changes).length});
}

// Use the original judges for cheap configuration checks during screening.
// Signal checks use complete training periods when finalists are ranked.
function configurationIssues(P,changes) {
    const A=require('./filter_autotune.cjs'),seg=P.segments[P.segments.length-1];
    if(!seg)return [];
    const cfg=A.settings(seg.cfg,{...P.ref.s,...changes}),h=header(seg,cfg,A.paths({seg,profile:seg.firstProfile},{}));
    const w={n:0,rate:seg.w.rate,fromS:0,extra:{},profileAt:[],flight:{...seg.w.flight,header:h}};
    return setup.judge([{log:seg.log,metrics:setup.analyse(w,{gear:cfg.gear})}]).filter(f=>['F1','F2','F3'].includes(f.id)&&bad(f));
}

function assess(check,opts={}) {
    const rows=check && check.rows || [], targets=rows.filter(r=>r.replayable!==false&&r.id!=='F7'&&r.before&&r.before.issues);
    const remaining=targets.filter(r=>r.after&&r.after.issues), unverified=targets.filter(r=>!(r.after&&r.after.issues)&&r.outcome!=='Cleared in replay');
    const added=rows.filter(r=>r.outcome==='New issue'),worse=remaining.filter(r=>r.trend==='worse'),improved=remaining.filter(r=>r.trend==='improved');
    const corrected=targets.filter(r=>r.outcome==='Cleared in replay'),configuration=remaining.filter(r=>['F1','F2','F3'].includes(r.id)),ids=rs=>[...new Set(rs.map(r=>r.id))].sort();
    const reasons=[];
    if(configuration.length)reasons.push('These filter parameter problems are not corrected: '+ids(configuration).join(', ')+'.');
    if(unverified.length)reasons.push('The replay cannot confirm a correction of these filter problems: '+ids(unverified).join(', ')+'.');
    if(added.length)reasons.push('The replay gives new filter problems: '+ids(added).join(', ')+'.');
    if(worse.length)reasons.push('These filter problems increase in the replay: '+ids(worse).join(', ')+'.');
    if(opts.requireProgress!==false&&targets.length&&!corrected.length&&!improved.length)reasons.push('The replay does not correct or decrease a measured filter problem.');
    return {passed:!reasons.length,complete:!remaining.length&&!unverified.length&&!added.length,targets:targets.length,corrected:corrected.length,improved:improved.length,
        remaining:remaining.length,unverified:unverified.length,newIssues:added.length,worsened:worse.length,configurationIssues:configuration.length,
        unavailable:rows.filter(r=>r.replayable===false&&r.before&&r.before.issues).length,
        ids:{remaining:ids(remaining),unverified:ids(unverified),newIssues:ids(added),worsened:ids(worse)},reasons};
}

module.exports={compare,compareFindings,findings,header,summary,configurationIssues,assess,verify};
