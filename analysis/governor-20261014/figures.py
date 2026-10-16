import matplotlib; matplotlib.use('Agg')
import matplotlib.pyplot as plt
from common import *
C = dict(blue='#2a78d6', orange='#eb6834', aqua='#1baf7a', yellow='#eda100', magenta='#e87ba4', green='#008300', violet='#6250d6', red='#e34948')
SURF, INK, INK2, GRID = '#fcfcfb', '#0b0b0b', '#52514e', '#e4e3df'
plt.rcParams.update({'figure.facecolor': SURF, 'axes.facecolor': SURF, 'axes.edgecolor': INK2, 'axes.labelcolor': INK, 'xtick.color': INK2, 'ytick.color': INK2,
                     'axes.grid': True, 'grid.color': GRID, 'grid.linewidth': 0.6, 'axes.spines.top': False, 'axes.spines.right': False, 'font.size': 9,
                     'axes.titlesize': 10, 'axes.titleweight': 'bold', 'lines.linewidth': 1.4, 'legend.frameon': False, 'legend.fontsize': 8})
STATE_C = {3: '#f9e3b3', 6: '#f3c6c6', 8: '#d9eed6', 7: '#dcdcf5', 2: '#d6ecf9'}
FB = {s['log']: s for s in segs('fireball')}; GA = {s['log']: s for s in segs('gaui')}

def shade(ax, s, a, b):
    g = s['gov'][a:b]; t = s['t'][a:b]
    for i0, i1 in runs(np.isin(g, list(STATE_C))):
        ax.axvspan(t[i0], t[min(i1, len(t) - 1)], color=STATE_C[g[i0]], lw=0, zorder=0)

def window(s, t0, t1): return int(np.searchsorted(s['t'], t0)), int(np.searchsorted(s['t'], t1))

def label_states(ax, s, a, b):
    g = s['gov'][a:b]; t = s['t'][a:b]
    for i0, i1 in runs(np.isin(g, list(STATE_C))):
        ax.text(t[i0], ax.get_ylim()[1], ' ' + ST[g[i0]], va='top', ha='left', fontsize=7, color=INK2)

# Figure 1: fallback events
fig, axs = plt.subplots(5, 3, figsize=(13, 10), sharex='col')
for col, (lg, tc) in enumerate([(11, 54.33), (11, 158.71), (14, 192.68)]):
    s = FB[lg]; a, b = window(s, tc - 1.2, tc + 2.0); t = s['t'][a:b]
    req = s['govRequest'][a:b][0]; f = pt2(s['hs'][a - 3000:b], 10, s['rate'])[3000:]
    ax = axs[0, col]; shade(ax, s, a, b)
    ax.plot(t, s['hs'][a:b], color=C['blue'], label='headspeed'); ax.plot(t, s['govTarget'][a:b], color=C['orange'], label='govTarget'); ax.set_ylabel('rpm')
    ax.set_title(f'Fireball log {lg} (app #{lg + 1}), FALLBACK at {tc:.2f} s'); label_states(ax, s, a, b)
    if col == 0: ax.legend(loc='lower left')
    ax = axs[1, col]; shade(ax, s, a, b); ax.plot(t, np.abs(s['hs'][a:b] - f), color=C['violet'], label='|headspeed - PT2(headspeed, 10 Hz)|')
    ax.axhline(0.25 * req, color=C['red'], lw=1, ls='--', label='firmware glitch limit 0.25 x gov_headspeed'); ax.set_ylabel('rpm')
    if col == 0: ax.legend(loc='upper left')
    ax = axs[2, col]; shade(ax, s, a, b); ax.plot(t, s['motor[0]'][a:b] / 10, color=C['blue'], label='motor[0]'); ax.plot(t, s['govSum'][a:b] / 10, color=C['aqua'], label='govSum (demand)')
    ax.plot(t, s['govI'][a:b] / 10, color=C['yellow'], label='govI'); ax.set_ylabel('% throttle')
    if col == 0: ax.legend(loc='lower left')
    ax = axs[3, col]; shade(ax, s, a, b); ax.plot(t, s['mixer[3]'][a:b] / 1000, color=C['green']); ax.set_ylabel('collective (mixer[3]/1000)')
    ax = axs[4, col]; shade(ax, s, a, b); ax.plot(t, s['Vbat'][a:b] / 100, color=C['magenta']); ax.set_ylabel('Vbat (V, ESC telemetry)'); ax.set_xlabel('s from log start')
