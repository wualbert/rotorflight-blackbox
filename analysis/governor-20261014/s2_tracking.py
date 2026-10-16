# (2) headspeed tracking error by state, phase and headspeed; load steps; profile-change ramps
from common import *

def settled_mask(s, guardS=1.0):
    n = len(s['gov']); g = int(guardS * s['rate']); m = np.ones(n, bool)
    ch = np.nonzero((np.diff(s['gov']) != 0) | (np.diff(s['req']) != 0))[0] + 1
    for i in ch: m[max(0, i - g):i + g] = False
    return m

def block_rms_ci(e, rate, blockS=1.0, B=400, rng=np.random.default_rng(1)):
    # bootstrap of 1-s blocks for the RMS of a correlated series
    nb = int(len(e) // (blockS * rate))
    if nb < 5: return None
    k = int(blockS * rate); ms = (e[:nb * k] ** 2).reshape(nb, k).mean(1)
    bs = [np.sqrt(ms[rng.integers(0, nb, nb)].mean()) for _ in range(B)]
    return [float(np.percentile(bs, 2.5)), float(np.percentile(bs, 97.5))]

def stats(e_rpm, req, rate, per_flight):
    e_pct = 100 * e_rpm / req
    return dict(n=int(len(e_rpm)), seconds=round(len(e_rpm) / rate, 1),
                rms_rpm=float(np.sqrt(np.mean(e_rpm ** 2))), mean_rpm=float(e_rpm.mean()), rms_pct=float(np.sqrt(np.mean(e_pct ** 2))), mean_pct=float(e_pct.mean()),
                pct=q(e_pct, (0.1, 1, 5, 50, 95, 99, 99.9)), rms_pct_ci95_blocks=block_rms_ci(e_pct, rate),
                perFlight_rms_pct=mean_se(per_flight))

def tracking(S, craft):
    out = {}
    hs_set = sorted(set(int(v) for s in S for v in np.unique(s['req'][(s['gov'] == 4) & (s['phase'] == 3)])))
    groups = [('ACTIVE', 'flight'), ('ACTIVE', 'ground'), ('RECOVERY', 'flight'), ('SPOOLUP', 'spoolup'), ('BAILOUT', None)]
    for st, ph in groups:
        for H in hs_set + ['all']:
            E, RQ, pf = [], [], []
            for s in S:
                if s['cls'] != 'flight': continue
                m = (s['gov'] == ST.index(st)) & (s['rescueAt'] == 0)
                if ph: m &= s['phase'] == PH.index(ph)
                if st == 'ACTIVE': m &= settled_mask(s)
                if H != 'all': m &= s['req'] == H
                if m.sum() < 100: continue
                ref = s['govTarget'] if st == 'ACTIVE' else s['govRequest']
                e = (s['hs'] - ref)[m]; E.append(e); RQ.append(s['govRequest'][m])
                pf.append(np.sqrt(np.mean((100 * e / s['govRequest'][m]) ** 2)))
            if not E: continue
            E = np.concatenate(E); RQ = np.concatenate(RQ)
            out[f'{st}|{ph}|{H}'] = dict(state=st, phase=ph, headspeed=H, ref='govTarget' if st == 'ACTIVE' else 'govRequest', **stats(E, RQ, S[0]['rate'], pf))
    # rescue in flight (ACTIVE)
    return out

def load_steps(S, craft, minStep=0.25, riseS=0.25, quietS=0.3, quiet=0.06):
    ev = []
    for s in S:
        if s['cls'] != 'flight': continue
        r = s['rate']; c = np.abs(s['mixer[3]']) / 1000; n = len(c)
        cs = pt1(c, 20, r)
        W = int(riseS * r); Q = int(quietS * r)
        e = (s['hs'] - s['govTarget']) / s['govRequest']
        ok = (s['gov'] == 4) & (s['phase'] == 3) & (s['rescueAt'] == 0)
        i = Q
        while i < n - int(2.5 * r):
            d = cs[i + W] - cs[i]
            pre = cs[i - Q:i]
            if abs(d) >= minStep and pre.max() - pre.min() < quiet and ok[i - Q:i + int(2.0 * r)].all() and (s['req'][i - Q:i + int(2.0 * r)] == s['req'][i]).all():
                sign = 1 if d > 0 else -1
                # onset: first sample where cs departs pre-mean by 10% of step
                pm = pre.mean(); j = i
                while j < i + W and abs(cs[j] - pm) < 0.1 * abs(d): j += 1
                w = slice(j, j + int(1.5 * r))
                ew = e[w]; e0 = e[j - Q:j].mean()
                k = int(np.argmin(ew)) if sign > 0 else int(np.argmax(ew))
                peak = ew[k] - e0
                # recovery: from onset until |e| back within 1 % for 0.2 s
                band = 0.01; hold = int(0.2 * r); rec = None
                post = e[j:j + int(2.5 * r)]
                for kk in range(k, len(post) - hold):
                    if np.all(np.abs(post[kk:kk + hold]) < band): rec = kk / r; break
                mot = s['motor[0]'][j - Q:j + int(1.5 * r)]
                ev.append(dict(log=s['log'], t=round(float(s['t'][j]), 3), dir='up' if sign > 0 else 'down', req=float(s['req'][j]),
                               c0=round(float(pm), 3), c1=round(float(cs[j + W]), 3), dc=round(float(cs[j + W] - pm), 3),
                               ratePerS=round(float(abs(d) / riseS), 2),
                               e0_pct=round(100 * e0, 3), peak_pct=round(100 * float(peak), 3), tPeak=round(k / r, 3), recoverS=None if rec is None else round(rec, 3),
                               mot0=float(s['motor[0]'][j - 1]), motMax=float(mot.max()), motMin=float(mot.min()), sat=bool(mot.max() >= 980),
                               F0=float(s['govF'][j - 1]), Fpeak=float(s['govF'][j:j + int(1.0 * r)].max() if sign > 0 else s['govF'][j:j + int(1.0 * r)].min()),
                               vbat=float(np.median(s['Vbat'][j:j + int(0.5 * r)]) / 100)))
                i = j + int(1.5 * r)
            else:
                i += 10
    return ev

def summarize_steps(ev):
    out = {}
    for H in sorted(set(e['req'] for e in ev)) + ['all']:
        for d in ['up', 'down']:
            for sat in [False, True]:
                E = [e for e in ev if e['dir'] == d and (H == 'all' or e['req'] == H) and e['sat'] == sat]
                if not E: continue
                pk = np.array([e['peak_pct'] for e in E]); dc = np.array([e['dc'] for e in E])
                rec = np.array([e['recoverS'] for e in E if e['recoverS'] is not None])
                # sensitivity: droop per unit collective step (%/unit), OLS through origin
                sens = float((pk * dc).sum() / (dc * dc).sum())
                res = pk - sens * dc
                out[f'{H}|{d}|{"sat" if sat else "unsat"}'] = dict(n=len(E), peak_pct=q(pk, (5, 50, 95)), peak_mean=mean_se(pk), dc_median=float(np.median(dc)),
                    droop_per_unit_collective_pct=sens, droop_per_unit_se=float(np.sqrt((res ** 2).sum() / max(1, len(E) - 1) / (dc * dc).sum())),
                    recover_s=q(rec, (5, 50, 95)) if len(rec) else None, recovered=f'{len(rec)}/{len(E)}', tPeak_median=float(np.median([e['tPeak'] for e in E])))
    return out

def profile_ramps(S):
    out = []
    for s in S:
        r = s['rate']; ch = np.nonzero(np.diff(s['req']) != 0)[0] + 1
        for i in ch:
            if s['gov'][i] != 4: continue
            r0, r1 = s['req'][i - 1], s['req'][i]
            tg = s['govTarget'][i:i + int(6 * r)]
            # time until target reaches request
            k = np.nonzero(np.abs(tg - r1) < 1)[0]; tr = k[0] / r if len(k) else None
            slope = (r1 - r0) / tr if tr else None
            e = (s['hs'] - s['govTarget'])[i:i + int(6 * r)]
            ee = (s['hs'] - r1)[i:i + int(8 * r)]
            st = None
            for kk in range(len(ee) - int(0.3 * r)):
                if np.all(np.abs(ee[kk:kk + int(0.3 * r)]) < 0.01 * r1): st = kk / r; break
            sat = float((s['motor[0]'][i:i + int(6 * r)] >= 980).mean())
            out.append(dict(log=s['log'], t=round(float(s['t'][i]), 3), fromRpm=float(r0), toRpm=float(r1), phase=PH[s['phase'][i]],
                            targetRampS=tr, targetSlope_rpm_s=slope, maxLag_rpm=float(np.max(np.abs(e))), settle1pctS=st, satShare=sat,
                            motorMax=float(s['motor[0]'][i:i + int(6 * r)].max()), motorMin=float(s['motor[0]'][i:i + int(6 * r)].min())))
    return out

def run(craft):
    S = segs(craft)
    ev = load_steps(S, craft)
    return dict(tracking=tracking(S, craft), steps=dict(events=ev, summary=summarize_steps(ev)), profileRamps=profile_ramps(S))

if __name__ == '__main__':
    for craft in ['fireball', 'gaui']:
        R = run(craft)
        print('==', craft)
        for k, v in R['tracking'].items():
            print(k, 'n', v['n'], 's', v['seconds'], 'rms %.3f%% mean %.3f%%' % (v['rms_pct'], v['mean_pct']), 'p1 %.2f p99 %.2f p0.1 %.2f' % (v['pct']['p1'], v['pct']['p99'], v['pct']['p0.1']), 'CI', rnd(v['rms_pct_ci95_blocks'], 3), 'perflight', rnd(v['perFlight_rms_pct'], 3))
        for k, v in R['steps']['summary'].items(): print(k, rnd(v, 3))
        for p in R['profileRamps']: print(rnd(p, 3))
