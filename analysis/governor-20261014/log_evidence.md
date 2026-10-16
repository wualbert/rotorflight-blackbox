# Governor log evidence: SAB Fireball and Gaui X4 II (2026-10-14)

Input for the governor digital twin and the governor autotune. Every number comes from the logs listed below, with its
sample count and uncertainty. Numbers: `log_evidence.json` (plus `oe_fit.json`, `oe_esc_fit.json`, `closed_check.json`,
`gains.json`, `term_ranges.json`). Figures: `fig_*.png`. Scripts: `extract.cjs`, `phase.cjs`, `s1_states.py` … `s8_extra.py`,
`assemble.py`, `figures.py` (all in this directory).

The gear ratios in the configuration are correct (Fireball direct drive `main_rotor_gear_ratio = 1,1`). Every headspeed number
below is the logged `headspeed` field. Nothing here questions a ratio or a pulley.

## 0. Data, method, conventions

| | Fireball | Gaui X4 II |
|---|---|---|
| Dump | `RTFL_BLACKBOX_LOG_SAB_Fireball_20261005_204823.BBL` | `RTFL_BLACKBOX_LOG_20261004_233406.BBL` (`AUTOTUNE_FLIGHT_RPM=2000`) |
| Logs (zero-based) | 5, 6, 8, 9, 10, 11, 13, 14, 15. Logs 7 and 12 are "Log truncated, no data". App log number = index + 1 | 38, 39, 40, 41, 43, 45, 46, 47, 48, 49 |
| Class (`health_phase.cjs` `phases()`, lines 165-237) | Flights: 5, 10, 11, 13, 14, 15 (1443 s flight phase). Bench runs: 6, 8, 9 | 10 flights (1352 s flight phase) |
| PID loop / log rate | 1 kHz / 1 kHz (frame clock 994.8 Hz) | 2 kHz / 1 kHz (frame clock 1011.9 Hz) |
| Profiles (`govRequest`) | 3500 / 4500 / 5000 rpm = PID profile 1 / 2 / 3 | 2300 / 2500 / 2700 rpm = PID profile 1 / 2 / 3 |
| Battery fields | `Vbat` from ESC telemetry (`battery_meter = ESC`), 20 ms updates. `Ibat` = 0 in every sample (`current_meter = ESC`, ESC without current sensing) | `Vbat` 10 ms updates, `Ibat` 5 ms updates, `Tesc` 0.1-0.7 s |
| CLI | `RTFL_cli_SAB_Fireball_20261013_184504.txt` (8 days after these logs, see 6.1) | none |

- Extraction: `extract.cjs` (a copy of `analysis/twin6dof/extract.cjs` with more fields) calls `lib.segments(app, file, {whole: true, extra})`
  (`tools/autotune/lib.cjs:70-147`) and writes float32 columns to `data/<craft>/`. Governor states come from GOVSTATE events
  (`lib.cjs:115`, `govStateAt`). Flight phases come from `phase.cjs`.
- Units (checked here and in `health_gov.cjs:8-13`): `motor[0]`, `govP/I/D/F/Sum` in 0.1 % of full throttle; `headspeed`, `govTarget`,
  `govRequest` in rpm; `Vbat` 0.01 V; `Ibat` 0.01 A; `mixer[i]` = stabilized mixer input x 1000 (the governor feedforward reads these, `flight_mixer.h:97-115`).
- Times are index times, s from log start (sample / 1000). The app shows frame seconds: multiply by 1.0052 (Fireball) or 0.988 (Gaui).
- Uncertainty: per-flight values with mean ± SE across flights, or a bootstrap of 1-2 s blocks inside a flight. "n" = events or flights.
- Telemetry delays used for every battery fit (measured in 4.1): Fireball `Vbat` 66 ms, Gaui `Vbat` 45 ms and `Ibat` 87 ms after `motor[0] x headspeed`.

## 1. Governor state timeline and durations

Totals over all extracted logs (`s1_states.py`; per-log timelines in `log_evidence.json` `<craft>.states.logs`):

| State | Fireball s | Fireball entries | Gaui s | Gaui entries |
|---|---|---|---|---|
| ACTIVE | 1480.4 | 14 | 1382.8 | 10 |
| SPOOLUP | 66.7 | 11 (durations 0.75-8.92 s, median 5.80) | 95.5 | 10 (7.37-11.95 s, median 9.59) |
| IDLE | 30.9 | 13 | 37.0 | 10 (3.33-4.32 s) |
| AUTOROTATION | 45.6 | 11 (0.03-15.00 s) | 9.1 | 8 (0.13-1.99 s) |
| HOLD | 0 | 0 | 6.7 | 2 (1.74, 5.00 s) |
| FALLBACK | 0.62 | 3 (0.203, 0.204, 0.213 s) | 0 | 0 |
| RECOVERY | 2.14 | 3 (0.48, 0.80, 0.86 s) | 0 | 0 |
| BAILOUT | 1.41 | 1 (1.41 s) | 0 | 0 |
| BYPASS | 0 | 0 | 0 | 0 |

Transitions, Fireball: OFF→IDLE 10, IDLE→SPOOLUP 11, SPOOLUP→ACTIVE 10, SPOOLUP→IDLE 1, ACTIVE→AUTOROTATION 11,
AUTOROTATION→OFF 9, AUTOROTATION→IDLE 1 (log 5, after exactly 15.00 s = `gov_autorotation_timeout = 15`), AUTOROTATION→BAILOUT 1,
BAILOUT→ACTIVE 1, ACTIVE→FALLBACK→RECOVERY→ACTIVE 3. Gaui: OFF→IDLE→SPOOLUP→ACTIVE 10, ACTIVE→AUTOROTATION→OFF 8,
ACTIVE→HOLD→OFF 2 (log 45 HOLD 5.001 s = `gov_throttle_hold_timeout = 50`).

- Both helicopters use a 3-position throttle channel: `rcCommand[4]` takes only 0, 509 and 1000. With `gov_throttle_type = FUNCTION`
  (`flight_governor.c:449-461`) 509 maps to `gov_auto_throttle` and 1000 to `gov_max_throttle`. The middle position gives AUTOROTATION
  (throttle input below handover, `isAutorotation()` true, `flight_governor.c:1157-1161`), position 0 gives HOLD.
- Every Fireball flight ends ACTIVE→AUTOROTATION, so an AUTOROTATION entry is the normal end of a flight, not an event to flag.
- All FALLBACK, RECOVERY and BAILOUT time is on the Fireball (section 6).

