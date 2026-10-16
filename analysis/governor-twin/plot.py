"""Governor twin: figures of the prediction quality (docs/GOVERNOR_AUTOTUNE.md section 9).

    /Users/albertwu/miniconda3/envs/rs-bench/bin/python analysis/governor-twin/plot.py <out dir> [<out dir> ...]

<out dir> holds result.json of dev.cjs (analysis/governor-twin/out/<craft>[-nocurrent]). Writes into the same directory:
  a_closed_loop_hs.png   closed-loop headspeed (native governor + twin, from the arm) against the log, each test flight, logged
                         governor-state bands, the closed-loop state disagreements as ticks
  a_zoom.png             zooms: the closed loop simulated at the PID rate, plotted at about 50-100 Hz (plotHz): the largest collective
                         rise (load step) and the longest saturation of each test flight
  b_throttle.png         governor throttle: log against the closed loop
  c_battery.png          Vbat (and Ibat): log, open loop (recorded throttle, each motor-on stretch) and closed loop
  d_horizon.png          horizon curve (causal start states): twin against "hold the start value" (the same information), in ACTIVE to
                         the horizon also against the logged target (uses the future target), and the horizons that cross a state change
  e_steady_map.png       required throttle against collective at each governed headspeed, full and end-of-pack OCV, with the
                         measured 1-s ACTIVE points
  f_params.png           the identified parameters: the p5-p95 band relative to the value (the wider of the block bootstrap and the
                         leave-one-flight-out refits; the soft start: the single-start fits; u0: the start throttles; vp: the flights)
  g_current.png          (gaui only, needs gaui-nocurrent next to it) the Gaui twin with and without the current channel
Log numbers are the 0-based indexes of the dump (app log number = index + 1).
"""
import json
import os
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

STATES = ["OFF", "IDLE", "SPOOLUP", "RECOVERY", "ACTIVE", "HOLD", "FALLBACK", "AUTOROTATION", "BAILOUT", "BYPASS"]
# measured: ink; closed loop: blue; open loop: orange; target: gray (reference palette slots 1 and 2)
INK, CL, OL, REF = "#2b2b2b", "#2a78d6", "#eb6834", "#9a9890"
BAND = {1: "#d9e6f5", 2: "#fde3c4", 3: "#f6c9c9", 5: "#e3e0f5", 6: "#e34948", 7: "#d4eedf", 8: "#f6c9c9", 9: "#eeeeee"}
plt.rcParams.update({"font.size": 9, "axes.spines.top": False, "axes.spines.right": False, "axes.grid": True, "grid.color": "#e6e5e0",
                     "grid.linewidth": 0.6, "lines.linewidth": 1.0, "legend.frameon": False, "figure.dpi": 110, "savefig.dpi": 130})


def arr(a):
    return np.array([np.nan if v is None else v for v in a], dtype=float) if a is not None else None


def bands(ax, t, st, alpha=0.55):
    """Background bands of the logged governor states other than ACTIVE (and OFF)."""
    if st is None:
        return set()
    st = np.asarray(st)
    seen, i = set(), 0
    while i < len(st):
        j = i
        while j < len(st) and st[j] == st[i]:
            j += 1
        s = int(st[i])
        if s in BAND:
            ax.axvspan(t[i], t[min(j, len(t) - 1)], color=BAND[s], alpha=alpha if s != 6 else 0.35, lw=0)
            seen.add(s)
        i = j
    return seen


def save(fig, out, name):
    fig.savefig(os.path.join(out, name), bbox_inches="tight")
    plt.close(fig)
    print("wrote", os.path.join(out, name))


def title(r):
    cur = "with current" if r["data"]["has"]["current"] else ("no current" if r["data"]["has"]["voltage"] else "no voltage")
    return f'{r["craft"].capitalize()} ({cur}): twin status "{r["status"]}"'


def cl_row(r, log):
    return next((q for q in r["validation"]["closedLoop"]["runs"] if q["log"] == log), {})


