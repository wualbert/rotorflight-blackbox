import numpy as np, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from load import load, D
ST = ['OFF', 'IDLE', 'SPOOLUP', 'RECOVERY', 'ACTIVE', 'HOLD', 'FALLBACK', 'AUTOROTATION', 'BAILOUT', 'BYPASS']
PH = ['idle', 'spoolup', 'ground', 'flight', 'spooldown']
PROFILE = {'fireball': {3500: 1, 4500: 2, 5000: 3}, 'gaui': {2300: 1, 2500: 2, 2700: 3}}

def pt1(x, fc, rate):
    k = 1.0 / (1.0 + rate / (2 * np.pi * fc)) if fc > 0 else 1.0  # firmware pt1FilterGain: dT/(RC+dT)
    from scipy.signal import lfilter
    return lfilter([k], [1, -(1 - k)], x, zi=[x[0] * (1 - k)])[0]

def pt2(x, fc, rate):
    c = fc * 1.553773974
    return pt1(pt1(x, c, rate), c, rate)

def segs(craft):
    m, S = load(craft)
    ph = json.load(open(f'{D}/{craft}/phases.json'))
    for s in S:
        nm = s['meta']['name']
        s['phase'] = np.fromfile(f'{D}/{craft}/{nm}.phase', dtype=np.uint8).astype(int)
        s['gov'] = s['govStateAt'].astype(int)
        s['req'] = np.round(s['govRequest'] / 50) * 50
        s['rate'] = s['meta']['rate']
        s['t'] = s['meta']['fromS'] + np.arange(s['meta']['n']) / s['rate']
        s['cls'] = ph[nm]['class']
        s['phinfo'] = ph[nm]
        s['log'] = s['meta']['log']
    return S

def runs(mask):
    m = np.concatenate([[0], mask.astype(np.int8), [0]])
    d = np.diff(m)
    return list(zip(np.nonzero(d == 1)[0], np.nonzero(d == -1)[0]))

def q(x, ps=(1, 5, 50, 95, 99)):
    return {f'p{p}': float(np.percentile(x, p)) for p in ps} if len(x) else None

def rnd(o, d=4):
    if isinstance(o, dict): return {k: rnd(v, d) for k, v in o.items()}
    if isinstance(o, (list, tuple)): return [rnd(v, d) for v in o]
    if isinstance(o, (np.floating, float)): return None if not np.isfinite(o) else round(float(o), d)
    if isinstance(o, (np.integer,)): return int(o)
    return o

def mean_se(v):
    v = np.asarray([x for x in v if x is not None and np.isfinite(x)], float)
    if len(v) == 0: return {'mean': None, 'se': None, 'n': 0}
    return {'mean': float(v.mean()), 'se': float(v.std(ddof=1) / np.sqrt(len(v))) if len(v) > 1 else None, 'n': int(len(v))}