fig.tight_layout(); fig.savefig('fig_fallback.png', dpi=130); plt.close(fig)

# Figure 2: RPM signal jumps vs throttle level (Fireball) and saturation share vs battery voltage
E = json.load(open('log_evidence.json'))
fig, axs = plt.subplots(1, 2, figsize=(12, 4))
ax = axs[0]
for s in FB.values():
    if s['cls'] != 'flight': continue
    m = ((s['gov'] == 4) & (s['phase'] == 3))[1:]; d = np.abs(np.diff(s['hs']))[m]; mo = s['motor[0]'][1:][m] / 10
    k = d > 20; ax.scatter(mo[k], d[k], s=8, color=C['blue'], alpha=0.6, lw=0)
ax.set_xlabel('motor[0] (%)'); ax.set_ylabel('|headspeed step| between 1 ms samples (rpm)'); ax.set_yscale('log')
ax.set_title('Fireball: headspeed steps > 20 rpm per sample, ACTIVE in flight'); ax.text(0.02, 0.95, '68 steps > 50 rpm in 1432 s; 65 at motor[0] = 100 %\n(18.1 s at 100 %: 3.6 per s; below 90 %: 0.002 per s)', transform=ax.transAxes, va='top', fontsize=8, color=INK2)
ax = axs[1]
for j, (H, col) in enumerate([(4500, C['blue']), (5000, C['orange'])]):
    rows = E['fireball']['saturation']['vbatBins'][str(H)]
    x = np.array([(r['v0'] + r['v1']) / 2 for r in rows]) + (j - 0.5) * 0.18; y = [100 * r['share98'] for r in rows]
    ax.bar(x, y, width=0.16, color=col, label=f'{H} rpm (PID profile {PROFILE["fireball"][H]})')
    for xx, r in zip(x, rows): ax.text(xx, 100 * r['share98'] + 1, f"{r['s']:.0f}s", ha='center', fontsize=6, color=INK2)
ax.set_xlabel('Vbat (V), 0.5 V bins'); ax.set_ylabel('% of ACTIVE flight time with motor[0] >= 98 %'); ax.legend(); ax.set_title('Fireball: throttle at its limit against battery voltage')
fig.tight_layout(); fig.savefig('fig_saturation_vbat.png', dpi=130); plt.close(fig)

# Figure 3: saturation example
s = FB[13]; a, b = window(s, 200.5, 228.0); t = s['t'][a:b]
fig, axs = plt.subplots(4, 1, figsize=(11, 8), sharex=True)
axs[0].plot(t, s['hs'][a:b], color=C['blue'], label='headspeed'); axs[0].plot(t, s['govTarget'][a:b], color=C['orange'], label='govTarget'); axs[0].set_ylabel('rpm'); axs[0].legend(loc='lower left')
axs[0].set_title('Fireball log 13 (app #14): throttle at 100 % during collective pulls, PID profile 2 (4500 rpm)')
axs[1].plot(t, s['motor[0]'][a:b] / 10, color=C['blue'], label='motor[0]'); axs[1].plot(t, s['govSum'][a:b] / 10, color=C['aqua'], label='govSum'); axs[1].axhline(100, color=C['red'], ls='--', lw=1, label='gov_max_throttle 100'); axs[1].set_ylabel('%'); axs[1].legend(loc='lower left')
axs[2].plot(t, np.abs(s['mixer[3]'][a:b]) / 1000, color=C['green']); axs[2].set_ylabel('|collective|')
axs[3].plot(t, s['Vbat'][a:b] / 100, color=C['magenta']); axs[3].set_ylabel('Vbat (V)'); axs[3].set_xlabel('s from log start')
fig.tight_layout(); fig.savefig('fig_saturation_example.png', dpi=130); plt.close(fig)

