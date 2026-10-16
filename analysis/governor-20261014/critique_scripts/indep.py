# Independent re-checks for critique.md (second pass). Usage: python -I indep.py <check>
import numpy as np, json, sys
from scipy.signal import lfilter
D = '/Users/albertwu/exp/rotorflight-blackbox/analysis/governor-20261014/data'

def load(craft):
    m = json.load(open(f'{D}/{craft}/meta.json'))
    out = []
    for s in m['segments']:
        a = np.fromfile(f"{D}/{craft}/{s['name']}.f32", dtype=np.float32).reshape(s['n'], len(s['columns']))
        d = {c: a[:, j].astype(np.float64) for j, c in enumerate(s['columns'])}
        d['meta'] = s; d['st'] = d['govStateAt'].astype(int)
        try: d['ph'] = np.fromfile(f"{D}/{craft}/{s['name']}.phase", dtype=np.uint8)
        except Exception: d['ph'] = None
        out.append(d)
    return out

def pt1(x, fc, rate):
    k = 1.0 / (1.0 + rate / (2 * np.pi * fc))
    return lfilter([k], [1, -(1 - k)], x, zi=[x[0] * (1 - k)])[0]
def pt2(x, fc, rate):
    c = fc * 1.553773974
    return pt1(pt1(x, c, rate), c, rate)
def runs(mask):
    m = np.concatenate([[0], mask.astype(np.int8), [0]]); d = np.diff(m)
    return list(zip(np.nonzero(d == 1)[0], np.nonzero(d == -1)[0]))

def kmot(s, rate_pid, loops_per_frame):
    # firmware EWMA of H/u (cutoff 0.05 Hz), updated per PID loop in SPOOLUP/ACTIVE when u > 0.2 and H/Hf > 0.2.
    # The log gives one frame per loops_per_frame loops; reuse the frame value for each loop.
    H = pt2(s['hs'], 10, 1000); u = s['motor[0]'] / 1000; Hf = s['govRequest']
    W = (0.05 + rate_pid / (2 * np.pi)) / 0.05
    K = np.zeros(len(H)); k = 0.0; n = 0
    for i in range(len(H)):
        if s['st'][i] in (2, 4) and u[i] > 0.2 and Hf[i] > 0 and H[i] / Hf[i] > 0.2:
            for _ in range(loops_per_frame):
                n += 1; w = 1.0 / min(n, W); k += w * (H[i] / u[i] - k)
        K[i] = k
    return K, H

what = sys.argv[1]

if what == 'vcomp':
    for craft in ('fireball', 'gaui'):
        n = bad = 0; n_unc = 0; worst = 0
        for s in load(craft):
            a = s['st'] == 4; m = s['motor[0]'][a]; g = s['govSum'][a]
            d = m - np.clip(g, 100, 1000); n += a.sum(); bad += (np.abs(d) > 1).sum(); worst = max(worst, np.abs(d).max())
            n_unc += ((g > 100) & (g < 1000)).sum()
        print(craft, 'ACTIVE frames', n, 'unclamped', n_unc, 'frames with |motor - clamp(govSum,100,1000)| > 1:', bad, 'max', worst)

if what == 'fallback':
    for s in load('fireball'):
        if not (s['st'] == 6).any(): continue
        K, H = kmot(s, 1000, 1); L = s['meta']['log']
        hs = s['hs']; f = pt2(hs, 10, 1000)
        for i0, i1 in runs(s['st'] == 6):
            gi, gf = s['govI'][i0 - 1], s['govF'][i0 - 1]
            mfb = s['motor[0]'][i0 + 2:i1 - 1]
            T = H[i1]; R = s['govRequest'][i1]
            pred = min(T / K[i1], T / R)
            jump = np.max(np.abs(hs - f)[i0 - 80:i0 + 2])
            sat = (s['motor[0]'][i0 - 400:i0] >= 999).sum()
            resc = np.nonzero(s['rescueAt'][i0 - 3000:i0 + 3000] > 0)[0]
            rtxt = 'none within 3 s' if len(resc) == 0 else 'rescue frames from %+.3f s to %+.3f s of entry' % ((resc[0] - 3000) / 1000, (resc[-1] - 3000) / 1000)
            print(f'log {L} t_idx {i0/1000:.3f}: FB {i1-i0} frames; frames at >=999 in prior 0.4 s {sat}; govI {gi:.0f} govF {gf:.0f}; '
                  f'motor in FB {np.median(mfb):.0f} (=0.9*govI {0.9*gi:.1f}; with precomp 0.9*(I+F) {0.9*(gi+gf):.1f}); '
                  f'RECOVERY motor[0] first {s["motor[0]"][i1]:.0f}, model min(T/Kmot,H/R) {1000*pred:.0f} (Kmot {K[i1]:.0f}, H {T:.0f}); '
                  f'max|hs-PT2| near entry {jump:.0f} vs 1125; rescue: {rtxt}')

