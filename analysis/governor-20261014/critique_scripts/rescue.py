import numpy as np, json
exec(open('check.py').read().split("what = sys.argv[1]")[0])
FB = load('fireball')
for s in FB:
    L = s['meta']['log']; r = s['rescueAt'] > 0; t = s['time']
    for i0, i1 in runs(r):
        st = s['st'][i0:i1]
        print('log', L, 'rescue idx_t %.3f-%.3f real_t %.3f-%.3f' % (i0/1000, i1/1000, t[i0], t[i1-1]), 'states', sorted(set(st.tolist())),
              'coll max %.2f' % (np.abs(s['mixer[3]'][i0:i1]).max()/1000), 'motor max', s['motor[0]'][i0:i1].max())
