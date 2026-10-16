import numpy as np, sys
exec(open('indep.py').read().split("what = sys.argv[1]")[0])
for s in load('fireball'):
    L = s['meta']['log']; rq = np.round(s['govRequest'] / 50) * 50
    a = (s['st'] == 4) & (rq == 5000)
    if a.sum() < 5000: continue
    K, H = kmot(s, 1000, 1)
    print('log', L, '5000 rpm ACTIVE s %.1f' % (a.sum() / 1000), 'Kmot p1/p50/max %.0f/%.0f/%.0f' % tuple(np.percentile(K[a], [1, 50, 100])), 'share with Kmot <= 5000: %.1f %%' % (100 * np.mean(K[a] <= 5000)))
    b = (s['st'] == 4) & (rq == 4500)
    print('   4500 rpm: Kmot p1/p50 %.0f/%.0f' % tuple(np.percentile(K[b], [1, 50])))
