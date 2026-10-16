# (3) throttle saturation; Vbat telemetry lag
from common import *
from scipy.signal import butter, sosfiltfilt

def hp_band(x, rate, lo=0.3, hi=5):
    sos = butter(2, [lo, hi], btype='band', fs=rate, output='sos'); return sosfiltfilt(sos, x)

def vbat_lag(s, ref='motor[0]', maxS=0.3):
    r = s['rate']; m = (s['phase'] == 3) & (s['gov'] == 4)
    rr = runs(m); 
    if not rr: return None
    i0, i1 = max(rr, key=lambda a: a[1] - a[0])
    v = hp_band(s['Vbat'][i0:i1], r); u = hp_band(s[ref][i0:i1] * (1 if ref != 'motor[0]' else 1), r)
    if ref == 'motor[0]': u = hp_band(s['motor[0]'][i0:i1] * s['hs'][i0:i1], r)  # power proxy
    lags = np.arange(0, int(maxS * r)); c = [np.corrcoef(v[k:], u[:len(u) - k])[0, 1] for k in lags]
    k = int(np.argmin(c)); return dict(lagS=k / r, corr=float(c[k]), corr0=float(c[0]))

def sat_runs(s, thr):
    r = s['rate']; m = (s['motor[0]'] >= thr) & (s['gov'] == 4) & np.isin(s['phase'], [2, 3])
    out = []
    for i0, i1 in runs(m):
        w0 = max(0, i0 - int(0.5 * r)); lagN = int(0.07 * r)
        e = (s['hs'] - s['govTarget'])[i0:min(len(m), i1 + int(0.5 * r))] / s['govRequest'][i0]
        out.append(dict(log=s['log'], t=round(float(s['t'][i0]), 3), dur=round((i1 - i0) / r, 3), req=float(s['req'][i0]), phase=PH[s['phase'][i0]], rescue=bool(s['rescueAt'][i0:i1].any()),
                        coll_abs_max=round(float(np.abs(s['mixer[3]'][w0:i1]).max() / 1000), 3), coll_abs_mean=round(float(np.abs(s['mixer[3]'][i0:i1]).mean() / 1000), 3),
                        cyc_max=round(float(np.sqrt(s['mixer[0]'][w0:i1] ** 2 + s['mixer[1]'][w0:i1] ** 2).max() / 1000), 3), yaw_abs_max=round(float(np.abs(s['mixer[2]'][w0:i1]).max() / 1000), 3),
                        vbat=round(float(np.median(s['Vbat'][i0 + lagN:i1 + lagN]) / 100), 2), vbat_min=round(float(s['Vbat'][i0:i1 + lagN].min() / 100), 2),
                        vbat_pre=round(float(np.median(s['Vbat'][max(0, i0 - int(2 * r)):i0 - int(0.5 * r)]) / 100), 2) if i0 > 2 * r else None,
                        err_min_pct=round(100 * float(e.min()), 2), sum_max=float(s['govSum'][i0:i1].max()), I_max=float(s['govI'][i0:i1].max()), F_max=float(s['govF'][i0:i1].max()), P_max=float(s['govP'][i0:i1].max()),
                        ibat_max=float(s['Ibat'][i0:i1 + lagN].max() / 100)))
    return out

def run(craft):
    S = [s for s in segs(craft) if s['cls'] == 'flight']
    R = dict(lag=[], perProfile={}, runs98=[], runs100=[], vbatBins=None)
    for s in S:
        lg = vbat_lag(s); 
        if lg: R['lag'].append(dict(log=s['log'], **lg))
        R['runs98'] += sat_runs(s, 980); R['runs100'] += sat_runs(s, 1000)
    # per profile totals over ACTIVE flight time
    for H in sorted(set(int(v) for s in S for v in np.unique(s['req'][(s['gov'] == 4) & (s['phase'] == 3)]))):
        tot = sum(((s['gov'] == 4) & (s['phase'] == 3) & (s['req'] == H)).sum() for s in S) / S[0]['rate']
        s98 = sum(((s['gov'] == 4) & (s['phase'] == 3) & (s['req'] == H) & (s['motor[0]'] >= 980)).sum() for s in S) / S[0]['rate']
        s100 = sum(((s['gov'] == 4) & (s['phase'] == 3) & (s['req'] == H) & (s['motor[0]'] >= 1000)).sum() for s in S) / S[0]['rate']
        mot = np.concatenate([s['motor[0]'][(s['gov'] == 4) & (s['phase'] == 3) & (s['req'] == H)] for s in S])
        dem = np.concatenate([s['govSum'][(s['gov'] == 4) & (s['phase'] == 3) & (s['req'] == H)] for s in S])
        R['perProfile'][H] = dict(activeFlightS=round(tot, 1), s98=round(s98, 2), s100=round(s100, 2), share98=s98 / tot, share100=s100 / tot,
                                  n98=sum(1 for x in R['runs98'] if x['req'] == H and x['phase'] == 'flight'), n100=sum(1 for x in R['runs100'] if x['req'] == H and x['phase'] == 'flight'),
                                  motor=q(mot, (1, 50, 95, 99, 99.9, 100)), govSum=q(dem, (50, 99, 99.9, 100)))
    # saturation share vs battery voltage (flight, ACTIVE, by profile)
    bins = np.arange(20.0, 26.01, 0.5); vb = {}
    for H in R['perProfile']:
        rows = []
        for a, b in zip(bins[:-1], bins[1:]):
            n = s98 = 0; mm = []
            for s in S:
                m = (s['gov'] == 4) & (s['phase'] == 3) & (s['req'] == H) & (s['Vbat'] / 100 >= a) & (s['Vbat'] / 100 < b)
                n += m.sum(); s98 += (m & (s['motor[0]'] >= 980)).sum(); mm.append(s['motor[0]'][m])
            if n > 2000: rows.append(dict(v0=float(a), v1=float(b), s=round(n / S[0]['rate'], 1), share98=s98 / n, motorMedian=float(np.median(np.concatenate(mm))), motorP99=float(np.percentile(np.concatenate(mm), 99))))
        vb[H] = rows
    R['vbatBins'] = vb
    return R

if __name__ == '__main__':
    for craft in ['fireball', 'gaui']:
        R = run(craft); print('==', craft)
        print('lag', R['lag'])
        for H, v in R['perProfile'].items(): print(H, rnd(v, 4))
        print('runs98 n', len(R['runs98']), 'runs100 n', len(R['runs100']))
        for x in sorted(R['runs100'], key=lambda x: -x['dur'])[:25]: print(x)
        for H, rows in R['vbatBins'].items():
            for r in rows: print(H, rnd(r, 3))