## 2. Headspeed tracking

### 2.1 Error by state, phase and headspeed (`s2_tracking.py`)

ACTIVE uses `headspeed - govTarget`; other states use `headspeed - govRequest` (the firmware sets the target to the present headspeed
there, `flight_governor.c:915, 648`). ACTIVE samples within 1 s of a state change or a `govRequest` change are left out, and so is rescue.
Percent = of `govRequest`. CI = 95 % bootstrap of 1-s blocks.

| Heli | State, phase | Headspeed | s | RMS % (CI) | per-flight RMS % (mean ± SE, n) | mean % | p1 / p99 % | p0.1 % |
|---|---|---|---|---|---|---|---|---|
| Fireball | ACTIVE flight | 3500 | 24.7 | 1.36 (0.57-2.02) | 1.43 ± 0.38 (5) | -0.27 | -6.6 / 2.4 | -9.8 |
| Fireball | ACTIVE flight | 4500 | 1184.5 | 1.76 (1.56-1.97) | 1.71 ± 0.15 (6) | -0.12 | -6.8 / 3.5 | -18.5 |
| Fireball | ACTIVE flight | 5000 | 175.1 | 1.16 (0.83-1.48) | 1.41 ± 0.41 (2) | -0.11 | -4.5 / 1.8 | -12.4 |
| Fireball | ACTIVE flight | all | 1384.3 | 1.69 (1.49-1.88) | 1.62 ± 0.15 (6) | -0.12 | -6.5 / 3.4 | -18.0 |
| Fireball | ACTIVE ground | 3500 | 17.9 | 6.68 | 4.0 ± 2.4 (4) | -1.27 | -15.7 / 15.3 | — (the bailout of 6.3) |
| Fireball | RECOVERY flight | 4500 | 1.4 | 32.4 | 35.6 ± 4.3 (2) | -29.2 | -42.6 / -0.8 | |
| Gaui | ACTIVE flight | 2300 | 726.5 | 0.87 (0.82-0.92) | 0.83 ± 0.06 (10) | +0.01 | -3.0 / 2.4 | -3.8 |
| Gaui | ACTIVE flight | 2500 | 323.9 | 1.08 (0.98-1.17) | 1.15 ± 0.16 (9) | -0.04 | -4.1 / 2.5 | -5.3 |
| Gaui | ACTIVE flight | 2700 | 242.9 | 0.90 (0.78-1.02) | 0.95 ± 0.13 (3) | -0.07 | -3.7 / 2.2 | -5.3 |
| Gaui | ACTIVE flight | all | 1293.3 | 0.93 (0.89-0.98) | 0.93 ± 0.05 (10) | -0.02 | -3.3 / 2.4 | -5.0 |
| Gaui | ACTIVE ground | all | 11.8 | 0.49 (0.32-0.61) | 0.46 ± 0.16 (7) | +0.10 | -1.6 / 1.3 | |

The Fireball has 1.8 x the Gaui RMS in flight, and its 0.1 % tail (-18 %) comes from throttle saturation and FALLBACK (sections 3, 6).

### 2.2 Collective load steps (`fig_load_steps.png`)

Step = |`mixer[3]`|/1000 (PT1 20 Hz) changes by 0.25 or more in 0.25 s after 0.3 s with less than 0.06 of movement; ACTIVE, flight,
no rescue, one profile for the 2.3 s window. Peak = extreme of `(headspeed - govTarget)/govRequest` in 1.5 s, minus the 0.3 s pre-step mean.
Recovery = first time |error| < 1 % for 0.2 s. "sat" = `motor[0]` >= 98 % in the window. Sensitivity = peak / Δ|collective|, OLS through 0 ± SE.

| Heli | Headspeed | Direction | n | Δ\|coll\| median | peak % p5 / p50 / p95 | % per unit Δ\|coll\| | t of peak s | recovery s p50 (p5-p95) | recovered |
|---|---|---|---|---|---|---|---|---|---|
| Fireball | all | up, unsat | 57 | 0.31 | -4.41 / **-1.98** / -0.27 | -6.2 ± 0.5 | 0.53 | 0.92 (0.11-1.88) | 52/57 |
| Fireball | 4500 | up, unsat | 49 | 0.31 | -4.37 / -1.96 / -0.26 | -5.95 ± 0.53 | 0.61 | 1.04 | 44/49 |
| Fireball | 5000 | up, unsat | 6 | 0.30 | -3.73 / -2.80 / -0.77 | -8.1 ± 1.6 | 0.33 | 0.58 | 6/6 |
| Fireball | all | up, **sat** | 10 | 0.46 | -19.96 / **-12.40** / -6.07 | -22.1 ± 4.0 | 0.58 | 1.65 (1.01-2.03) | 6/10 |
| Fireball | all | down, unsat | 85 | -0.28 | -0.08 / **+2.68** / +5.97 | 9.1 ± 0.7 | 0.39 | 0.89 | 77/85 |
| Fireball | all | down, sat before | 16 | -0.35 | +3.25 / +6.40 / +13.55 | 20.1 ± 2.5 | 0.57 | 1.40 | 5/16 |
| Gaui | all | up | 68 | 0.37 | -5.70 / **-2.81** / -0.85 | -6.1 ± 0.3 | 0.38 | 0.90 (0.36-1.92) | 58/68 |
| Gaui | 2300 / 2500 / 2700 | up | 36 / 23 / 9 | 0.37 / 0.33 / 0.54 | p50 -2.51 / -2.91 / -5.01 | -5.4 / -6.8 / -7.1 (± 0.4-0.9) | | 0.84 / 0.89 / 1.46 | |
| Gaui | all | down | 136 | -0.32 | +0.33 / **+2.09** / +6.06 | 6.2 ± 0.2 | 0.30 | 0.65 | 133/136 |

- Unsaturated, both helicopters lose about 6 % of headspeed per unit of |collective| step and recover in about 0.9 s.
- At the throttle limit the Fireball droop is 3.6 x larger (-22 vs -6.2 %/unit), and 4 of 10 events do not recover in 2.5 s.
- Fireball overshoot on a collective decrease (9.1 %/unit) is 1.5 x its droop on an increase; on the Gaui both are 6.2 %/unit.

### 2.3 Profile changes (target ramps)

The target slews at `max(gov_headspeed, motorRPMK) x 10 / gov_tracking_time` per second (`flight_governor.c:562-565, 973, 1646`).
Measured slopes and the firmware motor constant (`motorRPMK` ≈ median `headspeed / motor[0]` of the 5 s before, `flight_governor.c:550-560`)
give the implied `gov_tracking_time`:

