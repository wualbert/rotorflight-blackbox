import numpy as np
exec(open('check.py').read().split("what = sys.argv[1]")[0])
FB = load('fireball')
s = [x for x in FB if x['meta']['log'] == 10][0]
st = s['st']; b = runs(st == 8)[0]; i1 = b[1]
hs = s['hs']; m = s['motor[0]']; t = s['time']
r = [(a, c) for a, c in runs(m >= 999) if a >= i1 - 5][0]
a, c = r
print('log 10 BAILOUT idx_t %.3f-%.3f; then motor >= 999 idx_t %.3f-%.3f (%.2f s), hs %.0f -> %.0f, slope %.0f rpm/s real time, airborne %d, coll %.2f, Vbat %.2f' % (b[0]/1000, i1/1000, a/1000, c/1000, (c-a)/1000, hs[a], hs[c], np.polyfit(t[a:c], hs[a:c], 1)[0], s['airborneAt'][a:c].max(), np.median(s['mixer[3]'][a:c])/1000, s['Vbat'][a]/100))
for k in range(a, c, 500): print('  idx_t %.2f hs %.0f motor %.0f' % (k/1000, hs[k], m[k]))