def fig_a(r, out):
    runs = r["plots"]["runs"]
    fig, axs = plt.subplots(len(runs), 1, figsize=(11, 2.9 * len(runs)), squeeze=False)
    for ax, q in zip(axs[:, 0], runs):
        t, hs, hc, tg = arr(q["time"]), arr(q["hs"]), arr(q["hsClosed"]), arr(q["target"])
        bands(ax, t, q["state"])
        ax.plot(t, tg, color=REF, lw=0.9, ls="--", label="governor target (log)")
        ax.plot(t, hs, color=INK, lw=0.9, label="headspeed (log)")
        ax.plot(t, hc, color=CL, lw=0.9, alpha=0.9, label="twin + native governor (closed loop)")
        if q.get("stateClosed") is not None and q.get("state") is not None:
            bad = np.array(q["stateClosed"]) != np.array(q["state"])
            if bad.any():
                ax.plot(t[bad], np.full(bad.sum(), np.nanmax(hs) * 1.08), "|", color="#e34948", ms=6, label="closed-loop state differs")
        c = cl_row(r, q["log"])
        nz = lambda k: c.get(k) if c.get(k) is not None else float("nan")
        ax.set_title(f'log {q["log"]}: closed-loop headspeed RMS {nz("hsRms"):.2f} % of target in ACTIVE (logged tracking error {nz("baseRms"):.2f} %, '
                     f'fast part {nz("band"):.2f} of the log), throttle RMS {100 * nz("uRms"):.2f} %, state agreement {100 * nz("stateAgreement"):.2f} %, '
                     f'{c.get("forced", 0)} FALLBACK entries forced from the log', loc="left", fontsize=8.5)
        ax.set_ylabel("rotor rpm")
        ax.set_ylim(0, 1.32 * np.nanmax(hs))
        ax.legend(loc="upper left", ncol=4, fontsize=7)
        ax.set_xlim(t[0], t[-1])
    axs[-1, 0].set_xlabel("time from the log start, s")
    # one legend of the state bands for the figure
    from matplotlib.patches import Patch
    seen = sorted({int(s) for q in runs for s in (q["state"] or []) if int(s) in BAND})
    fig.legend(handles=[Patch(color=BAND[s], alpha=0.55, label=STATES[s]) for s in seen], loc="lower center", ncol=len(seen), fontsize=8,
               title="logged governor state (ACTIVE: no band)", title_fontsize=8, bbox_to_anchor=(0.5, -0.02))
    fig.suptitle(title(r) + " - closed-loop headspeed on the test flights", x=0.01, ha="left", fontsize=11)
    fig.tight_layout(rect=(0, 0.04, 1, 0.97))
    save(fig, out, "a_closed_loop_hs.png")