# Figure 4: load steps
fig, axs = plt.subplots(1, 3, figsize=(14, 4))
for craft, col in [('fireball', C['blue']), ('gaui', C['orange'])]:
    ev = E[craft]['tracking']['steps']['events']
    for sat, mk in [(False, 'o'), (True, 'x')]:
        x = [e['dc'] for e in ev if e['sat'] == sat]; y = [e['peak_pct'] for e in ev if e['sat'] == sat]
        if x: axs[0].scatter(x, y, s=14 if not sat else 30, marker=mk, color=col, label=f'{craft} {"throttle >= 98 %" if sat else "throttle < 98 %"} (n={len(x)})', lw=1 if sat else 0)
axs[0].set_xlabel('change of |collective| in 0.25 s'); axs[0].set_ylabel('peak headspeed error from target (% of request)'); axs[0].legend(fontsize=7); axs[0].set_title('Collective steps, ACTIVE in flight')
for k, (craft, segsd) in enumerate([('fireball', FB), ('gaui', GA)]):
    ax = axs[1 + k]; ev = E[craft]['tracking']['steps']['events']
    for d, col in [('up', C['blue']), ('down', C['orange'])]:
        tr = []
        for e in ev:
            if e['dir'] != d or e['sat']: continue
            s = segsd[e['log']]; i = int(np.searchsorted(s['t'], e['t'])); r = s['rate']
            tr.append(100 * (s['hs'] - s['govTarget'])[i - int(0.3 * r):i + int(2 * r)] / s['govRequest'][i])
        tr = np.array(tr); tt = np.arange(tr.shape[1]) / 1000 - 0.3
        for x in tr: ax.plot(tt, x, color=col, alpha=0.12, lw=0.6)
        ax.plot(tt, np.median(tr, 0), color=col, lw=2, label=f'{d} steps, median (n={len(tr)})')
    ax.axhline(0, color=INK2, lw=0.8); ax.set_xlabel('s from step onset'); ax.set_ylabel('headspeed - govTarget (% of request)'); ax.legend(loc='lower right'); ax.set_ylim(-8, 8)
    ax.set_title(f'{craft}: unsaturated collective steps')
fig.tight_layout(); fig.savefig('fig_load_steps.png', dpi=130); plt.close(fig)

# Figure 5: spool-ups
fig, axs = plt.subplots(2, 2, figsize=(12, 7), sharex='col')
for k, (craft, segsd) in enumerate([('fireball', FB), ('gaui', GA)]):
    for sp in E[craft]['events']['spoolups']:
        if sp['next'] != 'ACTIVE': continue
        s = segsd[sp['log']]; i0 = int(np.searchsorted(s['t'], sp['t'])); r = s['rate']; n = int((sp['dur'] + 3) * r)
        col = {10.0: C['blue'], 12.5: C['orange'], 5.0: C['blue'], 6.66: C['orange']}.get(round(sp['slope_pct_s'], 2), C['aqua'])
        tt = np.arange(n) / r
        req = s['govRequest'][i0 + int(sp['dur'] * r) - 1]
        axs[0, k].plot(tt, 100 * s['hs'][i0:i0 + n] / req, color=col, lw=1)
        axs[1, k].plot(tt, s['motor[0]'][i0:i0 + n] / 10, color=col, lw=1)
    axs[0, k].axhline(100, color=INK2, lw=0.8); axs[0, k].set_ylim(0, 120); axs[0, k].set_ylabel('headspeed (% of request)')
    axs[1, k].set_ylabel('motor[0] (%)'); axs[1, k].set_xlabel('s from SPOOLUP start')
    lab = ['10.0 %/s (logs 5-8)', '12.5 %/s (logs 9-15)'] if craft == 'fireball' else ['5.0 %/s (logs 38-45)', '6.66 %/s (logs 46-49)']
    axs[0, k].plot([], [], color=C['blue'], label=lab[0]); axs[0, k].plot([], [], color=C['orange'], label=lab[1]); axs[0, k].legend(loc='lower right')
    axs[0, k].set_title(f'{craft}: spool-up ramps (SPOOLUP throttle slope)')