| Heli | Ramps | target slope rpm/s (median) | implied gov_tracking_time (median, range) | max lag rpm (median) | settle to 1 % s, median (range) |
|---|---|---|---|---|---|
| Fireball | 16 | 1109 | 51.0 (41.6-57.9) = 50 (CLI 50) | 291 | 1.58 (0.76-4.27) |
| Gaui | 37 | 692 | 50.3 (49.1-52.0 p5-p95) = 50 | 94 | 1.30 (0.62-4.99) |

## 3. Throttle saturation (`fig_saturation_example.png`, `fig_saturation_vbat.png`)

Fireball `gov_max_throttle = 100` (CLI lines 1012, 1118, 1224); `motor[0]` piles up at exactly 1000.
Gaui: maximum `motor[0]` in ACTIVE flight 93.9 % (log 49, 205.58 s, 2500 rpm); no pile-up at any value, so its ceiling is not reached.

| Heli | Headspeed | ACTIVE flight s | s at >= 98 % (share) | s at 100 % | runs at >= 98 % in flight | motor[0] p50 / p95 / p99 % | govSum p99.9 / max % |
|---|---|---|---|---|---|---|---|
| Fireball | 3500 | 37.5 | 0.02 (0.06 %) | 0 | 0 | 57.6 / 75.8 / 88.8 | 96.5 / 100.0 |
| Fireball | 4500 | 1211.6 | 20.4 (1.68 %) | 15.7 | 50 | 79.6 / 90.1 / 100 | 120.9 / **137.4** |
| Fireball | 5000 | 183.4 | 3.1 (1.69 %) | 2.45 | 8 | 87.0 / 92.7 / 100 | 113.3 / 118.2 |
| Gaui | 2300 / 2500 / 2700 | 752 / 361 / 255 | 0 | 0 | 0 | 67.1 / 72.8 / 79.7 (p50) | max 83.4 / 93.9 / 93.2 |

Fireball saturation runs in flight (n = 58 at >= 98 %, 18.1 s at 100 % in 50 runs; all in PID profiles 2 and 3; 2 in a rescue):
- duration median 0.28 s, longest 1.36 s (log 14, 148.92 s) and 1.28 s (log 11, 217.92 s);
- largest |collective| in the run median 0.72 (range 0.59-1.04), often with cyclic 0.3-1.2 and yaw 0.5-1.5 at the same time;
- headspeed error at its minimum: median -7.9 % (to -38 % in log 14, 192.42 s, before the FALLBACK of 6.2);
- `Vbat` (lag-aligned) median 22.06 V during the run against 22.73 V in the 2 s before: 0.55 V of sag at the limit;
- govSum (the demand) median peak 102 %, up to 137 %. `govI` stays at 76-91 % (it does not wind up: conditional integration, `flight_governor.c:966-967`).

Saturation against pack voltage (share of ACTIVE flight time at >= 98 %, 0.5 V bins, seconds in brackets):

| Vbat V | 21.5-22.0 | 22.0-22.5 | 22.5-23.0 | 23.0-23.5 | 23.5-24.0 | 24.0-24.5 | 24.5-25.0 |
|---|---|---|---|---|---|---|---|
| Fireball 4500 | **36.4 %** (26 s) | 1.6 % (344) | 0.5 % (277) | 1.3 % (196) | 0.3 % (152) | 0 (151) | 0.1 % (65) |
| Fireball 5000 | **61.8 %** (3 s) | 3.0 % (23) | 0.7 % (50) | 0 (58) | 0 (25) | 0 (24) | — |
| motor[0] median 4500 | 90.6 % | 81.5 | 80.0 | 78.6 | 76.9 | 75.4 | 73.5 |

Motor-voltage demand `D x V` (`motor[0]` x lag-aligned `Vbat`, unsaturated samples; `s8_extra.py demand()`), the pack voltage below which the
governor runs out of throttle:

| Heli | Headspeed | D·V p50 V | p90 | p99 | p99.9 | Vbat in flight p1 / p50 |
|---|---|---|---|---|---|---|
| Fireball | 3500 | 14.2 | 16.2 | 20.7 | 22.1 | 23.2 / 24.8 |
| Fireball | 4500 | 18.2 | 19.6 | **21.7** | 23.2 | 21.9 / 22.9 |
| Fireball | 5000 | 20.1 | 20.6 | **21.6** | 22.3 | 21.8 / 23.1 |
| Gaui | 2300 | 15.2 | 16.0 | 16.8 | 17.0 | 21.5 / 22.7 |
| Gaui | 2500 | 16.6 | 17.4 | 18.2 | 18.5 | 21.1 / 22.7 |
| Gaui | 2700 | 18.2 | 18.6 | 19.5 | 19.8 | 21.6 / 22.8 |

- Fireball 4500 and 5000: the p99 demand (21.6-21.7 V) equals the late-pack voltage under load (last 20 s of each flight 21.98-22.50 V,
  minimum 20.96-21.67 V). The 1 % hardest load saturates at the end of every pack. At 5000 rpm the median demand is already 20.1 V (87 % throttle).
- Gaui: the p99.9 demand 19.8 V at 2700 rpm is 1.2 V under the lowest flight voltage seen at 2700; the margin is about 10 % throttle.
- Voltage compensation is inactive on both helicopters (7.1), so the throttle needed at a fixed load scales as 1/Vbat:
  Fireball 4500 median 73.5 % at 24.5-25.0 V and 90.6 % at 21.5-22.0 V.

## 4. Battery

### 4.1 Telemetry delays (`s3_sat.py vbat_lag`, cross-correlation of 0.3-5 Hz band-passed signals)

| | lag | n flights | correlation |
|---|---|---|---|
| Fireball `Vbat` after `motor[0] x headspeed` | 66 ± 4 ms (53-79) | 6 | -0.58 to -0.84 |
| Gaui `Vbat` after `motor[0] x headspeed` | 45 ± 2 ms | 10 | -0.87 to -0.98 |
| Gaui `Ibat` after `Vbat` | 41 ± 1 ms (36-44) | 10 | -0.95 to -0.98 |
| Gaui `Ibat` after `motor[0] x headspeed` | 87 ± 2 ms (73-96) | 10 | 0.85-0.96 |

### 4.2 Gaui: internal resistance and open-circuit trend (`s4_power.py battery_gaui`)