def fig_zoom(r, out):
    zs = r["plots"]["zooms"]
    if not zs:
        return
    logs = sorted({z["log"] for z in zs})
    kinds = [k for k in ["load step", "saturation"] if any(z["kind"] == k for z in zs)]
    fig, axs = plt.subplots(2 * len(logs), len(kinds), figsize=(5.6 * len(kinds), 2.4 * 2 * len(logs)), squeeze=False, sharex=False)
    for li, log in enumerate(logs):
        for ki, kind in enumerate(kinds):
            a1, a2 = axs[2 * li, ki], axs[2 * li + 1, ki]
            z = next((z for z in zs if z["log"] == log and z["kind"] == kind), None)
            if z is None:
                a1.axis("off"); a2.axis("off")
                continue
            t = arr(z["time"])
            for a in (a1, a2):
                bands(a, t, z["state"])
            a1.plot(t, arr(z["target"]), color=REF, ls="--", lw=0.9, label="target (log)")
            a1.plot(t, arr(z["hs"]), color=INK, label="log")
            a1.plot(t, arr(z["hsClosed"]), color=CL, label="closed loop")
            a2.plot(t, arr(z["u"]), color=INK, label="throttle (log)")
            a2.plot(t, arr(z["uClosed"]), color=CL, label="throttle (closed loop)")
            a2b = a2.twinx()
            a2b.plot(t, arr(z["coll"]), color="#1baf7a", lw=0.8, label="collective (mixer)")
            a2b.set_ylabel("collective", color="#1baf7a", fontsize=8)
            a2b.tick_params(axis="y", colors="#1baf7a", labelsize=7)
            a2b.spines["right"].set_visible(True)
            a2b.grid(False)
            extra = f', collective rise {z["collRise"]:.2f} in 0.5 s' if z.get("collRise") is not None else f', {z["satS"]:.2f} s at full throttle' if z.get("satS") is not None else ""
            a1.set_title(f'log {log}, {kind}{extra}', loc="left", fontsize=9)
            a1.set_ylabel("rotor rpm"); a2.set_ylabel("throttle 0..1"); a2.set_xlabel("time, s")
            a1.legend(fontsize=7, loc="best", ncol=3); a2.legend(fontsize=7, loc="best", ncol=2)
            a1.set_xlim(t[0], t[-1]); a2.set_xlim(t[0], t[-1])
    hz = sorted({z.get("plotHz") for z in zs if z.get("plotHz")})
    rate = (f"plotted at about {hz[0]:.0f} Hz" if round(hz[0]) == round(hz[-1]) else f"plotted at {hz[0]:.0f}-{hz[-1]:.0f} Hz") if hz else "decimated"
    fig.suptitle(title(r) + f" - zooms: closed loop simulated at the PID rate, {rate}", x=0.01, ha="left", fontsize=11)
    fig.tight_layout(rect=(0, 0, 1, 0.97))
    save(fig, out, "a_zoom.png")


def fig_b(r, out):
    runs = r["plots"]["runs"]
    fig, axs = plt.subplots(len(runs), 1, figsize=(11, 2.4 * len(runs)), squeeze=False)
    for ax, q in zip(axs[:, 0], runs):
        t = arr(q["time"])
        bands(ax, t, q["state"])
        ax.plot(t, arr(q["u"]), color=INK, lw=0.8, label="throttle (log, motor[0])")
        ax.plot(t, arr(q["uClosed"]), color=CL, lw=0.8, alpha=0.85, label="throttle (native governor on the twin)")
        c = cl_row(r, q["log"])
        ax.set_title(f'log {q["log"]}: throttle RMS {100 * c.get("uRms", float("nan")):.2f} % in ACTIVE, saturated (u >= 0.995) '
                     f'{c.get("satS", float("nan")):.2f} s in the closed loop', loc="left", fontsize=9)
        ax.set_ylabel("throttle 0..1"); ax.set_ylim(0, 1.05); ax.set_xlim(t[0], t[-1])
        ax.legend(loc="lower center", ncol=2, fontsize=7)
    axs[-1, 0].set_xlabel("time from the log start, s")
    fig.suptitle(title(r) + " - governor throttle, closed loop", x=0.01, ha="left", fontsize=11)
    fig.tight_layout(rect=(0, 0, 1, 0.97))
    save(fig, out, "b_throttle.png")


