# The app's governor stack (2026-10-14): what exists, what it measures, the gaps, where a governor twin plugs in

Scope: read-only map of everything in the app that touches the Rotorflight 4.6 governor, with file:line, thresholds and
the parameter each item recommends. Numbers marked "probe" come from `gov_stack_probe.cjs` and `gov_term_limits.cjs` in
this directory (outputs in `data/`), which call the unmodified toolkit modules on the two reference dumps:

- Fireball: `RTFL_BLACKBOX_LOG_SAB_Fireball_20261005_204823.BBL`, logs 5-15 (0-based; 1-based 6-16; logs 7 and 12 give no
  segment), CLI dump `RTFL_cli_SAB_Fireball_20261013_184504.txt`. Flown: 5, 10, 11, 13, 14, 15 (6 flights, 1474 s in ACTIVE).
- Gaui X4 II: `RTFL_BLACKBOX_LOG_20261004_233406.BBL`, logs 37-49, `AUTOTUNE_FLIGHT_RPM=2000`, no CLI. Flown: 38-41, 43,
  45-49 (10 flights).

---------------------------------------------------------------------------------------------------------------------------

## 0. Summary

1. **No governor parameter is tuned from a model today.** CLI text exists only for 4 gains (gov_f_gain G3/G4, gov_p_gain
   G5/G9, gov_i_gain G9, gov_gain G10), each a documentation step (+10 F, +10 P, x2/3 on oscillation, x0.9) sized by no
   model. `gov_spoolup_time` (G15) is a "check" with x1.2 and no CLI. The other 37 of the 42 governor CLI names are at
   most named in a text, or not mentioned (table in section 9).
2. **The closed-loop governor path of `control_pipeline.cjs` cannot become active on a real configuration.** The WASM
   needs `voltage_meter` and `battery_cell_count` (`firmware/schema.cjs:20-21`) with `executeGovernor`; no code maps the
   CLI name `battery_meter` to `voltage_meter`, and the Fireball's `battery_cell_count = 0` (auto) is out of the schema
   range 1-24. Verified (`vm_config_check.cjs` in this directory): `firmware_controller.fromHeader` on the Fireball CLI leaves `voltage_meter` missing and gives
   "out of its range: battery_cell_count" (`compatibility`, `firmware_controller.cjs:124,141`). The unit tests pass only
   because the fixture starts from `firmware.defaults()` (voltage_meter 1 = ADC, cells 6; `test/control_pipeline.test.cjs:15,725`).
   Prior runs record the same: `analysis/control-digital-twin-20261014/latest-gain-rearm.json` lists `voltage_meter` and
   `battery_cell_count` as unresolved, with "unverified release default" ADC.
3. **Battery voltage is mandatory and current is unused.** `governorInputs` refuses a period without `Vbat`
   (`control_pipeline.cjs:415`) although the firmware governor reads it only for voltage compensation; the twin treats
   `Vbat` as an exogenous input (`heli_twin.cjs:187`, `control_pipeline.cjs:640,714`), so a gain or headspeed change
   cannot change the sag. `Ibat` is read only by P1/P2 (`health_power.cjs`).
4. **The governor search is narrow.** Candidates are `gov_[pidf]_gain|gov_gain` at x0.8/0.9/1.1/1.2, one at a time
   (`control_pipeline.cjs:866-879`); `gov_d_gain` is never a candidate (no `advice.RANGE` entry, `advice.cjs:214`); P and
   I can only decrease (`control_pipeline.cjs:1023-1024`, the "no raise of feedback gains" filter matches `gov_p_gain`,
   `gov_i_gain`). The objective is the RMS of `govTarget - headspeed` only (`:896`); throttle saturation, droop at
   collective steps, spool-up and FALLBACK are not scored.
5. **Voltage compensation with an ESC voltage source is not explained anywhere.** The firmware turns it off unless the
   battery voltage meter is the ADC (`flight_governor.c:1556`). G8 measures that compensation is off (Fireball and Gaui:
   `motor[0]/govSum` median 1.000, probe) but no check reads `battery_meter`; only the G11 text says "with an ADC battery
   voltage source" (`advice.cjs:1093`), and G11 is "Monitor" at most (`catalog.cjs:713`).
6. **Power limit evidence exists but drives no parameter.** Fireball (probe): G6 flags in PID profile 2 (4500 rpm) in all 6
   flights, median throttle 78.4-81.7 %, profile 3 (5000 rpm) 87.0 % (> 85 % doc limit); L1 2.1-6.7 s at 100 % per flight;
   G11 +7.31 ± 0.33 points per pack and -2.95 ± 0.08 %/V (log 5); 2.1-6.7 s at the ceiling in ACTIVE per flight, at a median
   `Vbat` of 21.7-22.2 V against 22.7-23.3 V unsaturated, and at 55-78 % of the ACTIVE time (log 10: 8 %). All 3 FALLBACK
   entries (logs 11, 14) are "overload" (G20: throttle >= 95 % for 0.20-0.33 s, headspeed -5.4 to -19.1 % before the
   change); G19 log 14: -41.5 % headspeed at a rescue. The texts send the pilot to the battery, ESC and a lower headspeed
   (`governorLimitProcedure`, `advice.cjs:1374-1390`); no rule sizes `gov_max_throttle`, `gov_headspeed`,
   `gov_fallback_drop`, `gov_use_fallback_precomp` or `gov_recovery_time`.
7. **Spool-up is measured, not tuned.** Fireball G16 flags in 5 of 5 measured handovers: +7.1 to +13.2 % over target, 0.95-2.44 s to
   settle (gov_spoolup_time 80, implied 80 from the ramp 12.43 %/s, `gov_use_pid_spoolup` OFF). The advice gives no CLI and
   says "The documentation gives no procedure" (`advice.cjs:1280`).
8. Tests: `node --test test/health_gov.test.cjs test/health_power.test.cjs`: 45 tests, 43 pass, 0 fail, 2 skipped
   (health_gov 31/31; health_power 12/14, the 2 real-log tests skip). With `AUTOTUNE_REAL_LOG` (Gaui 20261004_113720) and
   `AUTOTUNE_RESCUE_LOG` (Fireball 20261005_204823): health_power 14/14 pass, 20.2 s.

---------------------------------------------------------------------------------------------------------------------------

## 1. The parameter universe (firmware 4.6.0, vendored `tools/autotune/firmware/vendor`)

