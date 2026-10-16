import json, numpy as np
exec(open('scripts/nocurrent.py').read().split("for D, logs in")[0])
for D, logs in [('gaui',[38,39,40,41,43,45,46,47,48,49]),('fb',[5,10,11,13,14,15])]:
    for li in logs:
        t,F,gov=load(D,li); d=F['motor[0]']/1000; V=F['Vbat']/100; I=F['Ibat']/100; w=F['headspeed']
        B=50; n=len(t)//B
        def blk(x): return x[:n*B].reshape(n,B).mean(1)
        act=blk((gov==4).astype(float))>0.99
        d_,V_,I_,w_=blk(d),blk(V),blk(I),blk(w)
        # 1 s smoothed ratio in ACTIVE, steady (|dw| small)
        r=w_/np.maximum(d_*V_,1e-3); W1=20
        rs=np.convolve(r,np.ones(W1)/W1,mode='same'); ok=act&(d_>0.3)
        kv_hat=np.percentile(rs[ok],99.5); ke=1/kv_hat
        W=40; m=act.copy(); m[:W]=False; m[-W:]=False
        x=hp(d_*(d_*V_-ke*w_),W); y=hp(V_,W)
        z=hp(np.abs(blk(F["mixer[3]"]/1000)),W); beta=-np.sum(z[m]*y[m])/np.sum(z[m]*x[m]); res=np.std(y[m]+beta*x[m]); bz=-np.sum(hp(d_,W)[m]*y[m])/np.sum(hp(d_,W)[m]*x[m]); out0=f" IV(|coll|) beta={beta:.3f} IV(d) beta={bz:.3f}"
        out=f"{D} log{li}: kv_hat={kv_hat:.1f}"+out0
        if (I>0).mean()>0.5:
            yb=hp(V_,W)[m]; xb=hp(I_,W)[m]; Rb=-np.polyfit(xb,yb,1)[0]
            mm=act&(d_>0.3); A2=np.c_[w_[mm],I_[mm]/d_[mm]]; c2,*_=np.linalg.lstsq(A2,(d_*V_)[mm],rcond=None)
            # predicted current without current sensor: I_bat = d*(dV - ke w)/Rm  (Rm from current fit, as a check of shape)
            Ipred=d_*(d_*V_-ke*w_)/c2[1]
            cc=np.corrcoef(Ipred[act],I_[act])[0,1]
            out+=f" | current-based Rb/Rm={Rb/c2[1]:.3f} kv={1/c2[0]:.1f} | corr(I_pred_noCurrentShape, I_meas)={cc:.3f}"
        print(out)