def fig_c(r, out):
    runs = r["plots"]["runs"]
    if not r["data"]["has"]["voltage"]:
        return
    cur = r["data"]["has"]["current"]
    fig, axs = plt.subplots(len(runs), 2 if cur else 1, figsize=(13 if cur else 11, 2.6 * len(runs)), squeeze=False)
    ol = r["validation"]["openLoop"]
    for i, q in enumerate(runs):
        t = arr(q["time"])
        ax = axs[i, 0]
        ax.plot(t, arr(q["vbat"]), color=INK, lw=0.8, label="Vbat (log)")
        ax.plot(t, arr(q["vbatOpen"]), color=OL, lw=0.8, label="twin, open loop (recorded throttle, each motor-on stretch)")
        ax.plot(t, arr(q["vbatClosed"]), color=CL, lw=0.8, label="twin, closed loop (OCV from the rest voltage less vp)")
        c = cl_row(r, q["log"])
        ax.set_title(f'log {q["log"]}: Vbat RMS in the closed loop {c.get("vbatRms", float("nan")):.3f} V', loc="left", fontsize=8.5)
        ax.set_ylabel("V"); ax.set_xlim(t[0], t[-1]); ax.legend(fontsize=7, loc="best")
        if cur:
            ax = axs[i, 1]
            ax.plot(t, arr(q["ibat"]), color=INK, lw=0.7, label="Ibat (log)")
            ax.plot(t, arr(q["ibatOpen"]), color=OL, lw=0.7, alpha=0.85, label="twin, open loop")
            if q.get("ibatClosed") is not None:
                ax.plot(t, arr(q["ibatClosed"]), color=CL, lw=0.7, alpha=0.8, label="twin, closed loop")
            ax.set_title(f'log {q["log"]}: Ibat', loc="left", fontsize=8.5)
            ax.set_ylabel("A"); ax.set_xlim(t[0], t[-1]); ax.legend(fontsize=7, loc="best")
    for ax in axs[-1, :]:
        ax.set_xlabel("time from the log start, s")
    sub = f'open loop on all test data: Vbat RMS {ol["window"]["vbat"]["rms"]:.3f} V (5-s windows), {ol["stretch"]["vbat"]["rms"]:.3f} V (whole motor-on stretches)'
    if cur:
        sub += f', Ibat RMS {ol["window"]["ibat"]["rms"]:.2f} A (5-s windows)'
    fig.suptitle(title(r) + " - battery voltage" + (" and current" if cur else "") + "\n" + sub, x=0.01, ha="left", fontsize=10)
    fig.tight_layout(rect=(0, 0, 1, 0.95))
    save(fig, out, "c_battery.png")


def fig_d(r, out):
    h = r["plots"]["horizon"]
    H = np.array(h["horizons"])
    ys = lambda a: np.array([np.nan if q["rms"] is None else q["rms"] for q in a])
    fig, (ax, bx) = plt.subplots(1, 2, figsize=(12, 4.2))
    ia, cr = h["inActive"], h["crossing"]
    for key, lab, col, ls in [(h["model"], "twin, all starts", CL, "-"), (h["hold"], '"hold the start value", all starts', INK, "-"),
                              (ia["model"], "twin, ACTIVE to the horizon", CL, ":"), (ia["hold"], "hold, ACTIVE to the horizon", INK, ":"),
                              (ia["target"], "logged target at the horizon (uses the future target)", REF, "--")]:
        ax.plot(H, ys(key), ls=ls, color=col, marker="o", ms=4, label=lab)
    for x, a, b in zip(H, h["model"], h["hold"]):
        ax.annotate(f'{a["rms"]:.2f}', (x, a["rms"]), textcoords="offset points", xytext=(0, -12), ha="center", fontsize=7, color=CL)
        ax.annotate(f'{b["rms"]:.2f}', (x, b["rms"]), textcoords="offset points", xytext=(0, 6), ha="center", fontsize=7, color=INK)
    n_in, n_x = ia["model"][-1]["n"], cr["model"][-1]["n"]
    ax.set_title(f'{title(r)}\nhorizon curve, {h["starts"]} starts every 0.5 s in the test data (causal start)', loc="left", fontsize=9)
    bx.plot(H, ys(cr["model"]), color=CL, marker="o", ms=4, label="twin (recorded throttle)")
    bx.plot(H, ys(cr["hold"]), color=INK, marker="o", ms=4, label='"hold the start value"')
    bx.set_title(f'starts whose horizon crosses a state change or a throttle cut\n({cr["model"][0]["n"]} at 0.1 s, {n_x} at 5 s; {n_in} at 5 s stay in ACTIVE)', loc="left", fontsize=9)
    for a in (ax, bx):
        a.set_xscale("log"); a.set_xticks(H); a.set_xticklabels([f"{x:g}" for x in H])
        a.set_xlabel("prediction horizon, s"); a.set_ylabel("headspeed error RMS, % of target"); a.legend(fontsize=7)
    fig.tight_layout()
    save(fig, out, "d_horizon.png")