42 CLI names: 18 global (`governorConfig_t`, `pg_governor.h:72-91`, defaults `pg_governor.c:30-49`) and 24 per PID profile
(`governorProfile_t`, `pg_governor.h:46-68`, 4 of them flag bits `pg_governor.h:39-44`). The log header records only 7 of
them: `govPID` = P, I, D, F, gain and `yaw_tta` = tta_gain, tta_limit (Fireball header `govPID:18,60,2,32,55`, Gaui
`40,50,0,10,40`; `firmware_controller.cjs:50-51`, `health_setup.cjs:112,116`). All others need the CLI dump or an inference
from data.

| name | scope | firmware use (`flight_governor.c`) | Fireball CLI |
|---|---|---|---|
| gov_mode | global | 1619-1638 (ELECTRIC/NITRO need a fast RPM source), 1434-1459 | ELECTRIC |
| gov_throttle_type | global | 429-460: SWITCH sets request = stick x headspeed (443); FUNCTION maps stick thirds to idle/auto/max throttle (449-459) | FUNCTION |
| gov_startup_time | global | rate 1644; IDLE/HOLD up-slew 1052 | 100 |
| gov_spoolup_time | global | rate 1645; SPOOLUP slew 912, PID-spoolup target slew 904 | 80 |
| gov_tracking_time | global | rate 1646; ACTIVE target slew 973 via `govCalcHeadspeedRate` 562-565 | 50 |
| gov_recovery_time | global | rate 1647; RECOVERY/BAILOUT 1068, AUTOROTATION up 1064, BYPASS 1071 | 20 |
| gov_spooldown_time | global | rate 1648; down-slew IDLE/HOLD 1052, AUTOROTATION 1064 | 80 |
| gov_throttle_hold_timeout | global | x100 ms 1650; HOLD exit 1125 | 50 |
| gov_autorotation_timeout | global | x1000 ms 1651; useAutorotation 1557; AUTOROTATION exit 1211 | 15 |
| gov_idle_throttle | global | /1000 1653; IDLE floor 1052, spool-up floor 1578, FUNCTION low third 452; <= handover x10-1 (1470) | 0 |
| gov_auto_throttle | global | /1000 1654; `isAutorotation` 389-392, AUTOROTATION floor 1064, FUNCTION middle 455 | 0 |
| gov_handover_throttle | global | /100 1656; IDLE->SPOOLUP 1115, ACTIVE->HOLD/AUTO 1157, PID spool-up 918, max_throttle >= it 1481 | 25 |
| gov_bypass_throttle[9] | global | /200 1658-1659; BYPASS curve on collective 415-427 | 0 x 9 |
| gov_pwr_filter | global | PT2 on Vbat 1665, 499 (voltage compensation only) | 5 |
| gov_rpm_filter | global | PT2 on motor RPM 1666, 576; glitch test 588 | 10 |
| gov_tta_filter | global | PT2 on yaw 1667, 517 | 0 |
| gov_ff_filter | global | PT2 on total F 1668, 485 | 5 |
| gov_d_filter | global | differentiator 1661, 622 | 50 |
| gov_headspeed | profile | full headspeed 1592, request 1594, error normalization 621, glitch limits 1596-1597 | 3500/4500/5000 |
| gov_min_throttle | profile | /100 1576; ACTIVE and FALLBACK floor 1058, 1061 | 10 |
| gov_max_throttle | profile | /100 1575; ACTIVE/FALLBACK/BYPASS ceiling, spool-up ceiling 1579, ACTIVE at 95 % of it 1146 | 100 |
| gov_gain | profile | K 1559 on P, C, D (625-627), F (482), TTA scale 1533 | 55 |
| gov_p_gain / i / d / f | profile | Kp /10, Ki /10, Kd /1000, Kf /100 (1560-1563) | 18 / 60 / 2 / 32 |
| gov_p/i/d/f_limit | profile | clamps 1565-1573, F floor 0; applied 935-938 | 30 / 95 / 5 / 40 |
| gov_tta_gain, gov_tta_limit | profile | `govInitTTA` 1523-1541, `govCalcTTA` 511-534 (headroom 2 x max(1 + limit - HS ratio, 0)) | 0, 20 |
| gov_yaw/cyclic/collective_ff_weight, gov_collective_curve | profile | 1587-1590; `govCalcFeedforward` 470-488, curve exponent /10 (465-468) | 5 / 35 / 100-150, 20 |
| gov_fallback_drop | profile | ratio (100 - drop)/100, drop 0-50 (1583); FALLBACK throttle = (I + F) x vcomp x ratio (988-991) | 10 |
| gov_dyn_min_throttle | profile | /100 1585; floor = target / motorRPMK x it (536-548) | 80 |
| gov_use_fallback_precomp | flag 2 | F kept in FALLBACK, else F = 0 (982-985) | OFF |
| gov_use_voltage_comp | flag 3 | active only with **ADC voltage meter** and ELECTRIC (1556); gain clamp(cells x 3.70 / PT2(Vbat), 0.8, 1.2) (490-509, 63) | OFF (battery_meter = ESC) |
| gov_use_pid_spoolup | flag 4 | PID controls the spool-up above handover (877-926) | OFF |
| gov_use_dyn_min_throttle | flag 6 | ELECTRIC only (1555) | OFF |

Internal quantities a twin must reproduce: the motor constant `motorRPMK` (EWMA 0.05 Hz, updated only with throttle > 0.20
and HS ratio > 0.20; 66, 550-560), used by the target slew rate (562-565), RECOVERY start throttle (1006-1007) and the dynamic
minimum (539-541); RPM-good logic (200 ms detect delay, 0.05 ratio, glitch 0.25 / 2.0, rpmError < 0.01 ratio at throttle >
0.10; 50-60, 584-606); I anti-windup (C applied only when the throttle is not at a limit, 966-967); state machine 1090-1254;
spool-up ratio and "spooled up" used by the tail and TTA (293-357). Related non-governor values: `battery_meter`,
`battery_cell_count` (0 = auto), `vbat_*_cell_voltage`, `motor_poles`, `main_rotor_gear_ratio` (correct by rule).

---------------------------------------------------------------------------------------------------------------------------

## 2. Data each helicopter gives

