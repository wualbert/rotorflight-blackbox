import json, numpy as np
exec(open('scripts/nocurrent.py').read().split("for D, logs in")[0])
def pt2(x, fc, fs=1000.0):
    # Betaflight/RF PT2: two PT1 at fc*1.553773974
    c = fc * 1.553773974; k = (2*np.pi*c/fs) / (2*np.pi*c/fs + 1)
    y1 = np.zeros_like(x); y2 = np.zeros_like(x); a = b = 0.0
    for i in range(len(x)):
        a += k*(x[i]-a); b += k*(a-b); y2[i] = b
    return y2
for D, li, T in [('fb',13,4500),('fb',11,4500),('gaui',48,2500)]:
    t,F,gov=load(D,li)
    m0,m1,m2,m3=[F[f'mixer[{k}]']/1000 for k in range(4)]; gF=F['govF']/1000; tg=F['govTarget']
    act=(gov==4)&(np.abs(tg-T)<30)&(gF<0.395)
    cyc=np.sqrt(m0**2+m1**2)
    best=None
    for e in (1.0,1.5,2.0,2.5):
        for fc in (2.5,5,10):
            X=np.c_[pt2(np.abs(m3)**e,fc), pt2(cyc,fc), pt2(np.abs(m2),fc)]
            c,*_=np.linalg.lstsq(X[act],gF[act],rcond=None); r=np.sqrt(np.mean((gF[act]-X[act]@c)**2))
            if best is None or r<best[0]: best=(r,e,fc,c)
    r,e,fc,c=best
    print(f"{D} log{li} T={T}: best exponent={e} (curve={e*10:.0f}) ff_filter={fc} Hz  K*Kf*w = coll {c[0]:.4f} cyc {c[1]:.4f} yaw {c[2]:.4f} rms={r*1000:.2f}e-3 (govF p99={np.percentile(gF[act],99):.3f})")