if what == 'ff':
    # Gaui: collective 50 % curve 2.0 and cyclic 10 % assumed, yaw weight solved alone per log and request, per half log
    for s in load('gaui'):
        L = s['meta']['log']; a = (s['st'] == 4)
        m0, m1, m2, m3 = (s[f'mixer[{i}]'] / 1000 for i in range(4))
        KKf = 0.40 * 0.10
        base = (pt2(KKf * 0.5 * np.abs(m3) ** 2.0, 5, 1000) + pt2(KKf * 0.10 * np.sqrt(m0 ** 2 + m1 ** 2), 5, 1000)) * 1000
        xy = pt2(KKf * np.abs(m2), 5, 1000) * 1000
        y = s['govF'] + 0.5 - base
        rq = np.round(s['govRequest'] / 50) * 50
        n = len(y); out = []
        for req in np.unique(rq[a]):
            for h, (j0, j1) in enumerate(((0, n // 2), (n // 2, n))):
                k = np.zeros(n, bool); k[j0:j1] = True; k &= a & (rq == req)
                if k.sum() < 4000 or xy[k].std() < 1: continue
                w = (xy[k] @ y[k]) / (xy[k] @ xy[k]); r = y[k] - w * xy[k]
                out.append(f'{req:.0f}/h{h}: yaw {100*w:.1f} rms {np.sqrt(np.mean(r**2)):.2f}')
        print('gaui log', L, '; '.join(out))

if what == 'spool':
    for craft in ('fireball', 'gaui'):
        for s in load(craft):
            st = s['st']; hs = s['hs']; t = s['time']; m = s['motor[0]']; L = s['meta']['log']
            for i0, i1 in runs(st == 2):
                if i1 - i0 < 1500: continue
                j = i1 - 1000
                acc = np.polyfit(t[j:i1], hs[j:i1], 1)[0]
                rq = s['govRequest'][i1]
                seg = hs[i1:i1 + 3000]; rqs = s['govRequest'][i1:i1 + 3000]; same = rqs == rq
                ov = 100 * (seg[same].max() / rq - 1)
                # steady throttle 2-4 s after entry on the ground (before liftoff if possible)
                ss = np.median(m[i1 + 2000:i1 + 4000])
                print(f'{craft} log {L} SPOOLUP {(i1-i0)/1000:.1f} s; exit motor {m[i1-1]:.0f} hs/req {hs[i1-1]/rq:.3f}; dHS/dt last 1 s {acc:.0f} rpm/s; overshoot (same request) {ov:.1f} %; motor 2-4 s later {ss:.0f}; airborne in 3 s {int(s["airborneAt"][i1:i1+3000].max())}')

if what == 'sat':
    # share of 4500/5000 rpm ACTIVE flight at >= 98 % and at exactly 100 %, by Vbat (66 ms lag), and drift at equal load
    tot = {}
    for s in load('fireball'):
        if s['ph'] is None: continue
        a = (s['st'] == 4) & (s['ph'] == 3) & (s['rescueAt'] == 0)
        rq = np.round(s['govRequest'] / 50) * 50; m = s['motor[0]']; V = np.roll(s['Vbat'] / 100, -66)
        for r in (4500, 5000):
            k = a & (rq == r)
            d = tot.setdefault(r, [0, 0, 0, []])
            d[0] += k.sum(); d[1] += (k & (m >= 980)).sum(); d[2] += (k & (m >= 1000)).sum()
            d[3].append((s['meta']['log'], k.sum() / 1000, (k & (m >= 1000)).sum() / 1000, (k & (m >= 980)).sum() / 1000))
    for r, d in tot.items():
        print(r, 'ACTIVE flight s %.1f, >=98 %% %.1f s (%.2f %%), =100 %% %.1f s' % (d[0] / 1000, d[1] / 1000, 100 * d[1] / d[0], d[2] / 1000), 'per log (log, s, s@100, s@98):', [tuple(np.round(x, 2)) for x in d[3]])

if what == 'drift':
    # throttle at 4500 rpm in hover-like load (|collective| 0.05-0.25, cyclic < 0.15, |yaw| < 0.2), first vs last 60 s of ACTIVE flight
    for s in load('fireball'):
        if s['ph'] is None: continue
        a = (s['st'] == 4) & (s['ph'] == 3) & (s['rescueAt'] == 0) & (np.round(s['govRequest'] / 50) * 50 == 4500)
        c = np.abs(s['mixer[3]']) / 1000; cy = np.hypot(s['mixer[0]'], s['mixer[1]']) / 1000; y = np.abs(s['mixer[2]']) / 1000
        k = a & (c > 0.05) & (c < 0.25) & (cy < 0.15) & (y < 0.2)
        idx = np.nonzero(a)[0]
        if len(idx) < 120000: continue
        first = k.copy(); first[idx[60000]:] = False
        last = k.copy(); last[:idx[-60000]] = False
        m = s['motor[0]'] / 10; V = np.roll(s['Vbat'] / 100, -66)
        if first.sum() < 2000 or last.sum() < 2000: continue
        print('log', s['meta']['log'], 'n %d/%d' % (first.sum(), last.sum()), 'throttle %.1f -> %.1f %% (+%.1f)' % (np.median(m[first]), np.median(m[last]), np.median(m[last]) - np.median(m[first])),
              'Vbat %.2f -> %.2f V' % (np.median(V[first]), np.median(V[last])), 'D*V %.2f -> %.2f V' % (np.median(m[first] * V[first] / 100), np.median(m[last] * V[last] / 100)),
              '|coll| %.3f -> %.3f' % (np.median(c[first]), np.median(c[last])))

if what == 'fmode':
    # rcCommand[4] levels and state per level, both crafts
    for craft in ('fireball', 'gaui'):
        lv = {}
        for s in load(craft):
            rc = s['rcCommand[4]']; st = s['st']
            for v in np.unique(rc):
                k = rc == v
                lv.setdefault(int(v), {}).update({})
                for q in np.unique(st[k]): lv[int(v)][int(q)] = lv[int(v)].get(int(q), 0) + int((st[k] == q).sum())
        print(craft, {v: dict(sorted(d.items())) for v, d in sorted(lv.items())})

if what == 'gauivbat':
    # Does Vbat lead Ibat on the Gaui? Cross-correlation of band-passed derivatives, and Vbat/Ibat change instants
    for s in load('gaui')[:4]:
        a = s['st'] == 4
        i0, i1 = np.nonzero(a)[0][[0, -1]]
        v = s['Vbat'][i0:i1]; ib = s['Ibat'][i0:i1]; mh = (s['motor[0]'] * s['hs'])[i0:i1]
        def bp(x): return pt1(x - pt1(x, 0.3, 1000), 5, 1000)
        V, I, P = bp(v), bp(ib), bp(mh)
        lags = np.arange(-150, 151)
        def xc(x, y):
            return np.array([np.corrcoef(x[150 + l:len(x) - 150 + l], y[150:len(y) - 150])[0, 1] for l in lags])
        cvp = xc(-V, P); cip = xc(I, P); cvi = xc(-V, I)
        print('gaui log', s['meta']['log'], 'lag of -Vbat after P %d ms (r %.2f), Ibat after P %d ms (r %.2f), -Vbat after Ibat %d ms (r %.2f)' % (
            lags[np.argmax(cvp)], cvp.max(), lags[np.argmax(cip)], cip.max(), lags[np.argmax(cvi)], cvi.max()))