def fig_e(r, out):
    sm = r["plots"]["steady"]
    hss = sorted({c["headspeed"] for c in sm["curves"]})
    fig, axs = plt.subplots(1, len(hss), figsize=(4.4 * len(hss), 4), squeeze=False, sharey=True)
    pts = sm["points"]
    vb = [p["vbat"] for p in pts if p["vbat"] is not None]
    vmin, vmax = (min(vb), max(vb)) if vb else (0, 1)
    for ax, hs in zip(axs[0], hss):
        sel = [p for p in pts if p["hs"] == hs]
        if sel:
            sc = ax.scatter([p["coll"] for p in sel], [p["u"] for p in sel], c=[p["vbat"] if p["vbat"] is not None else 0 for p in sel], cmap="Blues_r" if vb else None,
                            vmin=vmin, vmax=vmax, s=9, alpha=0.75, edgecolors="none", label=f"measured 1-s ACTIVE means ({len(sel)})")
        for c in sm["curves"]:
            if c["headspeed"] != hs:
                continue
            lab = f'twin, {c["ocv"]} pack OCV {c["voltage"]:.2f} V' if c["voltage"] else "twin (constant voltage)"
            ax.plot(c["coll"], [np.nan if v is None else v for v in c["throttle"]], color=OL if c["ocv"] == "end" else CL, lw=1.6, label=lab)
        ax.axhline(1, color="#e34948", lw=0.8, ls="--")
        ax.set_title(f"{hs} rpm", loc="left")
        ax.set_xlabel("collective (mixer, -1..1)")
        ax.legend(fontsize=7, loc="upper center")
        ax.set_ylim(0, 1.35)
    axs[0, 0].set_ylabel("required throttle (duty)")
    if vb:
        cb = fig.colorbar(sc, ax=axs[0, :].tolist(), shrink=0.8, pad=0.01)
        cb.set_label("Vbat of the point, V")
    fig.suptitle(title(r) + f' - steady-state map (median cyclic {sm["cyc"]:.2f}, median |yaw| {sm["yaw"]:.2f}); dashed: full throttle',
                 x=0.01, ha="left", fontsize=10)
    save(fig, out, "e_steady_map.png")


UNITS_SKIP = {"th"}


