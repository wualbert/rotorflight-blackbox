# Spool-up (open-loop throttle ramp) and spool-down (throttle 0) identification on the ground
from common import *
from s5_plant import lp, LAGV, LAGI, RPM2RAD

def spool_runs(s):
    g = s['gov']; out = []
    for i0, i1 in runs(g == 2):
        out.append((i0, i1))
    return out

def run(craft, tau=0.0):
    S = segs(craft); rows = []; downs = []
    for s in S:
        r = s['rate']; n = len(s['hs'])
        w = lp(s['hs'], 10, r) * RPM2RAD; dw = np.gradient(w) * r
        lv = int(round(LAGV[craft] * r)); li = int(round(LAGI * r)); k = int(round(tau * r))
        V = np.concatenate([s['Vbat'][lv:], np.full(lv, s['Vbat'][-1])]) / 100
        I = np.concatenate([s['Ibat'][li:], np.full(li, s['Ibat'][-1])]) / 100
        D = s['motor[0]'] / 1000; Dd = np.concatenate([np.full(k, 0), D[:n - k]]) if k else D
        c = np.abs(s['mixer[3]']) / 1000
        for i0, i1 in spool_runs(s):
            if (i1 - i0) / r < 3: continue
            # IDLE part before SPOOLUP with the rotor turning is excluded; use samples with w > 300 rpm
            m = np.zeros(n, bool); m[i0:i1] = True; m &= (w > 300 * RPM2RAD) & (Dd > 0.05)
            ii = np.nonzero(m)[0][::10]
            X = np.c_[Dd[ii] * V[ii], -w[ii], -w[ii] ** 2]
            cc, *_ = np.linalg.lstsq(X, dw[ii], rcond=None); r2 = 1 - np.var(dw[ii] - X @ cc) / np.var(dw[ii])
            row = dict(craft=craft, log=s['log'], t=round(float(s['t'][i0]), 2), cls=s['cls'], n=len(ii), r2=float(r2), a_u=float(cc[0]), a_w=float(cc[1]), q=float(cc[2]),
                       Kv_rpm_per_V=float(cc[0] / cc[1] / RPM2RAD) if cc[1] > 0 else None, coll_med=float(np.median(c[ii])),
                       dur=round((i1 - i0) / r, 2), hs_end=float(s['hs'][i1 - 1]), req=float(s['req'][i1 - 1]), D_end=float(D[i1 - 1]))
            if craft == 'gaui':
                Im = I[ii] / np.maximum(D[ii], 0.05)
                Xj = np.c_[dw[ii], w[ii] ** 2, np.ones(len(ii))]
                cj, *_ = np.linalg.lstsq(Xj, Im, rcond=None); rj = 1 - np.var(Im - Xj @ cj) / np.var(Im)
                row.update(J_over_Kt=float(cj[0]), q_over_Kt=float(cj[1]), I0=float(cj[2]), r2_current=float(rj))
            rows.append(row)
        # spool-down: AUTOROTATION/HOLD/OFF after ACTIVE, motor 0, rotor turning, on the ground or after landing
        for i0, i1 in runs((D == 0) & (s['hs'] > 500) & np.isin(s['gov'], [0, 5, 7]) & (s['phase'] == 4)):
            if (i1 - i0) / r < 1.5: continue
            ii = np.arange(i0 + int(0.2 * r), i1, 10)
            X = np.c_[-w[ii] ** 2, -np.ones(len(ii))]
            cc, *_ = np.linalg.lstsq(X, dw[ii], rcond=None); r2 = 1 - np.var(dw[ii] - X @ cc) / np.var(dw[ii])
            X1 = np.c_[-w[ii] ** 2]; c1, *_ = np.linalg.lstsq(X1, dw[ii], rcond=None)
            downs.append(dict(log=s['log'], t=round(float(s['t'][i0]), 2), dur=round((i1 - i0) / r, 2), hs0=float(s['hs'][i0]), hs1=float(s['hs'][i1 - 1]), q_over_J=float(cc[0]), f_over_J=float(cc[1]),
                              q_over_J_only=float(c1[0]), r2=float(r2), coll_med=float(np.median(c[ii])), coll_signed_med=float(np.median(s['mixer[3]'][ii]) / 1000)))
    return rows, downs

if __name__ == '__main__':
    for craft in ['gaui', 'fireball']:
        for tau in [0.0, 0.03, 0.06]:
            rows, downs = run(craft, tau)
            print('==', craft, 'tau', tau)
            for x in rows: print(rnd(x, 5))
            print('Kv', rnd(mean_se([x['Kv_rpm_per_V'] for x in rows if x['Kv_rpm_per_V']]), 3), 'r2', rnd(mean_se([x['r2'] for x in rows]), 3))
            if craft == 'gaui': print('J/Kt', rnd(mean_se([x['J_over_Kt'] for x in rows]), 5), 'r2I', rnd(mean_se([x['r2_current'] for x in rows]), 3))
        for x in downs: print('down', rnd(x, 6))
