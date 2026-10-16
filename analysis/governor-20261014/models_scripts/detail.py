import json, numpy as np, sys
D=sys.argv[1]; li=int(sys.argv[2]); t0=float(sys.argv[3]); t1=float(sys.argv[4]); step=float(sys.argv[5])
j=json.load(open(f'{D}/log{li:02d}.json')); a=np.load(f'{D}/log{li:02d}.npy').astype(float); F={n:a[:,k] for k,n in enumerate(j['fields'])}
t=(F['time']-F['time'][0])/1e6
for tt in np.arange(t0,t1,step):
    i=np.searchsorted(t,tt)
    if i>=len(t): break
    print(f"{t[i]:7.2f} thr={F['motor[0]'][i]/1000:5.3f} hs={F['headspeed'][i]:5.0f} tgt={F['govTarget'][i]:5.0f} req={F['govRequest'][i]:5.0f} V={F['Vbat'][i]/100:5.2f} I={F['Ibat'][i]/100:6.1f} coll={F['mixer[3]'][i]/1000:6.3f} sum={F['govSum'][i]/1000:6.3f} P={F['govP'][i]/1000:6.3f} I_={F['govI'][i]/1000:6.3f} F={F['govF'][i]/1000:6.3f} rc3={F['rcCommand[3]'][i]:6.0f} hs/(thrV)={F['headspeed'][i]/max(F['motor[0]'][i]/1000*F['Vbat'][i]/100,1e-3):6.1f}")
