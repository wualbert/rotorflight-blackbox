import json, numpy as np
exec(open('scripts/nocurrent.py').read().split("for D, logs in")[0])
for D, logs in [('fb',[0,2,3,4,5,6,8,9,10,11,13,14,15]),('gaui',[38,39,40,41,43,45,46,47,48,49])]:
    tot=0; rows=[]; dur=0; hi=0; sat=0; fb_after=0
    for li in logs:
        t,F,gov=load(D,li); hs=F['headspeed']; d=F['motor[0]']/1000; tg=np.maximum(F['govTarget'],1); I=F['Ibat']/100
        gv=np.isin(gov,[3,4,6,8])
        jump=np.zeros(len(hs)); jump[3:]=(hs[3:]-hs[:-3])
        cand=np.where(gv&(np.abs(jump)>0.08*tg))[0]
        ev=[]
        for i in cand:
            if not ev or i-ev[-1]>50: ev.append(i)
        dur+=gv.sum()/1000; tot+=len(ev)
        for i in ev:
            hi+= d[i-4]>=0.9; sat+= d[i-4]>=0.995
            fb_after+= np.any(gov[i:i+20]==6)
        rows.append(f"log{li}: n={len(ev)} " + ' '.join(f"[t={t[i]:.2f} thr={d[i-4]:.2f} dHS3ms={jump[i]:+.0f} I={I[i-4]:.0f} fb={'Y' if np.any(gov[i:i+20]==6) else 'n'}]" for i in ev[:10]))
    print(f"{D}: {tot} jumps >8% of target within 3 ms in {dur:.0f} s governed; thr>=0.9: {hi}; thr saturated: {sat}; followed by FALLBACK within 20 ms: {fb_after}")
    for r in rows: print('   ',r)
