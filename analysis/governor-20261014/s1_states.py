# (1) governor state timeline and durations; (6b) fallback, recovery, bailout, autorotation events
from common import *

def state_runs(s):
    g = s['gov']; n = len(g); out = []
    T = s['time']  # frame clock, s from segment start
    i = 0
    while i < n:
        j = i + 1
        while j < n and g[j] == g[i]: j += 1
        dur = (T[j] - T[i]) if j < n else (T[n - 1] - T[i] + 1 / s['rate'])
        ph = np.bincount(s['phase'][i:j], minlength=5)
        out.append(dict(state=ST[g[i]], i0=int(i), i1=int(j), t0=float(s['t'][i]), dur=float(dur), endOfLog=j >= n,
                        next=ST[g[j]] if j < n else None, prev=ST[g[i - 1]] if i > 0 else None,
                        req=float(np.median(s['req'][i:j])), phase=PH[int(np.argmax(ph))], phaseShare={PH[k]: round(ph[k] / (j - i), 3) for k in range(5) if ph[k]}))
        i = j
    return out

def run(craft):
    S = segs(craft); res = {'logs': {}, 'totals': {}, 'transitions': {}, 'entries': {}}
    tot = {k: 0.0 for k in ST}; trans = {}; entries = {k: [] for k in ST}
    for s in S:
        R = state_runs(s)
        res['logs'][s['meta']['name']] = dict(cls=s['cls'], log=s['log'], durationS=float(s['time'][-1]),
            flightS=s['phinfo']['seconds']['flight'], phases=s['phinfo']['seconds'],
            timeline=[dict(t=round(r['t0'], 3), state=r['state'], dur=round(r['dur'], 3), req=r['req'], phase=r['phase']) for r in R])
        for r in R:
            tot[r['state']] += r['dur']
            if r['prev'] is not None:
                k = f"{r['prev']}->{r['state']}"; trans[k] = trans.get(k, 0) + 1
            entries[r['state']].append(dict(log=s['log'], t=round(r['t0'], 3), dur=round(r['dur'], 3), prev=r['prev'], next=r['next'], req=r['req'], phase=r['phase'], cls=s['cls'], endOfLog=r['endOfLog']))
    res['totals'] = {k: round(v, 2) for k, v in tot.items() if v > 0}
    res['transitions'] = trans
    res['entries'] = {k: v for k, v in entries.items() if v and k not in ('OFF',)}
    # summary of durations per state
    summ = {}
    for k, v in entries.items():
        d = [e['dur'] for e in v if not e['endOfLog']]
        if d: summ[k] = dict(n=len(d), min=min(d), median=float(np.median(d)), max=max(d))
    res['durationSummary'] = summ
    return res

if __name__ == '__main__':
    for craft in ['fireball', 'gaui']:
        r = run(craft)
        print(craft, 'totals', r['totals']); print(' transitions', r['transitions']); print(' durations', rnd(r['durationSummary'], 3))
        for k in ['FALLBACK', 'RECOVERY', 'BAILOUT', 'AUTOROTATION', 'HOLD']:
            if k in r['entries']: print(' ', k, r['entries'][k])