Model on 20 ms blocks, ACTIVE flight: `V = Voc0 + a1 Q + a2 Q^2 - R I`, Q = charge used (Ah, integrated `Ibat`).

| | value | spread |
|---|---|---|
| R (quasi-static) | **15.3 ± 0.5 mΩ** (10 flights) | 13.6-17.9 mΩ; in-flight bootstrap SE 0.2-0.5 mΩ |
| R (0.5-5 Hz band) | 16.0 ± 0.6 mΩ | 13.9-19.7 mΩ |
| dVoc/dQ | -1.60 ± 0.16 V/Ah | -1.15 to -2.59 |
| fit R², residual | 0.968 ± 0.004, 63 ± 4 mV RMS | |
| current in flight | mean 26.6 ± 0.8 A, p99 101 ± 5 A, max 81-170 A | |
| charge used per flight | 313-2547 mAh (mean 1090) | |
| resting voltage before spool-up | 22.91-24.87 V (3.82-4.15 V/cell); several flights start on a used pack | |
| minimum in flight | 20.01 V (3.34 V/cell, log 49, 208.33 s, 169 A) | |

R agrees with the earlier PWR-TELEMETRY-VALID value (14.9 ± 0.5 mΩ, `analysis/gaui-x4/20261004_233406/verify/PWR-TELEMETRY-VALID/vi_lag.out`).

### 4.3 Fireball: no current sensor

`Ibat` = 0 in 100 % of samples. A twin must treat an all-zero `Ibat` as "not recorded", not as zero current.
- Resting voltage before spool-up 25.12-25.25 V (6 flights; 4.19-4.21 V/cell): every flight starts on a full pack.
- Under load: first 20 s 24.42-24.77 V, last 20 s 21.98-22.50 V, minimum 20.96-21.67 V (3.49-3.61 V/cell).
- Sag model without current (motor model of 5.1 substituted for the current): `V = Voc(t) - α D² V + β D ω`, with α = R_batt/R_motor and
  Kv = α/β. On 20 ms blocks: R² 0.991-0.997 (6 flights), residual 46-74 mV RMS, `dVoc/dt` = **-1.90 ± 0.11 V per 100 s** of flight,
  α = 0.124 ± 0.013. Kv from this model: 285 ± 8, 275 ± 9, 334 ± 35, 291 ± 33 rotor rpm/V (logs 5, 10, 11, 13); logs 14 and 15 do not identify it (SE > 1700).
- The same model on the Gaui (where the current is known): Kv 156-179 rotor rpm/V in 9 of 10 flights (-1 to +13 % against 157.8 from the current), one
  failure (log 47, negative). The no-current method therefore works to about ±10 % when the flight has enough load variation.
- A simple proxy `V = Voc(t) - k D ω` reaches R² 0.94-0.99 on the Fireball but only 0.40-0.96 on the Gaui (`fig_battery_motor.png`, right panel).

## 5. Motor, ESC and drivetrain

### 5.1 Gaui motor constants from the current (`s4_power.py motor_gaui`)

Steady DC-motor map: `D V = ω/Kv + R_m I_m` with `I_m = Ibat / D` (ESC as a buck converter). 20 ms blocks, lag-aligned.

| | value (10 flights) | spread |
|---|---|---|
| Kv (rotor rpm per volt of D·V) | **157.8 ± 0.4** | 155.8-159.1; in-flight SE 0.1-0.5 |
| R_m (motor + ESC + wiring, motor side) | **22.2 ± 0.6 mΩ** | 20.0-25.2 |
| fit R² | 0.89 ± 0.02 | 0.81-0.96 |
| Kt at the rotor = 60/(2π Kv) | 0.0605 N·m per motor A | |
| motor current, mean in flight | 37.3 ± 0.7 A | |
| electrical power, mean / p99 | 604 ± 17 W / 2205 ± 114 W | |
| current predicted by the map against `Ibat` | R² 0.84 ± 0.02 | 0.78-0.92 |

- An offset term (`D V = d0 V + ω/Kv + R_m I_m`) is not identifiable (d0 = 0.08 ± 0.07, unstable Kv); the gain-only map is used.
- Current proxies without a motor model fit badly: `D ω` R² 0.10-0.93, `D² V` 0.27-0.95, collective² x ω³ 0.57-0.82.

### 5.2 Fireball Kv without current: three methods agree

| Method | Kv (rotor rpm/V; direct drive, so also motor rpm/V) | n |
|---|---|---|
| Battery sag model (4.3) | 275-334 (4 flights identify it) | 4 |
| Spool-up regression `dω/dt = a_u (D V - ω/Kv) - q ω²` on the ground (`s5b_spool.py`, 60 ms delay) | median **313** (IQR 289-352); 2 outliers 483, 610; log 15 not identified | 9 |
| Output-error fit on 2-s flight windows (`s5c_oe.py`, `s5d_oe_esc.py`) | 316-319 | 349 windows |

Fireball Kv ≈ 300-320 rotor rpm/V. Spool-up regression on the Gaui fails (negative back-EMF term in 9 of 10 runs), so method 2 is not general.

### 5.3 Rotor-speed dynamics (input to the twin)

Output-error fits of `dω/dt = a_u (De V - ω/Kv) - ω² (q0 + q1|c| + q2 c² + q3 cyc²)` with a first-order ESC lag `De' = (D - De)/τ_esc`,
2-s windows at 100 Hz, half for training, half for test (`oe_esc_fit.json`):

| | a_u (rad/s² per V) | Kv | τ_esc | test RMS rpm | hold-last-value RMS rpm |
|---|---|---|---|---|---|
| Gaui, free | 37.2 | 169.7 | 0.098 s | **20.7** | 35.4 |
| Gaui, a_u and Kv fixed from the current (150, 157.8) | 150 | 157.8 | 0.060 s | 30.8 | 35.4 |
| Fireball, free | 31.8 | 315.6 | 0.113 s | **82.2** | 128.6 |

- A pure-delay version (`oe_fit.json`) improves monotonically up to the largest delay tried (0.12 s), so the throttle-to-torque path has
  about 0.1 s of lag (ESC response; the headspeed source is not delayed, see 6.2).