| | Fireball | Gaui X4 II |
|---|---|---|
| I fields | rcCommand[0..4], setpoint, mixer[0..3], axis terms, gyroRAW, gyroADC, attitude, altitude, vario, Vbat, Ibat, Tmcu, Tesc, govP/I/D/F, govSum, govTarget, govRequest, headspeed, motor[0], servo[0..3] | same plus Vbec, Vbus |
| Vbat | ESC telemetry, 20.96-25.38 V in the flown logs (probe) | 20.01-24.88 V |
| Ibat | logged, 0 in every sample (ESC without current sensing) | logged: median 19-24 A, p99 67-127 A, max 170 A in ACTIVE (probe) |
| GOVSTATE events | yes | yes |
| CLI dump | yes (2026-10-13) | no: 35 of 42 governor names unknown |
| vcomp (G8, probe) | off: `motor[0]/govSum` p50 1.000 in every flight | off: p50 1.000-1.0013 |

Telemetry lags measured by the app: `Vbat` updates 28.6 Hz on the Fireball; `Vbat` lags `Ibat` by 36.6 ± 1.3 ms and
`motor[0]` by 67.5 ± 1.1 ms (Gaui; `health_power.cjs:39-41,64`).

---------------------------------------------------------------------------------------------------------------------------

## 3. Checks that touch the governor

Thresholds are the `DEFAULT_RULES` of each module; "sig 2" means the value must pass its threshold by 2 SE.

### 3.1 `health_gov.cjs` (analyse 122-510, judge 516-656; RULE 22-43, DEFAULT_RULES 46-63)

Reference model in the measurement: error = (target - PT2(rpm, 10 Hz)) / gov_headspeed, pidSum = P+I+C+D+F, throttle = pidSum
x vcomp (`:14-15`). The filter constants are fixed (`RULE.firmware` `:24`: rpmFilterHz 10, ffFilterHz 5), not read from
`gov_rpm_filter` / `gov_ff_filter` / `gov_pwr_filter`. Masks: ACTIVE and settled 1 s from state/profile changes (`:137-140`).

| id | measures (file:line) | threshold | recommends (advice.cjs) | evidence source |
|---|---|---|---|---|
| D5 | largest Vbat step in 10 ms, time under 3.0 V/cell (214-243) | step 1.0 V; 3.0 V/cell for 0.5 s | check (906-907), no parameter | pipeline, unvalidated |
| G13 | 1 % quantile of in-flight V/cell (241-242) | 3.3 V/cell | check (1102-1108), no parameter | pipeline, unvalidated |
| G0 | govSum and govI zero in flight -> DIRECT/LIMIT (246-250) | firmware | info (974-978); guard 8 drops gov gain changes (2097-2099) | firmware |
| G1 | FALLBACK entries; glitch proxy abs(hs - PT2) > 0.25 x HS, hs > 2 x HS, hs = 0 at motor > 10 % (167-186, 252-255) | 1 entry | check (979-994); holds every governor change (1730-1733); `G1:overload` watch via G20/K22 | firmware |
| G2 | median and 5-95 % of steady headspeed error, quiet collective, ACTIVE (263-272) | 1 % by 2 SE, band ±2 %, 10 s | diag (995-996), no parameter | pipeline, unvalidated |
| G3 | droop after collective rises >= 0.30 of one-sided travel, split by throttle at ceiling; share of the govSum increase from F (291-343, 621-649) | 5 % by 2 SE (good 3 %), 3 events | gov_f_gain +10, CLI, only when unsaturated droop > 5 % by 2 SE and F share + 2 SE < 50 % (997-1024) | pipeline, unvalidated; GOVT step |
| G4 | overshoot on rise ("load onset") and after drops (308-310, 640-653) | 3 % by 2 SE | gov_f_gain -10 on rise overshoot, CLI (1025-1035); text only on drop | pipeline, unvalidated; GOVT |
| G5 | time from peak droop to the 1 % band, unsaturated rises (311-315, 643-648) | 0.5 s by 2 SE | gov_p_gain +10, CLI unless censored (1036-1046) | pipeline, unvalidated; GOVT step |
| G6 | median throttle in ACTIVE; runs >= 0.1 s at the ceiling with deficit > 2 % (373-383, 566-573); ceiling = CLI gov_max_throttle, else a pile in motor[0], else 1000 (274-289) | median 85 %; any such run | check with `governorLimitProcedure`, no parameter (1047-1066) | doc (FlyRotor 75-85 %) |
| G7 | govSum x vcomp - motor[0] at the ceiling (385-386, 574-575) | > 0 = note | none (diagnostic note, `advice.cjs:2082`) | firmware |
| G8 | motor[0]/govSum where unclamped; on/off and correlation with the firmware vcomp formula (346-371, 578-584) | outside 0.80-1.20 = flag | diag text only (1067-1068) | firmware |
| G9 | headspeed-error spectrum peaks, I band 0.3-3 Hz, P band 3-10 Hz, collective coherence < 0.5, jackknife SE (413-441, 586-593) | prominence 5 by 2 SE, amplitude 0.1 % | gov_i_gain or gov_p_gain x2/3, capped to 20 % (1069-1085) | pipeline, unvalidated; GOVT "reduce by 1/3" |
| G10 | coherence of headspeed (frame rotation removed) and yaw gyro at the wag peak 5-16 Hz (400-465, 595-600) | 0.5 by 2 SE | gov_gain x0.9 (1086-1091); holds governor raises (1758) | pipeline, unvalidated |
| G11 | throttle vs time and vs Vbat at equal collective, 2 s blocks (467-481, 602-605) | 5 points per pack by 2 SE | diag text naming gov_use_voltage_comp with an ADC source (1092-1093); catalog caps it at Monitor (`catalog.cjs:713`) | pipeline, unvalidated |
| G12 | main rotor order of the raw gyro against the logged headspeed (483-507, 607-611) | 0.5 % by 2 SE | action text: motor_poles, RPM sensor (1094-1101); holds governor changes (1731) | pipeline, unvalidated |
| gains | KKp from govP vs error, KKfCollW from govF vs PT2(coll^2) (389-398) | none | none: measured, never judged | - |

### 3.2 Other modules

