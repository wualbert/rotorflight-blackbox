import numpy as np
exec(open('check.py').read().split("what = sys.argv[1]")[0])
for s in load('gaui'):
    L = s['meta']['log']; a = s['st'] == 4; m = s['motor[0]']; rq = np.round(s['govRequest']/50)*50
    for r in np.unique(rq[a]):
        k = a & (rq == r)
        if k.sum() < 1000: continue
        top = m[k].max(); cnt = (m[k] == top).sum(); below = np.mean([(m[k] == top - j).sum() for j in (1, 2, 3)])
        flag = cnt >= 20 and cnt >= 3 * below
        if flag or top > 900: print('gaui log', L, 'req', int(r), 'top', int(top), 'count', cnt, 'mean count 3 below %.1f' % below, '-> health_gov pile rule fires' if flag else '')
