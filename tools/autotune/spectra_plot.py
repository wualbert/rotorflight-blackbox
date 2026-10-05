#!/usr/bin/env python3
"""Figures from spectra.json (tools/autotune/spectra.cjs) and results.json (tools/autotune/wag_report.cjs).

  python3 tools/autotune/spectra_plot.py <dir>        # needs numpy and matplotlib

Writes <dir>/figures/*.png. Groups of flights come from results.json, so run wag_report.cjs first.
"""
import json
import os
import sys

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
import numpy as np

DIR = sys.argv[1] if len(sys.argv) > 1 else sys.exit(__doc__)
S = json.load(open(os.path.join(DIR, 'spectra.json')))
R = json.load(open(os.path.join(DIR, 'results.json')))
OUT = os.path.join(DIR, 'figures')
os.makedirs(OUT, exist_ok=True)

AXES = ['roll', 'pitch', 'yaw']
GROUPS = [g for g in R['groups'] if g['day'] == R['groups'][-1]['day']]      # the groups of the last day of flying
COLORS = ['#3b6ea5', '#c0392b', '#2e8b57', '#8e44ad']
LINE = R.get('lines', {}).get('foreign')                                       # strongest line that is no multiple of the main rotor
plt.rcParams.update({'font.size': 9, 'axes.grid': True, 'grid.alpha': 0.25, 'figure.dpi': 130})


def pooled(group, profile, key):
    """mean squared amplitude per 1 Hz band over the logs of a group, weighted by windows; and the mean headspeed"""
    rows = [p for p in S['profiles'] if p['log'] in group['logs'] and p['profile'] == profile]
    n = sum(p['windows'] for p in rows)
    if not n:
        return None, None, 0
    power = [sum(np.array(p[key][a]) * p['windows'] for p in rows) / n for a in range(3)]
    return power, sum(p['headspeed'] * p['windows'] for p in rows) / n, n


def save(fig, name):
    fig.savefig(os.path.join(OUT, name), bbox_inches='tight')
    plt.close(fig)
    print('wrote', os.path.join(OUT, name))


# 1. raw gyro spectrum by profile, in hertz
for key, title in [('raw', 'Raw gyro'), ('gyro', 'Filtered gyro (what the PID loops work on)')]:
    fig, ax = plt.subplots(3, 3, figsize=(15, 9), sharex=True, sharey=True)
    for c, profile in enumerate([1, 2, 3]):
        for a in range(3):
            rotor = None
            for g, color in zip(GROUPS, COLORS):
                power, hs, n = pooled(g, profile, key)
                if power is None:
                    continue
                rotor = hs / 60
                ax[a][c].semilogy(np.arange(len(power[a])), np.sqrt(power[a]), color=color, lw=0.9, label=f"logs {g['name']} ({n} windows)")
            if rotor:
                for k in range(1, 6):
                    ax[a][c].axvline(k * rotor, color='k', lw=0.5, ls=':')
                    if a == 0:
                        ax[a][c].text(k * rotor, 260, f'{k}×', ha='center', fontsize=8)
                if LINE:
                    ax[a][c].axvline(LINE * rotor, color='#e67e22', lw=0.8, ls='--')
                    if a == 0:
                        ax[a][c].text(LINE * rotor, 420, f'{LINE:.2f}×', ha='center', fontsize=8, color='#e67e22')
            if a == 0:
                target = GROUPS[-1]['targetOf'].get(str(profile))
                ax[a][c].set_title(f'Profile {profile} ({target} rpm, rotor {rotor:.1f} Hz)\n\n' if rotor else f'Profile {profile}')
            if c == 0:
                ax[a][c].set_ylabel(f'{AXES[a]}  (deg/s per 1 Hz band)')
            if a == 2:
                ax[a][c].set_xlabel('Hz')
            ax[a][c].set_ylim(0.05, 250)
            ax[a][c].set_xlim(0, 497)
    ax[0][0].legend(loc='lower left', fontsize=8)
    fig.suptitle(f'{title}: amplitude against frequency, by PID profile. Dotted: multiples of rotor speed.', y=1.0)
    save(fig, f'spectrum_{key}.png')