def fig_f(r, out):
    P = r["params"]
    names = [k for k, v in P.items() if k not in UNITS_SKIP]
    fig, (ax, at) = plt.subplots(1, 2, figsize=(14, 0.3 * len(names) + 1.8), gridspec_kw={"width_ratios": [1, 1.05]})
    y = np.arange(len(names))[::-1]
    labels = []
    for yi, k in zip(y, names):
        v = P[k]
        val = v["value"]
        held = "" if v["free"] else " [output error, single starts]" if k in ("ass", "asr", "as0", "as1") else " [start throttles]" if k == "u0" \
            else " [regression]" if k == "kappa" else " [rest offset, flights]" if k == "vp" else " [held]"
        flag = " (not informed)" if v.get("informed") is False else ""
        rng = f' ({v["p5"]:.4g} to {v["p95"]:.4g})' if v.get("p5") is not None else ""
        labels.append(f'{k} = {val:.4g}{" " + v["unit"] if v["unit"] != "-" else ""}{rng}{held}{flag}')
        if v.get("p5") is not None and val not in (0, None):
            lo, hi = sorted([100 * (v["p5"] / val - 1), 100 * (v["p95"] / val - 1)])
            ax.plot([lo, hi], [yi, yi], color=CL if v["free"] else OL, lw=5, solid_capstyle="round")
        ax.plot([0], [yi], "o", color=INK, ms=4)
    ax.set_yticks(y); ax.set_yticklabels(labels, fontsize=7.5)
    ax.set_xscale("symlog", linthresh=10)
    ax.axvline(0, color=INK, lw=0.8)
    ax.set_xlabel("p5..p95 relative to the value, %\n(blue: LM fit, the wider of the block bootstrap and the leave-one-flight-out refits;\n"
                  "orange: the spread of the single-start fits (soft start), the start throttles (u0), the rest offset of each flight (vp);\n"
                  "kappa: the OCV regression of each fit)")
    ax.set_xlim(-100, 1000)
    bs = r.get("bootstrap") or {}
    ax.set_title(f'{title(r)}: parameters, {bs.get("n", r["options"]["bootstrap"])} bootstrap fits, {bs.get("flights", 0)} leave-one-flight-out fits', loc="left", fontsize=9)
    # table: physical values and the fit summary
    at.axis("off")
    rows = []
    ph = r.get("physical")
    if ph:
        rng = ph.get("range", {})
        fmt = {"Rm": ("R_m (motor, ESC, wires)", 1000, "mOhm"), "R0": ("R0 (pack, leads)", 1000, "mOhm"), "dOcvPerAh": ("dOCV/dQ", 1, "V/Ah"),
               "J": ("J (rotor shaft)", 1, "kg m^2"), "Ke": ("Ke = Kt", 1, "V s/rad"), "i0": ("i0 (current offset)", 1, "A")}
        for k, (lab, s, u) in fmt.items():
            if k in ph["value"]:
                q = rng.get(k, {})
                rows.append([lab, f'{s * ph["value"][k]:.4g} {u}', f'{s * q["p5"]:.4g} - {s * q["p95"]:.4g}' if q else "-"])
    reg = r.get("regression") or {}
    if reg.get("kvRatio"):
        rows.append(["kv lower bound (ratio, C2)", f'{reg["kvRatio"]:.1f} rpm/V' if r["data"]["has"]["voltage"] else f'{reg["kvRatio"]:.0f}', "-"])
    if reg.get("kvCurrent"):
        rows.append(["static regression: kv, R_m, R0", f'{reg["kvCurrent"]:.1f}, {1000 * reg["Rm"]:.1f}, {1000 * (reg.get("R0") or float("nan")):.1f}', "rpm/V, mOhm, mOhm"])
    if reg.get("betaStatic") is not None:
        rows.append(["R0/R_m static, no current (biased)", f'{reg["betaStatic"]:.3f}', f'fit {P["beta"]["value"]:.3f}' if "beta" in P else "-"])
    k = r.get("kappa") or {}
    if k.get("restOffset"):
        rows.append(["rest voltage - regression OCV", f'{k["restOffset"]["median"]:.2f} V', f'{k["restOffset"]["min"]:.2f} - {k["restOffset"]["max"]:.2f}'])
    ss = r.get("softStart") or {}
    if ss.get("starts"):
        rows.append(["ESC soft start: starts, RMS", f'{ss["starts"]} ({ss["method"]})', f'{ss["rms"]:.0f} rpm'])
    f = r["fit"]
    rows.append(["fit data: training / test", f'{f["trainS"] / 60:.1f} / {f["testS"] / 60:.1f} min', f'{f["windows"]["train"]} / {f["windows"]["test"]} windows'])
    tm = r["timing"]["identify"]
    rows.append(["time: fit, bootstrap, validate", f'{tm["fitS"]:.1f} s, {tm["bootstrapS"]:.1f} s', f'{r["timing"]["validateS"]:.1f} s'])
    tb = at.table(cellText=rows, colLabels=["quantity", "value", "p5 - p95 / note"], loc="upper left", cellLoc="left", colLoc="left", colWidths=[0.46, 0.27, 0.27])
    tb.auto_set_font_size(False); tb.set_fontsize(7.5); tb.scale(1, 1.25)
    for (i, j), cell in tb.get_celld().items():
        cell.set_edgecolor("#d8d7d0")
        if i == 0:
            cell.set_text_props(weight="bold")
    fig.tight_layout()
    save(fig, out, "f_params.png")


