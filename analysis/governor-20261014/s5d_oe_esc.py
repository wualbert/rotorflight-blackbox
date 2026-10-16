# Output-error fit with a first-order ESC lag on the throttle: De' = (D - De) / tauEsc; dw/dt = a_u (De V - w/Kv) - w^2 (q0 + q1|c| + q2 c^2 + q3 cyc^2)
from common import *
from scipy.optimize import least_squares
from s5_plant import RPM2RAD
from s5c_oe import windows

def winD(craft):
    # same windows but with D and V separate
    from s5_plant import lp, LAGV
    S = [s for s in segs(craft) if s['cls'] == 'flight']; W = []; blk = 10
    for s in S:
        r = s['rate']; n = len(s['hs']); lv = int(round(LAGV[craft] * r))
        V = np.concatenate([s['Vbat'][lv:], np.full(lv, s['Vbat'][-1])]) / 100
        D = s['motor[0]'] / 1000; w = lp(s['hs'], 20, r) * RPM2RAD
        c = lp(np.abs(s['mixer[3]']) / 1000, 20, r); cyc = lp(np.hypot(s['mixer[0]'], s['mixer[1]']) / 1000, 20, r)
        ok = (s['gov'] == 4) & (s['phase'] == 3) & (s['rescueAt'] == 0)
        L = int(2.0 * r); pre = int(1.0 * r)
        for i in range(pre, n - L, int(4.0 * r)):
            if ok[i - pre:i + L].all():
                sl = slice(i - pre, i + L); B = lambda x: x[sl][:((L + pre) // blk) * blk].reshape(-1, blk).mean(1)
                W.append(dict(log=s['log'], D=B(D), V=B(V), w=B(w), c=B(c), cyc=B(cyc)))
    return W

def sim(p, win, fixed):
    a_u = fixed.get('a_u', None) or np.exp(p[0]); kv = fixed.get('kv', None) or np.exp(p[1]); te = np.exp(p[2]); q = p[3:7]
    D, V, w, c, cy = win['D'], win['V'], win['w'], win['c'], win['cyc']; n = len(w); pre = 100
    De = D[0]
    for k in range(0, pre): De += (D[k] - De) * min(1, 0.01 / te)   # warm the ESC state over the 1 s before
    x = w[pre]; out = np.empty(n - pre)
    for k in range(pre, n):
        out[k - pre] = x
        De += (D[k] - De) * min(1, 0.01 / te)
        dx = a_u * (De * V[k] - x / kv) - x * x * (q[0] + q[1] * c[k] + q[2] * c[k] ** 2 + q[3] * cy[k] ** 2)
        x += dx * 0.01
    return out - w[pre:]

def fit(W, fixed, p0):
    f = lambda p: np.concatenate([sim(p, win, fixed) for win in W])
    r = least_squares(f, p0, x_scale=np.r_[1, 1, 1, 1e-4, 1e-4, 1e-4, 1e-4], max_nfev=300)
    return r.x, float(np.sqrt(np.mean(r.fun ** 2)) / RPM2RAD)

if __name__ == '__main__':
    out = {}
    for craft, cases in [('gaui', [{}, {'a_u': 150.0, 'kv': 157.8 * RPM2RAD}]), ('fireball', [{}])]:
        W = winD(craft); rng = np.random.default_rng(5); idx = rng.permutation(len(W)); tr = [W[i] for i in idx[:len(W) // 2]]; te = [W[i] for i in idx[len(W) // 2:]]
        base = float(np.sqrt(np.mean(np.concatenate([win['w'][100:] - win['w'][100] for win in te]) ** 2)) / RPM2RAD)
        for fx in cases:
            best = None
            for te0 in [0.05, 0.2, 0.5]:
                p0 = np.r_[np.log(40.0), np.log(18.0 if craft == 'gaui' else 33.0), np.log(te0), 7e-4, 6e-4, 5e-4, 9e-4]
                p, rms = fit(tr, fx, p0)
                if best is None or rms < best[1]: best = (p, rms)
            p, rms = best
            rte = float(np.sqrt(np.mean(np.concatenate([sim(p, win, fx) for win in te]) ** 2)) / RPM2RAD)
            row = dict(fixed={k: float(v) for k, v in fx.items()}, a_u=float(fx.get('a_u') or np.exp(p[0])), Kv_rpm_per_V=float((fx.get('kv') or np.exp(p[1])) / RPM2RAD), tauEsc_s=float(np.exp(p[2])), q=[float(v) for v in p[3:]],
                       rms_train_rpm=rms, rms_test_rpm=rte, hold_baseline_rpm=base, windows=len(W))
            print(craft, rnd(row, 5)); out.setdefault(craft, []).append(row)
    json.dump(rnd(out, 6), open('oe_esc_fit.json', 'w'), indent=1)
