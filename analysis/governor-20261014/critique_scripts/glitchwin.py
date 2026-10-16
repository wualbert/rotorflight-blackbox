import numpy as np, sys
exec(open('indep.py').read().split("what = sys.argv[1]")[0])
for s in load('fireball'):
    if not (s['st'] == 6).any(): continue
    hs = s['hs']; f = pt2(hs, 10, 1000); d = np.abs(hs - f); L = s['meta']['log']
    for i0, i1 in runs(s['st'] == 6):
        w = d[i0 - 100:i0 + 100]; k = np.argmax(w) - 100
        over = np.nonzero(w > 1125)[0] - 100
        print(f'log {L} entry {i0/1000:.3f}: max |hs-PT2(hs,10)| in +-100 ms = {w.max():.0f} at {k:+d} ms; frames over 1125: {len(over)}' + (f' first at {over[0]:+d} ms' if len(over) else '') +
              f'; hs at -5..+40 ms: {hs[i0-5]:.0f} {hs[i0]:.0f} {hs[i0+10]:.0f} {hs[i0+20]:.0f} {hs[i0+40]:.0f}')
