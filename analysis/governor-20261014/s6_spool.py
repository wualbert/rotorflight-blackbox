# (6) spool-up profiles, handover, bailout, fallback events
from common import *

def slope_fit(t, y):
    A = np.c_[t - t.mean(), np.ones_like(t)]; c, *_ = np.linalg.lstsq(A, y, rcond=None); res = y - A @ c
    se = np.sqrt(res.var() * len(t) / max(1, len(t) - 2) / ((t - t.mean()) ** 2).sum()); return float(c[0]), float(se)

def spoolups(S):
    out = []
    for s in S:
        r = s['rate']; g = s['gov']; mot = s['motor[0]']; hs = s['hs']
        for i0, i1 in runs(g == 2):
            # IDLE before
            j0 = i0
            while j0 > 0 and g[j0 - 1] == 1: j0 -= 1
            idle = slice(j0, i0)
            idle_m = mot[idle]; idle_slope = None
            if i0 - j0 > 0.3 * r and idle_m.max() > idle_m.min():
                kk = np.nonzero((idle_m > 0) & (idle_m < idle_m.max()))[0]
                if len(kk) > 50: idle_slope = slope_fit(kk / r, idle_m[kk] / 10)
            # SPOOLUP ramp: samples where motor rises, excluding the last 2 % of the run
            m = mot[i0:i1]; kk = np.arange(len(m))
            rising = kk[(m > m[0] + 5) & (m < m.max() - 5)]
            sl = slope_fit(rising / r, m[rising] / 10) if len(rising) > 50 else (None, None)
            nxt = g[i1] if i1 < len(g) else None
            req = s['req'][i1 - 1]; hsx = hs[i1 - 1]
            row = dict(log=s['log'], cls=s['cls'], t=round(float(s['t'][i0]), 3), dur=round((i1 - i0) / r, 3), idleS=round((i0 - j0) / r, 3), idleMotorMax_pct=float(idle_m.max() / 10) if len(idle_m) else None,
                       idleSlope_pct_s=idle_slope[0] if idle_slope else None, slope_pct_s=sl[0], slope_se=sl[1], motorStart_pct=float(m[0] / 10), motorEnd_pct=float(m[-1] / 10),
                       hsEnd=float(hsx), req=float(req), hsEndRatio=float(hsx / req), exitBy=('headspeed' if hsx >= 0.99 * req - 30 else ('throttle 95 %' if m[-1] >= 940 else 'other')),
                       next=ST[nxt] if nxt is not None else None, phase=PH[int(np.bincount(s['phase'][i0:i1]).argmax())], coll_med=float(np.median(s['mixer[3]'][i0:i1]) / 1000))
            if nxt == 4:
                end = min(len(hs), i1 + int(5 * r)); chg = np.nonzero((s['req'][i1:end] != req) | (g[i1:end] != 4))[0]
                if len(chg): end = i1 + chg[0]
                a = slice(i1, end); row['windowS'] = round((end - i1) / r, 3)
                e = (hs[a] - req) / req
                row.update(overshoot_pct=float(100 * e.max()), undershoot_pct=float(100 * e.min()), tMax=float(np.argmax(e) / r),
                           motorStep_pct=float((np.median(mot[i1:i1 + 20]) - np.median(mot[i1 - 20:i1])) / 10), motorAfterMax_pct=float(mot[a].max() / 10))
                st = None; hold = int(0.5 * r)
                for k in range(0, len(e) - hold):
                    if np.all(np.abs(e[k:k + hold]) < 0.01): st = k / r; break
                row['settle1pctS'] = st
                # time from SPOOLUP start to the headspeed within 1 % of the request for 0.5 s
                row['timeToTarget_s'] = None if st is None else round((i1 - i0) / r + st, 3)
            out.append(row)
    return out

def glitch_proxy(s, i0, i1, req):
    from common import pt2
    hs = s['hs'][max(0, i0 - 3000):i1]; f = pt2(hs, 10, s['rate'])
    d = np.abs(hs - f)[i0 - max(0, i0 - 3000):]
    return float(d.max()), float(0.25 * req)

