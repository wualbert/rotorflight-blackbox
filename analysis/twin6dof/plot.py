"""Plots of twin prediction quality: error vs horizon (model vs persistence) and prediction traces.
python plot.py <eval json> <out prefix> [trace index] [t0 t1]"""
import json, sys
import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

e = json.load(open(sys.argv[1])); out = sys.argv[2]
k = int(sys.argv[3]) if len(sys.argv) > 3 else 0
t0, t1 = (float(sys.argv[4]), float(sys.argv[5])) if len(sys.argv) > 5 else (None, None)
units = dict(p='deg/s', q='deg/s', r='deg/s', roll='deg', pitch='deg', heading='deg', altitude='m', vario='m/s', headspeed='RPM')

fig, axs = plt.subplots(3, 3, figsize=(13, 9))
for ch, ax in zip(range(9), axs.flat):
    name = e['channels'][ch]
    ax.plot(e['points'], e['rmse'][ch], 'o-', color='#d95f02', label='twin')
    ax.plot(e['points'], e['persistence'][ch], 's--', color='#7570b3', label='hold last value')
    ax.set_title(name); ax.set_xlabel('prediction horizon (s)'); ax.set_ylabel('RMS error (%s)' % units[name]); ax.grid(alpha=.3)
    ax.set_ylim(bottom=0)
axs[0, 0].legend()
fig.suptitle('Held-out prediction error vs horizon (%d origins)' % e['origins']); fig.tight_layout()
fig.savefig(out + '_horizon.png', dpi=110)

tr = e['traces'][k]
n = len(tr['measured'][0]); t = np.arange(n) / tr['rate']
sel = slice(None) if t0 is None else slice(int(t0 * tr['rate']), int(t1 * tr['rate']))
fig, axs = plt.subplots(9, 1, figsize=(13, 17), sharex=True)
for ch, ax in enumerate(axs):
    m = np.array(tr['measured'][ch], dtype=float); p = np.array(tr['predicted'][ch], dtype=float)
    ax.plot(t[sel], m[sel], color='#1b9e77', lw=1, label='recorded')
    ax.plot(t[sel], p[sel], color='#d95f02', lw=1, label='twin (free %.0f s predictions)' % tr['horizonS'])
    for s in tr['segmentStarts']:
        if t0 is None or t0 <= s <= t1: ax.axvline(s, color='k', alpha=.08, lw=.5)
    ax.set_ylabel('%s\n(%s)' % (e['channels'][ch], units[e['channels'][ch]]))
axs[0].legend(loc='upper right'); axs[-1].set_xlabel('time in run (s)')
fig.suptitle('%s: twin predictions restart from the observer every %.0f s' % (tr['id'], tr['horizonS'])); fig.tight_layout()
fig.savefig(out + '_trace%d.png' % k, dpi=100)
import os
vf = os.path.join(os.path.dirname(sys.argv[1]), 'validation.json')
if os.path.exists(vf):
    V = json.load(open(vf))
    for g in V['frequency']:
        fig, axs = plt.subplots(2, 5, figsize=(17, 6.5))
        for c, (i, j, name) in enumerate([(0, 0, 'roll'), (1, 1, 'pitch'), (2, 2, 'yaw'), (0, 1, 'roll from pitch cmd'), (1, 0, 'pitch from roll cmd')]):
            f = np.array([b['f'] for b in g['bins']]); coh = np.array([min(b['cohU'][i], b['cohY'][i], b['cohU'][j], b['cohY'][j]) for b in g['bins']])
            hm = np.array([complex(*b['model'][i][j]) for b in g['bins']]); hd = np.array([complex(*b['measured'][i][j]) for b in g['bins']])
            good = coh >= 0.5
            axs[0, c].loglog(f, abs(hm), '-', color='#d95f02', label='twin'); axs[0, c].loglog(f[good], abs(hd[good]), 'o', color='#1b9e77', label='reserved flights (coh>=0.5)')
            axs[0, c].loglog(f[~good], abs(hd[~good]), 'o', color='#1b9e77', alpha=.25, label='low coherence')
            axs[1, c].semilogx(f, np.angle(hm, deg=True), '-', color='#d95f02'); axs[1, c].semilogx(f[good], np.angle(hd[good], deg=True), 'o', color='#1b9e77')
            axs[1, c].semilogx(f[~good], np.angle(hd[~good], deg=True), 'o', color='#1b9e77', alpha=.25)
            axs[0, c].set_title(name); axs[1, c].set_xlabel('Hz'); axs[0, c].set_ylabel('rad/s per command'); axs[1, c].set_ylabel('phase (deg)'); axs[1, c].set_ylim(-200, 200)
            for a in axs[:, c]: a.grid(alpha=.3, which='both')
        axs[0, 0].legend(fontsize=7)
        fig.suptitle('Actuator -> body rate frequency response, %s (%.0f rpm), setpoint-instrumented, reserved flights' % (g['key'], g['op']['rpm'])); fig.tight_layout()
        fig.savefig(out + '_frequency_%s.png' % g['key'].replace(' ', ''), dpi=100)
print('wrote', out + '_horizon.png', out + '_trace%d.png' % k)
