import numpy as np, json, sys
from scipy.signal import lfilter
D = '/Users/albertwu/exp/rotorflight-blackbox/analysis/governor-20261014/data'

def load(craft):
    m = json.load(open(f'{D}/{craft}/meta.json'))
    out = []
    for s in m['segments']:
        a = np.fromfile(f"{D}/{craft}/{s['name']}.f32", dtype=np.float32).reshape(s['n'], len(s['columns']))
        d = {c: a[:, j].astype(np.float64) for j, c in enumerate(s['columns'])}
        d['meta'] = s
        d['st'] = d['govStateAt'].astype(int)
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

what = sys.argv[1]
FB = load('fireball'); GA = load('gaui')

if what == 'vcomp':
    for name, S, mn in (('fireball', FB, 100), ('gaui', GA, 100)):
        tot = big = 0; ratio = []
        for s in S:
            a = s['st'] == 4
            g = s['govSum'][a]; m = s['motor[0]'][a]
            d = m - np.clip(g, mn, 1000)
            tot += a.sum(); big += (np.abs(d) > 1).sum()
            u = (g > 150) & (g < 950); ratio.append(np.median(m[u] / g[u]))
        print(name, 'ACTIVE frames', tot, '|motor-clamp(govSum)|>1:', big, 'median ratio per log', np.round(ratio, 4))

if what == 'fallback':
    for s in FB:
        st = s['st']; L = s['meta']['log']
        hs = s['hs']; f = pt2(hs, 10, 1000)
        for i0, i1 in runs(st == 6):
            j1 = i1 + np.argmax(st[i1:] != 3) if (st[i1:] != 3).any() else len(st)
            gi = s['govI'][i0 - 1]; gf = s['govF'][i0 - 1]
            mf = np.median(s['motor[0]'][i0 + 2:i1 - 1])
            glitch = np.max(np.abs(hs - f)[i0 - 60:i0 + 5])
            mot_before = s['motor[0]'][i0 - 300:i0]
            sat = (mot_before >= 999).sum()
            print(f'log {L} idx_t {i0/1000:.3f} real_t {s["time"][i0]:.3f} FALLBACK {(i1-i0)} frames; motor before {s["motor[0]"][i0-1]:.0f} (sat frames in 0.3s {sat}); govI {gi:.0f} govF {gf:.0f}; motor in FB {mf:.0f} = {mf/gi:.4f} x govI; '
                  f'RECOVERY motor first {s["motor[0]"][i1]:.0f} hs {hs[i1]:.0f}; max|hs-PT2_10| near entry {glitch:.0f} (thr {0.25*4500:.0f}); hs min next 3 s {hs[i0:i0+3000].min():.0f}; Vbat {s["Vbat"][i0]/100:.2f}')
            # rescue flag around
            r = s['rescueAt'][i0 - 2000:i0 + 100]
            if r.any(): print('   rescue active before entry: first rescue frame at idx_t', (i0 - 2000 + np.argmax(r > 0)) / 1000)

if what == 'ramps':
    for name, S in (('fireball', FB), ('gaui', GA)):
        for s in S:
            st = s['st']; m = s['motor[0]']; t = s['time']; L = s['meta']['log']
            out = []
            for code, lab in ((1, 'IDLE'), (2, 'SPOOLUP'), (7, 'AUTO'), (3, 'RECOV'), (8, 'BAIL')):
                for i0, i1 in runs(st == code):
                    if i1 - i0 < 300: continue
                    seg = m[i0:i1]; dm = np.diff(seg)
                    # linear portion: samples whose value moves monotonically, exclude plateau
                    lo, hi = np.percentile(seg, 10), np.percentile(seg, 90)
                    k = np.nonzero((seg > lo) & (seg < hi))[0]
                    if len(k) < 100 or hi - lo < 30: continue
                    idx = np.arange(i0, i1)[k]
                    pi = np.polyfit(idx / 1000.0, seg[k], 1)[0]
                    pr = np.polyfit(t[idx], seg[k], 1)[0]
                    out.append(f'{lab}:{pi:+.2f}/{pr:+.2f}')
            print(name, 'log', L, 'slope permille/s (index-time / real-time):', ' '.join(out))

