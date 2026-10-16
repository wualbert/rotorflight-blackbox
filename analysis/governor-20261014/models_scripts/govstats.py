import json, sys, numpy as np, os
D = sys.argv[1]; logs = [int(x) for x in sys.argv[2].split(',')]
ST = ['OFF','IDLE','SPOOLUP','RECOVERY','ACTIVE','HOLD','FALLBACK','AUTOROT','BAILOUT','BYPASS']
def load(li):
    j = json.load(open(f'{D}/log{li:02d}.json')); a = np.load(f'{D}/log{li:02d}.npy').astype(float)
    F = {n: a[:, k] for k, n in enumerate(j['fields'])}
    n = j['n']; gov = np.zeros(n, int); air = np.zeros(n, int); prof = np.zeros(n, int)
    ev = sorted(j['events'], key=lambda e: e['i'])
    g = 0; ai = 0; p = 0; k = 0
    for e in ev:
        pass
    marks = []
    for e in ev:
        if e['event'] == 50: marks.append((e['i'], 'g', e['data']['govState']))
        if e['event'] == 52: marks.append((e['i'], 'a', e['data']['airborneState']))
        if e['event'] == 13 and e['data'].get('func') == 2: marks.append((e['i'], 'p', e['data']['value']))
    cur = {'g': 0, 'a': 0, 'p': 0}; last = 0
    for i, kind, v in marks + [(n, 'end', 0)]:
        gov[last:i] = cur['g']; air[last:i] = cur['a']; prof[last:i] = cur['p']; last = i
        if kind != 'end': cur[kind] = v
    return j, F, gov, air, prof
def runs(mask):
    d = np.diff(np.r_[0, mask.astype(int), 0]); s = np.where(d == 1)[0]; e = np.where(d == -1)[0]; return list(zip(s, e))
