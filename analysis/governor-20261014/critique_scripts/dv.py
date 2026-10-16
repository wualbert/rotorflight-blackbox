import numpy as np
exec(open('check.py').read().split("what = sys.argv[1]")[0])
uns, alls, nsat, ntot = [], [], 0, 0
for s in load('fireball'):
    ph = np.fromfile(f"{D}/fireball/{s['meta']['name']}.phase", dtype=np.uint8)
    a = (s['st'] == 4) & (ph == 3) & (np.round(s['govRequest']/50)*50 == 4500) & (s['rescueAt'] == 0)
    V = np.roll(s['Vbat']/100, -66); m = s['motor[0]']/1000
    dv = m*V
    sat = a & (m >= 0.98)
    uns.append(dv[a & ~sat]); alls.append(np.where(sat, np.inf, dv)[a]); nsat += sat.sum(); ntot += a.sum()
u = np.concatenate(uns); c = np.concatenate(alls)
print('4500 rpm ACTIVE flight samples', ntot, 'saturated share %.2f %%' % (100*nsat/ntot))
for p in (95, 99, 99.5):
    print('p%s D*V: unsaturated only %.2f V ; all samples with saturated = +inf (censored, lower bound of true pct) %s' % (p, np.percentile(u, p), np.percentile(c, p)))