def fig_g(r, out):
    other = os.path.join(os.path.dirname(os.path.abspath(out)), r["craft"] + "-nocurrent", "result.json")
    if not r["data"]["has"]["current"] or not os.path.exists(other):
        return
    n = json.load(open(other))
    fig, (a1, a2) = plt.subplots(1, 2, figsize=(13, 4.6), gridspec_kw={"width_ratios": [1.2, 1]})
    names = [k for k in r["params"] if k in n["params"] and k not in UNITS_SKIP and r["params"][k]["value"]]
    y = np.arange(len(names))[::-1]
    for yi, k in zip(y, names):
        a, b = r["params"][k], n["params"][k]
        for v, col, dy in [(a, CL, 0.17), (b, OL, -0.17)]:
            if v.get("p5") is not None:
                a1.plot([100 * (v["p5"] / a["value"] - 1), 100 * (v["p95"] / a["value"] - 1)], [yi + dy] * 2, color=col, lw=3.5, alpha=0.55, solid_capstyle="round")
            a1.plot([100 * (v["value"] / a["value"] - 1)], [yi + dy], "o", color=col, ms=4)
    a1.set_yticks(y); a1.set_yticklabels([f'{k} ({r["params"][k]["value"]:.4g}{" " + r["params"][k]["unit"] if r["params"][k]["unit"] != "-" else ""})' for k in names], fontsize=7.5)
    a1.axvline(0, color=INK, lw=0.8); a1.set_xscale("symlog", linthresh=10); a1.set_xlim(-100, 1000)
    a1.set_xlabel("% relative to the value with current (dot: value, bar: p5..p95, see f_params.png)")
    a1.plot([], [], "o-", color=CL, label="with current (Ibat used)"); a1.plot([], [], "o-", color=OL, label="without current (Ibat dropped)")
    a1.legend(fontsize=7, loc="lower right")
    a1.set_title("parameters", loc="left", fontsize=9)
    # prediction metrics
    def mets(x):
        v = x["validation"]
        hz = v["horizon"]
        idx = {h: i for i, h in enumerate(hz["horizons"])}
        return [("open loop: HS median |e| %", v["openLoop"]["window"]["hs"]["medianAbs"]), ("open loop: HS RMS %", v["openLoop"]["window"]["hs"]["rms"]),
                ("open loop: Vbat RMS x10 V", 10 * v["openLoop"]["window"]["vbat"]["rms"]), ("closed loop: HS RMS %", v["closedLoop"]["hsRms"]),
                ("closed loop: throttle RMS %", 100 * v["closedLoop"]["uRms"]), ("closed loop: states differ %", 100 * (1 - v["closedLoop"]["stateAgreement"])),
                ("closed loop: Vbat RMS x10 V", 10 * v["closedLoop"]["vbatRms"]), ("horizon 1 s: HS RMS %", hz["model"][idx[1]]["rms"]), ("horizon 5 s: HS RMS %", hz["model"][idx[5]]["rms"])]
    ma, mb = mets(r), mets(n)
    yy = np.arange(len(ma))[::-1]
    a2.barh(yy + 0.2, [v for _, v in ma], height=0.38, color=CL, label="with current")
    a2.barh(yy - 0.2, [v for _, v in mb], height=0.38, color=OL, label="without current")
    for yi, (_, va), (_, vb) in zip(yy, ma, mb):
        a2.text(va, yi + 0.2, f" {va:.3g}", va="center", fontsize=7); a2.text(vb, yi - 0.2, f" {vb:.3g}", va="center", fontsize=7)
    a2.set_yticks(yy); a2.set_yticklabels([k for k, _ in ma], fontsize=7.5)
    a2.set_xlabel("value on the test flights (smaller is better)")
    a2.legend(fontsize=7, loc="lower right")
    a2.set_title(f'prediction on the test flights (status: with current "{r["status"]}", without "{n["status"]}")', loc="left", fontsize=9)
    fig.suptitle("Gaui X4 II: the governor twin with and without the battery current", x=0.01, ha="left", fontsize=11)
    fig.tight_layout(rect=(0, 0, 1, 0.95))
    save(fig, out, "g_current.png")


def main():
    for out in sys.argv[1:]:
        r = json.load(open(os.path.join(out, "result.json")))
        fig_a(r, out); fig_zoom(r, out); fig_b(r, out); fig_c(r, out); fig_d(r, out); fig_e(r, out); fig_f(r, out); fig_g(r, out)


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    main()
