# (5) drivetrain plant identification from flight data:
#   J dw/dt = kmV * D(t - tau) * V - kmW * w - Qa(w, collective),  Qa = w^2 (q0 + q1 |c| + q2 c^2 + q3 cyc^2)
# divided by J this is linear in the coefficients; Kv = kmV / kmW (rad/s per V). Gaui: J from the measured current.
from common import *
from scipy.signal import butter, sosfiltfilt

LAGV = {'gaui': 0.045, 'fireball': 0.066}; LAGI = 0.087
RPM2RAD = 2 * np.pi / 60

def lp(x, fc, r):
    sos = butter(2, fc, fs=r, output='sos'); return sosfiltfilt(sos, x)

def design(s, craft, tau, blk=10, fc=15, states=(4,), phases=(3,)):
    r = s['rate']; n = len(s['hs'])
    w = lp(s['hs'], fc, r) * RPM2RAD
    dw = np.gradient(w) * r
    lv = int(round(LAGV[craft] * r)); k = int(round(tau * r)); li = int(round(LAGI * r))
    V = np.concatenate([s['Vbat'][lv:], np.full(lv, s['Vbat'][-1])]) / 100
    D = s['motor[0]'] / 1000
    Dd = np.concatenate([np.full(k, D[0]), D[:n - k]]) if k > 0 else D
    Vd = np.concatenate([np.full(k, V[0]), V[:n - k]]) if k > 0 else V
    c = np.abs(s['mixer[3]']) / 1000; cyc = np.hypot(s['mixer[0]'], s['mixer[1]']) / 1000
    c = lp(c, fc, r); cyc = lp(cyc, fc, r)
    I = np.concatenate([s['Ibat'][li:], np.full(li, s['Ibat'][-1])]) / 100
    m = np.isin(s['gov'], states) & np.isin(s['phase'], phases) & (s['rescueAt'] == 0) & (Dd > 0.05)
    nb = n // blk
    B = lambda x: x[:nb * blk].reshape(nb, blk).mean(1)
    keep = B(m.astype(float)) > 0.999
    out = dict(w=B(w), dw=B(dw), u=B(Dd * Vd), D=B(Dd), c=B(c), cyc=B(cyc), I=B(I), V=B(Vd))
    return {kk: v[keep] for kk, v in out.items()}

def fit_plant(d):
    w = d['w']; X = np.c_[d['u'], -w, -w ** 2, -w ** 2 * d['c'], -w ** 2 * d['c'] ** 2, -w ** 2 * d['cyc'] ** 2]
    c, *_ = np.linalg.lstsq(X, d['dw'], rcond=None); res = d['dw'] - X @ c
    return c, 1 - res.var() / d['dw'].var(), X

def run(craft):
    S = [s for s in segs(craft) if s['cls'] == 'flight']
    taus = [0, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08]
    res = {'tauScan': {}, 'perFlight': [], 'spoolup': []}
    for tau in taus:
        r2s = []
        for s in S:
            d = design(s, craft, tau); c, r2, _ = fit_plant(d); r2s.append(r2)
        res['tauScan'][tau] = float(np.mean(r2s))
    tbest = max(res['tauScan'], key=res['tauScan'].get)
    for s in S:
        d = design(s, craft, tbest); c, r2, X = fit_plant(d)
        # block bootstrap of Kv
        nb = len(d['w']) // 100; rng = np.random.default_rng(3); kv = []; a1 = []
        idx = np.arange(nb * 100).reshape(nb, 100)
        for _ in range(200):
            ix = idx[rng.integers(0, nb, nb)].ravel(); cc, *_ = np.linalg.lstsq(X[ix], d['dw'][ix], rcond=None); kv.append(cc[0] / cc[1] / RPM2RAD); a1.append(cc[0])
        row = dict(log=s['log'], n=len(d['w']), tau=tbest, r2=float(r2), a_u=float(c[0]), a_w=float(c[1]), Kv_rpm_per_V=float(c[0] / c[1] / RPM2RAD), Kv_se=float(np.std(kv, ddof=1)),
                   tau_mech_s=None, q=[float(x) for x in c[2:]])
        # small-signal mechanical time constant at the median operating point: d(dw)/dw = -(a_w + 2 w (q0 + q1 c + q2 c^2 + q3 cyc^2))
        wm, cm, cy = np.median(d['w']), np.median(d['c']), np.median(d['cyc'])
        slope = c[1] + 2 * wm * (c[2] + c[3] * cm + c[4] * cm ** 2 + c[5] * cy ** 2)
        row['tau_mech_s'] = float(1 / slope) if slope > 0 else None
        row['w_med_rpm'] = float(wm / RPM2RAD)
        if craft == 'gaui':
            # J from current: Kt I_m = J dw/dt + Qa ; Kt = 1/Kv_rad from the current-based motor fit, here from this flight's own a_u/a_w is not used
            Im = d['I'] / np.maximum(d['D'], 0.05)
            Y = Im
            w = d['w']; Xj = np.c_[d['dw'], w ** 2, w ** 2 * d['c'], w ** 2 * d['c'] ** 2, w ** 2 * d['cyc'] ** 2, np.ones_like(w)]
            cj, *_ = np.linalg.lstsq(Xj, Y, rcond=None); rj = 1 - np.var(Y - Xj @ cj) / np.var(Y)
            row['J_over_Kt'] = float(cj[0]); row['r2_current'] = float(rj); row['I0_A'] = float(cj[5])
        res['perFlight'].append(row)
    return res

if __name__ == '__main__':
    for craft in ['gaui', 'fireball']:
        R = run(craft); print('==', craft, 'tau scan', rnd(R['tauScan'], 4))
        for x in R['perFlight']: print(rnd(x, 5))
        print('Kv', rnd(mean_se([x['Kv_rpm_per_V'] for x in R['perFlight']]), 3), 'tau_mech', rnd(mean_se([x['tau_mech_s'] for x in R['perFlight']]), 4))
        if craft == 'gaui': print('J/Kt', rnd(mean_se([x['J_over_Kt'] for x in R['perFlight']]), 5))