- **Torque authority is not identified by voltage-only fits.** The current-based torque balance on the Gaui
  (`Kt I_m = J dω/dt + Q_aero`) gives J/Kt = 0.16-0.39 A·s/rad depending on the current alignment (spool-ups: 0.34 ± 0.04, n 10, R² 0.90),
  so J = 0.010-0.024 kg·m² and a_u = 1/(R_m J/Kt) = 115-280. The free output-error fit gives a_u = 37, which needs J = 0.074 kg·m².
  The closed loop hides the difference: the native governor law (P, I from the header, F from the log) flying either plant reproduces the
  logged headspeed to 11.7 rpm (free fit) or 13.5 rpm (current-based) RMS, against a 25.6 rpm signal SD, and `motor[0]` to 0.93 % or 1.01 %
  (`s5e_closed.py`, `closed_check.json`, 120 windows). This is the same feedback bias as in the 6-DOF twin (`analysis/twin6dof`, memory note "fits of
  feedback data bias authority down ~3x").
- The present 6-DOF twin rotor subsystem (`heli_twin.cjs:46-48, 56-57, 186-188`) sits on its bounds in both production fits
  (`analysis/twin6dof/out/prod3_*/model.json`): Gaui `kmV = 1` (upper bound), `ir = 0.0432` (upper bound, 3 x prior 0.0144), `tauEsc = 1`,
  `tauHs = 1`; Fireball `ir = 0.00569` (upper bound), `tauEsc = 1`, `tauHs = 0.004` (lower bound). Implied Kv: Gaui 199, Fireball 391 rotor rpm/V,
  against 157.8 and about 310 measured here. With the Gaui values (Kt/R_m = 2.73 N·m/V) `kmV` is outside its range [1e-4, 1].
- Spool-down with throttle 0 on the ground: `dω/dt = -(q/J) ω²` fits only partly (Fireball R² 0.30-0.72, q/J 0.0029-0.0086; Gaui R² 0.00-0.62);
  the pilot holds the collective at -1.04 to +0.16 during it, so it is not a clean drag test.

### 5.4 ESC temperature

| | Tesc start → end of flight °C | max °C | slope °C/min | update interval |
|---|---|---|---|---|
| Fireball (6 flights) | 40-63 → 54-64 | 54-65 | -1.2 to +3.6 | 60-100 ms |
| Gaui (10 flights) | 37-56 → 52-59 | 54-64 | 0.1-9.0 | 102-745 ms |

Back-to-back flights start warm (Fireball log 13 starts at 63 °C). Tesc is too slow and too coarse (1 °C) for the governor dynamics.

## 6. Spool-up, handover, bailout, fallback

### 6.1 Spool-up ramps (`s6_spool.py`, `fig_spoolup.png`)

The throttle ramps are exact firmware rates (`govCalcRate` = 10/param per s, `flight_governor.c:1603-1609, 1644-1648`), so the timing
parameters can be read from the log although the header does not hold them:

| Heli, logs | IDLE ramp %/s → gov_startup_time | SPOOLUP ramp %/s → gov_spoolup_time | AUTOROTATION ramp-down %/s → gov_spooldown_time |
|---|---|---|---|
| Fireball 5 | 5.00 → 200 | 10.00 → 100 | 10.0 → 100 |
| Fireball 6, 8 (bench) | 5.00 → 200 | 10.00 → 100 | 13.3 → 75 |
| Fireball 9 (bench) | 10.01 → 100 | 12.50 → 80 | 20.0 → 50 |
| Fireball 10-15 | 10.01 → 100 | 12.50 → 80 | 12.5 → 80 (= CLI 2026-10-13) |
| Gaui 38-45 | 4.00 → 250 | 5.00 → 200 | 33.3 → 30 |
| Gaui 46-49 | 4.00 → 250 | 6.66 → 150 | 33.3 → 30 |

**The Fireball governor timing changed between logs 5 and 10 with no change in the header** (all headers `govPID = 18,60,2,32,55`).
The bench runs 6, 8 and 9 sit between those changes. Logs 10-15 match the CLI dump of 2026-10-13. The Gaui spool-up change at log 46 agrees
with the earlier Gaui finding (`analysis/gaui-x4/20261004_233406/FINDINGS.md:338`).

Handover SPOOLUP→ACTIVE. The firmware leaves SPOOLUP at headspeed > 0.99 x request or throttle > 0.95 x `gov_max_throttle` (`flight_governor.c:1146-1147`);
with `gov_use_pid_spoolup = OFF` the spool-up is an open-loop throttle ramp (`flight_governor.c:906-926`, target = present headspeed).

| Heli | ramp | n | exit | overshoot after ACTIVE % (values) | t of peak s | settle 1 % s | SPOOLUP start to settled s |
|---|---|---|---|---|---|---|---|
| Fireball | 10 %/s | 4 | headspeed 99.1-99.4 % | 3.9, 4.7, 4.8, 7.1 | 0.42-0.53 | 0.95-1.26 | 6.7 (3500), 9.1-9.3 (4500) |
| Fireball | 12.5 %/s | 6 | 5 x headspeed, 1 x throttle 95 % | **8.3, 9.1, 12.9, 13.0, 13.0, 13.2** (median 12.9) | 0.78-1.66 | 1.41-2.44 | 7.2-9.0 |
| Gaui | 5.0 %/s | 6 | headspeed | 0.35-1.20 | | 0-0.25 | 9.6-12.1 |
| Gaui | 6.66 %/s | 4 | headspeed | 1.17-3.35 | | 0-0.79 | 7.6-8.8 |

- Fireball, 12.5 %/s: the throttle reaches 84.5-85.5 % at handover at 3500 rpm, while 3500 rpm on the ground needs about 52 %. The rotor lags
  the ramp, the I-term is set to the handover throttle (`flight_governor.c:945-954`), and the rotor overshoots by 13 % before the P-term pulls the
  throttle back to 45-55 %.
- Fireball log 15 armed in PID profile 2 (4500 rpm): SPOOLUP ended by the 95 % throttle rule at 3747 rpm (83 %), then 9.1 % overshoot, settled after 2.4 s.

### 6.2 FALLBACK events (Fireball only; `fig_fallback.png`)

| | log 11, 54.33 s | log 11, 158.71 s | log 14, 192.68 s (rescue at 193.04 s) |
|---|---|---|---|
| Profile | 2 (4500) | 2 (4500) | 2 (4500) |
| `motor[0]` = 100 % for, before entry | 0.17 s | 0.24 s | 0.28 s |
| \|collective\| | 0.65 | 0.89 | 1.04 |
| true headspeed droop before entry | to 3859 rpm (-14 %) | to 3505 rpm (-22 %) | to 3363 rpm (-25 %) |
| headspeed signal jump at entry | 3859 → 5015 rpm in 11 ms (max 355 rpm per sample) | 3563 → 5269 rpm in 26 ms (290 per sample) | 3463 → 5334 rpm in 36 ms (312 per sample) |
| \|headspeed - PT2(headspeed, 10 Hz)\| vs glitch limit 0.25 x 4500 = 1125 rpm | 1051 | **1276** | **1316** |
| FALLBACK duration | 0.202 s | 0.203 s | 0.212 s |
| throttle in FALLBACK = 0.9 x govI (predicted / logged) | 68.8 / 68.8 % | 67.1 / 67.2 % | 71.9 / 71.9 % |
| RECOVERY duration, ramp | 0.48 s, 50.0 %/s | 0.79 s, 50.0 %/s | 0.86 s, 50.0 %/s |
| headspeed minimum | 3606 (80 %) | 2574 (57 %) | 2547 (57 %) |
| time below 90 % of request | 0.56 s | 2.16 s | 1.24 s |
| back within 1 % after | 0.66 s | 2.36 s | 1.48 s |
| Vbat at entry | 23.22 V | 21.88 V | 21.17 V |

Firmware chain (`flight_governor.c`): the RPM glitch test `|rpm - PT2(rpm, gov_rpm_filter)| > 0.25 x gov_headspeed / gear` (lines 55, 588, 1596)
clears `motorRPMGood` for at least `GOV_HS_DETECT_DELAY` = 200 ms (lines 51, 594-606) → ACTIVE→FALLBACK (1163-1164). FALLBACK throttle =
`(I + F) x (100 - gov_fallback_drop)/100` with F = 0 because `gov_use_fallback_precomp = OFF` (979-995, 1583) → a step from 100 % to 67-72 % at
full collective → RECOVERY from the present headspeed at `gov_recovery_time = 20` (50 %/s) (997-1010, 1066-1069) → exit by the 95 % throttle rule
(1196-1197) → ACTIVE with the target ramping up from 57-80 % at the tracking rate (973). The logged headspeed is filtered (`motor_rpm_lpf = 100`),
so the raw value that the firmware tests was larger than the 1051 rpm of the first event.

RPM-signal census, ACTIVE in flight (`s6_spool.py glitch_census`, `fig_saturation_vbat.png` left):

| `motor[0]` | 0-90 % | 90-95 % | 95-98 % | 98-99.9 % | 100 % |
|---|---|---|---|---|---|
| seconds | 1337.1 | 61.8 | 10.1 | 5.4 | 18.1 |
| headspeed steps > 50 rpm per 1 ms sample | 3 | 0 | 0 | 0 | **65** (3.6 per s) |
| steps > 100 rpm | 0 | 0 | 0 | 0 | 26 |

- A step of 300 rpm in 1 ms needs about 30 000 rad/s² of rotor acceleration; the signal jumps are not rotor motion.
- They come only at 100 % throttle, 0.15-0.52 s after it starts, in 5 of 51 runs at 100 %. The Gaui has 0 such steps in 1368 s (it never reaches 100 %).
- The jumps start the FALLBACK; the FALLBACK throttle step (100 → 67-72 %) then causes most of the headspeed loss (from -14..-25 % to -43 %).

### 6.3 BAILOUT on the ground (Fireball log 10, `fig_bailout.png`)

- 10.71 s: throttle switch to the middle position (509) on the ground → AUTOROTATION; the throttle ramps down at 12.5 %/s; the headspeed signal
  drops to 0 below about 500 rpm (15.1 s).
- 16.75 s: switch back to 1000. 17.3 s: the RPM signal returns (240 rpm); the AUTOROTATION throttle rises to the handover 25 % (`flight_governor.c:1063-1064`).
- 17.63 s: BAILOUT (still inside the 15 s `gov_autorotation_timeout`, `flight_governor.c:1207-1208`) ramps at the recovery rate 50 %/s from 25 % to
  95 % in 1.41 s; exit by the 95 % rule at **721 rpm (21 % of 3500)**.
- ACTIVE then holds 100 % for 4.13 s while the target ramps, and the headspeed overshoots to 4050 rpm (+15.7 %) at 24.3 s.
  A normal spool-up of the same flight takes 5.7 s at 12.5 %/s with a 13 % overshoot.

### 6.4 Rescue

| Heli | log, t | s | headspeed min % | `motor[0]` max | s at >= 98 % | states |
|---|---|---|---|---|---|---|
| Fireball | 5, 136.16 | 0.87 | -1.8 | 91.9 | 0 | ACTIVE |
| Fireball | 13, 104.87 | 5.74 | -7.8 | 100 | 0.16 | ACTIVE |
| Fireball | 13, 188.10 | 1.54 | -7.9 | 100 | 0.14 | ACTIVE |
| Fireball | 14, 193.04 | 2.39 | **-43.4** | 100 | 0.28 | ACTIVE, FALLBACK, RECOVERY |
| Fireball | 15, 150.65 | 1.53 | -3.0 | 100 | 0.29 | ACTIVE |
| Gaui | 48, 117.65 / 49, 208.30 | 1.09 / 2.07 | -1.8 / -4.8 | 75.6 / 93.9 | 0 | ACTIVE |

## 7. The firmware law against the logged terms

### 7.1 Sum and output

- `govSum - (govP + govI + govD + govF)`: mean +0.4 to +0.6 count, |max| 3 counts (Fireball, 1.46 M ACTIVE samples) and 2 counts (Gaui,
  1.40 M). The difference is the integer rounding of each term plus the C increment (`flight_governor.c:957`).
- `motor[0] - govSum` in unsaturated ACTIVE (100-980): 0 or 1 count in **100 %** of 2.84 M samples (Fireball 1.44 M, Gaui 1.40 M), median ratio 1.0000 (Gaui flights 1.0000-1.0013).
  So `throttle = pidSum x voltageCompGain` (`flight_governor.c:960`) with gain = 1 on both helicopters: **voltage compensation is inactive**.
  - Fireball: `gov_use_voltage_comp = OFF` (CLI 995, 1101, 1207), and with `battery_meter = ESC` (CLI 657) the firmware disables it anyway:
    `useVoltageComp` needs `getBatteryVoltageSource() == VOLTAGE_METER_ADC` (`flight_governor.c:1556`).
  - Gaui: inactive (flag off or a non-ADC source); its `Vbat` is ESC telemetry too.
  - If it were active: gain = clamp(cells x 3.7 V / PT2(Vbat, gov_pwr_filter), 0.8, 1.2) (`flight_governor.c:490-509`): 0.888 at 25.0 V, 1.021 at 21.75 V.

### 7.2 Gains recovered from the terms (`s7_gains.py`, `gains.json`)

| Term | Fireball (3500 / 4500 / 5000) | expected from header/CLI | Gaui (2300 / 2500 / 2700) | expected from header |
|---|---|---|---|---|
| `govP` / e, e = (govTarget - PT2(headspeed, 10 Hz)) / govRequest | 975 / 975 / 971 (R² 0.998-0.9998, 11 flight-profile pairs) | 1000·K·Kp = 990 | 1564 / 1566 / 1564 (R² 0.997-0.9998) | 1600 |
| d`govI`/dt / e (unsaturated) | 3304 / 3296 / 3296 per s | 1000·K·Ki = 3300 | 1995 / 1998 / 2001 | 2000 |
| `govD` | \|D\| <= 2 counts, non-zero in 0.04 % | Kd = 2/1000: 1.1 counts per unit error rate | 0 | 0 |
| F: collective weight, exponent | 100.0 ± 0.0 / **150.2 ± 0.1** / 100.2 ± 0.2 %, exponent 2.0 | 100 / 150 / 100, curve 20 | 49.9 ± 0.3 / 49.5 ± 0.4 / 49.8 ± 0.3 % | default 50 |
| F: cyclic weight | 34.4 / 34.5 / 34.4 % (± 0.1-0.2) | 35 | 6.6 ± 0.3 / 6.9 ± 0.4 / 6.1 ± 0.3 % | default 10 |
| F: yaw weight | 4.7 / 4.5 / 4.4 % (± 0.05-0.1) | 5 | not identified (26-55 %, SE 7-23) | default 10 |
| F fit R² (5 Hz PT2) | 0.997-0.9999 | `gov_ff_filter = 5` | 0.73-0.85 (`govF` is 0-63 counts; rounding) | |

- With the PT2 10 Hz filter the P fit has R² 0.998-0.9999; without it 0.92-0.99. This confirms `gov_rpm_filter = 10` (`flight_governor.c:576, 1666`).
  The 1.5-2.3 % shortfall of the P slope is the difference between the logged headspeed (`motor_rpm_lpf`) and the raw RPM the firmware uses.
- The Fireball CLI dump of 2026-10-13 holds the gains and weights that the 2026-10-04/05 logs show, profile by profile (including collective 150 on profile 2).
- Gaui: one gain set in all three profiles (header `govPID = 40,50,0,10,40`, the defaults).

### 7.3 Terms against their limits (`term_ranges.json`)

| Heli, headspeed | govP p1 / p99 / extreme | govI p1 / p50 / p99 / max | govF p50 / p99 / max | limits (CLI or default) |
|---|---|---|---|---|
| Fireball 3500 | -77 / 60 / -118 | 505 / 533 / 741 / 809 | 42 / 210 / 228 | p 300, i 950, f 400 |
| Fireball 4500 | -35 / 71 / 240 | 651 / 767 / 836 / **945** | 24 / 186 / 335 | |
| Fireball 5000 | -17 / 50 / 131 | 795 / **852** / 910 / 917 | 16 / 82 / 169 | |
| Gaui 2300 | -41 / 46 / -85 | 620 / 664 / 718 / 825 | 8 / 48 / 62 | p 200, i 950, f 1000 (defaults assumed) |
| Gaui 2500 | -44 / 64 / 89 | 662 / 723 / 792 / 825 | 7 / 53 / 63 | |
| Gaui 2700 | -35 / 58 / 88 | 720 / 786 / 838 / 854 | 8 / 47 / 62 | |

No term reaches its limit in ACTIVE flight. Fireball `govI` reaches 945 of 950 once (4500 rpm), and at 5000 rpm the I-term alone carries 85 % throttle.

## 8. Every governor parameter: what the logs tell

| Parameter | Fireball | Gaui | Log evidence, identifiable? |
|---|---|---|---|
| `gov_mode` | ELECTRIC (CLI 712) | electric governor | states + PID terms logged |
| `gov_throttle_type` | FUNCTION (CLI 713) | FUNCTION-like 3-position (0/509/1000) | `rcCommand[4]` values, AUTOROTATION at 509 |
| `gov_startup_time` | 200 (logs 5-8) → 100 | 250 | IDLE ramp slope, exact (6.1) |
| `gov_spoolup_time` | 100 (logs 5-8) → 80 | 200 (38-45) → 150 (46-49) | SPOOLUP ramp slope, exact |
| `gov_tracking_time` | 50 | 50 | target slew / motorRPMK (2.3) |
| `gov_recovery_time` | 20 | not exercised | RECOVERY/BAILOUT ramp 50 %/s |
| `gov_spooldown_time` | 100 → 75 → 50 → 80 (logs 5 / 6-8 / 9 / 10-15) | 30 | AUTOROTATION/HOLD ramp-down |
| `gov_throttle_hold_timeout` | not exercised (no HOLD) | 50 (HOLD 5.0 s) | HOLD duration |
| `gov_autorotation_timeout` | 15 (AUTOROTATION→IDLE after 15.00 s) | > 0, >= 2 s | AUTOROTATION duration; BAILOUT inside it (6.3) |
| `gov_handover_throttle` | 25 | not seen | AUTOROTATION throttle capped at 25.0 % (6.3) |
| `gov_idle_throttle`, `gov_auto_throttle` | 0, 0 (CLI) | IDLE ramp to 13.3-14.8 % when RPM is detected | motor[0] in IDLE/AUTOROTATION |
| `gov_bypass_throttle` | unused | unused | no BYPASS state |
| `gov_pwr_filter` | used only by voltage compensation: inactive | same | — |
| `gov_rpm_filter` | 10 Hz | 10 Hz | P-term fit R² 0.999 with PT2 10 Hz |
| `gov_ff_filter` | 5 Hz | 5 Hz (best of 2/5/10/20) | F fit |
| `gov_d_filter` | D ≈ 0 | D = 0 | — |
| `gov_tta_filter`, `gov_tta_gain/limit` | TTA off (header `yaw_tta = 0,20`) | off | — |
| `gov_headspeed` | 3500 / 4500 / 5000 | 2300 / 2500 / 2700 | `govRequest` |
| `gov_gain`, `p/i/d/f_gain` | 55, 18, 60, 2, 32 | 40, 40, 50, 0, 10 | header `govPID` (start profile) + term fits for every profile |
| `gov_p/i/d/f_limit` | 30 / 95 / 5 / 40 | unknown (defaults 20/95/20/100) | term ranges, never at a limit |
| `gov_collective/cyclic/yaw_ff_weight`, `gov_collective_curve` | 100,150,100 / 35 / 5 / 20 | 50 / 6.6 (?) / ? / 20 | F fit (7.2) |
| `gov_max_throttle` | 100 | >= 94, not reached | pile-up of `motor[0]` |
| `gov_min_throttle` | 10 | unknown | ACTIVE minimum 50 % (Fireball): never reached |
| `gov_fallback_drop` | 10 | not exercised | FALLBACK throttle = 0.9 x govI, exact |
| `gov_dyn_min_throttle` + flag | 80, OFF | unknown | ACTIVE minimum far above min_throttle: no effect visible |
| `gov_use_fallback_precomp` | OFF | not exercised | F absent in FALLBACK, exact |
| `gov_use_pid_spoolup` | OFF | OFF (open-loop ramp) | target = headspeed during SPOOLUP |
| `gov_use_voltage_comp` | OFF and disabled by the ESC source | inactive | motor[0] = govSum |

## 9. Problems found, for the autotune recommendations

Each item has the number that the autotune rule must test.

1. **Power limit on the Fireball, profiles 2 and 3.** 1.7 % of ACTIVE flight time at >= 98 % throttle; 36 % (4500) and 62 % (5000) below 22.0 V;
   p99 motor-voltage demand 21.6-21.7 V against 21.98-22.50 V at the end of every pack; droop at the limit -12.4 % median (-22 %/unit collective,
   3.6 x the unsaturated value). The demand scales as 1/Vbat because voltage compensation is not available (item 5). Levers: `gov_headspeed`
   (the D·V table of section 3 gives the voltage limit per headspeed), pack voltage at landing, collective-pitch range.
2. **RPM signal jumps at 100 % throttle → FALLBACK → -43 % headspeed.** 65 of 68 jumps at exactly 100 %; 0 between 90 and 99.9 % (77 s, of which
   only 5.4 s at 98-99.9 %). Three FALLBACKs, all at the limit, one inside a rescue. Levers: `gov_max_throttle` below 100 (keeps the ESC out of
   full duty; evidence limited to 5.4 s at 98-99.9 %), `gov_use_fallback_precomp = ON` (keeps F = 19-34 % in FALLBACK instead of the 0.9 x I
   step), smaller `gov_fallback_drop`, and examination of the RPM sensor signal at full throttle.
3. **Spool-up overshoot on the Fireball.** 12.9 % median (n 6) at `gov_spoolup_time = 80` against 3.9-7.1 % (n 4) at 100; the Gaui at 150-200 has 0.3-3.4 %.
   Levers: `gov_spoolup_time`, `gov_use_pid_spoolup`.
4. **BAILOUT from a stopped rotor on the ground.** Inside the 15 s `gov_autorotation_timeout` a throttle switch back gives a 50 %/s ramp, ACTIVE at
   21 % headspeed, 4.1 s at 100 % and +15.7 % overshoot. Levers: `gov_autorotation_timeout`, `gov_recovery_time`, pilot procedure (hold position 0 for a
   ground stop: HOLD/OFF instead of AUTOROTATION).
5. **Voltage compensation inactive.** Both helicopters; with `battery_meter = ESC` the flag cannot work (`flight_governor.c:1556`). Fireball 4500
   median throttle 73.5 % → 90.6 % over a pack; the loop gain of the plant (∝ Vbat) changes by the same 23 %. The autotune must say that the flag
   needs an ADC voltage source, and size the gains for the low-voltage end.
6. **Load-step droop and overshoot.** Unsaturated: Fireball -2.0 % / +2.7 % (6.2 and 9.1 %/unit), Gaui -2.8 % / +2.1 % (6.1 and 6.2 %/unit),
   recovery 0.9 s. Levers: `gov_collective_ff_weight` / `gov_collective_curve` (the FF is exactly known, 7.2), `gov_gain`/`p`/`i`.
7. **Parameter epochs.** The Fireball governor timings changed 3 times between logs 5 and 10 with identical headers; they are measurable from the ramp
   slopes (6.1). The autotune must attach each result to its epoch.
8. **I-term headroom.** Fireball 5000 rpm: `govI` median 85 %, max 92 %; 4500: max 94.5 % of the 95 % `gov_i_limit`.

## 10. Implications for the governor twin

- Inputs always present: `motor[0]`, `Vbat` (with 45-66 ms telemetry delay), `headspeed`, `mixer[0..3]`, `govRequest`, GOVSTATE events.
  `Ibat` is optional: the Fireball logs all zeros. Detect "all zero" as missing.
- Battery: `V = Voc(charge or time) - R_batt I`, I = D (D V - ω/Kv)/R_m. With current (Gaui): R_batt 15.3 mΩ, Voc slope -1.60 V/Ah. Without current:
  α = R_batt/R_m and Kv from the sag model (Fireball α 0.124, Kv ≈ 300) and Voc(t) -1.90 V per 100 s.
- Motor/ESC: steady map `D V = ω/Kv + R_m I_m` (Gaui Kv 157.8, R_m 22.2 mΩ, R² 0.89); about 0.1 s ESC lag; the governor law of the native C code
  (gains confirmed to 0.1-2 %, F weights to 0.2 %).
- Inertia/authority: voltage-only and closed-loop fits do not fix J·R_m (factor 3-7). Fix it from the current where it exists (Gaui J 0.010-0.024 kg·m²),
  else from open-loop segments (spool-up ramps, FALLBACK steps of 28-33 % throttle, BAILOUT ramps), and validate on the step metrics of 2.2.
- The twin must reproduce: step droop 6 %/unit and 0.9 s recovery; saturation droop 22 %/unit; spool-up overshoot 4-13 % by ramp rate; the
  FALLBACK sequence (needs an RPM-signal glitch input at 100 % throttle on the Fireball).

## 11. Limits of this evidence

- The Gaui has no CLI dump: its limits, `gov_max_throttle`, `gov_min_throttle`, `gov_fallback_drop`, flags and yaw weight are not known.
- Fireball 3500 rpm has only 37.5 s of ACTIVE flight and 5 load steps; 5000 rpm has 183 s and 9 steps.
- Only 5.4 s at 98-99.9 % throttle: "no RPM jumps below 100 %" is a weak result for the 98-99.9 % range.
- Load steps use |collective|; steps that cross zero pitch are not counted.
- Rotor inertia and ESC lag from voltage-only data are biased by the closed loop (5.3); current-based J depends on the current alignment (0.16-0.39 A·s/rad).