def fallbacks(S):
    out = []
    for s in S:
        r = s['rate']; g = s['gov']
        for i0, i1 in runs(g == 6):
            req = s['req'][i0]; w = slice(i0 - int(1.0 * r), i1 + int(2.0 * r))
            hs = s['hs']; mot = s['motor[0]']
            dmax, lim = glitch_proxy(s, i0 - int(0.5 * r), i0 + int(0.05 * r), req)
            jumps = np.abs(np.diff(hs[i0 - int(0.5 * r):i0 + int(0.25 * r)]))
            # saturation before
            k = i0
            while k > 0 and mot[k - 1] >= 980: k -= 1
            rec = np.nonzero(g[i1:] == 4)[0]; rec_i = i1 + rec[0] if len(rec) else None
            out.append(dict(log=s['log'], t=round(float(s['t'][i0]), 3), dur=round((i1 - i0) / r, 3), req=float(req),
                            hs_at_entry=float(hs[i0]), hs_1s_before=float(hs[i0 - int(1.0 * r)]), hs_min_window=float(hs[w].min()), hs_min_t=round(float(s['t'][w][np.argmin(hs[w])]), 3),
                            hs_drop_pct_before=float(100 * (hs[i0] - hs[i0 - int(0.5 * r):i0].max()) / req), max_jump_rpm_per_sample=float(jumps.max()),
                            glitchProxy_rpm=dmax, glitchLimit_rpm=lim, hs_below10=bool((hs[i0 - int(0.5 * r):i1] < 10).any()),
                            satBeforeS=float((i0 - k) / r), motor_entry_pct=float(mot[i0 - 1] / 10), motor_in_fallback_pct=q(mot[i0:i1] / 10, (0, 50, 100)),
                            govI_entry=float(s['govI'][i0 - 1] / 10), govF_entry=float(s['govF'][i0 - 1] / 10), fallbackPred_pct=float((s['govI'][i0] + 0) / 10 * 0.9),
                            coll=float(s['mixer[3]'][i0] / 1000), coll_max=float(np.abs(s['mixer[3]'][i0 - int(1.0 * r):i0]).max() / 1000),
                            vbat=float(s['Vbat'][i0] / 100), vbat_min=float(s['Vbat'][w].min() / 100), rescue=bool(s['rescueAt'][w].any()), rescue_start_t=(round(float(s['t'][w][np.argmax(s['rescueAt'][w])]), 3) if s['rescueAt'][w].any() else None),
                            recovery_dur=round((rec_i - i1) / r, 3) if rec_i else None, motor_recovery_slope_pct_s=(slope_fit(np.arange(i1, rec_i) / r, mot[i1:rec_i] / 10)[0] if rec_i and rec_i - i1 > 50 else None),
                            hs_at_active=float(hs[rec_i]) if rec_i else None))
    return out

def bailout(S):
    out = []
    for s in S:
        r = s['rate']; g = s['gov']
        for i0, i1 in runs(g == 8):
            a = slice(i0 - int(2 * r), i1 + int(6 * r))
            out.append(dict(log=s['log'], t=round(float(s['t'][i0]), 3), dur=round((i1 - i0) / r, 3), hs_entry=float(s['hs'][i0]), hs_exit=float(s['hs'][i1]), req=float(s['req'][i0]),
                            motor_entry=float(s['motor[0]'][i0] / 10), motor_exit=float(s['motor[0]'][i1 - 1] / 10), phase=PH[s['phase'][i0]],
                            after=dict(motor_max=float(s['motor[0]'][i1:i1 + int(6 * r)].max() / 10), hs_min=float(s['hs'][i1:i1 + int(6 * r)].min()), hs_6s=float(s['hs'][i1 + int(6 * r)]),
                                       sat_s=float((s['motor[0]'][i1:i1 + int(6 * r)] >= 980).sum() / r), coll_med=float(np.median(s['mixer[3]'][i1:i1 + int(6 * r)]) / 1000),
                                       yaw_abs_med=float(np.median(np.abs(s['mixer[2]'][i1:i1 + int(6 * r)])) / 1000), gyroZ_absmax=float(np.abs(s['gyroADC[2]'][i1:i1 + int(6 * r)]).max()),
                                       vbat=float(np.median(s['Vbat'][i1:i1 + int(6 * r)]) / 100), airborne_share=float(s['airborneAt'][i1:i1 + int(6 * r)].mean()))))
    return out

def glitch_census(S, thr=(50, 100, 200)):
    out = {}
    for s in S:
        if s['cls'] != 'flight': continue
        r = s['rate']; m = (s['gov'] == 4) & (s['phase'] == 3); d = np.abs(np.diff(s['hs'])); mm = m[1:]
        sat = (s['motor[0]'][1:] >= 980)
        for th in thr:
            o = out.setdefault(th, dict(n=0, nSat=0, seconds=0.0, satSeconds=0.0, perReq={}))
            ev = mm & (d > th)
            o['n'] += int(ev.sum()); o['nSat'] += int((ev & sat).sum()); o['seconds'] += float(mm.sum() / r); o['satSeconds'] += float((mm & sat).sum() / r)
            for H in np.unique(s['req'][1:][ev]): o['perReq'][int(H)] = o['perReq'].get(int(H), 0) + int((ev & (s['req'][1:] == H)).sum())
    for th, o in out.items():
        o['ratePerMin_unsat'] = (o['n'] - o['nSat']) / max(1e-9, (o['seconds'] - o['satSeconds'])) * 60
        o['ratePerMin_sat'] = o['nSat'] / max(1e-9, o['satSeconds']) * 60
    return out

def run(craft):
    S = segs(craft)
    return dict(spoolups=spoolups(S), fallbacks=fallbacks(S), bailouts=bailout(S), glitchCensus=glitch_census(S))

if __name__ == '__main__':
    for craft in ['fireball', 'gaui']:
        R = run(craft); print('==', craft)
        for k, v in R.items():
            for x in v: print(k, rnd(x, 3))
