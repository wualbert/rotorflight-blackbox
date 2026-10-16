# (7) firmware law and gains recovered from the logged terms: P, I rate, D, F weights (per headspeed = PID profile)
from common import *
from scipy.optimize import nnls

HDR = {'fireball': dict(K=0.55, Kp=1.8, Ki=6.0, Kd=0.002, Kf=0.32), 'gaui': dict(K=0.40, Kp=4.0, Ki=5.0, Kd=0.0, Kf=0.10)}

def run(craft):
    S = [s for s in segs(craft) if s['cls'] == 'flight']; out = {'P': {}, 'I': {}, 'D': {}, 'F': {}, 'sum': {}}
    h = HDR[craft]
    for H in sorted(set(int(v) for s in S for v in np.unique(s['req'][(s['gov'] == 4) & (s['phase'] == 3)]))):
        Pe, Py, Ie, Iy, Fx, Fy, De, Dy = [], [], [], [], [], [], [], []
        for s in S:
            r = s['rate']; m = (s['gov'] == 4) & (s['phase'] == 3) & (s['req'] == H) & (s['rescueAt'] == 0)
            if m.sum() < 2000: continue
            f = pt2(s['hs'], 10, r); e = (s['govTarget'] - f) / s['govRequest']
            # P: unclipped samples, with a one-sample shift scan
            best = None
            for sh in [0, 1, 2]:
                ee = np.roll(e, sh); mm = m & (np.abs(s['govP']) < 0.95 * 1000 * h['K'] * h['Kp'] * 1)  # well inside p_limit
                c = (ee[mm] * s['govP'][mm]).sum() / (ee[mm] ** 2).sum(); r2 = 1 - np.var(s['govP'][mm] - c * ee[mm]) / np.var(s['govP'][mm])
                if best is None or r2 > best[2]: best = (sh, c, r2)
            Pe.append(best)
            # I: d(govI)/dt vs e where throttle is not saturated and no state reset (inside m, away from edges)
            dI = np.diff(s['govI']) * r; mm = m[1:] & (s['motor[0]'][1:] < 975) & (s['motor[0]'][1:] > 120)
            Ie.append(np.roll(e, best[0])[1:][mm]); Iy.append(dI[mm])
            # D
            De.append(e[m]); Dy.append(s['govD'][m])
            # F: regressors PT2(5 Hz) of |c|^k, cyclic, |yaw|
            c = np.abs(s['mixer[3]']) / 1000; cyc = np.hypot(s['mixer[0]'], s['mixer[1]']) / 1000; yw = np.abs(s['mixer[2]']) / 1000
            Fx.append((c, cyc, yw, m, r)); Fy.append(s['govF'])
        if not Pe: continue
        out['P'][H] = dict(slope=float(np.median([p[1] for p in Pe])), slope_per_flight=[float(p[1]) for p in Pe], shift_samples=[p[0] for p in Pe], r2=[float(p[2]) for p in Pe],
                           expected=1000 * h['K'] * h['Kp'], ratio=float(np.median([p[1] for p in Pe]) / (1000 * h['K'] * h['Kp'])))
        e = np.concatenate(Ie); y = np.concatenate(Iy); k = (e * y).sum() / (e * e).sum()
        # I increments are rounded to 1 count: use 100 ms sums for a cleaner slope
        out['I'][H] = dict(rate_per_s=float(k), expected=1000 * h['K'] * h['Ki'], ratio=float(k / (1000 * h['K'] * h['Ki'])), n=int(len(e)))
        out['D'][H] = dict(govD_absmax=float(np.abs(np.concatenate(Dy)).max()), share_nonzero=float((np.concatenate(Dy) != 0).mean()), expectedGain=1000 * h['K'] * h['Kd'])
        # F weights: scan the collective exponent, fit nonnegative weights of PT2-filtered regressors
        best = None
        for ex in [1.0, 1.5, 2.0, 2.5, 3.0]:
            X, Y = [], []
            for (c, cyc, yw, m, r), F in zip(Fx, Fy):
                R = np.c_[pt2(c ** ex, 5, r), pt2(cyc, 5, r), pt2(yw, 5, r)]
                X.append(R[m][::5]); Y.append(F[m][::5])
            X = np.concatenate(X); Y = np.concatenate(Y)
            wts, _ = nnls(X, Y); r2 = 1 - np.var(Y - X @ wts) / np.var(Y)
            if best is None or r2 > best['r2']: best = dict(exponent=ex, coef=[float(v) for v in wts], r2=float(r2))
        g = 1000 * h['K'] * h['Kf']
        best['weights_pct'] = dict(collective=100 * best['coef'][0] / g, cyclic=100 * best['coef'][1] / g, yaw=100 * best['coef'][2] / g)
        best['clipShare_at_f_limit'] = None
        out['F'][H] = best
    return out

if __name__ == '__main__':
    res = {}
    for craft in ['fireball', 'gaui']:
        R = run(craft); res[craft] = R; print('==', craft)
        for k, v in R.items():
            for H, x in v.items(): print(k, H, rnd(x, 4))
    json.dump(rnd(res, 5), open('gains.json', 'w'), indent=1)
