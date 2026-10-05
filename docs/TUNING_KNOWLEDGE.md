# Rotorflight 4.6 Tuning Knowledge Base

What to look for in a Rotorflight blackbox log, what to avoid and how the documentation says to fix it: the
cyclic loop, the tail loop, the governor and ESC, and filtering. Written for the pilot and for whoever extends
`tools/autotune`. Target firmware: **Rotorflight 4.6.0** (Configurator 2.3.0).

Compiled 2026-09-29 from the sources in section 1. Nothing in this document was flight-tested. It is a map of
what the firmware does and what its authors and users say, not a set of validated rules.

## Contents

1. [Scope and sources](#1-scope-and-sources)
2. [The control loop in 4.6 (pid_mode 3)](#2-the-control-loop-in-46-pid_mode-3)
3. [The governor in 4.6](#3-the-governor-in-46)
4. [Cyclic: symptom, signature, cause, fix](#4-cyclic-symptom-signature-cause-fix)
5. [Tail: symptom, signature, cause, fix](#5-tail-symptom-signature-cause-fix)
6. [Governor, ESC and power: symptom, signature, cause, fix](#6-governor-esc-and-power-symptom-signature-cause-fix)
7. [Filters and vibration: symptom, signature, cause, fix](#7-filters-and-vibration-symptom-signature-cause-fix)
8. [What to avoid](#8-what-to-avoid)
9. [Tuning order and step sizes](#9-tuning-order-and-step-sizes)
10. [Quantitative thresholds for automated checks](#10-quantitative-thresholds-for-automated-checks)
11. [Open questions](#11-open-questions)

---

## 1. Scope and sources

### Labels

| Label | Meaning |
|---|---|
| **[DOC]** | Stated on rotorflight.org or in the Configurator help text |
| **[SRC]** | Read in the firmware or Configurator source at the tags below |
| **[COM]** | Community post (RCGroups, HeliFreak, Spirit forum). Anecdote, one pilot, one heli |
| **[COM-AI]** | Community article that says it was written with AI summaries. Low weight |
| **[INF]** | Inference or arithmetic by the authors of this document. A hypothesis, not a fact |

### Version mapping

- Firmware 4.6.x is the firmware of Rotorflight 2.3: "The firmware for RF 2.3 uses version number 4.6.x"
  ([Releases.md](https://github.com/rotorflight/rotorflight-firmware/blob/release/4.6.0/Releases.md)).
- rotorflight.org pages without a version in the path are labelled "Version: 2.3.0". Pages under `/docs/2.2.0/`
  describe 4.5 and are cited only where 2.3.0 has nothing.
- The Rotorflight 1 wiki is still served at https://github.com/rotorflight/rotorflight-old-wiki/wiki (cloneable as
  `rotorflight-old-wiki.wiki.git`). It is marked outdated and is RF1-era documentation, not 4.6 documentation; it is
  cited as OLDWIKI and used only where 2.3.0 is silent.

### Citation shorthands

| Short | Expands to |
|---|---|
| `FW path:N` | `https://github.com/rotorflight/rotorflight-firmware/blob/release/4.6.0/path#LN` (tag `release/4.6.0`, commit 118e912). The files cited are identical on branch `RF-4.6.x` at 53fd063 |
| `CFG path:N` | `https://github.com/rotorflight/rotorflight-configurator/blob/release/2.3.0/path#LN` |
| `MSG key` | Configurator help string `key` in `CFG locales/en/messages.json` |
| `WEB /x` | `https://rotorflight.org/docs/x` |

### Official pages read

| Short | URL |
|---|---|
| PROF | https://rotorflight.org/docs/configurator/tabs/profiles |
| RATES | https://rotorflight.org/docs/configurator/tabs/rates |
| MIXT | https://rotorflight.org/docs/configurator/tabs/mixer |
| SERVO | https://rotorflight.org/docs/configurator/tabs/servos |
| MOTORS | https://rotorflight.org/docs/configurator/tabs/motors |
| GOVTAB | https://rotorflight.org/docs/configurator/tabs/governor |
| CONFTAB | https://rotorflight.org/docs/configurator/tabs/configuration |
| BB | https://rotorflight.org/docs/configurator/tabs/blackbox |
| GYROTAB | https://rotorflight.org/docs/configurator/tabs/gyro (empty page in 2.3.0, 2.2.0 and 2.1.0) |
| MIXS | https://rotorflight.org/docs/setup/setup-mixer |
| RPMM | https://rotorflight.org/docs/setup/rpm-measurement |
| RPMF | https://rotorflight.org/docs/setup/rpm-filters |
| ESCT | https://rotorflight.org/docs/setup/esc-telemetry |
| CLIREF | https://rotorflight.org/docs/setup/cli-reference |
| FLYR | https://rotorflight.org/docs/setup/governor/governor-flyrotor-setup |
| BYPASS | https://rotorflight.org/docs/setup/governor/governor-bypass |
| TUNE | https://rotorflight.org/docs/Tuning/Tuning-description |
| FF | https://rotorflight.org/docs/Tuning/Tune-Feedforward |
| HSI | https://rotorflight.org/docs/Tuning/High-Speed-Integral |
| XC | https://rotorflight.org/docs/Tuning/Cyclic-Cross-Coupling |
| XCM | https://rotorflight.org/docs/Contributing/Modeling-Cross-Coupling |
| FILT | https://rotorflight.org/docs/Tuning/First-Flight-Filter-Tuning |
| GOVT | https://rotorflight.org/docs/Tuning/Tune-Governor |
| TTA | https://rotorflight.org/docs/Tuning/Motorised-Tail-and-TTA |
| PRESETS | https://rotorflight.org/docs/Tuning/tuning-examples |
| NOTES | https://rotorflight.org/docs/download/notes |
| ANN | https://rotorflight.org/announcement/official-release-2.3.0 |
| GOV45 | https://rotorflight.org/docs/2.2.0/setup/governor (4.5 governor) |
| PROC45 | https://rotorflight.org/docs/2.2.0/testing/tuning-process |
| RPMF20 | https://rotorflight.org/docs/2.0.0/Wiki/Tutorial-Setup/RPM-Filters |
| CHG | https://github.com/rotorflight/rotorflight-firmware/blob/release/4.6.0/Changes.md |
| REL | https://github.com/rotorflight/rotorflight-firmware/releases/tag/release/4.6.0 |
| FWGOV | https://github.com/rotorflight/rotorflight-firmware/blob/release/4.6.0/docs/Governor.md |
| OLDWIKI | https://github.com/rotorflight/rotorflight-old-wiki/wiki (Rotorflight 1 era, marked outdated): `Tuning-Introduction`, `Tail-tuning` |
| LEGACY | https://github.com/rotorflight/rotorflight-firmware/blob/release/4.6.0/docs/PID%20tuning.md (inherited Betaflight text, parameters that do not exist in 4.6; do not use) |

### Community sources read

| Short | URL |
|---|---|
| RCG-n | `https://www.rcgroups.com/forums/showthread.php?4000345-Rotorflight-Flight-Control-(FBL)-Software-Official-discussion/page` + n (the official thread, 169 pages, 2,525 posts filtered by keyword) |
| HF-913037 | https://www.helifreak.com/showthread.php?t=913037 (pages 6 and 10) |
| HF-965481 | https://www.helifreak.com/showthread.php?t=965481 |
| HF-970331 | https://www.helifreak.com/showthread.php?t=970331 |
| HF-950905 | https://www.helifreak.com/showthread.php?t=950905 |
| HF-950165 | https://www.helifreak.com/showthread.php?t=950165 |
| HF-951299 | https://www.helifreak.com/showthread.php?t=951299 |
| HF-974843 | https://www.helifreak.com/showthread.php?t=974843 |
| SPIRIT | https://forum.spirit-system.com/viewtopic.php?p=21770, ?p=25120, ?p=22767, ?p=15805 (Fireball, Spirit FBL era) |
| HWG | https://www.hobbywingdirect.com/blogs/news/44399684-platinum-160a-hv-esc-v4-internal-governor |
| RCFP | https://www.rcflightpath.com/articles/FBL/RotorFlight/rotorflight-tuning-manual.html [COM-AI] |
| RCFP-JW | https://www.rcflightpath.com/articles/FBL/pid-tuning/rotorflight/PID_Tuning_-_Jonas_Wackershauser.html [COM-AI] |
| RCFP-I | https://www.rcflightpath.com/articles/FBL/pid-tuning/rotorflight/Cyclic_I-Term_Thresholds.html [COM-AI, pasted chatbot answer] |
| ARJ | https://www.angelrojasjr.com/2025/05/26/summary-of-bert-jiawen-and-alexs-video-on-rotorflight-filter-and-pid-tuning/ [COM-AI]; video https://youtu.be/Jd_UVcHilyE |
| RCH | https://www.rc-help.com/threads/new-tool-the-rch-heli-head-speed-governor-calculator.22847/ (HTTP 403, search snippet only, unverified) |

### The pilot's machine (what the logs do not record)

From the CLI dump and diff in the pilot's Drive folder (`RTFL_cli_SAB_Fireball_20260827_212131.txt`,
`RTFL_cli_SAB_Fireball_20260904_202152.txt`) and the kit manual:

- SAB Fireball Havok, Matek G474 (header: `Rotorflight 4.6.0 (118e912) STM32G47X`), `pid_mode = 3`.
- Direct drive: `main_rotor_gear_ratio = 1,1`, `motor_poles = 24`, `feature FREQ_SENSOR`, `motor_pwm_protocol = PWM`,
  `dshot_bidir = 0`. RPM therefore comes from the frequency sensor.
- Belt tail, `tail_rotor_gear_ratio = 19,76`. The project's own measurement puts the strongest line at 72/19 ×
  rotor, not 76/19 (`analysis/fireball-wag/line_report.md`). This is a measurement, not a verified fact about the parts.
- `feature -DYN_NOTCH`: the dynamic notch is off although the header still says `dyn_notch_count 6`.
- The 2026-09-04 diff says `gov_mode = DIRECT`, `gov_headspeed = 1800`, `gov_max_throttle = 60/70/80`. **[INF] The
  2026-09-28 logs contradict it:** `govSum` is non-zero (median 560 to 890) and `govTarget` sits at exactly 3500, 4500
  and 5000 rpm per profile. In DIRECT, `govSum` stays 0 (section 3.1). The governor was almost certainly switched
  to ELECTRIC after that diff. The pipeline must detect the mode from the data (check G0 in section 10).

---

## 2. The control loop in 4.6 (pid_mode 3)

### 2.1 Modes

- `pid_mode` range 0..9, default 3 (`FW src/main/cli/settings.c:1104`, `FW src/main/pg/pid.c:47`). The dispatcher
  implements 3 and 4; anything else is passthrough, F only (`FW src/main/flight/pid.c:1699-1741`). [SRC]
- Mode 4 is "for testing new features … The current default PID Mode 3 is maintained for backward compatibility"
  (CHG). It changes the units of axis error, forces equal roll/pitch I, O and F, multiplies pitch B by 10, divides roll
  B and D by 5 and divides the yaw precomp cutoff by 10 (CHG). [DOC]
- `pid_mode` is **not** in the log header (`FW src/main/blackbox/blackbox.c:1637-1779`). **[INF]** Assume 3 only
  when the CLI says so. It does for this pilot.
- `error_rotation` was removed in 4.6 (#294, CHG). Rotation of roll/pitch error by the yaw gyro is always on
  (`FW src/main/flight/pid.c:766-786`). PROF still describes it as a toggle; that text is out of date.

### 2.2 Execution order

setpoint → PID → mixer → servos/motors → blackbox, once per PID loop (`FW src/main/fc/core.c:885-897`). Mode 3 runs
`rotateAxisError`, cyclic roll, cyclic pitch, offset bleed, offset flood, cyclic cross-coupling, yaw, then collective
and precomp (`FW src/main/flight/pid.c:1705-1736`). A gyro overflow resets all PID state (`pid.c:1739-1740`). [SRC]

### 2.3 Units

- **Mixer units.** "min_cyclic = 500; // = 6°" (`FW src/main/flight/mixer.c:605`); "Collective is an angle - scale it
  here so that 480°/s => 12°" (`FW src/main/fc/rc_rates.c:417-419`); the Configurator mixer tab uses scale 0.012
  (`CFG src/js/tabs/mixer.js:20-22`). So **1000 units = 12° of blade pitch** on cyclic and collective. [SRC] On cyclic
  this holds only after mixer calibration (MIXS). [INF]
- **Tail.** The Configurator shows the variable-pitch yaw limit as value × 24/1000, so 1000 = 24° and the default
  ±1250 = ±30° (`CFG src/js/tabs/mixer.js:23,424-425`). For a motorised tail the scale is ×0.1 %. [SRC]

### 2.4 Logged fields

All from `FW src/main/blackbox/blackbox.c:1304-1330` unless noted. [SRC]

| Field | Meaning | Units |
|---|---|---|
| `setpoint[0..2]` | `getSetpoint(i)`: after rates, setpoint boost and cyclic ring, **before** angle/horizon/rescue overrides (`pid.c:813-839`) | deg/s |
| `setpoint[3]` | collective | mixer units ×1000, 1000 = 12° |
| `gyroADC[i]` | `gyro.gyroADCf`: after decimator, RPM notches, LPFs, static and dynamic notches. **Before** the PID bandwidth LPF `gyro_cutoff` (`pid.c:841-853`) | deg/s |
| `gyroRAW[i]` | `gyro.gyroADCd`: after the 4th-order Bessel decimator (default 500 Hz), **before** the RPM notches. Not the sensor output | deg/s |
| `axisP/I/D/F/B/O[i]` | `pidData[i].X × 1000` | mixer units; 1 LSB = 0.012° on cyclic [INF] |
| `axisB` | written only if some B gain > 0 (`blackbox.c:553-562`) | |
| `axisO` | written only if roll or pitch O > 0; always 0 on yaw | |
| `mixer[0..3]` | stabilized roll, pitch, yaw, collective ×1000, **after** input clamp, swash ring, total pitch limit and swash phase (`mixer.c:260-324`); yaw is tail throttle on a motorised tail (`mixer.c:371-418`) | mixer units |
| `servo[n]` | servo output | µs |
| `motor[0]` | `motorOutput × 1000`: the governor output throttle through the default 1:1 mixer rule (`mixer.c:545,713`, `pg/mixer.c:57-59`); ceiling = `gov_max_throttle` × 10 in governed states, not rescaled (`FW src/main/flight/motors.c:97-100,292`) | 0.1 % throttle |
| `headspeed` | motor RPM × main gear ratio, filtered by `motor_rpm_lpf` (100 Hz Bessel default), **not** the governor's own 10 Hz PT2 (`motors.c:237,309-313`) | rpm |
| `govP/I/D/F`, `govSum` | governor terms ×1000; `govSum` is before voltage compensation (`FW src/main/flight/governor.c:258-269`) | 0.1 % throttle |
| `govTarget`, `govRequest` | slewed target and requested headspeed | rpm |
| `Vbat`, `Ibat` | battery voltage and current (`FW src/main/sensors/battery.c:128-171`) | 0.01 V, 0.01 A [INF from internals] |
| `EscV/EscI/EscRPM/EscThr/Tesc` | ESC telemetry, zeroed if stale; need `feature ESC_SENSOR` and `blackbox_log_esc` (`blackbox.c:1362-1368`) | |

**Header keys** available: rates, `rollPID/pitchPID/yawPID` as P,I,D,F,B (no O), `rollBW/pitchBW/yawBW` as
gyro_cutoff, dterm_cutoff, bterm_cutoff, `iterm_relax_type`, `iterm_relax_cutoff`, `error_limit`, `error_decay`,
`error_decay_ground`, `cyclic_coupling`, `hsi_gain`, `hsi_limit`, `pitch_compensation`, `yaw_precomp`,
`yaw_inertia_precomp`, `yaw_tta`, `yaw_stop_gain`, `govPID` (p,i,d,f,gain), filter settings, `looptime`,
`pid_process_denom`, `debug_mode`, `collectiveRange` (collective mixer input min,max, `blackbox.c:1775-1776`),
`minthrottle`, `maxthrottle` (`blackbox.c:1637-1779`). [SRC]

**Not in the header:** `pid_mode`, `iterm_relax_level`, setpoint boost, `cyclic_ring`, roll/pitch/yaw mixer input limits (collective is logged as `collectiveRange`),
`swash_ring`, `swash_pitch_limit`, swash phase, servo limits and speeds, `gov_mode`, `gov_headspeed`,
`gov_max_throttle`, governor limits and weights, motor poles, gear ratios. [SRC] The pipeline needs a CLI `diff all`
for these. [INF]

**Not in the standard fields:** the mixer saturation flag (not logged at all), the PID bandwidth-filtered gyro, the
cyclic cross-coupling term (debug `CROSS_COUPLING` only: [0] rollDeriv, [1] pitchDeriv, [2] rollComp×1000,
[3] pitchComp×1000, `pid.c:949-965`), the governor-filtered headspeed (debug GOVERNOR[2] only). [SRC]

### 2.5 Gain scaling

`Kx = SCALE × gain` (`FW src/main/flight/pid.c:593-613`), with scales from `FW src/main/flight/pid.h:37-59`. [SRC]

| Axis | P | I (and O) | D | F | B |
|---|---|---|---|---|---|
| Roll | 6.66666e-6 | 2e-4 | **0.1e-6** | 2.5e-5 | 0.1e-6 |
| Pitch | 6.66666e-6 | 2e-4 | **1.0e-6** | 2.5e-5 | 0.1e-6 |
| Yaw | 6.666666e-5 | 5e-4 | 1.0e-6 | 2.5e-5 | 1.0e-6 |

- Roll D is 10× weaker per unit than pitch D; the numbers are not comparable. [INF]
- `CROSS_COUPLING_SCALE 10e-6`, `PID_GAIN_MAX 1000` (`pid.h:35,55`). [SRC]
- 4.6 defaults (`FW src/main/pg/pid.c:47-52`): roll 50/100/0/100/0 O 50, pitch 50/100/40/100/0 O 50, yaw 80/120/10/0/0.
  These are the same as in 4.5.0: #292 (b3856e2e, merged 2025-05-20), which set D to 0/40/10 and O to 50, already
  shipped in `release/4.5.0` (`pg/pid.c:48-50`). A 4.5 and a 4.6 setup have no PID default differences. [SRC]

**Worked numbers at defaults** [INF, arithmetic from the table]:

| Term | Coefficient | Logged value | Physical |
|---|---|---|---|
| Roll/pitch P 50 | 3.33e-4 per deg/s | axisP ≈ 0.333 × error | 100 deg/s error ≈ 0.40° |
| F 100 | 2.5e-3 per deg/s | axisF = 2.5 × setpoint | 250 deg/s ≈ 7.5° |
| I 100 | 0.02 per deg of accumulated error | axisI = 20 × axisError | ceiling at 45° limit = 900 ≈ 10.8° |
| O 50 | 0.01 | axisO = 10 × axisOffset × collective | 90° limit, 12° collective ≈ 10.8° |
| Pitch D 40 | 4e-5 per deg/s² | axisD = 0.04 × (−gyro accel) | |
| Yaw P 80 | 5.33e-3 per deg/s | 100 deg/s error ≈ 533, ×1.2 CW stop gain ≈ 640 | ≈ 12.8° / 15.4° of tail pitch |
| Yaw I 120 | 0.06 per deg | 60° limit → 3600 | far beyond the ±1250 clamp: saturation, not `error_limit`, bounds yaw I |

### 2.6 Cyclic control law (roll, pitch; `FW src/main/flight/pid.c:1126-1261`) [SRC]

```
gyroRate  = LPF1(gyroADCf, gyro_cutoff)                    default 50 Hz
errorRate = setpoint − gyroRate
P = Kp·errorRate
D = Kd·difFilter(−gyroRate, dterm_cutoff)                  derivative on measurement, default 15 Hz
I: itermError = errorRate·relaxFactor; frozen if saturated and growing away from 0
   axisError = clamp(axisError + itermError·dT, ±error_limit);  I = Ki·axisError;  then decay
O: axisOffset = clamp(axisOffset + itermError·dT·offMod, ±offset_limit);  O = Ko·axisOffset·collective
F = Kf·setpoint
B = Kb·difFilter(setpoint, bterm_cutoff)                   default 15 Hz
pidSum = P + I + D + F + B + O    (+ unlogged cross-coupling;  pitch collective FF is inside F[pitch])
```

- `difFilter` is a bilinear differentiator with first-order LPF: `W=tan(π·fc/fs); a=(W−1)/(W+1); b=2·fs·W/(W+1)`
  (`FW src/main/common/filter.c:449-473`).
- pid.c never clamps `pidSum`; limits are in the mixer (section 2.11).
- Collective-indexed curves use `curve = |collective| × 0.8`, commented "Convert 0..15° => 0..1". The 16 points are one
  per degree from 0 to 15°. [SRC; per-degree reading is INF]

### 2.7 I-term relax, error decay, airborne detection

**Relax** (`pid.c:788-811`, limits `pid.c:664-671`) [SRC]: `factor = max(0, 1 − |sp − PT1(sp, cutoff)| / level)`.
Defaults RPY, level 40 deg/s, cutoff 10 Hz; level 10..250, cutoff 1..100. `iterm_relax_level` is CLI only
(`settings.c:1166`) and not in the header. The relaxed error feeds I and O charging; P is unaffected. [INF]

**Cyclic decay, airborne** (`pid.c:65-66,1166-1188`) [SRC]: rate = `(10/error_decay_time_cyclic) ×
curve(|coll|) × 0.08`, curve {12,13,14,15,17,20,23,28,36,49,78,187,250,250,250,250}; limit `error_decay_limit_cyclic ×
12 × 0.08` deg/s. The Configurator shows times ÷10, so the stored unit is 0.1 s (`CFG src/js/tabs/profiles.js:178-180`).

| Collective | I time constant at defaults (250, 12) [INF] |
|---|---|
| 0° | ≈ 26 s |
| 8° | ≈ 8.7 s |
| 10° | ≈ 4.0 s |
| ≥ 12° | ≈ 1.25 s |

Maximum decay speed ≈ 11.5 deg/s of accumulated error. **I is bled hard at high |collective|; HSI (O) takes over
there.** [INF]

**Ground decay** [SRC]: when not airborne, rate `10/error_decay_time_ground` per second, no limit, on axisError and
axisOffset (`pid.c:1170-1181`). Default 25 → τ 2.5 s. PROF: "prevent the helicopter from tilting during takeoff". [DOC]

**Yaw decay** [SRC]: gated on `isSpooledUp()`, not airborne; `error_decay_time_yaw` default 0 = no decay in flight;
forced to at least 0.2/s when yaw I = 0 (`pid.c:651-656,1313-1324`).

**Airborne** (`FW src/main/flight/airborne.c:78-130`, `FW src/main/pg/rx.c:80`) [SRC]: liftoff needs armed, spooled up,
and one of: stick peak above `rc_threshold` (default 2.5 % cyclic/yaw, 10 % collective), cos(tilt) < 0.80, rescue or
failsafe. Landing uses threshold/1500 and cos < 0.90. **[INF]** A centred-stick, low-collective hover can stay
"landed" and see ground decay (axisI bleeding with τ ≈ 2.5 s).

### 2.8 HSI (offset) bleed and flood

- **Charge**: `offset_charge_curve` {0,100,100,100,100,100,95,90,82,76,72,68,65,62,60,58}/100, signed by collective.
  **Decay** rate {250×5,30,5,0…}×0.04/s, limit {12,12,10,8,6,4,2…} (`pid.c:68-75,1196-1236`). [SRC]
  **[INF, table lookup with index = |collective| in degrees]** τ = 0.1 s for |coll| ≤ 4°, 1.2/s at 5°, 0.2/s at 6°,
  exactly 0 from 7°. The decay is also capped by the limit curve (deg/s), so a large offset decays linearly, not with
  τ 0.1 s. HSI only persists at high collective.
- **Bleed** (`pid.c:1020-1068`) [SRC]: cyclic setpoint magnitude /300 indexes a bleed curve that moves offset back
  into I along the stick direction. **[INF]** starts at ≈ 120 deg/s, 10/s above ≈ 180 deg/s.
- **Flood** (`pid.c:1070-1124`) [SRC]: from just above 2° collective (20×0.08 at 3°) [INF], I error moves into offset, curve
  {0,0,0,20,50,100,180,220…}×0.08, scaled by a relax factor from high-passed collective (3 Hz, level 40). Skipped if O
  or I is 0.
- Only the HSI page names these curves as parameters (`offset_bleed_rate_curve`, `offset_bleed_limit_curve`,
  `offset_charge_curve`); PROF does not mention them. Since #285 (60b5d8c8, merged 2025-04-14, shipped in 4.5.0) they
  are hardcoded (`pid.c:65-75`). [SRC] The HSI page has been out of date on this point since 4.5.

### 2.9 Cross-coupling and pitch precomp

- Cyclic cross-coupling (`pid.c:700-707,949-965`) [SRC]: HPF(pitch setpoint, cutoff/10 Hz) × gain × rotSign × −10e-6
  added to roll `pidSum`; roll→pitch scaled by `ratio/−100`. Defaults 50 / 0 / 25 (2.5 Hz). Not in the standard
  fields; logged with debug_mode `CROSS_COUPLING` (section 2.4). Otherwise `mixer[0] − Σaxis[0]` estimates it, valid
  only while the mixer is unsaturated (no clamp, ring or pitch limit) and swash phase = 0. [INF]
- Pitch collective FF (`pid.c:402-409,937-942`): `collective × gain/500` into `F[pitch]` and `axisF[1]`. Default 0,
  range 0..250. [SRC]

### 2.10 Tail control law and precomp (`pid.c:1263-1350`, `pid.c:883-935`) [SRC]

```
stopGain = transition(errorRate, −10, +10, CCW_gain, CW_gain)/100   // linear blend within ±10 deg/s
P = Kp·errorRate·stopGain        // stop gain multiplies P only
D = Kd·difFilter(−gyroRate)      I: as cyclic, no O     F = Kf·sp     B = Kb·difFilter(sp)
mainPrecomp   = LPF1((|coll|·collFF/100 + |cyclic|·cycFF/100)², yaw_precomp_cutoff)
torquePrecomp = difFilter(PT2_20Hz((headspeed + sign·yawSp/6)/3000), inertia_cutoff/10) · inertia_gain/200
F[yaw] += (mainPrecomp + torquePrecomp) · rotationSign · spoolUpRatio
```

- **`axisF[2]` includes all yaw precomp.** With yaw F = 0 it is pure precomp. [SRC]
- Sign: "rcCommand[YAW] CW direction is positive, while gyro[YAW] is negative" (`FW src/main/flight/setpoint.c:291-292`).
  Which physical stop uses which stop gain must be checked against the sign of `gyroADC[2]` in a real log before
  any recommendation. [INF]
- Defaults: stop gains CW 120 / CCW 80 (range 25..250), collective FF 60, cyclic FF 10, cutoff 5 Hz, inertia gain 0,
  inertia cutoff 25 (2.5 Hz) (`FW src/main/pg/pid.c:43-75`, `settings.c:1118-1145`). Same as 4.5.0 (#292 shipped in
  4.5.0, `release/4.5.0 pg/pid.c:75`); collective FF 30 / cyclic FF 0 are pre-4.5 values. [SRC]
- **[INF]** At the default collective FF and 12° collective, precomp ≈ 0.36 units (≈ 29 % of the ±1.25 clamp).
- Collective impulse FF is gone from the 4.6 CLI; the Configurator hides it at API ≥ 12.8
  (`CFG src/js/tabs/profiles.js:572-582`). PROF still shows it and says it "is generally overcompensating". [SRC/DOC]

### 2.11 Saturation

- Mixer input clamp to min/max (default ±1250 on all stabilized inputs, `FW src/main/pg/mixer.c:49-55`), swash ring
  (default 100 → circular limit, `mixer.c:619-622`), total pitch limit, or a servo reaching its travel limit
  (`FW src/main/flight/servos.c:243-253`) all call a saturate function. The flag lasts `MIXER_SATURATION_TIME 5`
  mixer cycles (`FW src/main/flight/mixer.h:55`). [SRC]
- A servo at its limit saturates **every mixer input mapped to it**: on a 120° swash, collective at a servo limit
  also freezes cyclic I and O growth (`mixer.c:145-152,681-691`). [SRC]
- While saturated, I and O stop growing away from zero; unwinding is allowed. Servo speed limiting and motor outputs
  (including a motorised tail) never set the flag. [SRC]
- The flag is not logged. [SRC] Infer it from `|mixer[i]| ≥ 0.98 × limit`, a servo pinned at an extreme, or the ring
  norm reaching 1. [INF]

### 2.12 Rates and setpoint

For `rates_type = ROTORFLIGHT` only (the 4.6 default, `pg/rates.c:35`; read `rates_type` from the header):
`rate = rc_rate×5 × (x(1−expo) + x^(srate/16+2)·expo)` (`rc_rates.c:368-381`). BETAFLIGHT, RACEFLIGHT, KISS, ACTUAL
and QUICK use different curves (`rc_rates.c:383-410`); pilots who restored a diff may still be on ACTUAL (NOTES). Defaults 250/250/400 deg/s, collective
≈ 12.5° (`FW src/main/pg/rates.c:35-67`). Setpoint pipeline order: stick → PT3 smoothing → yaw deadband → response
time PT1 (cutoff 500/response_time Hz) and accel limit → setpoint boost → rates → cyclic ring (default 150 %) → cap
2000 deg/s (`setpoint.c:177-353`). The Rates-tab setpoint boost **is** visible in `setpoint`; the PID B term is in
`axisB`. Two different boosts. [SRC; the distinction is INF]

---

## 3. The governor in 4.6

The governor was rewritten for 4.6 (#314, #343, #353; REL). Advice from before mid-2026 that mentions
PASSTHROUGH/STANDARD/MODE1/MODE2 applies to 4.5 ([COM] RCG-164, HF-974843). NOTES: "Type set gov_mode = ELECTRIC
to configure an electric motor if you were using the Rotorflight governor." [DOC]

### 3.1 Modes

`OFF, LIMIT, DIRECT, ELECTRIC, NITRO` (`FW src/main/pg/governor.h:25-31`, `settings.c:474-476`). [SRC]

| Mode | What it does | Source |
|---|---|---|
| OFF | output = input throttle | GOVTAB |
| LIMIT | passthrough with idle, min and max | GOVTAB |
| DIRECT | "input throttle is used directly, but with limits and slow spoolup features. The speed governing function is disabled. … intended for use with ESCs that have their own built-in governor … does not require an RPM signal" | GOVTAB |
| ELECTRIC | full PID governor; "Requires an RPM signal from the ESC or a separate RPM sensor" | GOVTAB (the "from the ESC" wording is misleading for ESC serial telemetry, which 4.6 refuses; see below) |
| NITRO | same for IC engines, magnetic RPM sensor | GOVTAB |

- The **fast**-source requirement comes from the source and RPMM, not GOVTAB. ELECTRIC/NITRO without a **fast** RPM source (DShot telemetry or the frequency sensor) disable arming and drop the
  mode to NONE (`governor.c:1627-1634`, `motors.c:184-187`). ESC-telemetry RPM "is at a refresh frequency that is too
  slow to be used for filtering or governing" (RPMM). [SRC/DOC]
- **DIRECT in the logs** [SRC]: output is `constrain(throttleInput, min, max)` slewed (`governor.c:674-691`).
  `govI` and `govSum` stay 0 (they are written only by spoolup, PID and fallback control, `governor.c:887-901,950-957,988`).
  `govP/D/F` are computed and logged but unused (`governor.c:620-630,1442-1444`). `govTarget` freezes at the headspeed
  when spoolup ended (`governor.c:648`). **[INF]** Never read governor tuning from `govP/D/F/Target` in a DIRECT log.
- Zero ramp times (`gov_*_time = 0`) remove the slew limit entirely (`governor.c:1603-1609`,
  `FW src/main/common/maths.h:235-273`). [SRC]

**Throttle types** [SRC] (`governor.c:436-461`): NORMAL (requested headspeed = `gov_headspeed`), SWITCH (request =
throttle × `gov_headspeed`, forced to NORMAL below ELECTRIC), FUNCTION (three bands: idle, auto, max). NORMAL and
SWITCH need a full-resolution channel; ELRS wide channels are unsuitable (GOVTAB) [DOC]; a low-resolution channel made
headspeed jump 2400 → 3000 between 66 % and 67 % ([COM] HF-951299).

**States** (`FW src/main/flight/governor.h:27-38`) [SRC]: 0 OFF, 1 IDLE, 2 SPOOLUP, 3 RECOVERY, 4 ACTIVE, 5 HOLD,
6 FALLBACK, 7 AUTOROTATION, 8 BAILOUT, 9 BYPASS. Every change is blackbox event 50 `GOVSTATE`
(`blackbox.c:1904-1908`). The viewer maps the 4.6 table in `js/flightlog_fielddefs.js:900`.

### 3.2 Parameters (defaults, ranges, scaling)

Global (`FW src/main/pg/governor.c:30-49`, ranges `settings.c:956-973`, scaling `governor.c:1644-1668`) [SRC]:

| Parameter | Default | Meaning |
|---|---|---|
| `gov_startup_time`, `spoolup_time`, `tracking_time`, `recovery_time`, `spooldown_time` | 200, 100, 50, 30, 30 | tenths of a second for a 0→100 % **throttle** ramp (`governor.c:1603-1609`); 0 = unlimited. Tracking (ACTIVE) and PID spoolup slew the **target headspeed** at max(`gov_headspeed`, motorRPMK) per param/10 s (`govCalcHeadspeedRate`, `governor.c:562-565,904,973`), so a target change of `gov_headspeed` completes faster than param/10 s once RPMK > `gov_headspeed` |
| `gov_handover_throttle` | 25 % | range 10..100 |
| `gov_throttle_hold_timeout` | 50 (5 s) | |
| `gov_autorotation_timeout` | 15 (15 s) | autorotation enabled iff > 0. **Conflicts with GOVTAB** ("disabled unless this timeout is explicitly configured"): with the defaults (15, `gov_auto_throttle = 0`) a throttle drop below handover (not to off) from ACTIVE or FALLBACK goes to AUTOROTATION (GOVSTATE 7), not HOLD |
| `gov_rpm_filter`, `gov_pwr_filter`, `gov_ff_filter` | 10, 5, 5 Hz | PT2 on RPM, Vbat, total FF |
| `gov_d_filter` | 50 → 5.0 Hz | differentiator bandwidth |
| `gov_tta_filter` | 0 | 0 = pass-through |

Per profile (`FW src/main/pg/pid.c:106-126`, ranges `settings.c:1202-1226`, scaling `governor.c:1559-1590`) [SRC]:

| Parameter | Default | Internal |
|---|---|---|
| `gov_headspeed` | 1000 rpm | full headspeed, clamped 100..50000 |
| `gov_gain` (K), `p`, `i`, `d`, `f` | 40, 40, 50, 0, 10 | K /100, Kp /10, Ki /10, Kd /1000, Kf /100 |
| `gov_p/i/d_limit` | 20 / 95 / 20 % | ± of throttle |
| `gov_f_limit` | 100 % | F clamped to [0, limit]: **F is never negative** |
| `gov_min_throttle`, `gov_max_throttle` | 10, 100 % | |
| `gov_collective/cyclic/yaw_ff_weight` | 50 / 10 / 10 | /100 |
| `gov_collective_curve` | 20 | exponent /10, so \|coll\|^2 |
| `gov_tta_gain`, `gov_tta_limit` | 0, 20 % | |
| `gov_fallback_drop` | 10 % | |
| `gov_dyn_min_throttle` | 80 % | |
| `gov_use_fallback_precomp / pid_spoolup / voltage_comp / dyn_min_throttle` | OFF | cleared below ELECTRIC (`governor.c:1509-1515`) |

4.5 defaults differed: f_limit 50, collective weight 100, tracking 20, recovery 20, handover 20, autorotation timeout
0 (`RF-4.5.x` branch `pg/pid.c`, `pg/governor.c`). [SRC]

### 3.3 Control law (ELECTRIC, NITRO) [SRC]

```
currentHS  = PT2(rawMotorRPM, gov_rpm_filter) × mainGearRatio                     governor.c:573-582
error      = (targetHS − currentHS)/gov_headspeed + ttaAdd                         governor.c:621
P = K·Kp·error      C = K·Ki·error·dT      D = K·Kd·difFilter(error)             governor.c:622-630
F = PT2( K·Kf·(collW·|coll|^curve + cycW·|cyclic| + yawW·|yaw|), gov_ff_filter )  governor.c:465-488
ACTIVE:  clamp P, I, D to ±limits; F to [0, f_limit]
         on entry: I = throttle/vcomp − (P + D + F)                               bumpless, governor.c:932-977
         pidSum = P + I + C + D + F;  throttle = pidSum × vcomp
         I += C only if throttle inside (dynMin, max) or C pushes back inside      anti-windup
         output = clamp(throttle, dynMin, max)
         targetHS slewed toward requestHS at max(gov_headspeed, RPMK)/(tracking_time/10) per s
```

- **Voltage compensation** (`governor.c:490-509,1556`): gain = clamp(cells × 3.70 V / PT2(Vbat), 0.80, 1.20); only with
  the flag set, ELECTRIC mode and `VOLTAGE_METER_ADC` as source. **[INF]** With ESC-telemetry voltage it is silently off.
  **[INF]** Unsaturated, `motor[0]/govSum ≈ vcomp`; a ratio of exactly 1 means voltage compensation is off.
- **Motor constant** (`governor.c:536-560`): `motorRPMK = EWMA_0.05Hz(HS/throttle)`, estimated headspeed at 100 %.
  Dynamic minimum throttle = max(min, targetHS/RPMK × dyn_min).
- **Spoolup** (`governor.c:875-930,1139-1148`): output = slew(clamp(throttleInput, `gov_idle_throttle`,
  `gov_max_throttle`)) at the spoolup rate, i.e. toward the input throttle, which is 100 % only for SWITCH above
  handover or FUNCTION RUN (`governor.c:436-461,905-915`). With NORMAL and a channel below 95 % of max, only the
  headspeed condition can end spoolup. If `gov_use_pid_spoolup` is ON and input and output exceed handover, the PID
  drives throttle with the target slewed toward the request (`governor.c:877-905,918-925`). ACTIVE when
  governor-filtered HS > 0.99 × `govRequest` **or** output > 0.95 × `gov_max_throttle`; back to IDLE if throttle drops
  below handover or RPM is lost.
- **Fallback** (`governor.c:979-995,1163-1164`): entered from ACTIVE when `motorRPMGood` clears, or forced by the
  BOXGOVFALLBACK mode switch (`isForcedFallback`, `governor.c:591`); throttle = (I + F_fb) × vcomp ×
  (1 − `gov_fallback_drop`/100), drop constrained to 0..50 %, with F_fb = clamp(F, 0, f_limit) only if
  `gov_use_fallback_precomp` = ON, else 0 (the default, `pg/pid.c:106`; also cleared below ELECTRIC). By default the
  logged `govF` is 0 in FALLBACK. RPM is bad when HS ratio < 1 % or raw RPM < 10 at throttle > 10 % (`governor.c:59-60,589`),
  or on a glitch: `|raw − PT2(raw, gov_rpm_filter)| > 0.25 × gov_headspeed/gear` or `raw > 2 × gov_headspeed/gear`
  (`governor.c:54-56,573-606,1596-1597`). It is restored after HS/fullHS > 5 % and raw RPM > 0 hold, glitch-free,
  for more than 200 ms (`governor.c:594-606`).
- **Governor outputs used elsewhere**: throttle mixer input (`mixer.c:541-545`), spoolup ratio scales yaw precomp
  (`pid.c:886`), `isSpooledUp` switches yaw decay (`pid.c:1313`), full-headspeed ratio scales the dynamic gyro LPF
  (`FW src/main/sensors/gyro.c:471`).

**`govRequest`** = `gov_headspeed` (NORMAL) or throttle × `gov_headspeed` (SWITCH). **`govTarget`** (ELECTRIC/NITRO)
is slewed toward `govRequest` in ACTIVE and PID spoolup; **held at its last value in FALLBACK** (`governor.c:979-995`);
0 in THROTTLE_OFF and whenever the throttle input is off in IDLE, HOLD, AUTOROTATION and BYPASS
(`governor.c:636,1015,1046`); otherwise set to the governor-filtered headspeed in IDLE, HOLD, non-PID SPOOLUP, RECOVERY,
BAILOUT, AUTOROTATION and BYPASS (`governor.c:633-650,1012-1076`). [SRC] So in FALLBACK the error against the frozen
target is meaningful for G1–G4, and in OFF the target is 0.

### 3.4 Precompensation and TTA

- Precomp weights feed F directly; `gov_yaw_ff_weight` "Usually 20..100" (MSG). [DOC]
- TTA (`governor.c:511-534,1523-1541`, `mixer.c:332-338`) [SRC]: `TTA = PT2(mixer yaw) × spoolupRatio × rotSign ×
  tta_gain/−125` (÷ K·Kp in ELECTRIC). Headroom ELECTRIC = `2·max(1 + tta_limit/100 − HS/fullHS, 0)`, DIRECT =
  `tta_limit/100`. `ttaAdd = clamp(TTA, 0, headroom)` is added to the governor error, raising the effective target.
  `swash_tta_precomp` divides collective by `(1 + ttaAdd × precomp/100)²`. Enabled only with DIRECT/ELECTRIC, gain > 0
  and limit > 0; **the code does not check `tail_rotor_mode`**.
- MSG: `gov_tta_gain` "Usually 50..150"; `gov_tta_limit` "Usually 20..50%". [DOC]
- **[INF] Probable 4.6.0 bug**: DIRECT with TTA does `throttle += throttle + throttle * gov.ttaAdd`
  (`governor.c:686`), doubling throttle before the max clamp. Irrelevant unless `gov_tta_gain > 0` in DIRECT.
- CLIREF calls TTA "throttle-to-angle" and misdescribes `gov_idle_throttle` and `gov_auto_throttle`. Trust the source. [DOC error]

### 3.5 Debug modes for governor work

GOVERNOR (ELECTRIC/NITRO only): [0] request, [1] target, [2] governor-filtered HS, [3] sum, [4..7] P,I,D,F
(`governor.c:362-372`). GOV_MOTOR: [0] instantaneous RPMK, [1] filtered RPMK, [2] throttle estimate, [3] dynamic min,
[5] vcomp. TTA: [0..3]. [SRC] GOVT asks for debug GOVERNOR at 1 kHz while tuning. [DOC]

---

## 4. Cyclic: symptom, signature, cause, fix

"Signature" columns are [INF] unless marked; fixes carry their source.

| Symptom | Log signature | Likely cause | Documented fix |
|---|---|---|---|
| Bounce-back after flip/roll stop | gyro crosses zero after setpoint returns to ≈ 0; `axisI` charged in the flip direction pushes back | FF too high, relax too weak, B too high | "stops and bounces back → decrease the FF gain" (FF); relax: "start high and decrease until bounce back disappears" (PROF); "Too high on B-gain results in unwanted oscillations at stops" (TUNE) |
| Keeps rotating after stop | gyro lags setpoint at the stop; large same-sign `axisI` during continuous flips | FF too low | "did not stop cleanly and kept moving a little bit → increase the FF gain" (FF); set FF "so that … Integral (I) remains near 0 in full stick flips and rolls" (TUNE) |
| Rate below setpoint in rolls | `gyroADC` < `setpoint` in steady rolls, `axisI` winding up | FF too low, or saturation | add FF until gyro reaches setpoint ([COM] HF-965481); check saturation first |
| Uneven flip rate, "not wanting to finish" | variance of setpoint − gyro in steady phases; `axisI` at ±Ki × error_limit × 1000 | I too low, or I pinned | raise I (PROF) |
| Hover drift | non-zero, slowly trending mean `axisI` at low collective | I too low, or ground decay while "landed" | raise I; longer cyclic decay "makes hovering more stable" (MSG `profilesErrorDecay*Help`) |
| Slow oscillation at stops, pitch pumps, tick-tocks | 0.5–3 Hz in gyro after stops; `axisI` oscillating in phase | I too high or P too low | "lower the I-gain or raise the P-gain" (TUNE); try I-relax (TUNE). Best seen in "pirouetting long pitch pumps" (TUNE) |
| Fast wobble | 5–25 Hz peak in gyro, `axisP`/`axisD`; growth after taps | P or D too high, or D driven by noise | back off the last raised gain; "D-gain dampens oscillations caused by P" (TUNE); keep D cutoff "around 20Hz" (PROF) |
| Hot servos, noisy D | HF RMS (> 30 Hz) of `axisD`, `servo[]`; gyro peaks at rotor harmonics | D amplifying vibration | filters first; "If you do not have filters enabled … do not use Derivative. This can result in hot Motors and Servos" (TUNE); D "VERY sensitive to high frequency gyro vibrations … magnifies by 10x to 100x" (MSG `profilesDerivativeHelp`) |
| Sluggish initial response | lag setpoint→gyro (cross-correlation), `axisB` ≈ 0 | B too low, response_time too high | raise B, not FF (FF); "too high [response time] could cause significant input delay" (RATES) |
| Roll tilt when only elevator is moved; disk rotates at tick-tock stops | roll gyro correlated with d(`setpoint[1]`)/dt while roll setpoint ≈ 0; `mixer[0] − Σaxis[0]` is the applied compensation | cyclic cross-coupling | tune `cyclic_cross_coupling_gain` from low, harder dampers need less (XC); constant coupling: swash phase +2..+10° (XC, MIXT) |
| Nose pitches up in climbs and pumps | pitch gyro vs collective; `axisI[1]`, `axisO[1]` correlated with collective | drag-induced pitching | raise `pitch_collective_ff_gain`, "relatively low value to be conservative" (PROF) |
| Dive on negative collective in fast forward flight; snaking in fast side tick-tocks | pitch error correlated with sign(collective) at \|coll\| ≥ 5°; `axisI` charging/discharging at each reversal | HSI too low | "Should the model dive, increase the HSI Offset Gain" (MSG `profilesOffsetGainHelp`) |
| Wobble after elevator jabs at high collective; bobble at tick-tock end | `axisO` stepping at each collective reversal | HSI too high | "decrease the HSI Offset Gain" (MSG); HSI: "Too high might result in bobble during stops" |
| Collective bobbing on fast elevator | swash servos diverge while `mixer[3]` constant; servo slew vs datasheet | unequal servo travel speed | servo speed equalisation in ms/60°; "using the value from the servo datasheet is always safe" (SERVO) |
| Tips over on takeoff | `axisI` accumulating before the airborne transition | ground decay off or too slow | ground error decay (PROF) |
| Rate capped, flat tops | `|mixer[0/1]|` at cyclic max (default 1250 = 15°), servo at a flat extreme, `axisI` frozen while error persists | mechanical/mixer limits, not gains | mixer limits, swash ring, servo min/max, check binding (MIXT); "12 deg has shown to be a good starting point" for cyclic ([COM] RCG-20); flat tops = saturation not PID error ([COM] RCG-59) |
| I grows until it hits a limit on one servo | one servo output drifting to max, craft not reacting | servo glitch or failure | [COM] RCG-65: inspect the servo |
| Kick when a profile is switched in flight | transient at the switch event | I and O are no longer reset on profile change (#418, `pid.c:719-723`) | [INF] expected in 4.6; judge profiles on data away from switches |

**Conflicting frequency bands** [DOC]: TUNE says I oscillation is 0.5–1 Hz and P/D 5–8 Hz; PROF says I 1–3 Hz and
P ≈ 20 Hz. **[INF]** Detect in bands (0.5–3 Hz for I-type, 5–25 Hz for P/D-type), report the measured frequency,
and do not name a term from frequency alone.

---

## 5. Tail: symptom, signature, cause, fix

| Symptom | Log signature | Likely cause | Documented fix |
|---|---|---|---|
| Slow wag (≈ 0.5–3 Hz) | `gyroADC[2]` oscillating with `setpoint[2]` ≈ 0; `axisI[2]` large, slow, in phase | yaw I too high or P too low; or mechanical binding | lower I or raise P (TUNE); "Slow wags are almost always mechanical in nature" ([COM] RCG-140); lowering I cured a ≤ 2 Hz wag on a Goblin 420 ([COM] RCG-161) |
| Fast wag (5–20 Hz), funnels and hurricanes | `axisP[2]`/`axisD[2]` alternating, decaying ring after stops | yaw P or stop gain too high; D too high or noisy | lower P ([COM] HF-970331); "Too high may cause fast oscillations" for stop gains (PROF); decaying CCW-stop ring: lower yaw D cutoff 20 → 15 Hz ([COM] HF-965481) |
| Wag that survives any gain change | wag frequency unchanged across gain sets | mechanical: slop, sticky slider, bearings, tail centre | "mechanical issue … cannot be tuned out" (PROC45); tail thrust bearings in the wrong order ([COM] RCG-140); 1° extra right-rudder pitch at centre caused a wag ([COM] RCG-141) |
| Wag that changes with headspeed | same gains, wag amplitude/frequency differ between profiles | belt tail loop gain rises with headspeed | "A belt or tube driven tail generates more mechanical gain as the headspeed increases and might need lower PIDs for higher headspeeds. However, a tail with it's own motor ... might need higher PIDs for higher RPMs." (OLDWIKI `Tuning-Introduction`, RF1-era documentation) |
| Wag coherent with headspeed | `headspeed`/`govSum` coherent with `gyroADC[2]` at the wag frequency | governor P too high | "the tail can exhibit oscillation if the gov gain is too high, or the gov bandwidth is too high" (OLDWIKI `Tail-tuning`, RF1-era, legacy official); "a governor with too high of a 'P' gain" causes wag ([COM] RCG-141); counter-example with flat RPM during wag ([COM] RCG-107) |
| Stop overshoots / bounces | overshoot past zero after \|`setpoint[2]`\| drops; separately for each direction | stop gain too high, FF too high, pilot's stick rebound | lower stop gain, add D ([COM] RCG-59, HF-970331); stops "bounce back" → lower FF (FF); plot yaw rcCommand, raise yaw deadband 2 → 5 ([COM] HF-970331) |
| Stop creeps into target | slow approach to zero, `axisI[2]` wound up | FF too low | raise yaw FF ([COM] HF-970331); counter-report: tail "doesn't like feed forward", ≤ 5 ([COM] HF-950165). Start at 0 on the tail (FF) |
| CW and CCW stops differ | asymmetry of overshoot between the two stop directions | stop gains unbalanced | tune CW and CCW separately, "Typical range 50..200" (MSG); ratio matters more than the absolute ([COM] RCG-59) |
| Kick on collective punches | yaw error pulse aligned with d(`mixer[3]`)/dt; `axisI[2]` absorbs it | collective FF wrong | "Higher gain results in CW response, lower gain results in CCW response" (CW rotor), "advised to use a lower value" (PROF). Correct precomp leaves `axisI[2]` flat across collective steps ([COM] RCG-55) |
| Kick lagging the collective by 30–100 ms | as above but delayed | precomp cutoff too low (5 Hz → τ 32 ms), or torque change from headspeed | [INF] check `yaw_precomp_cutoff`; inertia precomp (PROF, no procedure given) |
| Yaw at pitch/roll onset | yaw error at cyclic onset with `setpoint[2]` ≈ 0 | cyclic FF | "a high cyclic value results CW motion … a low value results CCW motion (for CW main rotor)" (PROF) |
| Blowout, loss of authority | `|mixer[2]|` at its limit for more than a few ms; `axisI[2]` frozen while error persists in the torque direction; often high `mixer[3]`, headspeed dip | insufficient tail authority | pitch limits and calibration (MIXS); bigger tail blades or higher tail speed; detune the governor (GOVT); precomp cannot add authority [INF] |
| Tail poor at low headspeed | wag or stop bounce only on the lowest-headspeed profile | low tail authority | maximise P/D and stop gains, then bigger blades or a speed-up pulley ([COM] HF-970331, RCG-87) |
| Motorised tail snaps round flying backwards | `mixer[2]` (throttle) at idle or 0 while yaw error is with-torque | tail motor authority | raise TTA "in increments of 10" (TTA) |
| Constant yaw offset in `axisI[2]` | steady non-zero `axisI[2]` in hover | tail centre trim / zero pitch wrong | centre calibration "helps the feedforwards to work correctly" (MIXS); offset centre shifts steady `axisI[2]` ([COM] HF-950165) |

Fireball-specific Rotorflight tail gains do not exist in any source read. The only Fireball tail data is Spirit-era:
fast wag at high headspeed and slow wag at low headspeed with one gain, and a "death wag at 90% throttle" ([COM]
SPIRIT). **[INF]** Consistent with the belt-tail gain-vs-headspeed statement above.

Community yaw gain reports vary widely (700 class P70/I120/D20, 380+ ≈ P85/I150/D30, Goblin 420 P95/I70/D15, Protos 380
P68/I92/D10 F0; [COM] HF-965481, HF-950905, RCG-161, RCG-102). "Unlike most FBLs in Rotorflight P values are small and
I values tend to be large" ([COM] HF-965481). Do not copy other pilots' gains ([COM] HF-970331).

---

## 6. Governor, ESC and power: symptom, signature, cause, fix

| Symptom | Log signature | Likely cause | Documented fix |
|---|---|---|---|
| Headspeed droops on collective punches | droop % = (`govTarget` − `headspeed`)/`govTarget` peaks at collective rise; `govF` small or at `f_limit` | governor F too low, or throttle saturated | "F-gain too low … headspeed drops quite a bit when doing pitch pumps"; raise F in steps of 10 (GOVT) |
| Headspeed overshoots on load changes | headspeed above target at collective onset or unload | F too high | "headspeed temporarily too high" → lower F (GOVT) |
| Slow hunting during or after pumps | low-frequency periodicity in headspeed error and `govI` | governor I too high | raise until it "plays up", then cut by 1/3; I steps of 25 (GOVT) |
| Fast oscillation / surge | higher-frequency peak in headspeed error and `govP` | governor P or master gain too high | "head speed will oscillate or surge" → lower (FLYR); cut P by 1/3 (GOVT) |
| Bog under load | slow recovery after droop | P too low | "bog or droop under load" (FLYR) |
| No headroom | `motor[0]` at its ceiling `gov_max_throttle` × 10 (e.g. 600/700/800 with the 09-04 values) while `headspeed` < target; `govSum` > `motor[0]`/vcomp | target headspeed not reachable: gearing, cells, battery | "Recommended throttle is 75–85% with 15–25% reserved for governor authority" (FLYR); KV sized for 80 % ([COM] RCG-145); I stops integrating at max (`governor.c:966-967`) |
| Rising throttle over the pack | steady-hover `motor[0]` vs `Vbat` trend | battery sag | voltage compensation (GOV45, 4.5 MODE2); 4.6: `gov_use_voltage_comp`, needs ADC voltage (`governor.c:1556`) |
| Sag masked | headspeed flat, throttle rising, `Vbat`/cell low | governor hides a flat pack | [COM] RCG-20: "the governor will probably hide the dip"; Hobbywing soft cutoff cuts RPM by 50 % ([COM] RCG-20) |
| Tail kicks on governor torque | yaw error aligned with governor throttle steps | governor stronger than tail | "detuning the governor a bit, or reducing the collective range … bigger tail rotor blades, or a higher tail rotor speed" (GOVT); lower ESC "Starting Torque" for spool-up whip (FLYR) |
| RPM dropouts, fallback | `GOVSTATE` 6 events; `headspeed` zero; raw RPM deviating from the governor-filtered (10 Hz PT2) RPM by > 25 % of full HS (motor side), or raw RPM > 2 × full HS (`governor.c:591-592`); from the log only a proxy, since the logged `headspeed` is filtered differently; headspeed far above any target | noisy or lost RPM signal | firmware falls back with `gov_fallback_drop` (`governor.c:979-995`); one pilot went back to the ESC governor after an RPM dropout shutdown ([COM] RCG-129) |
| Headspeed wrong by a constant factor | vibration 1P line ≠ `headspeed`/60 | `motor_poles` or gear ratio wrong | "accurate gear ratio is essential" (MOTORS); 17T vs 18T pinion gave 2400 logged vs 2540 real ([COM] RCG-25) |
| Throttle stalls at ≈ 36 % in spoolup | throttle plateau, RPM not following | ESC governor still on under RF ELECTRIC | set the ESC to airplane / external-governor mode ([COM] RCG-167) |
| Limit-cycling with ESC governor | slow oscillation, `govI` wandering while headspeed flat, then jumps | double governing | DIRECT for ESCs with their own built-in governor (GOVTAB); FlyRotor: set ESC to "RF Gyro Governor" (FLYR); Hobbywing: use "fixed-wing" with an external governor (HWG) |
| Headspeed jumps with a small throttle move | step changes in `govRequest` | low-resolution throttle channel | full-resolution channel (GOVTAB, [COM] HF-951299) |
| Autorotation entered unexpectedly | `GOVSTATE` 7 when throttle dropped below handover | 4.6 default `gov_autorotation_timeout = 15` with `gov_auto_throttle = 0` makes `isAutorotation()` always true (`governor.c:389-392`) | [INF] set the timeout to 0 if autorotation bailout is not wanted; GOVTAB says it is off unless configured, which conflicts with the source |

Accuracy reported by users: "±30 rpm on my 1920 headspeed" (≈ ±1.6 %, Specter 700; [COM] HF-913037 p6); an
ungoverned pack sags ≈ 10 % (2050 → 1850 rpm; [COM] RCG-140). No source gives a Rotorflight droop tolerance.

---

## 7. Filters and vibration: symptom, signature, cause, fix

### 7.1 Signal chain and defaults (4.6) [SRC]

Sensor → 4th-order Bessel decimator at `gyro_decimation_hz` (default changed to 500 Hz in 4.6, #405; decimator changed to a 4th-order Bessel in #287) → RPM notches → LPF2 →
LPF1 → static notch 2 → notch 1 → dynamic notch → `gyroADCf` (`FW src/main/sensors/gyro_filter_impl.c:20-75`,
`FW src/main/common/filter.h:38-42`). The PID then applies the per-axis bandwidth LPF (`gyro_cutoff`) and D/B
differentiators (section 2.6).

| Parameter | Default | Source |
|---|---|---|
| `gyro_lpf1_type` / `static_hz` | FIRST_ORDER / 100 Hz | `FW src/main/pg/gyro.c:29-30` |
| `gyro_lpf2_type` / `static_hz` | NONE / 50 | `pg/gyro.c:34-35` |
| dynamic LPF1 | off (min = max = 0); cutoff scales with headspeed ratio | `gyro.c:466-481` |
| `dyn_notch_count` / Q / min / max | 6 / 2.5 / 20 / 240 Hz | `FW src/main/pg/dyn_notch.c:33-37` |
| dynamic notch | on by default on F405, F7X2, F745, G47X, H743; off below 1 kHz PID rate | `FW src/main/target/STM32_UNIFIED/target.h:194,309,356,406,459`; `FW src/main/flight/dyn_notch_filter.c:89,164` |
| `gyro_rpm_notch_preset` / `min_hz` | 2 (medium) / 20 Hz | `FW src/main/pg/rpm_filter.c:28-31` |
| `roll_/pitch_/yaw_gyro_cutoff` (struct field `gyro_cutoff`) | 50 / 50 / 100 Hz | `FW src/main/pg/pid.c:67`, CLI `settings.c:1124-1134` |
| `roll_/pitch_/yaw_d_cutoff`, `roll_/pitch_/yaw_b_cutoff` (struct `dterm_cutoff`, `bterm_cutoff`) | 15 / 15 / 20 Hz | `pg/pid.c:65-66`, CLI `settings.c:1124-1134` |
| `blackbox_rate_denom` | 8 | `FW src/main/pg/blackbox.c:44` |

4.6 drops gyro ODR to 4 kHz on F4/F7 (#291, CHG). Configurator "D Term Lowpass" strings are Betaflight leftovers with
no 4.6 CLI parameter behind them. [SRC/INF]

**RPM notch presets** (`FW src/main/flight/rpm_filter.c:57-110`) [SRC]: Low: M1 Q8, M2 Q4, M4 Q6, T1 Q5. Medium: M1 8,
M2 3, M3 8, M4 6, T1 6, T2 5, motor 8. High adds a double M2 and M5, M6. Frequency = motor RPM × gear × harmonic/60;
notch max 0.45 × filter rate; notches fade in between `min_hz` and 1.25 × `min_hz` (`rpm_filter.c:195-316`). A missing
fast RPM source blocks arming (`rpm_filter.c:277-279`).

**FILT conflicts with the presets.** It recommends Q 2.5 single on the main fundamental, double Q 2.5 on the 2nd
harmonic, Q 2.5 on tail 1st and 2nd, a motor notch on geared helis, and a first-order 100 Hz LPF. The page is
unchanged since 2.0.0; the 4.6 presets use Q 5–8 on fundamentals. **[INF]** Treat FILT's Q values as legacy.

### 7.2 Symptom table

| Symptom | Log signature | Likely cause | Documented fix |
|---|---|---|---|
| Sharp peak at k × headspeed/60 in `gyroADC` | peak present in both `gyroRAW` and `gyroADC`, too little attenuation | missing or mis-centred notch (wrong gear/poles), notch too narrow | add a notch at that harmonic, Q 4.0 (FILT); fix the ratio (MOTORS) |
| Bump at fundamental or 2nd harmonic | broad 1P/2P energy | blade tracking or imbalance | "blade tracking and blade imbalance. Check them first."; then lower Q or double notch, "not advised to lower the Q value below 2.0" (FILT) |
| Peak that does not scale with rpm | fixed frequency across headspeeds | skids, tail fin, tail belt, bearings | "Check your helicopter first"; else static notch at that frequency (FILT) |
| Peak at a non-integer multiple that scales with rpm | rotor-locked line at a ratio ≠ integer, ≠ tail ratio | belt, pulley, gear mesh [INF] | mechanical inspection; project tool `line.cjs` identifies tooth ratios |
| High grass 60–80 Hz, worse in maneuvers | broadband energy in the band | airframe, blades | lower the LPF, but "not advised to lower it below 60hz"; "better if this cutoff is high" (FILT) |
| Hot servos or motors | HF content in `axisD`, `servo[]` | vibration through D | fix filters before gains (TUNE) |
| Sloppy, delayed feel; wobble at gains that should be stable | larger setpoint→gyro lag | over-filtering | "a filter too strong … may lower the maximum gains later"; use the "highest Q value possible without leaking too much vibrations" (FILT); "minimize the filters used" (RPMF) |
| Oscillation in autorotation or overspeed | vibration notches wrong while the one-way bearing freewheels | RPM no longer tracks rotor | dynamic filters for autos, "may wish to enable 2 notches" (RPMF, RPMM) |
| Notch centre jumps | debug RPM_FILTER [2] jumps, fader [6] drops to 0 | RPM source fault | `DSHOT_RPM_ERRORS` for bidirectional DShot (`rpm_filter.c:318-327`) |

### 7.3 Filter delay [INF, estimates to verify numerically against the firmware filters]

First-order LPF τ ≈ 1/(2π fc): 100 Hz ≈ 1.6 ms, 50 Hz bandwidth ≈ 3.2 ms, 15 Hz D cutoff ≈ 10.6 ms on the D path
only. Bessel decimator at 500 Hz ≈ 0.67 ms. A notch at f0, quality Q adds ≈ 1/(2π f0 Q) at low frequency (M1 40 Hz Q8 ≈
0.5 ms). Delays add across banks.

### 7.4 Logging for analysis

- BB: enable "Command Setpoint Mixer PID Raw Gyro Gyro Battery RSSI RPM Motors Servos"; debug `GYRO_SCALED` for PID,
  `GOVERNOR` for the governor; "Set it to 2kHz for OpenLager". [DOC]
- Log rate = PID rate / `blackbox_rate_denom` (`blackbox.c:2262`). **[INF]** At 250 Hz the Nyquist is 125 Hz and tail
  and upper main harmonics alias to |f − k × 250|; `gyroRAW` is only low-passed at 500 Hz, so aliasing is real. Log
  at ≥ 1 kHz for vibration work. The pilot's logs are at 1 kHz (looptime 500 µs, P interval 1; 992–995 Hz measured).
- Per-stage gyro: debug `GYRO_SAMPLE` [0] pre-decimation … [5] post-dyn-notch for `debug_axis`
  (`gyro_filter_impl.c`). [SRC]
- No numeric vibration limit (deg/s RMS or dB) is published on rotorflight.org. "A well-tuned filter should have no
  sharp peaks and might have small bumps at 40-80hz"; "Tall 'grass' is usually fine" (FILT). [DOC]

---

## 8. What to avoid

| Anti-pattern | Why | Source |
|---|---|---|
| Raising gains before filters are verified; any D without filters | "hot Motors and Servos" | TUNE, PRESETS; yaw D at 0 until RPM filters work ([COM] RCG-71) |
| Tuning before mixer calibration | "Without the calibration, all defaults in PID Profile are probably wrong" | MIXS |
| Gyro LPF below 60 Hz; notch Q below 2.0 | delay, lower achievable gains | FILT; LPF cutoffs below 20–30 Hz ([COM] RCG-24) |
| No gyro LPF at all | "With RPM Filters or Dynamic Notch Filters, one extra filter is needed around 100Hz. Without them, two second order filters are required." | MSG `gyroLowpassFilterHelp` |
| Dynamic notch Q below 2.0 | "will greatly increase filter delay" | MSG `gyroDynamicNotchQHelp` |
| Disabling dynamic notches when autorotation is possible | RPM notches lose their input when the motor stops | [COM] HF-970331; RPMF |
| Using FF to change responsiveness | "This parameter is NOT designed to tune the response" – use B | FF |
| Very low I-relax cutoff | "unpredictable … hide gain imbalance" | TUNE |
| Very fast cyclic I decay | "significant drifting problem … less predictable" | HSI |
| Leaving the temporary "I-gain ~200" trick after finding mixer limits | "MAKE SURE TO TURN THEM BACK" | MIXT |
| Using servo Min/Max for range adjustment | Min/Max are binding limits; "it may buzz, damage components, or even burn out" | SERVO |
| Collective impulse FF | "generally overcompensating … suggested to turn it off" (and absent in 4.6) | PROF |
| ESC governor under the RF ELECTRIC governor (double governing) | conflicting loops: "the ESC may cause some conflicts with the flybarless controller" in Heli Linear Throttle mode (HWG); stalls at ≈ 36 % spoolup ([COM] RCG-167) | HWG, [COM] RCG-167; GOVTAB only says DIRECT is for ESCs with their own governor, FLYR only says to set the FlyRotor ESC to "RF Gyro Governor" |
| ESC serial telemetry as the governor RPM source | too slow; 4.6 refuses to arm | RPMM, `governor.c:1627-1634` |
| Wrong `motor_poles` or gear ratio | headspeed, notches, dynamic LPF and glitch thresholds all scale by the error | MOTORS |
| Low-resolution throttle channel with NORMAL/SWITCH | headspeed steps | GOVTAB, [COM] HF-951299 |
| Nitro `min_throttle` at engine idle; clutch engaging above handover | | GOVTAB |
| TTA on while tuning the governor | confounds the tune | GOVT |
| Governor so strong the tail cannot hold torque | tail kicks, blowouts | GOVT |
| Restoring a 4.5 dump onto 4.6 | governor must be redone; mode names changed; other defaults changed: `rates_type` now ROTORFLIGHT (a restored diff may keep ACTUAL), `motor_poles` now 0 (disables RPM, so ELECTRIC cannot arm), `rescue_flip` ON | NOTES, [COM] RCG-164 |
| Chasing a continuous wag with PIDs before checking mechanics | "cannot be tuned out" | PROC45, [COM] RCG-140 |
| Copying other pilots' PIDs | "gains are usually higher at lower headspeeds, but not always" | [COM] HF-970331 |
| Reading governor tuning from `govP/D/F/Target` in DIRECT | fields unused or frozen | `governor.c:620-693` [INF] |
| Trusting AI-generated tuning thresholds | e.g. "cyclic I above 160–180 risks bounce-back" is a pasted chatbot answer | RCFP-I; HF-965481 warns likewise |
| Using LEGACY `docs/PID tuning.md` | Betaflight text, parameters not in 4.6 | LEGACY |

---

## 9. Tuning order and step sizes

### 9.1 Order

**[INF]** The overall sequence (governor before cyclic before tail) is this document's inference; no cited page
prescribes it. TUNE supports only filters first ("Please start by confirming your filters are working correctly before
you increase your tuning parameters") and the within-axis D → P → I → FF order.

| Step | Loop | Action | Source |
|---|---|---|---|
| 0 | all | mixer calibration, tail centre and yaw calibration, servo speeds, RPM source, poles/gear | MIXS, SERVO, MOTORS |
| 1 | filters | log a constant-headspeed hover, identify peaks, set notches/LPF | RPMF, FILT |
| 2 | governor | disable TTA; debug GOVERNOR at 1 kHz; F, then I, then P, then D | GOVT (position in the sequence [INF]) |
| 3 | cyclic | pitch first ("most difficult"), roll last | TUNE (position in the sequence [INF]) |
| 3a | each axis | D until it wobbles, back off; then P; then I | TUNE |
| 3b | | FF so I stays near 0 in full-stick flips; start ≤ 100 on cyclic, 0 on tail | TUNE, FF |
| 3c | | P:D ratio if needed | TUNE |
| 3d | | HSI: increase until it wobbles jabbing elevator at full collective, back off. **Conflicts with HSI**: "45 HSI gain and 100° HSI term limit … Additional tuning is not necessary in most cases" | TUNE vs HSI |
| 3e | | B for a sharper response ("Usually only pitch needs a significant B-gain") | TUNE |
| 3f | | cross-coupling from low; swash phase if bobbling persists | XC, MIXT |
| 4 | tail (position [INF]) | same D → P → I → FF order; collective FF from climb onset; stop gains per direction | TUNE, PROF, [COM] RCFP-JW, HF-970331 |
| 5 | TTA | only for motorised tails; increments of 10 | TTA |

Test maneuvers by level (TUNE): stick taps → flips with sudden stops, fast forward flight with taps, tick-tocks →
high-rate. I-oscillation shows best in "pirouetting long pitch pumps" (TUNE). Tail FF: continuous piros, then stop
(FF). HSI: straight line at safe altitude, brief negative collective; elevator/aileron jabs in a high-collective climb
(MSG `profilesOffsetGainHelp`). TTA: fast backwards flight with the tail into the wind, tail slides, backwards loops (TTA).

### 9.2 Step sizes

| Gain | Step | Source |
|---|---|---|
| Governor F | 10 | GOVT |
| Governor I | 25; raise until it plays up, then cut by 1/3 | GOVT |
| Governor P | 10; start ≈ 10 (I ≈ 20); raise until slight oscillation, cut by 1/3 | GOVT |
| Governor D | "Unless you're flying a 500+ heli you probably won't need D, since there's hardly any momentum in the rotor." | GOVT |
| TTA gain | 10 | TTA |
| Cyclic/tail P, I, D | "until it wobbles, then back off a bit"; no number | TUNE |
| Tail D | steps of 10 ([COM] HF-970331); raise until "slight shimmy at stop", cut by ≈ 1/3 ([COM-AI] RCFP-JW) | |
| Pipeline recommendations | at most ±20 % per gain and 3 gains per iteration | `RULES.multipliers`, `maxGainsChanged` in `tools/autotune/report.cjs` (pipeline choice) |

GOVT's "F-gain has a default value of 15" does not match the firmware default of 10 (unchanged in 4.3.0, 4.4.0, 4.5.0
and 4.6.0, `pg/pid.c`). Treat it as the author's own starting value, not a historical default, and use GOVT's
numbers as relative steps only.

---

## 10. Quantitative thresholds for automated checks

Almost no official source gives a number for "acceptable". Every threshold below says where it comes from:

- **firmware** – a limit the firmware itself enforces; exact.
- **doc** – a number printed in official documentation.
- **community** – a number from a community report, one heli.
- **pipeline** – chosen for this pipeline, **unvalidated**. Must live in `RULES` and be reported alongside every result.

Common definitions [pipeline]: *in flight* = airborne, headspeed ≥ 3000 rpm and body rate > 10 deg/s rms (`RULE.flight = { headspeed: 3000, rate: 10 }`
in `wag.cjs`);
analyse governor state ACTIVE (4) only; exclude ±1 s around profile switches and GOVSTATE changes.

### 10.1 Data validity (run first)

| ID | Check | Metric | Threshold | Source |
|---|---|---|---|---|
| D1 | Logging rate | nominal 1e6 / (looptime × pid_process_denom × P interval) and measured frame rate | vibration and D-noise checks only if ≥ 1000 Hz; below, report aliasing risk | pipeline, from Nyquist (section 7.4) |
| D2 | Gaps / truncation | missing frames, parse errors | any → exclude the span | pipeline |
| D3 | Field availability | presence of `gyroRAW`, `axisD`, `servo`, `headspeed`, gov fields, `Ibat` non-zero, ESC fields | skip the checks that need them; state which | pipeline (CLAUDE.md "Handle missing fields") |
| D4 | Header vs CLI | header gains vs pilot's CLI; `pid_mode`, `gov_mode`, limits from CLI | disagreement → flag and trust the log header for header keys, the data for the mode | pipeline |
| D5 | Voltage plausibility | `Vbat` step between samples; per-cell in flight | step > 1 V in 10 ms or per-cell < 3.0 V → flag as sag or telemetry glitch, do not interpret power | pipeline |

### 10.2 Governor, ESC and power

| ID | Check | Metric | Threshold | Source |
|---|---|---|---|---|
| G0 | Mode detection | `govSum` and `govI` while in flight | both ≡ 0 → DIRECT/LIMIT: skip G2–G6 and G9, analyse headspeed against its per-profile median | firmware (`governor.c:887-988`) |
| G1 | Fallback and glitches (approximate) | count of GOVSTATE 6; proxy glitches: \|`headspeed` − PT2(`headspeed`, `gov_rpm_filter`)\| > 0.25 × `gov_headspeed`, `headspeed` > 2 × `gov_headspeed` (from the profile/CLI, not `govRequest`), or 0 while `motor[0]` > 100 | any FALLBACK → top-priority finding; glitch counts are a proxy | firmware criterion: rpmGlitch = \|motorRPM − filteredRPM\| > 0.25 × `gov_headspeed`/gear or motorRPM > 2 × `gov_headspeed`/gear, filteredRPM = motorRPM through the `gov_rpm_filter` PT2; rpmError = (HS/full < 0.01 or motorRPM < 10) and throttle > 0.10; either clears motorRPMGood → FALLBACK (`governor.c:50-60,574-606,1596-1597`). The logged `headspeed` is Bessel-filtered at `motor_rpm_lpf` (`motors.c:237,309-313`), not raw, so the log check only approximates it [INF] |
| G2 | Steady headspeed error | median and p5/p95 of (`headspeed` − `govTarget`)/`govTarget` in ACTIVE, low collective activity | \|median\| ≤ 1 %, p5..p95 within ±2 % | pipeline; community ±1.6 % (HF-913037) |
| G3 | Droop per collective event | peak (`govTarget` − `headspeed`)/`govTarget` within 1 s of a collective rise > 30 % of range | ≤ 3 % good; 3–5 % note; > 5 % flag (then check G5 before blaming F) | pipeline; no documented tolerance |
| G4 | Overshoot on unload | peak (`headspeed` − `govTarget`)/`govTarget` after collective drop | > 3 % flag (F too high, GOVT) | pipeline |
| G5 | Recovery time | time from droop peak back within 1 % of target | > 0.5 s flag | pipeline |
| G6 | Throttle headroom | median `motor[0]`/10 in ACTIVE per profile; share of ACTIVE time with `motor[0]` ≥ 0.995 × ceiling (ceiling = `gov_max_throttle` × 10); runs ≥ 100 ms at the ceiling while `headspeed` < target − 2 % | median > 85 % flag; any such run flag as saturation (not a gain problem) | doc 75–85 % (FLYR, written for FlyRotor ESC); 100 ms is pipeline |
| G7 | Output ceiling vs sum | `govSum` − `motor[0]` when `motor[0]` is at its ceiling | > 0 means the PID asks for more than the ESC is given; report size | firmware (clamp, `governor.c:966-969`) |
| G8 | Voltage compensation | ratio `motor[0]`/`govSum` when unsaturated | ≡ 1.000 → voltage comp off; 0.80–1.20 bounds | firmware (`governor.c:490-509`) |
| G9 | Governor oscillation | PSD of headspeed error: peak prominence vs band median in 0.3–3 Hz (I-type) and 3–10 Hz (P-type) | prominence ≥ 5 → flag, report frequency | pipeline (prominence reuses `RULES.lineProminence`); bands follow GOVT wording, no numbers there |
| G10 | Governor–tail coupling | magnitude-squared coherence of `headspeed` and `gyroADC[2]` at the yaw wag peak | ≥ 0.5 → governor implicated; ≤ 0.1 with flat headspeed → ruled out | pipeline; rationale OLDWIKI `Tail-tuning` (RF1-era), [COM] RCG-141 and RCG-107 |
| G11 | Throttle trend over the pack | slope of steady `motor[0]` vs time and vs `Vbat` at constant profile | report; > 5 %/pack flag as sag | pipeline; ungoverned ≈ 10 % headspeed loss per pack (RCG-140) |
| G12 | Poles / gear | ratio of lines matching main-rotor harmonics (1P, 2P, …) to `headspeed`/60; or pole count and gear checked against an independent source (ESC eRPM, tachometer) | main-rotor harmonic within 0.5 % of an integer; else ratio or pole error. Non-integer lines (tail at k × tail ratio, belt, pulley; section 7.2, `line.cjs`) are mechanical candidates, not pole errors; this pilot's strongest line is at 72/19 × rotor (section 1) | pipeline; `RULES.lineCluster` 1.5 % is the existing clustering tolerance |
| G13 | Min cell voltage under load | `Vbat`/cells, p1 in flight | < 3.3 V/cell flag | pipeline (common LiPo practice, no Rotorflight source) |

### 10.3 Cyclic

| ID | Check | Metric | Threshold | Source |
|---|---|---|---|---|
| C1 | Integrator pinned | \|`axisI`\| vs 1000 × Ki × `error_limit` | ≥ 95 % for > 0.2 s → flag | limit is firmware (`pid.c:1156-1166`); 95 % and 0.2 s pipeline |
| C2 | Saturation | \|`mixer[0/1]`\| ≥ 0.98 × cyclic max (default 1250), hypot(`mixer[0]`,`mixer[1]`) at ring limit, `servo[n]` flat at an extreme ≥ 20 samples | any episode → report duration; exclude from gain analysis | firmware limits; 0.98 and 20 samples pipeline (`RULE.limitSamples`) |
| C3 | FF adequacy | in steady full-stick rolls/flips (\|setpoint\| ≥ 70 % of max rate for ≥ 0.5 s): \|mean `axisI`\| / \|mean `axisF`\| and gyro/setpoint | I/F ≤ 0.10 and gyro/setpoint 0.9–1.1 → OK | doc says only "I remains near 0" (TUNE); numbers pipeline |
| C4 | Stop quality | after \|setpoint\| falls from ≥ 150 deg/s to ≈ 0 within 0.1 s: overshoot past zero as % of pre-stop rate; settling to < 10 deg/s | overshoot > 10 % or settling > 0.3 s → flag; sign of `axisI` at the stop decides FF-high vs FF-low | pipeline |
| C5 | Oscillation (fast) | amplitude of gyro − setpoint in roll 10–20 Hz, pitch 8–16 Hz windows, stick-free | shares of time ≥ 10 / 20 / 40 deg/s reported; self-excited growth from < 30 to > 150 deg/s over ≥ 6 half cycles flagged | pipeline (`RULE.bands`, `RULES.thresholds`, `RULES.onset` in `wag.cjs`/`wag_report.cjs`) |
| C6 | Oscillation (slow) | 0.5–3 Hz gyro energy after stops with `axisI` in phase | peak prominence ≥ 5 → flag, report frequency | band from doc (TUNE 0.5–1, PROF 1–3 Hz); prominence pipeline |
| C7 | Loop margin | closed-loop sensitivity peak from `report.cjs` frequency responses | > 1.5 → candidate for change | pipeline (`RULES.peakSensitivity`, `RULES.gainMargin` 2 (6 dB) and `RULES.phaseMargin` in `tools/autotune/wag_report.cjs`; `report.cjs` only compares peak sensitivity against the baseline) |
| C8 | Cross-coupling | coherence of roll gyro with d(pitch setpoint)/dt when roll setpoint ≈ 0 | report gain; no threshold yet | pipeline |
| C9 | HSI | pitch error vs sign(collective) at \|coll\| ≥ 5°; `axisO` share | report only | pipeline |
| C10 | Ground decay in flight | `axisI` decay while flying, at \|collective\| < ≈ 8° (airborne τ ≥ 8.7 s there), or decay speed of `axisError` above the in-flight cap ≈ 11.5 deg/s | τ within 2–3 s at low collective, or decay faster than the cap → flag possible airborne misdetection; τ alone is not enough, since airborne τ is also 2–3 s near 10.5–11.5° collective | firmware (`pid.c:65-66,645-650,1170-1188`, defaults `pg/pid.c:52-56`: ground 25, cyclic 250, limit 12); window pipeline |
| C11 | D noise | share of `axisD` power above 30 Hz | > 50 % → flag D as noise-driven | pipeline |

### 10.4 Tail

| ID | Check | Metric | Threshold | Source |
|---|---|---|---|---|
| T1 | Wag amplitude | yaw gyro − setpoint in 5–16 Hz windows (0.5 s), stick-free | shares ≥ 10 / 20 / 40 deg/s; large event ≥ 30 deg/s amplitude or 80 deg/s peak | pipeline (`RULE.bands.yaw`, `RULE.big`) |
| T2 | Slow wag | 0.5–3 Hz yaw with `setpoint[2]` ≈ 0, `axisI[2]` in phase | prominence ≥ 5 → flag | band doc; prominence pipeline |
| T3 | Wag vs headspeed | T1/T2 per profile at identical gains | amplitude ratio ≥ 2 between profiles → flag headspeed-dependent (belt-tail gain) | pipeline; rationale OLDWIKI `Tuning-Introduction` (RF1-era) |
| T4 | Wag vs gains | wag frequency across gain sets | change < 10 % while gains changed > 20 % → suspect mechanics | pipeline; rationale PROC45 |
| T5 | Stop asymmetry | overshoot % for each stop direction (split at errorRate ±10 deg/s, the firmware blend band) | ratio ≥ 1.5 → adjust the larger side's stop gain | ±10 is firmware (`pid.c:1277`); 1.5 pipeline |
| T6 | Collective kick | peak yaw error within 0.3 s of a collective step ≥ 30 % of range; sign vs torque direction | ≥ 30 deg/s flag; sign selects raise/lower `yaw_collective_ff_gain` | pipeline; sign rule PROF |
| T7 | Precomp vs I | correlation of `axisI[2]` with `axisF[2]` in collective pumps (yaw F = 0) | \|r\| ≥ 0.5 with opposite sign → precomp too large; same sign → too small | pipeline; rationale [COM] RCG-55 |
| T8 | Authority | \|`mixer[2]`\| at the yaw limit for ≥ 20 samples; `servo[3]` pinned | any → report; gain changes cannot fix it | firmware limit; 20 samples pipeline (`RULE.limitSamples`) |
| T9 | Piro FF | in steady piros ≥ 0.5 s: \|`axisI[2]`\| and gyro/setpoint | as C3 | pipeline |
| T10 | Phase margin for yaw changes | from fitted tail response | ≥ 35° after any change | pipeline (`RULES.phaseMargin`) |

### 10.5 Filters and vibration

| ID | Check | Metric | Threshold | Source |
|---|---|---|---|---|
| F1 | LPF present | header `gyro_lpf1_type/static_hz`, `gyro_lpf2_type` | no gyro LPF with RPM filters → flag | doc (MSG `gyroLowpassFilterHelp`) |
| F2 | LPF too low | lowest active gyro LPF cutoff | < 60 Hz flag; < 80 Hz note | doc (FILT) |
| F3 | Notch Q | RPM / dynamic notch Q from header | < 2.0 flag | doc (FILT, MSG) |
| F4 | D cutoff | `dterm_cutoff` from `rollBW/pitchBW/yawBW` | report deviation from "around 20Hz" | doc (PROF), advisory only |
| F5 | Notch placement | rotor-locked lines in `gyroRAW` vs configured notch sources | a line with prominence ≥ 5 and no notch within 2 % → flag | pipeline (`RULES.lineProminence`) |
| F6 | Notch attenuation | `gyroADC`/`gyroRAW` amplitude at each notched harmonic | < 10 dB → flag mis-centred or too narrow | pipeline |
| F7 | Vibration level | `gyroRAW` RMS above 30 Hz per axis and profile, and per line | no absolute threshold; report and compare across flights; ≥ 2× change between groups flagged | pipeline; no official number exists (FILT) |
| F8 | Dynamic notch | feature state vs PID rate | off with no RPM coverage of a line → note; forced off below 1 kHz PID rate | firmware (`dyn_notch_filter.c:89,164`) |
| F9 | Aliasing | configured harmonic frequencies vs log Nyquist | any > Nyquist → report its alias frequency | pipeline (arithmetic) |

### 10.6 Decision rules for recommendations (already in `report.cjs`)

A gain change is recommended only if the predicted tracking or disturbance improves by ≥ 10 % and ≥ 2 standard errors,
the other gets worse by ≤ 1 %, total error drops ≥ 2 %, using ≥ 3 flights, with prediction floors 2.5 % / 3 %
added in quadrature (`RULES` in `tools/autotune/report.cjs`; floors measured in `test/autotune.test.cjs`). All
pipeline choices; the floors are validated on simulated flights only (DEVELOPMENT.md section 12).

---

## 11. Open questions

**Things the documentation does not say**

1. No acceptable headspeed droop, steady error or recovery time for the Rotorflight governor. G2–G5 are pipeline guesses.
2. No numeric vibration limit (deg/s RMS or dB), no relation between filter Q/LPF and achievable gain. F6, F7 are guesses.
3. No guidance on logging rate versus Nyquist.
4. No documented yaw-specific tuning differences for belt, torque-tube and direct-drive tails, beyond the gear-ratio
   entry (MOTORS). The belt-tail/headspeed statement is in the RF1-era OLDWIKI `Tuning-Introduction`, not in 4.6 docs.
5. No procedure for `yaw_inertia_precomp_gain` (PROF names it only).
6. Which physical stop direction uses `yaw_cw_stop_gain`: the code says errorRate > +10 deg/s, and yaw gyro is
   negative for CW (`setpoint.c:291`), but no doc maps it to "stopping a right piro". Verify against a log.

**Conflicts between sources**

7. Oscillation bands: TUNE (I 0.5–1 Hz, P/D 5–8 Hz) vs PROF (I 1–3 Hz, P ≈ 20 Hz).
8. HSI: page says gain 45 and limit 100° are "good values"; firmware defaults are O 50, limit 90; the page's tunable
   curves are hardcoded since #285 (4.5.0).
9. Governor: GOVT says F default 15, firmware 10 (since at least 4.3). GOVTAB says autorotation bailout is off unless configured; the
   default timeout is 15 and `isAutorotation()` is always true with `gov_auto_throttle = 0` (`governor.c:389-392`).
10. CLIREF misdescribes TTA, `gov_idle_throttle`, `gov_auto_throttle`.
11. FILT's Q 2.5 recommendations vs the 4.6 preset Qs of 5–8.
12. FF: FF page says FF is not a response knob; the Configurator help says higher FF gives a sharper response.

**Open for firmware verification**

13. Offset flood relax: `1 − |collectiveHPF|/40` with collective in mixer units (1.0 = 12°) looks nearly inactive.
    Needs checking in the source.
14. DIRECT + TTA doubles throttle (`governor.c:686`). Probable bug; irrelevant unless TTA gain > 0 in DIRECT.

**Specific to this pilot's data (to resolve with the pilot, not from the docs)**

15. `gov_mode`: the 2026-09-04 diff says DIRECT with `gov_headspeed = 1800`; the 2026-09-28 logs show a running PID
    governor with targets 3500/4500/5000. A current `diff all` is needed before any governor recommendation.
16. `motor[0]` reaches 1000 while the 09-04 diff has `gov_max_throttle` 60/70/80. Resolved by the source: `motor[0]`
    is the governor output in 0.1 % steps, not rescaled, with ceiling `gov_max_throttle` × 10 (`motors.c:97-100`,
    `mixer.c:545,713`, `pg/mixer.c:57-59`, `governor.c:690,970,1575-1579`). A `motor[0]` of 1000 in a governed state
    means `gov_max_throttle` was 100 in that log (or gov_mode OFF or a custom mixer rule), so the 09-04 limits were no
    longer in force, consistent with item 15. G6 uses that ceiling.
17. ESC model and whether its own governor is active (double governing) are unknown. ESC telemetry fields are not
    logged, and `Ibat` is logged but always zero, so power and current checks cannot run.
18. Voltage source for compensation (ADC or ESC) and whether `gov_use_voltage_comp` is on; G8 can answer the second
    from data.
19. Tail pulley: 76T per manual and CLI, 72T per the vibration line measurement. Test proposed: turn the main rotor one
    turn and check where the tail blade stops.
20. `iterm_relax_level`, mixer/servo limits and swash settings are CLI-only; the current values are unknown.
21. Headspeed maxima of 7753, 6483 and 5926 rpm in logs #12, #18, #7 are far above any target and coincide with logs
    that have FALLBACK events. Whether they are RPM glitches (G1) is not yet checked.