# 2. against rotor revolutions: raw and filtered, all profiles together
step = S['orders'][0]['step']
orders = np.arange(len(S['orders'][0]['raw'][0])) * step
fig, ax = plt.subplots(3, 2, figsize=(15, 9), sharey='row', gridspec_kw={'width_ratios': [2.2, 1]})
for a in range(3):
    for g, color in zip(GROUPS, COLORS):
        rows = [o for o in S['orders'] if o['log'] in g['logs']]
        n = sum(o['windows'] for o in rows)
        if not n:
            continue
        raw = sum(np.array(o['raw'][a]) * o['windows'] for o in rows) / n
        gyro = sum(np.array(o['gyro'][a]) * o['windows'] for o in rows) / n
        for col in range(2):
            ax[a][col].semilogy(orders, np.sqrt(raw), color=color, lw=0.9, label=f"raw, logs {g['name']}")
            ax[a][col].semilogy(orders, np.sqrt(gyro), color=color, lw=0.9, ls='--', alpha=0.8, label=f"filtered, logs {g['name']}")
    ax[a][0].set_xlim(0.3, 9)
    ax[a][1].set_xlim(3.4, 4.4)
    for col in range(2):
        ax[a][col].set_ylim(0.02, 200)
        for k in range(1, 9):
            ax[a][col].axvline(k, color='k', lw=0.5, ls=':')
        if LINE:
            ax[a][col].axvline(LINE, color='#e67e22', lw=0.8, ls='--')
    ax[a][0].set_ylabel(f'{AXES[a]}  (deg/s)')
ax[2][0].set_xlabel('multiples of rotor speed')
ax[2][1].set_xlabel('multiples of rotor speed (close-up)')
ax[0][0].legend(loc='upper right', fontsize=8, ncol=2)
fig.suptitle('Gyro against rotor revolutions, all profiles together. Solid: raw. Dashed: after the gyro filters. '
             'A dip of the dashed curve below the solid one is a notch of the filters.', y=0.93)
save(fig, 'orders.png')

# 3. does the line follow the rotor? every 2 s window of every flight, also while headspeed is changing
T = [t for t in S['tracking'] if t['prominence'] >= 8]
fig, ax = plt.subplots(1, 2, figsize=(15, 5.5))
for g, color in zip(GROUPS, COLORS):
    rows = [t for t in T if t['log'] in g['logs']]
    ax[0].scatter([t['headspeed'] for t in rows], [t['hz'] for t in rows], s=5, color=color, alpha=0.5, label=f"logs {g['name']} ({len(rows)} windows)")
    ax[1].scatter([t['headspeed'] for t in rows], [t['hz'] / (t['headspeed'] / 60) for t in rows], s=5, color=color, alpha=0.5)
hs = np.linspace(1500, 5300, 50)
for k, style in [(4.0, ':'), (LINE or 3.79, '--')]:
    ax[0].plot(hs, k * hs / 60, color='k', lw=0.8, ls=style, label=f'{k:.3f} × rotor speed')
    ax[1].axhline(k, color='k', lw=0.8, ls=style)
ax[0].set_xlabel('headspeed (rpm)'); ax[0].set_ylabel('frequency of the strongest line (Hz)'); ax[0].legend(fontsize=8)
ax[1].set_xlabel('headspeed (rpm)'); ax[1].set_ylabel('the same, in multiples of rotor speed'); ax[1].set_ylim(3.5, 4.3)
tr = S['rule']['track']
fig.suptitle(f"Strongest line of the raw gyro between {tr['from']} and {tr['to']} × rotor speed, one point per 2 s window "
             f"(windows where it stands 8 times above its surroundings: {len(T)} of {len(S['tracking'])})")
save(fig, 'line_tracking.png')

