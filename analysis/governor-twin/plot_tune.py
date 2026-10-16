"""Figures of the governor autotune (docs/GOVERNOR_AUTOTUNE.md sections 7 and 9).

    python analysis/governor-twin/plot_tune.py <out dir>      (rs-bench python: numpy, matplotlib)

Reads <out dir>/tune.json (analysis/governor-twin/tune.cjs) and draws each plot spec of the result (the plots of the Governor tab:
twin.plots for the model quality, plots for the autotune) as <out dir>/tune_<id>.png. The specs are generic (gov_tune.cjs plotSpec):
{ id, title, kind 'time' | 'xy', x, y: { label, unit, log }, series: [{ name, role, x, y, style }] }. A time plot of the closed loop
with the recommended values also gets a zoom on the 20 s with the largest difference between the two models.
"""
import json
import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

# the reference categorical palette (dataviz skill, light mode), in fixed order; a role takes its own slot order
SLOTS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"]
ROLE = {"measured": ["#3a3936", "#8a8984"], "model": SLOTS, "baseline": ["#eb6834", "#9b9a95"], "candidate": ["#008300", "#1baf7a"],
        "limit": ["#7a7975"], "other": SLOTS}
INK, MUTED, GRID = "#0b0b0b", "#52514e", "#e4e3df"


def arr(v):
    return np.array([np.nan if q is None else q for q in v], dtype=float)


def axis_label(a):
    if not a:
        return ""
    return a.get("label", "") + (f" ({a['unit']})" if a.get("unit") else "")


def draw(ax, spec, xlim=None):
    used, named = {}, {}
    for s in spec["series"]:
        role = s.get("role") if s.get("role") in ROLE else "other"
        # a dashed series whose name starts with the name of an earlier series (the same case with another option) takes its color
        stem = next((n for n in named if s.get("style") == "dash" and s.get("name", "").startswith(n + ",")), None)
        if stem:
            color = named[stem]
        else:
            k = used[role] = used.get(role, 0) + 1
            color = ROLE[role][(k - 1) % len(ROLE[role])]
            named[s.get("name", "")] = color
        x, y = arr(s["x"]), arr(s["y"])
        if xlim is not None:
            m = (x >= xlim[0]) & (x <= xlim[1])
            x, y = x[m], y[m]
        kw = dict(color=color, label=s.get("name", ""))
        if s.get("style") == "points":
            ax.plot(x, y, linestyle="none", marker="o", markersize=2.5, alpha=0.45, **kw)
            continue
        dash = s.get("style") == "dash" or role == "limit"
        width = 1.0 if role in ("limit", "baseline", "measured") else 1.5
        ax.plot(x, y, linestyle="--" if dash else "-", linewidth=width, marker="o" if spec["kind"] == "xy" and len(x) <= 12 else None, markersize=4, **kw)
    if spec["x"].get("log"):
        ax.set_xscale("log")
    ax.set_xlabel(axis_label(spec["x"]), color=MUTED)
    ax.set_ylabel(axis_label(spec["y"]), color=MUTED)
    ax.grid(True, color=GRID, linewidth=0.6)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    ax.tick_params(colors=MUTED, labelsize=8)
    if len(spec["series"]) > 6:
        ax.legend(fontsize=7, frameon=False, loc="upper left", bbox_to_anchor=(1.01, 1.0))
    elif len(spec["series"]) > 1:
        ax.legend(fontsize=7, frameon=False, loc="best")


def zoom_window(spec, seconds=20.0):
    """the window of `seconds` with the largest mean |candidate - baseline| (the closed loop with the recommended values)"""
    base = next((s for s in spec["series"] if s.get("role") == "baseline"), None)
    cand = next((s for s in spec["series"] if s.get("role") == "candidate"), None)
    if not base or not cand:
        return None
    x, d = arr(base["x"]), np.abs(arr(cand["y"]) - arr(base["y"]))
    if len(x) < 10:
        return None
    best, at = -1.0, None
    for i in range(0, len(x), max(1, len(x) // 400)):
        m = (x >= x[i]) & (x < x[i] + seconds)
        v = np.nanmean(d[m]) if m.any() else np.nan
        if np.isfinite(v) and v > best:
            best, at = v, (x[i], x[i] + seconds)
    return at


def main(out):
    res = json.load(open(os.path.join(out, "tune.json")))
    specs = list((res.get("twin") or {}).get("plots") or []) + list(res.get("plots") or [])
    written = []
    for spec in specs:
        z = zoom_window(spec) if spec["id"] in ("tune-hs", "tune-u") else None
        if z:
            fig, axes = plt.subplots(2, 1, figsize=(11, 6.4), height_ratios=[1, 1])
            draw(axes[0], spec)
            draw(axes[1], spec, xlim=z)
            axes[1].set_title(f"Zoom: {z[0]:.0f} s to {z[1]:.0f} s", fontsize=8, color=MUTED, loc="left")
        else:
            fig, ax = plt.subplots(figsize=(11 if spec["kind"] == "time" or len(spec["series"]) > 6 else 7.5, 4.2))
            draw(ax, spec)
        fig.suptitle(spec["title"], fontsize=10, color=INK, x=0.01, ha="left")
        fig.tight_layout()
        f = os.path.join(out, f"tune_{spec['id']}.png")
        fig.savefig(f, dpi=110)
        plt.close(fig)
        written.append(f)
    print(f"{len(written)} figures in {out}")
    for f in written:
        print(" ", os.path.basename(f))


if __name__ == "__main__":
    main(sys.argv[1])
