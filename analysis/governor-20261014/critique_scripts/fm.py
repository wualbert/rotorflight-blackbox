import numpy as np, json
exec(open('check.py').read().split("what = sys.argv[1]")[0])
FB = load('fireball')
s = [x for x in FB if x['meta']['log'] == 14][0]
f = s['flightModeFlags'].astype(np.int64); st = s['st']
i = np.nonzero(np.diff(f) != 0)[0]
for k in i:
    if 185000 < k < 197000: print('idx_t %.3f flightModeFlags %d -> %d  state %d' % (k/1000, f[k], f[k+1], st[k+1]))
j = np.nonzero(np.diff(st) != 0)[0]
for k in j:
    if 185000 < k < 197000: print('idx_t %.3f state %d -> %d  motor %.0f hs %.0f coll %.2f' % (k/1000, st[k], st[k+1], s['motor[0]'][k+1], s['hs'][k+1], s['mixer[3]'][k+1]/1000))
