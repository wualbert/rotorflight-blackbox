import numpy as np, sys
exec(open('indep.py').read().split("what = sys.argv[1]")[0])
for s in load('fireball'):
    L = s['meta']['log']; r = s['govRequest']; st = s['st']
    ch = np.nonzero(np.diff(r) != 0)[0]
    ch = [k for k in ch if r[k+1] > 0 and r[k] > 0]
    print('log', L, 'first nonzero request', r[np.argmax(r > 0)] if (r > 0).any() else None, 'request changes (idx_t, from, to):', [(round(k/1000, 2), int(r[k]), int(r[k+1])) for k in ch][:8])