| id | file:line | measures | threshold | recommends | source |
|---|---|---|---|---|---|
| G14 | `health_more.cjs:496-522, 721-732`, rule 84 | time and entries per state, spool-up ramp, implied gov_spoolup_time; AUTOROTATION/BAILOUT in flight | flag: BAILOUT in flight, or AUTOROTATION > 0.5 s at collective >= 300, landings excluded | diag naming gov_autorotation_timeout, gov_auto_throttle (`advice.cjs:1109-1110`) | firmware states |
| D7 | `health_phase.cjs` 97, 303 | flight log vs bench run, phase seconds | report | info | pipeline |
| G15 | `health_phase.cjs:316-336, 508-518` | largest ground yaw rate in a spool-up; OLS throttle ramp in motor 10-45 %; implied gov_spoolup_time = 1000/(%/s) | flag 150 deg/s, note 50 | gov_spoolup_time x1.2, severity check, no CLI (`advice.cjs:1237-1251`) | Gaui result: 10 of 10 ground yaws > 150 deg/s at ramps 50-101 %/s, 0 of 7 at 34-41 %/s |
| G16 | `health_phase.cjs:339-367, 520-540` | SPOOLUP->ACTIVE: largest error vs govTarget, settle to 1 % for 0.5 s, throttle step, after-liftoff flag | 3 % or 1 s | text, caveat on gov_use_pid_spoolup, no CLI (`advice.cjs:1252-1282`) | pipeline; G4 limit |
| G17 | `health_phase.cjs:372-402, 542-549` | motor steps at IDLE/spool-up, rotor turning with no output, headspeed drop >= 10 % at non-decreasing throttle | 1 kick | check: ESC, wires, timing (`advice.cjs:1283-1297`) | Gaui result |
| G18 | `health_phase.cjs:405-419, 551-559` | rms headspeed / mean at IDLE with constant motor | 5 % by 2 SE | check naming gov_idle_throttle (`advice.cjs:1298-1303`) | pipeline |
| G19 | `health_rescue.cjs` 74-75, analyse 201-232, judge 286-308 | headspeed vs target at each rescue, time at throttle >= 95 %, state changes, overload | G3 limit 5 % by 2 x signal noise, or ACTIVE->FALLBACK/RECOVERY/BAILOUT | check, text names gov_max_throttle, gov_fallback_drop, gov_recovery_time (`advice.cjs:1306-1321`) | pipeline + firmware |
| G20 | `health_rescue.cjs:82-86, 142-180, 276` | cause of each FALLBACK: overload (throttle >= 95 % 0.05 s, headspeed fall >= 2 %, <= 0.3 s before), signal, none | information | feeds `G1:overload` and K22 (`advice.cjs:982-993, 1766-1770, 2109-2110`) | firmware glitch rule |
| P1 | `health_power.cjs:139-211, 264-299` | per load step (motor +10 points in 0.5 s, ACTIVE) V/cell before vs lowest 0.1 s median within 0.5 s | flag: warning -> under minimum (header vbatcellvoltage); note: under warning | check/watch, no parameter (`advice.cjs:888-899`) | header levels |
| P2 | `health_power.cjs:301-324` | dV/dI (mOhm) per battery when Ibat > 0, 10 A minimum step | note; "higher" if > 1.3 x median of other packs by 2 SE | watch, no parameter (`advice.cjs:900-905`) | pipeline |
| L1 | `health_limits.cjs:153-166, 318-364`, rule 76 | periods with motor[0] within 0.5 % of gov_max_throttle (CLI, else data pile, else 100 %), all phases, rescue included, concurrent limits, headspeed error | 0.1 s, or error > G3 limit, or 2 outputs at limits | check/watch, `governorLimitProcedure`, no parameter (`advice.cjs:1355, 1409-1429`) | CLAUDE.md control limits |
| D4 | `health_setup.cjs:357-358, 484-488` | CLI gov_mode against the data (govSum zero or not) | clash | "use the data for the governor mode" | - |

L1 looks at the high limit only (`limits: {lo: null, ...}`, `health_limits.cjs:162-165`): `gov_min_throttle` and the
governor P/I/D/F clamps are not examined by any L check, although CLAUDE.md "Control limits" names the I-term and the PID sum.
Probe: Fireball `govI` reaches its 95 % limit for 0.27 s in log 10; `govF` max 33.5 % against `gov_f_limit` 40 %; `govP` max
24.0 % against 30 %; `govD` within ±0.2 %.

Legacy viewer lab (pre-toolkit): `js/flight_analysis.js:277-318` "governor" lab, 99th percentile of 100 ms sag, 2.5/5 %
(`docs/DEVELOPMENT.md:312`); `esc` and `battery` labs alongside. Independent of the checks above.

---------------------------------------------------------------------------------------------------------------------------

## 4. `advice.cjs`: governor recommendations, rules, names, ranges, guards

- RULES (`:139-204`): `govSteps {F:10, I:25, P:10}` (148), `govCut 1/3` (149), `maxStep 0.20` (141), `dirStep 0.10` (142);
  sources `govSteps`, `govCut` (177-178, GOVT), `spoolup` (195, Gaui result), `handover` (196), `fallback` (201).
- Writable names (`PARAMS`, `:279-298`): gov_p_gain, gov_i_gain, gov_f_gain, gov_gain (header `govPID` 0, 1, 3, 4; 283-284)
  and gov_spoolup_time (global, CLI only, 291). **Not** gov_d_gain (header index 2 exists) and no other gov_* name.
- RANGE (`:212-217`): gov_p/i/f_gain and gov_gain [0, 250], gov_spoolup_time [0, 600] (214). Nothing else of the governor.
  `PROFILE_CONFIG` (`:2573-2606`, the restore schema, not used by the generators) has all profile gov_* ranges: gains,
  weights, tta 0-250, limits and dyn_min 0-100, max/min throttle 10-100, fallback_drop 0-50, collective_curve 5-40, headspeed
  0-50000, 4 flags OFF/ON. Firmware ranges for the globals are in `firmware/schema.cjs:15-16,24-27` (times 0-600, others 0-250).