fig.tight_layout(); fig.savefig('fig_spoolup.png', dpi=130); plt.close(fig)

# Figure 6: battery and motor (Gaui V-I; Gaui back-EMF; Fireball no-current sag)
from s4_power import prep
fig, axs = plt.subplots(1, 3, figsize=(15, 4.3))
s = GA[49]; d = prep(s, 'gaui', blockS=0.1)
sc = axs[0].scatter(d['I'], d['V'], c=d['Q'] * 1000, s=3, cmap='viridis', lw=0); plt.colorbar(sc, ax=axs[0], label='charge used (mAh)')
b = [x for x in E['gaui']['power']['battery'] if x['log'] == 49][0]
for qq in [0.2, 1.0, 1.8]:
    ii = np.linspace(0, 150, 10); axs[0].plot(ii, b['Voc0'] + b['dVoc_dAh'] * qq + b['d2'] * qq ** 2 - b['R_ohm'] * ii, color=C['red'], lw=1)
axs[0].set_xlabel('Ibat (A, aligned)'); axs[0].set_ylabel('Vbat (V, aligned)'); axs[0].set_title(f'Gaui log 49: R = {1000 * b["R_ohm"]:.1f} mOhm, Voc slope {b["dVoc_dAh"]:.2f} V/Ah')
m = [x for x in E['gaui']['power']['motor'] if x['log'] == 49][0]
Im = d['I'] / d['D']; y = d['D'] * d['V'] - m['Rm_ohm'] * Im
axs[1].scatter(d['W'], y, s=3, color=C['blue'], lw=0, alpha=0.5); ww = np.linspace(2000, 2800, 5); axs[1].plot(ww, ww / m['Kv_rpm_per_V'], color=C['red'], lw=1.2)
axs[1].set_xlabel('headspeed (rpm)'); axs[1].set_ylabel('motor[0] x Vbat - Rm x Ibat/motor[0] (V)'); axs[1].set_title(f'Gaui log 49: back-EMF line, Kv = {m["Kv_rpm_per_V"]:.1f} rotor rpm/V')
for s in FB.values():
    if s['cls'] != 'flight': continue
    d = prep(s, 'fireball', blockS=0.1); axs[2].scatter(d['D'] * d['W'] / 1000, d['V'], s=2, lw=0, alpha=0.4, color=C['blue'])
axs[2].set_xlabel('motor[0] x headspeed / 1000 (proxy of load)'); axs[2].set_ylabel('Vbat (V, aligned)'); axs[2].set_title('Fireball (no current sensor): Vbat against the load proxy')
fig.tight_layout(); fig.savefig('fig_battery_motor.png', dpi=130); plt.close(fig)

# Figure 7: bailout on the ground (Fireball log 10)
s = FB[10]; a, b = window(s, 9.5, 26.0); t = s['t'][a:b]
fig, axs = plt.subplots(3, 1, figsize=(11, 6.5), sharex=True)
shade(axs[0], s, a, b); axs[0].plot(t, s['hs'][a:b], color=C['blue'], label='headspeed'); axs[0].plot(t, s['govTarget'][a:b], color=C['orange'], label='govTarget'); axs[0].set_ylabel('rpm'); axs[0].legend(loc='center right')
axs[0].set_title('Fireball log 10 (app #11): throttle cut on the ground, re-engage within gov_autorotation_timeout -> BAILOUT'); label_states(axs[0], s, a, b)
shade(axs[1], s, a, b); axs[1].plot(t, s['motor[0]'][a:b] / 10, color=C['blue'], label='motor[0]'); axs[1].plot(t, s['govSum'][a:b] / 10, color=C['aqua'], label='govSum'); axs[1].set_ylabel('%'); axs[1].legend(loc='center right')
shade(axs[2], s, a, b); axs[2].plot(t, s['rcCommand[4]'][a:b], color=C['violet']); axs[2].set_ylabel('rcCommand[4] (throttle channel)'); axs[2].set_xlabel('s from log start')
fig.tight_layout(); fig.savefig('fig_bailout.png', dpi=130); plt.close(fig)
print('ok')
