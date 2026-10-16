import numpy as np, sys
exec(open('indep.py').read().split("what = sys.argv[1]")[0])
for L in (10, 11, 13, 14):
    s = [x for x in load('fireball') if x['meta']['log'] == L][0]
    st = s['st']; hs = s['hs']; r = s['govRequest']
    i0, i1 = runs(st == 2)[0]; e = i1
    seg = hs[e:e + 3000]; k = np.argmax(seg)
    ch = np.nonzero(np.diff(r[e:e + 3000]) != 0)[0]
    print(f'log {L}: ACTIVE entry {e/1000:.2f} s; first request change after entry: {ch[0]/1000 if len(ch) else None} s; peak hs {seg[k]:.0f} at +{k/1000:.2f} s (request there {r[e+k]:.0f}); peak before first change {seg[:ch[0]].max() if len(ch) else seg.max():.0f}')
