import json, numpy as np
exec(open('scripts/nocurrent.py').read().split("for D, logs in")[0])
for D,li in [('gaui',48),('gaui',38),('gaui',49),('fb',11),('fb',15)]:
    t,F,gov=load(D,li); d=F['motor[0]']/1000; V=F['Vbat']/100; I=F['Ibat']/100; w=F['headspeed']
    act=(gov==4)
    W=2000
    res=[]
    for lag in (0,20,40,60,80,100,150,200,300):
        Vs=np.r_[V[lag:],np.full(lag,V[-1])]; Is=np.r_[I[lag:],np.full(lag,I[-1])]
        m=act.copy(); m[:W]=False; m[-W-lag:]=False
        ke=1/ (155.5 if D=='gaui' else 270.0)
        x=hp(d*(d*Vs-ke*w),W); y=hp(Vs,W); z=hp(d,W)
        b=-np.sum(z[m]*y[m])/np.sum(z[m]*x[m])
        s=f"lag {lag}ms beta_IV(d)={b:.3f}"
        if (I>0).mean()>0.5:
            # corr of hp(d*(dV-ke w)) [current proxy, using lagged V] with lagged I, and of throttle with lagged I
            c=np.corrcoef(hp(d,W)[m],hp(Is,W)[m])[0,1]; c2=np.corrcoef(hp(Vs,W)[m],hp(Is,W)[m])[0,1]
            s+=f" corr(hp d, hp I_lagged)={c:.3f} corr(hp V_lag, hp I_lag)={c2:.3f}"
        else:
            c=np.corrcoef(hp(d,W)[m],hp(Vs,W)[m])[0,1]; s+=f" corr(hp d, hp V_lagged)={c:.3f}"
        res.append(s)
    print(D,li); print('\n'.join('  '+r for r in res))