out = {}
for li in logs:
    if not os.path.exists(f'{D}/log{li:02d}.json'): continue
    j, F, gov, air, prof = load(li)
    t = F['time'] / 1e6; t -= t[0]; dt = np.median(np.diff(t))
    thr = F['motor[0]'] / 1000.0; V = F['Vbat'] / 100.0; I = F['Ibat'] / 100.0; hs = F['headspeed']; tg = F['govTarget']; rq = F['govRequest']
    gs = F['govSum'] / 1000.0; gI = F['govI'] / 1000.0; gF = F['govF'] / 1000.0; gP = F['govP'] / 1000.0; coll = F['mixer[3]'] / 1000.0
    r = {'log': li, 'dur_s': round(t[-1], 1), 'states': {ST[s]: round(float((gov == s).sum() * dt), 1) for s in np.unique(gov)}}
    r['transitions'] = []
    prev = None
    for k in range(len(gov)):
        pass
    ch = np.where(np.diff(gov) != 0)[0]
    r['transitions'] = [(round(t[c + 1], 2), ST[gov[c]] + '>' + ST[gov[c + 1]]) for c in ch]
    # battery voltage
    vchg = np.where(np.diff(V) != 0)[0]
    r['V_updates_per_s'] = round(len(vchg) / t[-1], 1)
    r['V_step_min'] = float(np.min(np.abs(np.diff(V)[vchg]))) if len(vchg) else None
    r['V_first'] = float(np.median(V[:200])); r['V_last'] = float(np.median(V[-200:]))
    r['I_nonzero_share'] = round(float((I > 0).mean()), 3)
    act = (gov == 4) & (hs > 0.5 * np.maximum(tg, 1))
    if act.sum() > 1000:
        r['active_s'] = round(act.sum() * dt, 1)
        r['thr_active'] = {q: round(float(np.percentile(thr[act], q)), 3) for q in (5, 50, 95, 99, 100)}
        r['thr_ge_0.98_s'] = round(float((thr[act] >= 0.98).sum() * dt), 2)
        r['govSum_gt_thr_s'] = round(float((gs[act] > thr[act] + 0.005).sum() * dt), 2)
        err = (tg[act] - hs[act]) / tg[act]
        r['hs_err_pct'] = {'rms': round(100 * float(np.sqrt(np.mean(err ** 2))), 2), 'p1': round(100 * float(np.percentile(err, 1)), 2), 'p99': round(100 * float(np.percentile(err, 99)), 2), 'max_droop': round(100 * float(err.max()), 2), 'max_over': round(-100 * float(err.min()), 2)}
        r['V_active'] = {q: round(float(np.percentile(V[act], q)), 2) for q in (1, 50, 99)}
        r['F_share_median'] = round(float(np.median(gF[act] / np.maximum(gs[act], 1e-3))), 3)
        r['govF_p99'] = round(float(np.percentile(gF[act], 99)), 3)
        r['govI_range'] = [round(float(np.percentile(gI[act], 1)), 3), round(float(np.percentile(gI[act], 99)), 3)]
        r['govP_p1p99'] = [round(float(np.percentile(gP[act], 1)), 3), round(float(np.percentile(gP[act], 99)), 3)]
        # per target headspeed
        byT = {}
        for T in np.unique(np.round(tg[act], -2)):
            m = act & (np.abs(tg - T) < 60)
            if m.sum() < 2000: continue
            byT[int(T)] = {'s': round(m.sum() * dt, 1), 'thr50': round(float(np.median(thr[m])), 3), 'thr99': round(float(np.percentile(thr[m], 99)), 3),
                          'hs_per_thrV': round(float(np.median(hs[m] / np.maximum(thr[m] * V[m], 1e-3))), 2), 'V50': round(float(np.median(V[m])), 2)}
        r['byTarget'] = byT
        # sag: high-pass V vs high-pass thr (and vs I)
        w = int(2.0 / dt)
        def hp(x):
            c = np.convolve(x, np.ones(w) / w, mode='same'); return x - c
        m = act.copy(); m[:w] = False; m[-w:] = False
        x = hp(thr)[m]; y = hp(V)[m]
        if np.std(x) > 0: r['dV_dthr_hp'] = round(float(np.polyfit(x, y, 1)[0]), 2)
        if (I > 0).mean() > 0.5:
            xi = hp(I)[m]; b = np.polyfit(xi, y, 1)[0]; r['R_int_ohm_hp'] = round(-float(b), 4)
            r['I_active'] = {q: round(float(np.percentile(I[act], q)), 1) for q in (5, 50, 95, 99, 100)}
            r['P_active_W'] = {q: round(float(np.percentile((V * I)[act], q)), 0) for q in (50, 95, 99, 100)}
            # motor model d*V = c0*V + ke*hs + Rm*I/d
            mm = act & (thr > 0.3)
            A = np.c_[V[mm], hs[mm], I[mm] / thr[mm]]; yy = thr[mm] * V[mm]
            coef, *_ = np.linalg.lstsq(A, yy, rcond=None)
            res = yy - A @ coef
            r['motor_fit'] = {'c0': round(float(coef[0]), 4), 'ke_V_per_rpm_rotor': round(float(coef[1]), 6), 'kv_rotor_rpm_per_V': round(1 / float(coef[1]), 1), 'Rm_ohm': round(float(coef[2]), 4), 'res_rms_V': round(float(np.std(res)), 3)}
            # without c0
            A2 = np.c_[hs[mm], I[mm] / thr[mm]]; coef2, *_ = np.linalg.lstsq(A2, yy, rcond=None)
            r['motor_fit_noc0'] = {'kv_rotor': round(1 / float(coef2[0]), 1), 'Rm_ohm': round(float(coef2[1]), 4), 'res_rms_V': round(float(np.std(yy - A2 @ coef2)), 3)}
    # spoolups
    sp = []
    for s, e in runs(gov == 2):
        if e - s < 200: continue
        T = rq[min(e, len(rq) - 1)]
        k1 = min(len(hs), e + int(4 / dt))
        sp.append({'t': round(t[s], 1), 'dur': round((e - s) * dt, 2), 'thr_exit': round(float(thr[e - 1]), 3), 'hs_exit': int(hs[e - 1]), 'req': int(T),
                   'hs_max_after_pct': round(100 * float(hs[e:k1].max() / max(T, 1) - 1), 2) if k1 > e else None,
                   'thr_3s_after': round(float(np.median(thr[min(e + int(2.5 / dt), len(thr) - 1):min(e + int(3.5 / dt), len(thr))])), 3) if e + int(3.5 / dt) < len(thr) else None,
                   'coll_med': round(float(np.median(coll[s:e])), 3)})
    r['spoolups'] = sp
    # coasts: throttle 0, hs > 30% of 3500
    co = []
    for s, e in runs((thr <= 0.001) & (hs > 1000) & np.isin(gov, [5, 7, 0, 1])):
        if e - s < 300: continue
        seg = slice(s, e); tt = t[seg]; h = hs[seg]
        # fit dω/dt = -a ω^2 via 1/ω linear in time: d(1/ω)/dt = a
        p = np.polyfit(tt, 1.0 / h, 1)
        co.append({'t': round(t[s], 1), 'dur': round((e - s) * dt, 2), 'hs0': int(h[0]), 'hs1': int(h[-1]), 'coll_med': round(float(np.median(coll[seg])), 3), 'a_per_rpm_s': float(p[0]),
                   'decel_rpm_s_at_hs0': round(float(p[0] * h[0] ** 2), 1), 'state': ST[gov[s]]})
    r['coasts'] = co
    out[li] = r
print(json.dumps(out, indent=1, default=lambda o: o.item() if hasattr(o, 'item') else str(o)))
