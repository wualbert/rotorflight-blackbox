import numpy as np
exec(open('check.py').read().split("what = sys.argv[1]")[0])
s = [x for x in load('fireball') if x['meta']['log'] == 10][0]
st = s['st']; m = s['motor[0]']; rc = s['rcCommand[4]']; hs = s['hs']
i0, i1 = runs(st == 7)[0]
k = np.nonzero(rc[i0:i1] == 1000)[0]
seg = m[i0:i1][k]
print('log 10 AUTOROTATION with stick 1000: %.2f s, motor min %.0f max %.0f, frames at 250: %d, hs at end %.0f' % (len(k)/1000, seg.min(), seg.max(), (seg == 250).sum(), hs[i1-1]))
