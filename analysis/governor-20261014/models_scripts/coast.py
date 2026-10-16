import json, numpy as np, sys
def load(D, li):
    j=json.load(open(f'{D}/log{li:02d}.json')); a=np.load(f'{D}/log{li:02d}.npy').astype(float); F={n:a[:,k] for k,n in enumerate(j['fields'])}
    return (F['time']-F['time'][0])/1e6, F
for D, li, t0 in [('fb',2,37.0),('fb',3,15.9),('fb',8,13.0),('fb',13,300.0),('fb',14,224.3),('gaui',45,146.8),('gaui',48,307.9),('gaui',47,68.5)]:
    t,F=load(D,li); thr=F['motor[0]']/1000; hs=F['headspeed']; coll=F['mixer[3]']/1000
    i0=np.searchsorted(t,t0)
    # find start where thr==0 after t0-0.2
    i=i0
    while thr[i]>0.001: i+=1
    k=i
    while k<len(t)-1 and thr[k]<=0.001 and hs[k]>800: k+=1
    seg=slice(i+20,k)  # skip first 20 ms
    tt=t[seg]; w=hs[seg]*2*np.pi/60
    # smooth derivative by local quadratic over 50 ms windows
    n=50; dw=[]; ww=[]
    for m in range(0,len(tt)-n,n//2):
        p=np.polyfit(tt[m:m+n]-tt[m],w[m:m+n],1); dw.append(p[0]); ww.append(np.mean(w[m:m+n]))
    dw=np.array(dw); ww=np.array(ww)
    if len(ww)<4: print(D,li,'short'); continue
    # models
    A1=np.c_[ww**2]; c1,*_=np.linalg.lstsq(A1,-dw,rcond=None); r1=np.std(-dw-A1@c1)
    A2=np.c_[ww]; c2,*_=np.linalg.lstsq(A2,-dw,rcond=None); r2=np.std(-dw-A2@c2)
    A3=np.c_[ww,ww**2]; c3,*_=np.linalg.lstsq(A3,-dw,rcond=None); r3=np.std(-dw-A3@c3)
    A4=np.c_[np.ones_like(ww),ww**2]; c4,*_=np.linalg.lstsq(A4,-dw,rcond=None); r4=np.std(-dw-A4@c4)
    print(f"{D} log{li} t={t[i]:.2f}..{t[k]:.2f} hs {hs[i]:.0f}->{hs[k-1]:.0f} coll_med={np.median(coll[seg]):.3f} n={len(ww)} decel_at_start={-dw[0]*60/2/np.pi:.0f}rpm/s "
          f"| quad a={c1[0]:.3e} rms={r1:.1f} | lin b={c2[0]:.3f}/s (tau={1/c2[0]:.2f}s) rms={r2:.1f} | lin+quad b={c3[0]:.3f} a={c3[1]:.2e} rms={r3:.1f} | const+quad c={c4[0]:.1f} a={c4[1]:.2e} rms={r4:.1f}")
