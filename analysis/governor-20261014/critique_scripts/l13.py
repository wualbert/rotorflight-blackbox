import numpy as np
exec(open('check.py').read().split("what = sys.argv[1]")[0])
FB = load('fireball')
s = [x for x in FB if x['meta']['log'] == 13][0]
st = s['st']; i = [i0 for i0, i1 in runs(st == 2)][0]; e = i + np.argmax(st[i:] == 4)
r = s['govRequest'][e:e+3000]; hs = s['hs'][e:e+3000]
print('ACTIVE entry idx_t %.3f; govRequest values in next 3 s' % (e/1000), np.unique(r))
k = np.argmax(hs); print('hs max %.0f at +%.3f s, request there %.0f, airborne %d, phase-coll %.2f' % (hs[k], k/1000, r[k], s['airborneAt'][e+k], s['mixer[3]'][e+k]/1000))
rq = s['govRequest'][e]; m = r == rq; print('overshoot while request unchanged: %.1f %%' % (100*(hs[m].max()/rq-1)))
s = [x for x in FB if x['meta']['log'] == 10][0]
st = s['st']; b = [ (i0,i1) for i0,i1 in runs(st == 8)][0]; i1 = b[1]
hs = s['hs']; m = s['motor[0]']; t = s['time']
j = i1 + np.argmax(m[i1:] < 999)
print('log 10 after BAILOUT: motor 1000 for %.2f s (index), hs %.0f -> %.0f, slope %.0f rpm/s (real time), Vbat %.2f' % ((j-i1)/1000, hs[i1], hs[j], np.polyfit(t[i1:j], hs[i1:j], 1)[0], s['Vbat'][i1]/100))
