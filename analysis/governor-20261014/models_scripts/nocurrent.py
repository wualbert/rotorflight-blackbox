import json, numpy as np, sys
def load(D, li):
    j=json.load(open(f'{D}/log{li:02d}.json')); a=np.load(f'{D}/log{li:02d}.npy').astype(float); F={n:a[:,k] for k,n in enumerate(j['fields'])}
    gov=np.zeros(j['n'],int); last=0; g=0
    for e in sorted(j['events'],key=lambda e:e['i']):
        if e['event']==50: gov[last:e['i']]=g; last=e['i']; g=e['data']['govState']
    gov[last:]=g
    return (F['time']-F['time'][0])/1e6, F, gov
def hp(x, w):
    c=np.convolve(x,np.ones(w)/w,mode='same'); return x-c
for D, logs in [('gaui',[38,39,40,41,43,45,46,47,48,49]),('fb',[5,10,11,13,14,15])]:
    for li in logs:
        t,F,gov=load(D,li); d=F['motor[0]']/1000; V=F['Vbat']/100; I=F['Ibat']/100; w=F['headspeed']
        # resample to Vbat update instants? use 50 ms block means to reduce ESC telemetry quantization/latency
        B=50; n=len(t)//B
        def blk(x): return x[:n*B].reshape(n,B).mean(1)
        act=blk((gov==4).astype(float))>0.99
        d_,V_,I_,w_=blk(d),blk(V),blk(I),blk(w)
        W=40  # 2 s high-pass
        m=act.copy(); m[:W]=False; m[-W:]=False
        x1=hp(d_**2*V_,W); x2=hp(d_*w_,W); y=hp(V_,W)
        # V = OCV - beta*d*(d*V - ke*w)  ->  y = -beta*x1 + beta*ke*x2
        A=np.c_[x1[m],x2[m]]; c,*_=np.linalg.lstsq(A,y[m],rcond=None)
        beta=-c[0]; ke=c[1]/beta if beta!=0 else np.nan
        res=y[m]-A@c
        # bootstrap over 5 s blocks for SE
        idx=np.where(m)[0]; nb=len(idx)//100; est=[]
        rng=np.random.default_rng(0)
        if nb>=5:
            chunks=[idx[k*100:(k+1)*100] for k in range(nb)]
            for _ in range(200):
                sel=np.concatenate([chunks[k] for k in rng.integers(0,nb,nb)])
                cc,*_=np.linalg.lstsq(np.c_[x1[sel],x2[sel]],y[sel],rcond=None); b=-cc[0]; est.append((b, cc[1]/b))
            est=np.array(est); se=est.std(0)
        else: se=[np.nan,np.nan]
        out=f"{D} log{li}: no-current fit beta=Rb/Rm={beta:.3f}±{se[0]:.3f}  kv=1/ke={1/ke:.1f}±{se[1]/ke**2:.1f} rpm/V  res_rms={np.std(res)*1000:.0f} mV n={m.sum()}"
        if (I>0).mean()>0.5:
            # with current: Rb from hp(V) vs hp(I); Rm, ke from d*V = ke*w + Rm*I/d
            yb=hp(V_,W)[m]; xb=hp(I_,W)[m]; Rb=-np.polyfit(xb,yb,1)[0]
            mm=act&(d_>0.3); A2=np.c_[w_[mm],I_[mm]/d_[mm]]; c2,*_=np.linalg.lstsq(A2,(d_*V_)[mm],rcond=None)
            out+=f" | with current: Rb={Rb*1000:.1f} mOhm Rm={c2[1]*1000:.1f} mOhm Rb/Rm={Rb/c2[1]:.3f} kv={1/c2[0]:.1f}"
        print(out)
