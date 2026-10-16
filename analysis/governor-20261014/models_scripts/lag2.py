import json, numpy as np
exec(open('scripts/nocurrent.py').read().split("for D, logs in")[0])
def bp(x, w1, w2):
    a=np.convolve(x,np.ones(w1)/w1,mode='same'); b=np.convolve(x,np.ones(w2)/w2,mode='same'); return a-b
for D,li in [('gaui',48),('gaui',38),('fb',11),('fb',13)]:
    t,F,gov=load(D,li); d=F['motor[0]']/1000; V=F['Vbat']/100; I=F['Ibat']/100; w=F['headspeed']; coll=np.abs(F['mixer[3]']/1000)
    act=(gov==4); W=2000
    acc=np.gradient(np.convolve(w,np.ones(20)/20,mode='same'))*1000  # rpm/s
    x=bp(d,20,W)
    res=[]
    for lag in (0,10,20,40,60,80,100,120,150,200):
        def sh(y): return np.r_[y[lag:],np.full(lag,y[-1])]
        m=act.copy(); m[:W]=False; m[-W-lag:]=False
        r_acc=np.corrcoef(x[m],bp(sh(acc),20,W)[m])[0,1]
        r_I=np.corrcoef(x[m],bp(sh(I),20,W)[m])[0,1] if (I>0).mean()>0.5 else np.nan
        r_V=np.corrcoef(x[m],bp(sh(V),20,W)[m])[0,1]
        res.append(f"{lag:3d}ms acc {r_acc:+.2f} I {r_I:+.2f} V {r_V:+.2f}")
    print(D,li,' | '.join(res))
