import numpy as np
exec(open('check.py').read().split("what = sys.argv[1]")[0])
for craft in ('fireball', 'gaui'):
    for s in load(craft):
        st = s['st']; m = s['motor[0]']; L = s['meta']['log']; rc = s['rcCommand[4]']
        for code, lab in ((7, 'AUTO'), (1, 'IDLE')):
            for i0, i1 in runs(st == code):
                seg = m[i0:i1]
                if len(seg) < 50: continue
                vals, cnt = np.unique(seg, return_counts=True); top = vals[np.argmax(cnt)]
                print(craft, L, lab, '%.2f s' % ((i1-i0)/1000), 'max motor %.0f, most frequent %.0f (%d frames), stick values %s' % (seg.max(), top, cnt.max(), np.unique(rc[i0:i1]).astype(int).tolist()[:5]))
