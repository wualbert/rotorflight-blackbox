# Extras: motor-voltage demand D*V per profile (headroom), tracking-time inference, F weights per flight, Tesc vs current, rescue tracking
from common import *
from scipy.optimize import nnls
from s7_gains import HDR

def demand(craft):
    S = [s for s in segs(craft) if s['cls'] == 'flight']; lag = {'gaui': 0.045, 'fireball': 0.066}[craft]; out = {}
    for H in sorted(set(int(v) for s in S for v in np.unique(s['req'][(s['gov'] == 4) & (s['phase'] == 3)]))):
        dv, vb, sat = [], [], 0; n = 0
        for s in S:
            r = s['rate']; lv = int(round(lag * r)); V = np.concatenate([s['Vbat'][lv:], np.full(lv, s['Vbat'][-1])]) / 100
            m = (s['gov'] == 4) & (s['phase'] == 3) & (s['req'] == H)
            u = m & (s['motor[0]'] < 1000)
            dv.append((s['motor[0]'] / 1000 * V)[u]); vb.append(V[m]); sat += (m & (s['motor[0]'] >= 1000)).sum(); n += m.sum()
        dv = np.concatenate(dv); vb = np.concatenate(vb)
        out[H] = dict(DV_V=q(dv, (50, 90, 99, 99.9, 100)), Vbat=q(vb, (1, 5, 50, 95)), censoredShare=float(sat / n), seconds=float(n / S[0]['rate']),
                      note='D*V = motor[0] x Vbat (telemetry lag removed): the effective motor voltage; samples at 100 % are censored (demand higher)')
    return out

def tracking_time(craft):
    S = segs(craft); rows = []
    for s in S:
        r = s['rate']
        for i in np.nonzero(np.diff(s['req']) != 0)[0] + 1:
            if s['gov'][i] != 4 or i < 5 * r: continue
            r0, r1 = s['req'][i - 1], s['req'][i]; tg = s['govTarget'][i:i + int(3 * r)]
            k = np.nonzero(np.abs(tg - r1) < 1)[0]
            if not len(k) or k[0] < 50: continue
            slope = abs(r1 - r0) / (k[0] / r)
            hs = s['hs'][i - int(5 * r):i]; mo = s['motor[0]'][i - int(5 * r):i] / 1000
            K = float(np.median(hs[mo > 0.2] / mo[mo > 0.2]))  # firmware motorRPMK ~ EWMA(hs / throttle), 0.05 Hz
            rows.append(dict(log=s['log'], t=round(float(s['t'][i]), 2), slope_rpm_s=float(slope), motorRPMK=K, fullHS=float(r0), implied_tracking_time=float(10 * max(r0, K) / slope)))
    return rows

def f_weights_per_flight(craft):
    S = [s for s in segs(craft) if s['cls'] == 'flight']; h = HDR[craft]; g = 1000 * h['K'] * h['Kf']; out = {}
    for s in S:
        r = s['rate']; c = np.abs(s['mixer[3]']) / 1000; cyc = np.hypot(s['mixer[0]'], s['mixer[1]']) / 1000; yw = np.abs(s['mixer[2]']) / 1000
        R = np.c_[pt2(c ** 2, 5, r), pt2(cyc, 5, r), pt2(yw, 5, r)]
        for H in np.unique(s['req'][(s['gov'] == 4) & (s['phase'] == 3)]):
            m = (s['gov'] == 4) & (s['phase'] == 3) & (s['req'] == H) & (s['rescueAt'] == 0)
            if m.sum() < 5000: continue
            w, _ = nnls(R[m][::5], s['govF'][m][::5]); out.setdefault(int(H), []).append(100 * w / g)
    return {H: dict(collective=mean_se([x[0] for x in v]), cyclic=mean_se([x[1] for x in v]), yaw=mean_se([x[2] for x in v])) for H, v in out.items()}

def tesc(craft):
    S = [s for s in segs(craft) if s['cls'] == 'flight']; rows = []
    for s in S:
        r = s['rate']; ii = np.nonzero(s['phase'] == 3)[0]; i0, i1 = ii[0], ii[-1]
        T = s['Tesc']; dur = (i1 - i0) / r
        a, b = np.polyfit(np.arange(i0, i1, 100) / r, T[i0:i1:100], 1)
        I = s['Ibat'][i0:i1] / 100; P = (s['Vbat'][i0:i1] / 100) * I
        rows.append(dict(log=s['log'], T_start=float(np.median(T[i0:i0 + int(5 * r)])), T_end=float(np.median(T[i1 - int(5 * r):i1])), T_max=float(T[i0:i1].max()), slope_C_per_min=float(60 * a),
                         I_rms=float(np.sqrt((I ** 2).mean())) if craft == 'gaui' else None, P_mean_W=float(P.mean()) if craft == 'gaui' else None, flightS=dur,
                         update_ms=float(np.median(np.diff(np.nonzero(np.diff(T) != 0)[0])) / r * 1000)))
    return rows

def rescue_tracking(craft):
    S = [s for s in segs(craft) if s['cls'] == 'flight']; rows = []
    for s in S:
        r = s['rate']
        for i0, i1 in runs(s['rescueAt'] > 0):
            a = slice(max(0, i0 - int(1 * r)), i1 + int(1 * r)); e = (s['hs'] - s['govRequest'])[a] / s['govRequest'][a]
            rows.append(dict(log=s['log'], t=round(float(s['t'][i0]), 2), dur=round((i1 - i0) / r, 2), req=float(s['req'][i0]), err_min_pct=float(100 * e.min()),
                             motor_max_pct=float(s['motor[0]'][a].max() / 10), sat_s=float((s['motor[0]'][a] >= 980).sum() / r), states=sorted(set(ST[v] for v in s['gov'][a]))))
    return rows

def run(craft):
    return dict(demand=demand(craft), trackingTime=tracking_time(craft), fWeightsPerFlight=f_weights_per_flight(craft), tesc=tesc(craft), rescue=rescue_tracking(craft))

if __name__ == '__main__':
    for craft in ['fireball', 'gaui']:
        R = run(craft); print('==', craft)
        for k, v in R.items(): print(k, rnd(v, 3))
