# Output-error identification of the rotor-speed subsystem on flight windows (multiple shooting, 2 s windows at 100 Hz):
#   dw/dt = a_u * (D(t - tau) V(t - tau) - w / Kv) - w^2 (q0 + q1 |c| + q2 c^2 + q3 cyc^2)
from common import *
from scipy.optimize import least_squares
from s5_plant import lp, LAGV, RPM2RAD

def windows(craft, winS=2.0, step=4.0, blk=10):
    S = [s for s in segs(craft) if s['cls'] == 'flight']; W = []
    for s in S:
        r = s['rate']; n = len(s['hs']); lv = int(round(LAGV[craft] * r))
        V = np.concatenate([s['Vbat'][lv:], np.full(lv, s['Vbat'][-1])]) / 100
        D = s['motor[0]'] / 1000; w = lp(s['hs'], 20, r) * RPM2RAD
        c = lp(np.abs(s['mixer[3]']) / 1000, 20, r); cyc = lp(np.hypot(s['mixer[0]'], s['mixer[1]']) / 1000, 20, r)
        ok = (s['gov'] == 4) & (s['phase'] == 3) & (s['rescueAt'] == 0)
        L = int(winS * r); pre = int(0.2 * r)
        for i in range(pre, n - L, int(step * r)):
            if ok[i - pre:i + L].all():
                sl = slice(i - pre, i + L)
                B = lambda x: x[sl][:((L + pre) // blk) * blk].reshape(-1, blk).mean(1)
                W.append(dict(log=s['log'], u=B(D * V), w=B(w), c=B(c), cyc=B(cyc), req=s['req'][i]))
    return W

def sim(p, win, tauN, kv_fixed=None):
    a_u = np.exp(p[0]); kv = kv_fixed if kv_fixed else np.exp(p[1]); q = p[2:6]
    u, w, c, cy = win['u'], win['w'], win['c'], win['cyc']; n = len(w); pre = 20
    x = w[pre]; out = np.empty(n - pre)
    for k in range(pre, n):
        out[k - pre] = x
        uu = u[k - tauN]
        dx = a_u * (uu - x / kv) - x * x * (q[0] + q[1] * c[k] + q[2] * c[k] ** 2 + q[3] * cy[k] ** 2)
        x = x + dx * 0.01
    return out - w[pre:]

def fit(W, tauN, kv_fixed=None):
    p0 = np.r_[np.log(20.0), np.log(30.0), 1e-4, 1e-4, 1e-4, 1e-4]
    f = lambda p: np.concatenate([sim(p, win, tauN, kv_fixed) for win in W])
    r = least_squares(f, p0, x_scale=np.r_[1, 1, 1e-4, 1e-4, 1e-4, 1e-4], max_nfev=200)
    res = r.fun; w_all = np.concatenate([win['w'][20:] for win in W])
    return r.x, float(np.sqrt(np.mean(res ** 2)) / RPM2RAD), r

if __name__ == '__main__':
    import sys
    out = {}
    for craft in ['gaui', 'fireball']:
        W = windows(craft); rng = np.random.default_rng(5); idx = rng.permutation(len(W))
        tr = [W[i] for i in idx[:len(W) // 2]]; te = [W[i] for i in idx[len(W) // 2:]]
        print('==', craft, 'windows', len(W))
        best = None
        for tauN in [0, 2, 4, 6, 8, 12]:
            p, rms, r = fit(tr, tauN)
            rms_te = float(np.sqrt(np.mean(np.concatenate([sim(p, win, tauN) for win in te]) ** 2)) / RPM2RAD)
            # hold-last-value baseline on test windows
            base = float(np.sqrt(np.mean(np.concatenate([win['w'][20:] - win['w'][20] for win in te]) ** 2)) / RPM2RAD)
            row = dict(tauS=tauN / 100, a_u=float(np.exp(p[0])), Kv_rpm_per_V=float(np.exp(p[1]) / RPM2RAD), q=[float(v) for v in p[2:]], rms_train_rpm=rms, rms_test_rpm=rms_te, hold_baseline_rpm=base)
            print(rnd(row, 5)); out.setdefault(craft, []).append(row)
            if best is None or rms_te < best['rms_test_rpm']: best = row
        out[craft + '_best'] = best
    json.dump(rnd(out, 6), open('oe_fit.json', 'w'), indent=1)
