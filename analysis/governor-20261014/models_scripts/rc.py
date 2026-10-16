import json, numpy as np
exec(open('scripts/nocurrent.py').read().split("for D, logs in")[0])
def lp(x, tau, dt=0.001):
    a=dt/(tau+dt); y=np.empty_like(x); s=x[0]
    for i in range(len(x)): s+=a*(x[i]-s); y[i]=s
    return y
for li in (38,48,49):
    t,F,gov=load('gaui',li); V=F['Vbat']/100; I=F['Ibat']/100
    lag=80; Vs=np.r_[V[lag:],np.full(lag,V[-1])]
    m=(gov==4); idx=np.where(m)[0]; a,b=idx[0],idx[-1]; sl=slice(a,b)
    tt=t[sl]-t[a]; y=Vs[sl]; i_=I[sl]
    # coulomb count
    q=np.cumsum(I)*0.001/3600; q=q[sl]
    base=np.c_[np.ones_like(tt), q, q**2]
    X0=np.c_[base,-i_]; c0,*_=np.linalg.lstsq(X0,y,rcond=None); r0=np.sqrt(np.mean((y-X0@c0)**2))
    out=f"gaui log{li}: 0RC: R0={c0[3]*1000:.1f} mOhm rms={r0*1000:.0f} mV, OCV slope={c0[1]:.2f} V/Ah"
    best=None
    for tau in (0.3,1,3,10,30):
        X=np.c_[base,-i_,-lp(I,tau)[sl]]; c,*_=np.linalg.lstsq(X,y,rcond=None); r=np.sqrt(np.mean((y-X@c)**2))
        if best is None or r<best[0]: best=(r,tau,c)
    r,tau,c=best
    out+=f" | 1RC best tau={tau}s R0={c[3]*1000:.1f} R1={c[4]*1000:.1f} mOhm rms={r*1000:.0f} mV; Ah used in ACTIVE={q[-1]-q[0]:.2f}"
    print(out)
