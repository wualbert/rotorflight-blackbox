import numpy as np, sys
exec(open('indep.py').read().split("what = sys.argv[1]")[0])
s = [x for x in load('fireball') if x['meta']['log'] == 15][0]
st = s['st']; r = s['govRequest']; p = s['profileAt']
i0, i1 = runs(st == 2)[0]
print('profileAt at frame 0', p[0], 'govRequest first nonzero at idx_t %.2f = %.0f' % (np.argmax(r > 0) / 1000, r[np.argmax(r > 0)]))
print('SPOOLUP idx_t %.2f-%.2f; request at start %.0f, at end %.0f; profileAt start %d end %d' % (i0 / 1000, i1 / 1000, r[i0], r[i1 - 1], p[i0], p[i1 - 1]))
ch = np.nonzero(np.diff(p) != 0)[0]; print('profile changes idx_t', [(round(k / 1000, 2), int(p[k]), int(p[k + 1])) for k in ch][:4])