- COVERAGE rows of the governor (`:352-369`) map names to checks: mode G0 D4; F G3 G4; I G9 G2; P G9 G5; D none ("Unless
  you're flying a 500+ heli you probably won't need D"); gain G9 G10; FF weights G3 G4 (cli); limits G3 G7 (cli); headspeed
  G1 G2 (cli); throttle limits G6 G7 L1 (cli); vcomp G8 G11 G13 D5 (cli); filters G1 G10 (cli); ramp times G14 G15 G16 G19
  (cli); autorotation values G14 G16 G18 (cli); throttle type none; FALLBACK G1 G19 (cli); PID spool-up and dyn min throttle
  "nolog"; TTA (row 352) none. Battery row 394: battery_meter, battery_cell_count, vbat levels -> D5 G13 G8 P1 P2. A COVERAGE
  mapping is a status label, not a generator: of these rows only F, P, I, gain and spool-up time produce a value.
- Guards on governor changes: G12 or G1 flag holds every governor change (`:1730-1733`); a governor gain raise is held by
  G6 or L1 in the same PID profile (1753-1754), by T8 tail at its limit (1755-1757) and by G10 (1758); TTA on gives a caveat
  (1761); DIRECT/LIMIT drops governor gain changes (2097-2099).
- `governorLimitProcedure` (`:1374-1390`) is the only power-limit "procedure": examine Vbat, Ibat, ESC temperature and ESC
  limit warnings, then a short flight, then "a flight test at a lower headspeed"; used by G3 (saturated), G6, G19, L1.
- `control_tune.cjs` (rule-based proposals for the Tuning tab, no model): governor step regex `gov_[pidf]_gain|gov_gain`
  (`:16`), flight plan "Collective steps" (`:48-57`), absolute steps F 10, I 25, P 10 (`:124-127`), eligibility needs
  `advice.RANGE` (`:139-140`), so gov_d_gain and gov_tta_gain (tailcomp, `:20`) can never be proposed.

---------------------------------------------------------------------------------------------------------------------------

## 5. `hierarchy.cjs` and `catalog.cjs`

- Governor block (`hierarchy.cjs:102-110`): checks G0 G2-G10 G14-G19 L1; chips "Mode and limits" (G0 G6 G7 G8 L1),
  "Spool-up and changes" (G14-G19), F (G3 G4), I (G9 G2), P (G9 G5), D (none), Gain (G10); params list 36 names (no
  gov_bypass_throttle, gov_use_dyn_min_throttle, gov_dyn_min_throttle, gov_tta_*). Not applicable when G0 says DIRECT/LIMIT
  (`:539-541`).
- Prerequisites gating it: `rpm` (G1 G12 G20; `:69-71`, edge 157), `power` (D5 G13 G11 P1 P2, params include battery_meter;
  `:72-74`, edge 158 "Governor gains cannot increase the maximum throttle"), `logging` validity (D1, `:153`); order
  filters -> governor (166), governor -> cyclic/tail (169-170), cause governor -> tailcomp (171).
- K rules: K11 headspeed control (G2 G3 G4 G5 G9 <- G1 G12 G6 G7 G11 G13 D5 G0 G14 G8 P1; `:217-219`), K12 throttle reserve
  (G6 G7 <- G11 G13 D5 P1; 221-222), K13 tail/governor oscillation (224-225), K14 tail authority (T8 <- G3 G6; 226), K22
  FALLBACK at a large load (G1 <- G19 L1 G20; 243-245), K25 throttle at its limit (G2 G3 G5 G19 <- L1; 251-252), K27 load at a
  rescue (255-256).
- `catalog.cjs`: entries G13 232, G0 236, G1 240, G2 246, G3 250, G4 254, G5 258, G6 264, G7 268, G8 271, G9 276, G10 280, G11
  285, G12 291, G14 423, G15-G18 461-487, G19 510, G20 521, P1 573, P2 586; all on the governor tab; G0, G7, G8, G14, G20, P2 are
  "information"; G11 and L7 capped at Monitor (709, 713); LEAD texts 680-703; L1 lead 715-716.

---------------------------------------------------------------------------------------------------------------------------

## 6. The model path: `control_pipeline.cjs`, `firmware_controller.cjs`, the twin

### 6.1 What exists

- Firmware: `CAPABILITIES.governor {available, enable: config.executeGovernor, rpmInput: raw mechanical motor RPM}`
  (`firmware_controller.cjs:9-14`). With `executeGovernor` the step needs `rawMotorRpm`, `batteryVoltage`,
  `throttleCommand`, `throttleOff`, `armed`, `rcDeflection`; mode boxes `govBypass/govSuspend/govFallback` default 0
  (`:186-189`); outputs P, I, D, F, sum, targetHS, requestHS, currentHeadSpeed, state, ttaIncrease, spoolUpRatio, spooledUp,
  throttle (`:193`, `bridge.c:175`). Host stubs: `getBatteryVoltageSource` = config `voltage_meter`, `getBatteryCellCount` =
  config `battery_cell_count`, `getMotorRawRPMf` = input 36 (`host.c:47-51`); flags assembled from the 4 gov_use_* names
  (`firmware_controller.cjs:79-80`); `requiredFields` makes every field after `governorStart` required with
  `executeGovernor` (`:108`; 49 fields incl. gear ratio, cells, voltage meter); `compatibility` refuses unknown values,
  stale values, mixer rules, motorized tails and out-of-range values (`:118-143`).
- `governorSample` (`control_pipeline.cjs:400-404`): raw motor rpm = headspeed x gear ratio, `Vbat`/100, `rcCommand[4]`/1000,
  throttleOff = stick not > 0, armed always true.
- `governorInputs` gates (`:407-418`): firmware compatibility with step governor; `rcCommand[0..4]`, `Vbat`, `motor[0]`
  finite from 20 s before the period (`governorWarmupS`) to its end.
- `governorReplay` parity (`:422-442`): native governor on recorded headspeed/sticks/Vbat from 20 s before; throttle RMSE <=
  0.02 (0-1) over the 2 s prefix and state ACTIVE at its end.
- `simulate` (`:643-774`): with the governor, its throttle drives the twin and the rotor speed is free (`:710-714`); Vbat stays
  the recorded input (`twinLog :640`); governor metrics: headspeed RMSE <= 100 rpm or relative <= 0.30, throttle RMSE <= 0.04 or
  relative <= 0.30, `tracking` = RMSE(govTarget - headspeed) (`:752-763`; RULES `:42-46`).
- `tune` (`:908-1074`): the governor step skips the twin's `eligibleSteps` (`:918, 1004`) but needs controller parity, sensor
  parity and governor parity (`:974-986`), else status `unsupported-loop`; candidates x0.8-1.2 single changes (`:866-879`), P/I/D
  only downward (`:1023-1024`); objective governor tracking (`:896`); regression and mixer-saturation gates (`:1029`);
  holdout: >= 3 flights, mean improvement > 2 SE (`:1056-1058`); CLI `profile N` + `set` (`:1062-1071`), unit rpm.
- Twin rotor speed (`heli_twin.cjs:186-188, 202`; `docs/HELICOPTER_SYSID_MODEL.md:63`): `Omega' = (Q_m - Q_a)/I_r`,
  `Q_m = max(0, kmV x esc x Vbat - kmW x Omega)`, `esc' = (motor[0] - esc)/tauEsc`, `hs' = (Omega - hs)/tauHs`,
  `Q_a` from cq0 and Ct lambda; motor reaction torque on yaw (`:195`). Fitted in stages "rotor speed" and "rotor speed again"
  on the headspeed channel only (`twin_fit.cjs:358, 364`); `Vbat` missing or 0 becomes 1 (`twin_fit.cjs:58-60`).
- Worker (`js/tuning_worker.js:3022-3026`): control inputs decode `K.extraAll` (all module EXTRA: govTarget, govRequest,
  govSum, govP/I/D/F, motor[0], Vbat, Ibat, mixer[3], gyroRAW, flightModeFlags, servo[0..7], time) plus tailspeed,
  rcCommand[0..4], Vbat, Ibat, altitude, vario, attitude. Not decoded: Tesc, Tmcu, Vbec, Vbus. GOVSTATE comes as
  `w.govStateAt`. Governor masks for the checks: `govMasks` (`:475-500`).
- Tuning view (`js/tuning_dialog.js`): Governor tab (`:145`), area "Governor and battery" for /^G\d+$/ (`:107`; P1, P2 are not
  G ids), plots `govPlots` headspeed/target with state bands, error ±1/±2 %, throttle with collective (`:3118-3139`; no Vbat,
  Ibat or gov term plot); A/B pairs for /^(G\d+|L1)$/ (`:4247`); model notes and closed-loop headspeed/throttle plots
  (`:4187-4199, 4207-4225`); `CONTROL_STEPS` includes governor (`:3983`).

### 6.2 What is missing or wrong in this path

1. `voltage_meter` is never filled from CLI `battery_meter`; `battery_cell_count = 0` (auto) is out of range -> governor path
   never active on real data (section 0, item 2). The cell count of auto must come from the firmware rule
   (`health_power.cjs:129-133` `autoCells`, as P1 already does).
2. Vbat required (`:415`) although the governor reads it only with an ADC meter and vcomp on; a heli that logs Vbat as 0 (Gaui
   20261004_113720) is excluded. Current not used.
3. The twin cannot predict sag (Vbat exogenous), so it cannot test changes that move the operating point (headspeed, max
   throttle, gains at saturation). Saturation of the throttle is not in any score (`moreSaturation` counts mixer axes only,
   `:894`).
4. Search space: 5 gains, no limits, filters, FF weights/curve, times, throttle limits, flags, headspeed; gov_d_gain excluded by
   RANGE; P/I raises excluded although G5 asks for a P raise; single-parameter only.
5. Objective: RMS tracking only; not droop at load steps (G3), recovery time (G5), oscillation (G9), headspeed-yaw coupling
   (G10), saturation time (G6/L1), spool-up overshoot (G16), FALLBACK risk (G20).
6. Parity only in ACTIVE (state 4 at prefix end); SPOOLUP, RECOVERY, FALLBACK, AUTOROTATION, BAILOUT transitions never
   checked; `armed: true` in the 20 s warm-up even when it reaches before arming; mode boxes always 0.
7. The rotor-speed model has 2 motor constants and no current: kmV, kmW, Vbat in; no winding resistance, back-EMF constant,
   ESC duty mapping, battery Thevenin source or telemetry lag (68 ms Vbat).
8. `health_gov` fixes 10 Hz / 5 Hz filter constants (`:24`) and the comment that FUNCTION lowers the request
   (`:149-150`) does not match `flight_governor.c:449-459` (FUNCTION remaps the throttle only; SWITCH sets the request).

---------------------------------------------------------------------------------------------------------------------------

## 7. Probe results on the reference dumps (what the existing checks say today)

Fireball (probe, PID profile labels of the toolkit: 1 = 3500, 2 = 4500, 3 = 5000 rpm):

| item | value |
|---|---|
| G6 | flag in profile 2 in 6/6 flights (median 78.4-81.7 %, runs at 100 % with > 2 % deficit), profile 3 87.0 % (logs 10, 15); profile 1 56.5-61.1 % ok |
| L1 | flag in 9 flight-profile pairs (all 6 flights), 0.82-6.35 s at 100 % per pair (1-18 periods); 2.1-6.7 s per flight |
| saturation vs Vbat | 2.14-6.74 s at motor >= 99.5 % in ACTIVE; Vbat p50 at saturation 21.66-22.16 V (log 10: 25.0 V early) vs unsaturated 22.73-23.26 V; at 55-78 % of ACTIVE time; Vbat first/last 10 % of ACTIVE 24.36-24.92 -> 22.01-22.49 V |
| G7 | command beyond output at the ceiling 4.2-13.9 % (note) |
| G8 | vcomp off (ratio 1.000, n 79k-140k samples) |
| G11 | +6.2 to +7.3 points per pack; log 5 flag 7.31 ± 0.33, -2.95 ± 0.08 %/V |
| G3 | profile 2: 3.28 ± 0.26 % droop (n 236, note); profile 3: 4.72 ± 0.99 % (n 16) |
| G4 / G5 | overshoot 1.0-2.9 % ok; recovery 0.03-0.23 s ok (profile 2: 0.225 ± 0.018 s, n 205) |
| G9 | notes only: P-band peaks at 3.1-3.6 Hz, prominence 5.7-8.4, amplitude 0.04-0.06 % of target (< 0.1 % rule) or collective coherence 0.76 |
| G1 / G20 | 3 FALLBACK (log 11: 2, log 14: 1), all "overload": throttle >= 95 % for 0.20-0.33 s, headspeed -5.4, -10.2, -19.1 % before |
| G19 | log 13: -7.6 %, -6.5 %; log 14: -41.5 % (1.27 s > 10 % under, then FALLBACK) |
| G15 | ground yaw 21-40 deg/s ok; ramp 12.43 %/s -> implied gov_spoolup_time 80 (CLI 80); log 5: 9.95 %/s -> 101 |
| G16 | flag 5/5: +7.1, +12.9, +13.2, +13.0, +9.1 % over target, settle 0.95-2.44 s |
| G17 | log 10: 1 kick (12.1 % headspeed drop on the ground) |
| P1 | 0.064-0.106 V/cell sag per load step (7-47 steps), ok; P2 skipped (Ibat 0) |
| govI at limit | log 10: 0.27 s at 95 %; I p50 0.75-0.84 of full throttle |

Gaui (probe, no CLI, ceiling assumed 1000 or data pile 904-939): G6 ok except log 49 profile 3 (79.2 %, guessed ceiling 904);
L1 0.10-0.57 s at estimated limits (logs 38, 49); G3 1.95-2.17 % ok; G5 0.18-0.30 s; G16 ok except log 45 (+3.5 % after the
liftoff); G15 6-21 deg/s, implied gov_spoolup_time 198 (5.06 %/s) and 148-150 (6.7 %/s); P1 0.18-0.26 V/cell; P2 14.3-19.2 mOhm
per pack; G8 off; no FALLBACK, no rescue.

---------------------------------------------------------------------------------------------------------------------------

## 8. Rule-of-thumb recommendations without a model

| rec | size rule | what a twin would replace it with |
|---|---|---|
| G3 gov_f_gain +10 | GOVT increment, condition F share < 50 % | F that removes the unsaturated droop at the measured collective steps, with the F clamp (gov_f_limit) and the weights/curve |
| G4 gov_f_gain -10 | GOVT increment on "load onset" overshoot | same, jointly with P and D filter |
| G5 gov_p_gain +10 | GOVT increment on slow recovery | P that meets a recovery time without G9 oscillation; not allowed by the twin search (P only down) |
| G9 gov_p/i_gain x2/3 (cap 20 %) | GOVT "reduce by 1/3" | stability margin of the identified loop (rotor inertia, ESC lag, rpm filter) |
| G10 gov_gain x0.9 | dirStep 10 % | coupled governor-tail simulation (the twin has the motor reaction torque on yaw) |
| G15 gov_spoolup_time x1.2 | maxStep 20 %, Gaui threshold 150 deg/s | spool-up simulation: ground yaw and handover overshoot vs ramp rate; also gov_use_pid_spoolup |
| G6/L1/G19 procedure | "examine battery and ESC", "lower headspeed" test | required throttle vs Vbat and collective: max sustainable headspeed and the max_throttle/headspeed margin per pack state |
| G11 text on vcomp | names the ADC requirement | expected throttle drift with and without vcomp from the battery model; a recommendation only when battery_meter can be ADC |
| G14 text on autorotation values | firmware defaults | none needed: state-machine logic, exact from the firmware code |
| G18 text on gov_idle_throttle | none | exact from the IDLE motor plateau |

---------------------------------------------------------------------------------------------------------------------------

## 9. Parameter coverage and gaps (42 governor names + battery source)

Legend: CLI = a generator writes a value; text = named in a recommendation without a value; none = not named. "Inferable"
= the log can give the present value without the CLI (needed for the "PID profile/from-value" rules and for the Gaui).

| name | today | inferable from the log | twin / autotune need |
|---|---|---|---|
| gov_mode | info (G0, D4) | govSum/govI zero or not (G0) | gate only |
| gov_throttle_type | none | govRequest steps (SWITCH), throttle input thirds (FUNCTION) | input mapping of the replay (rcCommand[4]) |
| gov_startup_time | none | IDLE/HOLD up slope of motor[0] | state-machine timing |
| gov_spoolup_time | G15 check x1.2, no CLI | SPOOLUP slope (G14/G15: Fireball 80, Gaui 198/148) | **tune**: ground yaw, handover overshoot (G16) |
| gov_tracking_time | text (T14 caveat) | govTarget slew at profile changes | tune with T14 (yaw at headspeed ramps) |
| gov_recovery_time | text (G19) | RECOVERY slope | **tune**: FALLBACK/rescue recovery (G19, G20) |
| gov_spooldown_time | none | HOLD/IDLE down slope | check only |
| gov_throttle_hold_timeout | none | HOLD duration | check only |
| gov_autorotation_timeout | text (G14) | AUTOROTATION duration | check (bailout window) |
| gov_idle_throttle | text (G18) | motor[0] plateau at IDLE | check |
| gov_auto_throttle | text (G14) | motor[0] plateau in AUTOROTATION | check |
| gov_handover_throttle | none | rcCommand[4] at SPOOLUP entry and ACTIVE exit | check (also bounds max_throttle) |
| gov_bypass_throttle[9] | none | BYPASS motor vs collective | only if BYPASS used |
| gov_pwr_filter | none | only with ADC vcomp | vcomp model |
| gov_rpm_filter | none (fixed 10 Hz in health_gov) | govP vs headspeed phase | **tune** with G9 margin and G1 glitch risk |
| gov_tta_filter | none | TTA off on both helis | tailcomp |
| gov_ff_filter | none (fixed 5 Hz in health_gov) | govF vs collective lag | **tune** with F |
| gov_d_filter | none | govD vs error derivative | with D |
| gov_headspeed | none (reference only) | govRequest | **recommend** within power and tail limits (G6, L1, T8) |
| gov_min_throttle | none (L1 has no low side) | motor[0] floor in ACTIVE | check |
| gov_max_throttle | text (G19) | motor[0] pile (G6/L1), else unknown | **recommend** (Gaui: 904-939 guessed) |
| gov_gain | G10 CLI x0.9; twin x0.8-1.2 | header govPID[4] | **tune** |
| gov_p_gain | G5 +10, G9 x2/3; twin down only | header | **tune** both ways |
| gov_i_gain | G9 x2/3; twin down only | header | **tune** both ways (GOVT raises I) |
| gov_d_gain | none; not in RANGE | header | **tune** (Fireball D 2, Gaui 0) |
| gov_f_gain | G3 +10, G4 -10; twin ±20 % | header | **tune** |
| gov_p_limit | none | govP clamps | **check/tune** (Fireball max 24 % of 30 %) |
| gov_i_limit | none | govI clamps | **check/tune** (Fireball 0.27 s at 95 %) |
| gov_d_limit | none | govD clamps | with D |
| gov_f_limit | none | govF clamps | **tune** with F (Fireball max 33.5 % of 40 %) |
| gov_tta_gain, gov_tta_limit | none (tailcomp; not in RANGE) | header yaw_tta | out of governor block; off on both |
| gov_yaw_ff_weight | none | govF regression on yaw deflection | **tune** with F |
| gov_cyclic_ff_weight | none | govF regression on cyclic | **tune** with F |
| gov_collective_ff_weight | none | govF regression on abs(collective) | **tune** with F |
| gov_collective_curve | none (health_gov fits curve 2 only, `:395`) | exponent of the govF regression | **tune** with F |
| gov_fallback_drop | text (G19, source) | motor[0]/((govI+govF) x vcomp) in FALLBACK | **recommend** with G20 overload FALLBACKs |
| gov_dyn_min_throttle | none ("nolog") | motor floor vs target/RPMK | check |
| gov_use_fallback_precomp | none | govF zero or not in FALLBACK | **recommend** with G20 |
| gov_use_voltage_comp | text (G11) | G8 ratio | **recommend** only with battery_meter = ADC |
| gov_use_pid_spoolup | caveat (G16) | govP/govI non-zero in SPOOLUP | **recommend** with G16 |
| gov_use_dyn_min_throttle | none | as dyn_min | check |
| battery_meter (related) | listed (power node, coverage 394) | ESC telemetry signature (28.6 Hz holds) | **explain** vcomp inactive with ESC |
| battery_cell_count (related) | P1/D5 use autoCells | firmware rule | map 0 -> autoCells for the WASM |

Gaps summarized:

- **No check/recommendation at all** (27): gov_throttle_type, gov_startup_time, gov_spooldown_time,
  gov_throttle_hold_timeout, gov_handover_throttle, gov_bypass_throttle, gov_pwr_filter, gov_rpm_filter, gov_tta_filter,
  gov_ff_filter, gov_d_filter, gov_headspeed (as a value), gov_min_throttle, gov_d_gain, gov_p/i/d/f_limit (4),
  gov_yaw/cyclic/collective_ff_weight and gov_collective_curve (4), gov_tta_gain, gov_tta_limit, gov_dyn_min_throttle,
  gov_use_fallback_precomp, gov_use_dyn_min_throttle.
- **Text only** (10): gov_mode, gov_tracking_time, gov_recovery_time, gov_autorotation_timeout, gov_idle_throttle,
  gov_auto_throttle, gov_max_throttle, gov_fallback_drop, gov_use_voltage_comp, gov_use_pid_spoolup.
- **Value, rule of thumb** (5; 27 + 10 + 5 = 42): gov_f_gain, gov_p_gain, gov_i_gain, gov_gain (CLI) and gov_spoolup_time (no CLI).
- **Model-based** (0 active): the twin search covers gov_p/i/f_gain and gov_gain but cannot run (section 6.2 item 1).
- Checks that the task names and their status: power limits = G6, G7, L1, G11, P1, P2, G19, G20 measured, no parameter;
  voltage compensation via ESC = not explained (G8 measures off, G11 text only); fallback events = G1, G20, G19 measured,
  gov_fallback_drop / gov_use_fallback_precomp / gov_recovery_time text only; spool-up = G14-G18 measured, gov_spoolup_time
  check only, gov_use_pid_spoolup caveat only.

---------------------------------------------------------------------------------------------------------------------------

## 10. Where a governor twin plugs in

1. **Configuration** (`firmware_controller.cjs:52-80`): map `battery_meter` (CLI enum NONE/ADC/ESC, `:55`) to
   `voltage_meter`; map `battery_cell_count = 0` to the firmware auto rule (`health_power.autoCells`); infer from the log
   the CLI-only values in the table of section 9 (spool-up/recovery slopes, motor piles, FALLBACK ratio, govRequest) with a
   source and a "possibly not current" flag, so that the Gaui (no CLI) can run.
2. **Battery and drivetrain model** (`heli_twin.cjs:186-188,202`; fit stages `twin_fit.cjs:358,364`): Vbat becomes a state
   (open-circuit voltage falling with charge, series resistance, optional RC) and an output with the telemetry hold and lag
   (`health_power.cjs:39-41`); the motor torque from duty x Vbat, back-EMF and winding resistance; the battery current is
   derived. Fit on headspeed + Vbat always, + Ibat when it is non-zero (Gaui: 14-19 mOhm per pack from P2 is a prior);
   without Ibat the resistance is identified from the sag against the modelled current (Fireball P1: 0.06-0.11 V/cell per
   step). Make `Vbat` optional in `governorInputs` (`control_pipeline.cjs:415`).
3. **Native governor parity** (`governorReplay :422-442`): extend from "ACTIVE at prefix end" to state sequences (SPOOLUP,
   RECOVERY, FALLBACK, AUTOROTATION/BAILOUT) so that the timing parameters and FALLBACK behaviour are validated; supply
   arming from the log rather than `armed: true` (`:403`).
4. **Search** (`candidates :866-879`, `tune :1023-1058`): all governor names with firmware ranges (`schema.cjs` ranges, or
   `advice.PROFILE_CONFIG`), joint changes (F with weights/curve/limit; P/I/D with rpm and D filters), raises allowed when the
   twin's stability margin passes; scenario objectives per check: droop and recovery at the logged collective steps
   (G3/G5), oscillation margin (G9), headspeed-yaw coupling (G10), time at the throttle ceiling and headspeed deficit at the
   end-of-pack Vbat (G6/L1/G11), handover overshoot and ground yaw (G15/G16), FALLBACK entry and recovery at overload
   (G19/G20).
5. **Recommendations** (`advice.cjs`): extend `PARAMS`/`RANGE` (`:212-217, 279-298`) to the governor names the twin can
   size; keep the CLAUDE.md guards (G12/G1 hold, profile known, from-value source); add a vcomp explanation keyed on
   `battery_meter`; turn `governorLimitProcedure` (`:1374-1390`) into a quantitative headroom statement (throttle needed at the
   measured end-of-pack Vbat for the logged peak load).
6. **Worker and view**: decode `Tesc` (ESC derating), `Vbec`, `Vbus` in `controlInputs` (`tuning_worker.js:3022-3026`); add
   Vbat/Ibat and governor-term plots to `govPlots` (`tuning_dialog.js:3118-3139`); include P1/P2 in the governor A/B pairs
   (`:4247`).

---------------------------------------------------------------------------------------------------------------------------

## 11. Tests run

```
export PATH="$HOME/.nvm/versions/node/v22.17.0/bin:$PATH"; unset -f node npm npx nvm
node --test test/health_gov.test.cjs test/health_power.test.cjs
  tests 45, pass 43, fail 0, skipped 2, 14.8 s   (health_gov 31/31; health_power 12 pass, 2 skipped: real logs)
AUTOTUNE_REAL_LOG=<Gaui 20261004_113720> AUTOTUNE_RESCUE_LOG=<Fireball 20261005_204823> node --test test/health_power.test.cjs
  tests 14, pass 14, fail 0, 20.2 s
```

Files in this directory: `gov_stack_probe.cjs` (runs health_gov, health_power, health_phase, health_rescue, health_limits on
selected logs and judges them), `gov_term_limits.cjs` (governor term clamps, saturation against Vbat); outputs
`data/probe_fireball.json`, `data/probe_gaui.json`, `data/limits_fireball.json`, `data/limits_gaui.json`.