# 4. spectrograms: a whole log from start to end, in hertz and in multiples of rotor speed
for sp in S['spectrograms']:
    t = np.array(sp['t']); hs = np.array(sp['headspeed'], dtype=float); A = np.array(sp['amplitude']).T      # rows: frequency
    f = (np.arange(A.shape[0]) + 0.5) * sp['binHz']
    fig, ax = plt.subplots(3, 1, figsize=(15, 11), sharex=True, gridspec_kw={'height_ratios': [1, 3, 3]})
    ax[0].plot(t, hs, color='k', lw=0.9, label='headspeed'); ax[0].plot(t, sp['target'], color='#c0392b', lw=0.8, ls='--', label='governor target')
    ax[0].set_ylabel('rpm'); ax[0].legend(loc='lower center', ncol=2, fontsize=8)
    prof = np.array(sp['profile'])
    for p in sorted(set(prof)):
        idx = np.where(prof == p)[0]
        runs = np.split(idx, np.where(np.diff(idx) > 1)[0] + 1)
        for run in runs:
            if len(run) > 4 and p > 0:
                ax[0].text(t[run[len(run) // 2]], ax[0].get_ylim()[0] + 300, f'profile {p}', ha='center', fontsize=8)
    img = ax[1].pcolormesh(t, f, 20 * np.log10(np.maximum(A, 0.05)), shading='auto', cmap='magma', vmin=-15, vmax=40)
    ax[1].set_ylabel('Hz')
    fig.colorbar(img, ax=ax[1], pad=0.01, label='dB re 1 deg/s')
    # the same against rotor speed: each column is re-read on a grid of multiples of its own rotor frequency
    grid = np.arange(0.3, 5.0, 0.02)
    O = np.full((len(grid), len(t)), np.nan)
    for j in range(len(t)):
        if hs[j] > 1500:
            O[:, j] = np.interp(grid * hs[j] / 60, f, A[:, j], right=np.nan)
    img = ax[2].pcolormesh(t, grid, 20 * np.log10(np.maximum(O, 0.05)), shading='auto', cmap='magma', vmin=-15, vmax=40)
    ax[2].set_ylabel('multiples of rotor speed'); ax[2].set_xlabel('time in the log (s)')
    ax[2].set_yticks([1, 2, 3, 4] + ([LINE] if LINE else [])); ax[2].set_yticklabels(['1', '2', '3', '4'] + ([f'{LINE:.2f}'] if LINE else []))
    fig.colorbar(img, ax=ax[2], pad=0.01, label='dB re 1 deg/s')
    fig.colorbar(plt.cm.ScalarMappable(), ax=ax[0], pad=0.01).remove()
    fig.suptitle(f"Log #{sp['log']}: raw gyro, all three axes together, from start to end. Middle: against frequency. "
                 f"Bottom: against multiples of rotor speed, where anything that turns with the rotor is a level line.", y=0.91)
    save(fig, f"spectrogram_log{sp['log']}.png")

# 5. what the sticks explain: gyro motion per 1 Hz band, all of it and the part the four sticks do not explain
split = R.get('sticks', {}).get('split', [])
if split:
    fig, ax = plt.subplots(3, 3, figsize=(15, 9), sharex=True)
    for e in split:
        a, c = AXES.index(e['axis']), e['profile'] - 1
        gi = [g['name'] for g in GROUPS].index(e['group']) if e['group'] in [g['name'] for g in GROUPS] else None
        if gi is None or not 0 <= c <= 2:
            continue
        ax[a][c].semilogy(e['hz'], e['spectrumTotal'], color=COLORS[gi], lw=1.0, label=f"all motion, logs {e['group']}")
        ax[a][c].semilogy(e['hz'], e['spectrumRest'], color=COLORS[gi], lw=1.0, ls='--', label=f"not explained by the sticks, logs {e['group']}")
        ax[a][c].axvspan(e['band'][0], e['band'][1], color='k', alpha=0.04)
    for a in range(3):
        for c in range(3):
            ax[a][c].set_ylim(0.2, 60)
            if a == 0:
                ax[a][c].set_title(f"Profile {c + 1} ({GROUPS[-1]['targetOf'].get(str(c + 1))} rpm)")
            if c == 0:
                ax[a][c].set_ylabel(f'{AXES[a]} gyro  (deg/s per 1 Hz band)')
            if a == 2:
                ax[a][c].set_xlabel('Hz')
    ax[0][0].legend(fontsize=7, loc='lower left')
    fig.suptitle('Gyro motion against frequency: all of it (solid) and the part that the four sticks together do not explain (dashed). '
                 'Shaded: the band where the axis oscillates.', y=0.94)
    save(fig, 'sticks.png')

# 6. the line near 3.79 x: its ratio to the main rotor window by window, and close-ups at the line and at twice it (line.json)
LJ = os.path.join(DIR, 'line.json')
if os.path.exists(LJ):
    Lj = json.load(open(LJ))
    W = [w for w in Lj['windows'] if w['pass'] == 'long' and w['line']['snr'] >= 10 and w['main']['snr'] >= 5]
    group = lambda log: '#0–#5' if log <= 5 else '#6' if log == 6 else '#7–#16' if log <= 16 else '#17–#26'
    colours = {'#0–#5': '#7f8c8d', '#6': '#16a085', '#7–#16': COLORS[0], '#17–#26': COLORS[1]}
    fig, ax = plt.subplots(2, 2, figsize=(15, 9))
    for g, colour in colours.items():
        rows = [w for w in W if group(w['log']) == g]
        if not rows:
            continue
        ratio = [w['line']['order'] / w['main']['order'] for w in rows]
        ax[0][0].scatter([w['headspeed'] for w in rows], ratio, s=8, color=colour, alpha=0.6, label=f'logs {g} ({len(rows)} windows)')
        ax[0][1].scatter([w['collective'] / 12.5 for w in rows], ratio, s=8, color=colour, alpha=0.6)
    for a in (ax[0][0], ax[0][1]):
        for value, name, style in [(72 / 19, '72/19', '-'), (91 / 24, '91/24', ':'), (53 / 14, '53/14', ':')]:
            a.axhline(value, color='k', lw=0.8, ls=style)
            a.text(a.get_xlim()[1], value, ' ' + name, va='center', fontsize=8)
        a.set_ylim(3.784, 3.794)
    ax[0][0].set_xlabel('headspeed (rpm)'); ax[0][0].set_ylabel('the line / the main rotor line'); ax[0][0].legend(fontsize=8, loc='lower right')
    ax[0][1].set_xlabel('collective, mean over the window (% of full range)')
    R = Lj['spectra'][0]['revolutions']; nb = len(Lj['spectra'][0]['m']) // 9
    scale = float(np.median([w['main']['order'] for w in W]))
    for g, lo, hi, colour in [('#7–#16', 7, 16, COLORS[0]), ('#17–#26', 17, 26, COLORS[1])]:
        rows = [e for e in Lj['spectra'] if e['air'] and lo <= e['log'] <= hi and e['profile'] == 1]
        n = sum(e['windows'] for e in rows)
        m = sum(np.array(e['m']) for e in rows).reshape(nb, 9)
        amp = np.sqrt((m[:, 0] + m[:, 1] + m[:, 2]) / n)
        orders = np.arange(nb) / R / scale
        for a, lim in [(ax[1][0], (3.6, 4.1)), (ax[1][1], (7.3, 8.2))]:
            sel = (orders >= lim[0]) & (orders <= lim[1])
            a.semilogy(orders[sel], amp[sel], color=colour, lw=1, label=f'logs {g}, profile 1 ({n} windows)')
    for a, marks in [(ax[1][0], [(72 / 19, '72/19'), (4, '4')]), (ax[1][1], [(144 / 19, '2 × 72/19'), (8, '8')])]:
        for value, name in marks:
            a.axvline(value, color='k', lw=0.6, ls=':')
            a.text(value, a.get_ylim()[1], name, ha='center', va='bottom', fontsize=8)
        a.set_xlabel('multiples of the main rotor'); a.set_ylabel('raw gyro, all axes (deg/s)')
    ax[1][0].legend(fontsize=8)
    fig.suptitle('The line near 3.79 × rotor speed. Top: its ratio to the main rotor line in every window of 512 revolutions. '
                 'Bottom: at 3500 rpm, where twice the line still lies below the logging limit.', y=0.95)
    save(fig, 'line_ratio.png')
