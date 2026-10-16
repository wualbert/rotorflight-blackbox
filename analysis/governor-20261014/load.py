import numpy as np, json, os
D = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
def load(craft):
    m = json.load(open(f'{D}/{craft}/meta.json'))
    out = []
    for s in m['segments']:
        a = np.fromfile(f"{D}/{craft}/{s['name']}.f32", dtype=np.float32).reshape(s['n'], len(s['columns']))
        out.append(dict(meta=s, **{c: a[:, j].astype(np.float64) for j, c in enumerate(s['columns'])}))
    return m, out
