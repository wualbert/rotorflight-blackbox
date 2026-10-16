import json, numpy as np
exec(open('scripts/nocurrent.py').read().split("for D, logs in")[0])
for D, logs, T in [('fb',[5,10,11,13,14,15],4500),('gaui',[38,48,49],2500)]:
    for li in logs:
        t,F,gov=load(D,li); d=F['motor[0]']/1000; V=F['Vbat']/100; w=F['headspeed']; tg=F['govTarget']; I=F['Ibat']/100
        m=(gov==4)&(np.abs(tg-T)<30)
        idx=np.where(m)[0]
        if len(idx)<60000: continue
        a=idx[:30000]; b=idx[-30000:]
        sat=(gov==4)&(d>=0.995)
        # saturation runs
        dd=np.diff(np.r_[0,sat.astype(int),0]); s=np.where(dd==1)[0]; e=np.where(dd==-1)[0]
        runs=[(t[x],(y-x)/1000) for x,y in zip(s,e) if y-x>=30]
        Vs=[np.median(V[x:y]) for x,y in zip(s,e) if y-x>=30]
        print(f"{D} log{li} T={T}: first30s thr50={np.median(d[a]):.3f} V50={np.median(V[a]):.2f} dV50={np.median(d[a]*V[a]):.2f} | last30s thr50={np.median(d[b]):.3f} V50={np.median(V[b]):.2f} dV50={np.median(d[b]*V[b]):.2f}"
              + (f" | I50 first={np.median(I[a]):.1f} last={np.median(I[b]):.1f}" if (I>0).mean()>0.5 else "")
              + f" | sat runs>=30ms: n={len(runs)} total={sum(r[1] for r in runs):.2f}s longest={max([r[1] for r in runs],default=0):.2f}s at t={[round(r[0]) for r in runs][:12]} V_med_at_sat={np.round(Vs[:12],2).tolist()}")
