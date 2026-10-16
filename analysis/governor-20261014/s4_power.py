# (4) battery and (5) motor/ESC models
from common import *
from scipy.optimize import least_squares

LAG = {'gaui': {'V': 0.045, 'I': 0.087}, 'fireball': {'V': 0.066, 'I': None}}

def blocks(x, k):
    nb = len(x) // k; return x[:nb * k].reshape(nb, k).mean(1)

def prep(s, craft, blockS=0.02, mask=None):
    r = s['rate']; n = len(s['hs']); k = int(blockS * r)
    lv = int(round(LAG[craft]['V'] * r)); li = int(round((LAG[craft]['I'] or 0) * r))
    sh = lambda x, l: np.concatenate([x[l:], np.full(l, x[-1])]) if l > 0 else x
    V = sh(s['Vbat'], lv) / 100; I = sh(s['Ibat'], li) / 100
    D = s['motor[0]'] / 1000; W = s['hs']
    Q = np.cumsum(s['Ibat'] / 100) / r / 3600  # Ah, unshifted
    m = mask if mask is not None else ((s['phase'] == 3) & (s['gov'] == 4) & (s['rescueAt'] == 0))
    out = {}
    for nm, x in dict(V=V, I=I, D=D, W=W, Q=Q, t=s['t'], c=np.abs(s['mixer[3]']) / 1000, m=m.astype(float)).items(): out[nm] = blocks(x, k)
    keep = out['m'] > 0.999
    return {k2: v[keep] for k2, v in out.items()}

def ols(X, y):
    c, *_ = np.linalg.lstsq(X, y, rcond=None); res = y - X @ c
    return c, 1 - res.var() / y.var(), res

def boot_se(fn, n, blockN, B=200, rng=np.random.default_rng(2)):
    nb = n // blockN; idx = np.arange(nb * blockN).reshape(nb, blockN); vals = []
    for _ in range(B): vals.append(fn(idx[rng.integers(0, nb, nb)].ravel()))
    return np.std(vals, axis=0, ddof=1)

def battery_gaui(s):
    d = prep(s, 'gaui'); V, I, Q = d['V'], d['I'], d['Q']
    X = np.c_[np.ones_like(V), Q, Q ** 2, -I]
    c, r2, res = ols(X, V)
    se = boot_se(lambda ix: ols(X[ix], V[ix])[0], len(V), 100)
    # rest voltages: last 1 s before the first SPOOLUP with I < 1 A; and the last 1 s of the log with I < 1 A after the flight
    r = s['rate']; sp = np.nonzero(s['gov'] == 2)[0]
    pre = s['Vbat'][max(0, sp[0] - int(1.0 * r)):sp[0]] / 100 if len(sp) else np.array([])
    end = np.nonzero((s['Ibat'] / 100 < 1) & (s['t'] > s['t'][-1] - 3))[0]
    qend = float(Q[-1])
    # fast resistance from band-passed regression
    from scipy.signal import butter, sosfiltfilt
    sos = butter(2, [0.5, 5], btype='band', fs=50, output='sos')
    Vb, Ib = sosfiltfilt(sos, V), sosfiltfilt(sos, I)
    Rf = -float((Vb * Ib).sum() / (Ib * Ib).sum())
    return dict(log=s['log'], n=len(V), R_ohm=float(c[3]), R_se=float(se[3]), Voc0=float(c[0]), dVoc_dAh=float(c[1]), d2=float(c[2]), r2=float(r2), resid_rms_V=float(res.std()),
                R_fast_0p5_5Hz=Rf, I_mean=float(I.mean()), I_p99=float(np.percentile(I, 99)), I_max=float(I.max()), consumed_mAh=1000 * float(s['Ibat'].sum() / 100 / r / 3600),
                Vrest_pre=float(np.median(pre)) if len(pre) else None, Vmin=float(V.min()), Vmean=float(V.mean()), cells=6)

