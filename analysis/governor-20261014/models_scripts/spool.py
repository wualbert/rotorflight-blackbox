import json, numpy as np
exec(open('scripts/nocurrent.py').read().split("for D, logs in")[0])
for D, logs in [('fb',[0,2,3,4,5,6,8,9,10,11,13,14,15]),('gaui',[38,39,40,41,43,45,46,47,48,49])]:
    for li in logs:
        t,F,gov=load(D,li); d=F['motor[0]']/1000; V=F['Vbat']/100; w=F['headspeed']; tg=F['govTarget']; rq=F['govRequest']
        sp=np.where((gov[:-1]==2)&(gov[1:]==4))[0]
        for e in sp:
            s=e
            while s>0 and gov[s-1]==2: s-=1
            k=min(len(t)-1,e+3000)
            ov=np.max((w[e:k]-rq[e])/rq[e])*100
            # steady throttle: median over 2.5..3.5 s after if still ACTIVE
            kk=slice(e+2500,min(len(t),e+3500)); thr_ss=np.median(d[kk]) if gov[min(len(t)-1,e+3500)]==4 else np.nan
            # throttle ramp slope during spoolup (from 30% to 70% of the duration)
            a=s+int(0.3*(e-s)); b=s+int(0.7*(e-s)); slope=(d[b]-d[a])/(t[b]-t[a])
            # hs accel in the last second of spoolup
            acc=(w[e]-w[max(s,e-1000)])/(t[e]-t[max(s,e-1000)])
            # ratio of hs/(thr*V) at exit vs steady
            r_exit=w[e]/(d[e]*V[e]); r_ss=np.median(w[kk]/(d[kk]*V[kk])) if gov[min(len(t)-1,e+3500)]==4 else np.nan
            print(f"{D} log{li} spool {t[s]:.1f}-{t[e]:.1f}s dur={t[e]-t[s]:.1f} req={rq[e]:.0f} thr_slope={slope:.3f}/s ({1/slope:.1f}s per 100%) thr_exit={d[e]:.3f} thr_ss3s={thr_ss:.3f} excess={d[e]-thr_ss:+.3f} hs_acc_last1s={acc:.0f}rpm/s overshoot={ov:+.1f}% ratio_exit/ss={r_exit/r_ss:.2f} V={V[e]:.2f}")