if what == 'ff':
    for s in GA:
        L = s['meta']['log']; a = (s['st'] == 4)
        m0, m1, m2, m3 = (s[f'mixer[{i}]'] / 1000 for i in range(4))
        KKf = 0.40 * 0.10
        X = np.stack([pt2(KKf * np.abs(m3) ** 2.0, 5, 1000), pt2(KKf * np.sqrt(m0 ** 2 + m1 ** 2), 5, 1000), pt2(KKf * np.abs(m2), 5, 1000)], 1) * 1000
        y = s['govF'] + 0.5
        for req in np.unique(np.round(s['govRequest'][a] / 50) * 50):
            k = a & (np.round(s['govRequest'] / 50) * 50 == req)
            # avoid 1 s after state/profile changes
            if k.sum() < 5000: continue
            w, res, *_ = np.linalg.lstsq(X[k], y[k], rcond=None)
            r = y[k] - X[k] @ w
            # fixed default weights for comparison
            r0 = y[k] - X[k] @ np.array([0.5, 0.1, 0.1])
            print(f'gaui log {L} req {req:.0f} n {k.sum()} weights coll/cyc/yaw = {w[0]*100:.1f} {w[1]*100:.1f} {w[2]*100:.1f}  rms {np.sqrt(np.mean(r**2)):.2f}  rms@50/10/10 {np.sqrt(np.mean(r0**2)):.2f}  yaw|max| {np.abs(m2[k]).max():.2f} cyc max {np.sqrt(m0**2+m1**2)[k].max():.2f}')

if what == 'ceiling':
    for name, S in (('fireball', FB), ('gaui', GA)):
        allm = np.concatenate([s['motor[0]'][s['st'] == 4] for s in S])
        top = allm[allm >= 850]
        h, e = np.histogram(top, bins=np.arange(850, 1002, 5))
        print(name, 'ACTIVE n', len(allm), 'max', allm.max(), 'counts per 5 permille bin from 850:', h.tolist())
        print('   frames at exact max value', (allm == allm.max()).sum(), ' at >=995', (allm >= 995).sum())

if what == 'vbat':
    for name, S in (('fireball', FB), ('gaui', GA)):
        for s in S[:3]:
            v = s['Vbat']; t = s['time']; L = s['meta']['log']
            ch = np.nonzero(np.diff(v) != 0)[0]
            dt = np.diff(t[ch]) * 1000
            ib = s['Ibat']; chi = np.nonzero(np.diff(ib) != 0)[0]
            print(name, L, 'Vbat changes per s', len(ch) / (t[-1] - t[0]), 'median interval ms', np.median(dt), 'p10', np.percentile(dt, 10),
                  '| Ibat changes/s', len(chi) / (t[-1] - t[0]), 'Ibat nonzero share', np.mean(ib != 0))

if what == 'kv':
    # lower bound of Kv: HS/(u*V) is <= Kv when the motor current is >= 0
    for name, S in (('fireball', FB), ('gaui', GA)):
        per = []
        for s in S:
            a = (s['st'] == 4) & (s['motor[0]'] > 200) & (s['Vbat'] > 1000)
            if a.sum() < 10000: continue
            # 1 s block means, Vbat delayed by the telemetry lag (66 ms Fireball, 45 ms Gaui)
            lag = 66 if name == 'fireball' else 45
            V = np.roll(s['Vbat'] / 100, -lag)
            r = s['hs'] / (s['motor[0]'] / 1000 * V)
            n = len(r) // 1000 * 1000
            blk = r[:n].reshape(-1, 1000); ok = a[:n].reshape(-1, 1000).all(1)
            b = blk[ok].mean(1)
            per.append((s['meta']['log'], np.percentile(b, 50), np.percentile(b, 99.5), b.max()))
        print(name, 'HS/(u V) per 1 s block in ACTIVE: (log, p50, p99.5, max)', [tuple(np.round(x, 1)) for x in per])

if what == 'spool':
    for s in FB:
        st = s['st']; hs = s['hs']; t = s['time']; L = s['meta']['log']; m = s['motor[0]']
        for code, lab in ((2, 'SPOOLUP'), (8, 'BAILOUT')):
            for i0, i1 in runs(st == code):
                if i1 - i0 < 500: continue
                # acceleration in the last second of the state (rpm/s, real time)
                j = max(i0, i1 - 1000)
                acc = np.polyfit(t[j:i1], hs[j:i1], 1)[0]
                # acceleration in the first half second after ACTIVE entry
                print(f'fireball log {L} {lab} {(i1-i0)/1000:.2f}s exit motor {m[i1-1]:.0f} hs {hs[i1-1]:.0f} req {s["govRequest"][i1-1]:.0f}; dHS/dt last 1 s {acc:.0f} rpm/s; overshoot next 3 s {100*(hs[i1:i1+3000].max()/s["govRequest"][i1]-1):.1f} %')