def motor_gaui(s):
    d = prep(s, 'gaui'); V, I, D, W = d['V'], d['I'], d['D'], d['W']
    Im = I / D
    # (a) D V = W / Kv + Rm Im           (b) D V = d0 V + W / Kv + Rm Im
    Xa = np.c_[W, Im]; ca, r2a, _ = ols(Xa, D * V)
    Xb = np.c_[V, W, Im]; cb, r2b, _ = ols(Xb, D * V)
    sea = boot_se(lambda ix: ols(Xa[ix], (D * V)[ix])[0], len(V), 100)
    seb = boot_se(lambda ix: ols(Xb[ix], (D * V)[ix])[0], len(V), 100)
    # current prediction quality of model (a): I = D (D V - W/Kv)/Rm
    Ihat = D * (D * V - W * ca[0]) / ca[1]
    r2I = 1 - np.var(I - Ihat) / np.var(I)
    # proxies of current for a log without it
    prox = {}
    for nm, p in dict(D_W=D * W, D2V=D * D * V, D_W_V=D * W * V, c2W3=(d['c'] ** 2) * W ** 3).items():
        cc, rr, _ = ols(np.c_[np.ones_like(p), p], I); prox[nm] = float(rr)
    return dict(log=s['log'], n=len(V), Kv_rpm_per_V=float(1 / ca[0]), Kv_se=float(sea[0] / ca[0] ** 2), Rm_ohm=float(ca[1]), Rm_se=float(sea[1]), r2=float(r2a),
                b_d0=float(cb[0]), b_d0_se=float(seb[0]), b_Kv=float(1 / cb[1]), b_Kv_se=float(seb[1] / cb[1] ** 2), b_Rm=float(cb[2]), b_Rm_se=float(seb[2]), b_r2=float(r2b),
                r2_current_from_model=float(r2I), proxy_r2=prox, Im_mean=float(Im.mean()), D_mean=float(D.mean()), W_mean=float(W.mean()),
                Pelec_W_mean=float((V * I).mean()), Pelec_W_p99=float(np.percentile(V * I, 99)))

def sag_model(s, craft, poly_t=2):
    # Battery sag without a current sensor: V = Voc(t) - alpha D^2 V + beta D W   ->  Kv = alpha / beta, alpha = Rb / Rm
    d = prep(s, craft); V, D, W, t = d['V'], d['D'], d['W'], d['t']
    tt = (t - t[0]) / 100
    X = np.c_[np.ones_like(V), tt, tt ** 2, -(D * D * V), D * W]
    c, r2, res = ols(X, V)
    se = boot_se(lambda ix: ols(X[ix], V[ix])[0], len(V), 100)
    a, b = c[3], c[4]
    kv = a / b
    # delta-method SE of a/b with bootstrap of the ratio
    rs = boot_se(lambda ix: (lambda cc: cc[3] / cc[4])(ols(X[ix], V[ix])[0]), len(V), 100)
    # simple proxy: V = Voc(t) - k D W
    X2 = np.c_[np.ones_like(V), tt, tt ** 2, -(D * W)]; c2, r22, _ = ols(X2, V)
    return dict(log=s['log'], n=len(V), alpha_Rb_over_Rm=float(a), alpha_se=float(se[3]), beta=float(b), Kv_rpm_per_V=float(kv), Kv_se=float(rs), r2=float(r2),
                k_DW=float(c2[3]), r2_DW=float(r22), Voc_t0=float(c[0]), dVoc_per_100s=float(c[1]), resid_rms_V=float(res.std()), D_mean=float(D.mean()), V_mean=float(V.mean()))

def rest_and_decline(s, craft):
    r = s['rate']; V = s['Vbat'] / 100; sp = np.nonzero(s['gov'] == 2)[0]
    pre = float(np.median(V[max(0, sp[0] - int(1.0 * r)):sp[0]])) if len(sp) and sp[0] > 10 else None
    fl = s['phase'] == 3; ii = np.nonzero(fl)[0]
    if not len(ii): return None
    i0, i1 = ii[0], ii[-1]
    hov = lambda a, b: float(np.median(V[a:b]))
    # voltage at matched load early vs late: median V over the first and last 20 s of the flight phase
    return dict(log=s['log'], Vrest_pre=pre, V_first20s=hov(i0, i0 + int(20 * r)), V_last20s=hov(i1 - int(20 * r), i1), flightS=(i1 - i0) / r,
                Vmin=float(V[fl].min()), Vmin_t=float(s['t'][ii[np.argmin(V[fl])]]), D_first20s=float(np.median(s['motor[0]'][i0:i0 + int(20 * r)])) / 1000,
                D_last20s=float(np.median(s['motor[0]'][i1 - int(20 * r):i1])) / 1000, Tesc_start=float(np.median(s['Tesc'][i0:i0 + int(5 * r)])), Tesc_end=float(np.median(s['Tesc'][i1 - int(5 * r):i1])), Tesc_max=float(s['Tesc'][fl].max()))

def run(craft):
    S = [s for s in segs(craft) if s['cls'] == 'flight']
    R = dict(rest=[rest_and_decline(s, craft) for s in S], sag=[sag_model(s, craft) for s in S])
    if craft == 'gaui':
        R['battery'] = [battery_gaui(s) for s in S]; R['motor'] = [motor_gaui(s) for s in S]
    return R

if __name__ == '__main__':
    for craft in ['gaui', 'fireball']:
        R = run(craft); print('==', craft)
        for k, v in R.items():
            for x in v: print(k, rnd(x, 4))
        for k in ['battery', 'motor', 'sag']:
            if k in R:
                keys = [kk for kk, vv in R[k][0].items() if isinstance(vv, float)]
                print(k, 'across flights', {kk: rnd(mean_se([x[kk] for x in R[k]]), 4) for kk in keys})
