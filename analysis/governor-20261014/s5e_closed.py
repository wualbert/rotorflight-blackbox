# Closed-loop check of plant candidates: the firmware governor law (P, I, D from the header gains, F = logged govF) flies each plant
# candidate over 2 s flight windows; compare simulated headspeed and throttle with the log.
from common import *
from s5_plant import RPM2RAD, lp, LAGV

GAINS = {'fireball': dict(K=0.55, Kp=1.8, Ki=6.0, Kd=0.002), 'gaui': dict(K=0.40, Kp=4.0, Ki=5.0, Kd=0.0)}

def pt1k(fc, dt): return dt / (dt + 1 / (2 * np.pi * fc))

def closed(craft, plant, win):
    g = GAINS[craft]; dt = 0.001
    hs, tgt, req, F, I0, D0, V, c, cyc = win['hs'], win['tgt'], win['req'], win['F'], win['I0'], win['D'], win['V'], win['c'], win['cyc']
    n = len(hs); w = hs[0] * RPM2RAD; De = D0[0]; Iacc = I0
    k2 = pt1k(10 * 1.553773974, dt); f1 = f2 = hs[0]
    a_u, kv, te, q = plant['a_u'], plant['kv'], plant['te'], plant['q']
    outw = np.empty(n); outD = np.empty(n)
    for i in range(n):
        rpm = w / RPM2RAD
        f1 += (rpm - f1) * k2; f2 += (f1 - f2) * k2
        e = (tgt[i] - f2) / req[i]
        P = np.clip(g['K'] * g['Kp'] * e, -0.3 if craft == 'fireball' else -0.2, 0.3 if craft == 'fireball' else 0.2)
        C = g['K'] * g['Ki'] * e * dt
        s = P + Iacc + C + F[i]
        thr = s
        if (thr > 0.10 or C > 0) and (thr < 1.0 or C < 0): Iacc += C
        D = min(1.0, max(0.10, thr))
        De += (D - De) * min(1, dt / te)
        dw = a_u * (De * V[i] - w / kv) - w * w * (q[0] + q[1] * c[i] + q[2] * c[i] ** 2 + q[3] * cyc[i] ** 2)
        w += dw * dt
        outw[i] = w / RPM2RAD; outD[i] = D
    return outw, outD

def wins(craft, n=120, L=2.0):
    S = [s for s in segs(craft) if s['cls'] == 'flight']; W = []; rng = np.random.default_rng(7)
    for s in S:
        r = s['rate']; N = len(s['hs']); lv = int(round(LAGV[craft] * r))
        V = np.concatenate([s['Vbat'][lv:], np.full(lv, s['Vbat'][-1])]) / 100
        c = lp(np.abs(s['mixer[3]']) / 1000, 20, r); cyc = lp(np.hypot(s['mixer[0]'], s['mixer[1]']) / 1000, 20, r)
        ok = (s['gov'] == 4) & (s['phase'] == 3) & (s['rescueAt'] == 0)
        for i in range(int(2 * r), N - int(L * r), int(4 * r)):
            sl = slice(i, i + int(L * r))
            if ok[sl].all():
                W.append(dict(log=s['log'], hs=s['hs'][sl], tgt=s['govTarget'][sl], req=s['govRequest'][sl], F=s['govF'][sl] / 1000, I0=s['govI'][i] / 1000,
                              D=s['motor[0]'][sl] / 1000, V=V[sl], c=c[sl], cyc=cyc[sl], dmax=s['motor[0]'][sl].max()))
    idx = rng.permutation(len(W))[:n]
    return [W[i] for i in idx]

if __name__ == '__main__':
    oe = json.load(open('oe_esc_fit.json'))
    res = {}
    for craft in ['gaui', 'fireball']:
        W = wins(craft)
        cands = {}
        for row in oe[craft]:
            nm = 'OE fit (free)' if not row['fixed'] else 'current-based a_u=150, Kv=157.8 (q, tauEsc refit)'
            cands[nm] = dict(a_u=row['a_u'], kv=row['Kv_rpm_per_V'] * RPM2RAD, te=row['tauEsc_s'], q=row['q'])
        # scaled-authority variants of the free OE fit: torque authority x2, x4 (same Kv, same q)
        out = {}
        for nm, p in cands.items():
            ew, eD = [], []
            for win in W:
                sw, sD = closed(craft, p, win)
                ew.append(sw - win['hs']); eD.append(sD - win['D'])
            ew = np.concatenate(ew); eD = np.concatenate(eD)
            hsd = np.concatenate([win['hs'] - win['hs'].mean() for win in W]); Dd = np.concatenate([win['D'] - win['D'].mean() for win in W])
            out[nm] = dict(rms_hs_rpm=float(np.sqrt(np.mean(ew ** 2))), rms_motor_pct=float(100 * np.sqrt(np.mean(eD ** 2))), bias_motor_pct=float(100 * eD.mean()),
                           hs_std_rpm=float(hsd.std()), motor_std_pct=float(100 * Dd.std()), windows=len(W))
            print(craft, nm, rnd(out[nm], 3))
        res[craft] = out
    json.dump(rnd(res, 4), open('closed_check.json', 'w'), indent=1)
