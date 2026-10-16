# Governor reports: completeness critique (2026-10-14)

This critique covers the four reports in this directory:
- R1: `firmware_parameters.md` and `firmware_parameters.json`
- R2: `app_governor_stack.md`
- R3: `log_evidence.md`
- R4: `models_and_guidance.md`

It replaces the first-pass critique that was in this file. I re-checked every claim I kept from the first pass with my own
scripts. I corrected its statement on log 15 (C6) and its glitch amplitudes (C12). I added the items marked **new**.

**Checks made.**
- Parameter list: checked against `fw:src/main/cli/settings.c` at the pinned commit 118e912 (`git show 118e912:...` in
  `/Users/albertwu/exp/rotorflight-firmware`). That checkout is on branch `sitl-linux` (76f08cc), so line numbers that cite
  `fw:` must come from 118e912, not from the working tree.
- Source code read: the vendored governor (`tools/autotune/firmware/vendor/flight_governor.c`), `schema.cjs`, `host.c`,
  `bridge.c`, `firmware_controller.cjs`, `health_rescue.cjs`, `health_gov.cjs`, `control_pipeline.cjs`, `advice.cjs`,
  `twin_fit.cjs`.
- Native replay: I re-ran `scripts/replay.cjs` on Fireball log 5, 0-23 s. The first pass re-ran log 10.
- Data: I recomputed the claims that decide the design from the float32 data in `data/`. I decoded the events of all logs
  with `critique_scripts/events.cjs`.

**Scripts.** All scripts are in `critique_scripts/`. Run them from that directory with
`/Users/albertwu/miniconda3/envs/rs-bench/bin/python -I <script>`. The Node scripts need the PATH prefix of the task.

| Script | What it checks |
|---|---|
| `indep.py <vcomp, fallback, ff, spool, sat, drift, fmode, gauivbat>` | the independent checks of this pass |
| `glitchwin.py` | the glitch test on the logged headspeed |
| `kmot5000.py` | the Kmot reconstruction at 4500 and 5000 rpm |
| `l15.py`, `l13b.py`, `req.py` | profile switches near spool-up |
| `events.cjs <dump> <first> <last>` | in-flight adjustment census |
| `check.py`, `rescue.py`, `fm.py`, `l10.py`, `l13.py`, `ho*.py`, `dv.py`, `pile*.py` | first-pass checks, re-run where cited |

Replay outputs: `replay_fireball_log5_rerun2.json` and `replay_fireball_log10_rerun.json`.

**Conventions.**
- Log numbers are 0-based, as in R1 and R3. The app log number is the index + 1.
- "Index time" is frame / 1000. "Real time" is the log `time` field.
- I write PID profiles as the CLI does (`profile 0` = 3500 rpm on the Fireball) only where a report does. The app texts must
  use "PID profile 1"-"PID profile 6".

## 1. Verdict

- **Parameter list: complete.** `settings.c:956-973` has 18 global names. `settings.c:1202-1205` and `1207-1226` have 24
  profile names. That is 42 in all. R1 and R2 list the same 42.
- **R1 JSON.** All 42 governor records have every field the brief asks for: scope, type, default, range, states, effect,
  observable in log, simulatable in WASM and identification evidence. Of the 17 "related" records, 12 have empty fields,
  for example `main_rotor_dir` has no observability and `rc_min_throttle` has no range. This does not block the design.
- **Coverage.** Every parameter has its semantics (R1 §5-7 and the JSON `effect` field), a log-observability statement and a
  WASM statement. The WASM statements are correct: all 42 are in `schema.cjs:14-17`. Every parameter has an identification
  idea and an autotune method (R4 table 7.2).
- **Weak or wrong methods.** The method is wrong or weak for 7 items (section 2):
  - idle and auto throttle (C7);
  - handover (C5);
  - tracking time (M6);
  - fallback precomp and fallback drop (V3);
  - headspeed and max throttle, because each has a side effect on the glitch test (M15);
  - the spool-up time, because the overshoot depends on the load after handover (M17);
  - the gains (C13).
- **Missing.** Section 3 lists 17 items. These change the design:
  - The Gaui battery voltage source is unknown, so its voltage-compensation advice must be conditional (M10).
  - A replay with the logged headspeed misses 1 of 3 FALLBACK entries (M11).
  - The time since boot shows the power cycles, which Kmot needs (M12).
  - The WASM timer base differs from the firmware timer base (M13).
- **Contradictions.** Section 4 resolves 17. Six of them change a recommendation:
  - C1, the Gaui feedforward weights;
  - C6, the spool-up statistics;
  - C7, the FUNCTION/autorotation rule;
  - C8, the Gaui throttle ceiling;
  - C9, the "power limit" of log 10;
  - C12, the FALLBACK cause.

## 2. Coverage matrix (42 governor parameters)

Column keys:
- S = semantics
- O = observable in these logs
- W = simulated by `controller.wasm`
- I = identification idea
- M = autotune method of R4 7.2

"yes" means present and correct. The last column refers to sections 3 to 5.

| Parameter | S | O | W | I | M | Gap or correction |
|---|---|---|---|---|---|---|
| gov_mode | yes | yes | yes, but CLI `OFF` is not mapped (`firmware_controller.cjs:55`) and the fast-RPM guard is stubbed (`host.c:53`) | yes | rule | No path for NITRO, DIRECT and LIMIT (M3). `feature GOVERNOR` is missing (M1). |
| gov_throttle_type | yes | yes (`rcCommand[4]` levels) | yes | yes | rule | The R4 rule is wrong (C7). SWITCH breaks the rule that identifies the profile from `govRequest` (M3). |
| gov_startup_time | yes | yes, exact | yes | yes | scenario S | Fit the slopes in index time (C3). Epochs: 200 → 100 at log 9 (V4). |
| gov_spoolup_time | yes | yes, exact | yes | yes | S with a_ss | The R4 bound has ±25 % uncertainty (C2). The overshoot depends on the load after handover (M17). Leave out log 15 (C6). |
| gov_tracking_time | yes | yes (needs Kmot) | yes (Kmot reset) | yes | profile switches | Its role after RECOVERY/BAILOUT is missing (M6). |
| gov_recovery_time | yes | yes, exact | yes | yes | G, S | Scenario G must start RECOVERY at `min(T/Kmot, H/R)` (V3). |
| gov_spooldown_time | yes | yes, exact | yes | yes | S | 5 epochs in logs 0-10 (V4). |
| gov_throttle_hold_timeout | yes | yes (state duration) | yes, but the timer base differs (M13) | yes | rule | none |
| gov_autorotation_timeout | yes | yes | yes, but the timer base differs (M13) | yes | rule + S | The middle switch position is AUTO (C7). |
| gov_idle_throttle | yes | yes (IDLE floor) | yes | yes | rule | "Set auto > idle" has no effect with these switches (C7). |
| gov_auto_throttle | yes | yes | yes | yes | rule | as idle |
| gov_handover_throttle | yes | **yes when the throttle reaches it** (R1 says "bounds only") | yes | corrected (C5) | rule | none |
| gov_bypass_throttle | yes | only in BYPASS | yes, but `govBypass` is never supplied (R1 10.3-7) | n/a | generated curve | Needs an aux switch. The pilot decides this. |
| gov_pwr_filter | yes | no (vcomp off) | yes, after the `voltage_meter` mapping is added | no | N/A unless ADC | Gaui: unknown, because its source is unknown (M10). |
| gov_rpm_filter | yes | yes (govP identity) | yes | yes | search | It is also the reference of the glitch test (`flight_governor.c:576, 588`). A change also changes the FALLBACK risk (M15). |
| gov_tta_filter | yes | no (TTA off) | yes | no | N/A | Fireball `tail_rotor_mode = VARIABLE`. |
| gov_ff_filter | yes | yes | yes | yes | search | none |
| gov_d_filter | yes (0 = D off, `common_filter.c:449-462`) | no (\|govD\| <= 2 counts) | yes | no | search | Only the model can validate it. Say so. |
| gov_use_fallback_precomp | yes | yes (FALLBACK throttle) | yes | yes | G | The benefit lasts only for the 0.2 s FALLBACK window (V3). |
| gov_use_voltage_comp | yes | yes (motor[0] = govSum) | yes, but `battery_meter` is not mapped, so the diagnostic default is ADC | yes | rule | Fireball: no effect (ESC source). Gaui: source unknown (M10). |
| gov_use_pid_spoolup | yes | yes | yes | yes | S | The target slope is `max(Hf, Kmot) x rate`. On the Fireball, Kmot starts at 0 in every flight (M12). |
| gov_use_dyn_min_throttle | yes | only when the floor acts | yes | no | rule | none |
| gov_headspeed | yes | yes (`govRequest`) | yes (one profile per instance) | yes | feasibility | The demand is censored (C11). The glitch threshold scales with it (M15). |
| gov_min_throttle | yes | only when reached | yes | no | rule | L1 has no low side (R2). |
| gov_max_throttle | yes | yes (Fireball pile at 1000) | yes | Gaui false pile (C8) | glitch trial | It also moves the 95 % exit rule of SPOOLUP/RECOVERY/BAILOUT (M15). |
| gov_gain, p/i/d/f gain | yes | header + term fits | yes | yes | search | The margin constraint needs the rotor-speed authority. Without current, the logs do not identify it (C13). D is below log resolution. |
| gov_p/i/d/f_limit | yes | only when reached | yes | no | constraint | Fireball I reaches 945 of 950 (R3 7.3). |
| gov_tta_gain, gov_tta_limit | yes | header | yes | n/a | N/A | none |
| yaw/cyclic/collective weight, curve | yes | **per log and per PID profile** | yes | yes | search | Pooling over logs or profiles gives wrong weights (C1). |
| gov_fallback_drop | yes | yes (0.900 x govI) | yes | yes | G | V3 |
| gov_dyn_min_throttle | yes | no (flag OFF) | yes (Kmot reset) | no | rule | none |

**Values the log does not record.** CLAUDE.md ("No access to the flight controller") requires the text "the log does not
record this value" for each unobservable value. Today this applies to the pwr, tta and d filters, the limits that are never
reached, the dynamic minimum, the bypass curve and the Gaui battery source. No report proposes that text. Where a flight can
record the value, give the method:
- `debug_mode = GOVERNOR` records D, T and H.
- `GOV_MOTOR` records the vcomp gain and Kmot.
- `blackbox_log_esc` gives `EscV`, which shows the voltage source (M10).

## 3. Missing items

**M1. Related settings that no report lists.**
- **`feature GOVERNOR`.** `governorInit` runs only with this feature (`fw:src/main/fc/init.c:798-800` at 118e912). It is bit 26
  of the header `features`. Fireball 1543504904 and Gaui 2080375816 both have bits 26, 27 (ESC_SENSOR) and 28 (FREQ_SENSOR).
- **`freq_input_pull`, `freq_input_edge`, `freq_input_minhz`** (`settings.c:779-781`). These condition the frequency-sensor
  signal that gives the RPM, so they are a direct lever for the glitches at 100 % throttle.
- **The `blackbox_log_*` switches** (`settings.c:808-819`). They decide which twin inputs exist.
- **`blackbox_log_esc`** adds `EscV`, `EscI`, `EscCap`, `EscRPM`, `EscThr` and `EscPwm` (`fw:src/main/blackbox/blackbox.c:258-263`).
  - `EscThr` and `EscPwm` would measure the ESC soft start and the throttle-to-duty map.
  - `EscV` against `Vbat` would show the battery source (M10).
- **`failsafe_throttle`** (`settings.c:857`). It decides the governor state in a failsafe.

**M2. Input matrix beyond V and I.** R4 6.1 covers "no Ibat" and "no Vbat". No report says what the twin and the autotune do
when one of these is missing:
- **Governor fields** (`blackbox_log_governor` OFF). Without `govRequest` there is no PID profile from the headspeed. There are
  no term fits and no Kmot reconstruction. Only the header govPID is left.
- **Mixer.** No FF model and no load model.
- **`rcCommand[4]`.** The state machine must be driven from GOVERNOR_STATE events.
- **Headspeed.** No governor analysis is possible.
- **Logging rate.** The Gaui logs every second loop, so the twin and the WASM must step at the PID rate. R1 used `loopsPerFrame 2`.

`control_pipeline.cjs:415` refuses a period without `Vbat`. `twin_fit.cjs:58-60` already turns a missing or zero `Vbat` into 1.
The pipeline gate must follow the twin.

**M3. Scope outside ELECTRIC + FUNCTION.**
- NITRO: the electric plant, vcomp, Kmot and the dynamic minimum do not apply.
- DIRECT and LIMIT have no PID.
- SWITCH: the stick sets `govRequest` (`flight_governor.c:440-446`), so the CLAUDE.md rule "the governor headspeed gives PID
  profile N" fails.

Each case needs an explicit "not applicable" text or its own path.

**M4. ESC acceleration limit as a separate cause of saturation.**
- After the log 10 BAILOUT the throttle was >= 999 for 3.95 s on the ground (collective -0.23, Vbat 25.1 V). The headspeed
  rose linearly from 848 to 3380 rpm, at 646 rpm/s (`l10.py`).
- Every full Fireball spool-up has 555-698 rpm/s in its last second, at both ramp rates (`indep.py spool`).
- R4 models this as a_ss. R2, R3 and the app's L1 and G6 count these seconds as power-limit saturation (C9).

**M5. Kmot state.**
- Kmot persists from boot across arms and profile changes (R1 §2). WASM `rf_reset` zeroes it (`bridge.c:7`).
- Kmot sets:
  - the RECOVERY entry throttle (`flight_governor.c:1006-1007`, only when `Kmot > Hf`);
  - the tracking and PID spool-up target rates (`562-565`);
  - the dynamic floor (`539-541`).
- My EWMA reconstruction (`indep.py`, `kmot()`) reproduces all three RECOVERY entry throttles to the count (V3).
- At 5000 rpm, Kmot stays above Hf: p1 5211-5389 in logs 10 and 15 (`kmot5000.py`). The RECOVERY branch would therefore apply
  at both headspeeds.

**M6. RECOVERY and tracking after a FALLBACK.** After the 0.2 s FALLBACK window, the outcome depends on three things:
- the RECOVERY entry throttle `min(T/Kmot, H/R)`, which no parameter sets;
- `gov_recovery_time`, the ramp from that throttle;
- `gov_tracking_time`, the target ramp from the sagged headspeed after the exit at 95 % throttle (R1 11.5: 3170 → 4479 rpm in
  1.28 s).

R4 7.3-3 and R3 9-2 do not use these.

**M7. Parameter epochs.**
- The Gaui yaw FF weight changes between logs and between PID profiles (C1). The Fireball timing changes between logs (V4).
- **New:** all INFLIGHT_ADJUSTMENT events in Gaui logs 38-49 and Fireball logs 0-15 are "PID Profile" changes
  (`events.cjs`). No governor value was changed in flight.
- The changes were therefore made between logs, through MSP (Configurator or transmitter script). Only the log fits can detect
  them. Attach the "values possibly not current" flag from the fit, per log segment.

**M8. "From"-value policy.**
- CLAUDE.md allows three sources: the CLI section, the gains that the analysis calculates, and the header.
- For the Gaui (no dump), the timing values, weights, filters, handover and fallback drop can come only from the log.
- Decide that these count as "values the analysis calculates", and give each one a source string. Without that, the Gaui can
  get no CLI text.

**M9. Bench runs.** R1 and R3 identify the Fireball epochs from bench runs 6, 8 and 9. That is valid as configuration evidence.
By CLAUDE.md, recommendations must not use bench runs. Bench log 9 is also in R3's spool-up overshoot list (13.0 %).

**M10 (new). The Gaui battery voltage source is unknown.**
- R3 7.1 says "its `Vbat` is ESC telemetry too". The report gives no evidence for this.
- The header has no meter source. The battery header lines are `vbatcellvoltage`, `vbatref`, `currentMeterScale` and
  `currentMeterOffset` (`blackbox.c:1609-1773` at 118e912).
- Bit 27 (ESC_SENSOR) is set, so an ESC voltage exists, but the meter can still be ADC.
- One sign points to ADC: Gaui `Vbat` leads `Ibat` by 41-43 ms (r 0.95-0.97, logs 38-41, `indep.py gauivbat`). Both use the
  default 10 Hz filters (`pg/battery.c:55-56`), so one ESC telemetry frame would give a lead near 0.
- This is not proof, because the ESC can average its current.
- Consequence: the vcomp advice for the Gaui must be conditional. "Inactive in these logs. If `battery_meter = ADC`, the flag
  works; if it is ESC, it does nothing."
- A flight with `blackbox_log_esc` ON settles it: `EscV` equals `Vbat` only with the ESC source.

**M11 (new). A replay does not reproduce FALLBACK entries from the logged headspeed.** I fed the logged headspeed to the 10 Hz
PT2 glitch test (`glitchwin.py`):

| Event | Largest \|hs - PT2(hs)\| | Against 1125 rpm | In the replay |
|---|---|---|---|
| Log 11, 54.334 s | 1051 rpm | below | missed |
| Log 11, 158.707 s | 1276 rpm | above | detected 1 ms late |
| Log 14, 192.676 s | 1316 rpm | above | detected 5 ms late |

R1 10.3-6 says only "not reproduced". For parity, set the forced-fallback input (slot 42, `isForcedFallback`,
`flight_governor.c:591`) for one frame at each logged FALLBACK entry. That gives the exact 200 ms detection delay. Scenario G
must inject a glitch in the same way.

**M12 (new). Power cycles from the time since boot.** The `time` of the first frame is microseconds since boot (meta.json
`timeStartUs`).
- Fireball: flight logs 10-15 start 16-49 s after boot, so each is a new power cycle, and Kmot starts at 0 at each of
  these spool-ups. Log 5 starts at 84 s; logs 0-4 were not extracted, so its power cycle is not known. Bench log 8 (starts at
  86.8 s) follows bench log 6 (ends at 85.1 s).
- Gaui: these logs start after the end of the previous log (shown as previous end → start), so each is consistent with one
  power cycle:
  - log 40 after 39 (245.8 → 316.0 s);
  - log 41 after 40;
  - log 45 after 43;
  - log 47 after 46.
- The yaw weight of the 2300 rpm profile changed 30 → 40 between logs 39 and 40. If these logs are one power cycle, the
  change was made without a reboot. A later start time is consistent with one power cycle but does not prove it.
- The twin must carry Kmot from the previous log of the same power cycle, or seed it.

**M13 (new). Timer base of the WASM.**
- The firmware slews per loop with the nominal dT (`flight_governor.c:1603-1609`). It times states with `millis()`
  (`405-408`) on the FC clock, which is the log `time`.
- The WASM `millis()` is `hostTimeUs/1000` (`host.c:44`), and the replay advances it by the nominal looptime (R1 10.2).
- The Fireball frame clock is 994.8 Hz, so the replay timers drift by 0.52 %:
  - 78 ms over the 15 s autorotation timeout;
  - 26 ms over the 5 s hold timeout.
- Supply the log time to slot 34. Keep one step per logged loop.

**M14 (new). A one-frame transition offset leaves a constant I offset.**
- In my log 5 replay, SPOOLUP → ACTIVE came 1 frame late (frame 8230). The bumpless reset `I = u/gv - (P+D+F)` then used another
  `u`.
- govI stayed 2 counts low for all 14,769 ACTIVE frames (p01 -3, p50 -2, p99 -2). The throttle p50 was -2 and the RMS 1.94.
- The parity rule must allow a constant I offset from transition timing, or re-sync I at each state entry.

**M15 (new). Side effects of the power and glitch levers.**
- **`gov_max_throttle`** is also:
  - the FUNCTION RUN input (`flight_governor.c:458`);
  - the reference of the "throttle > 0.95 x max" exit of SPOOLUP, RECOVERY and BAILOUT (`1146-1147`, `maxSpoolupThrottle =
    maxThrottle` at `1579`).
  
  A 97 % ceiling moves that exit to 0.92.
- **`gov_headspeed`** sets the glitch thresholds `0.25 x Hf/gear` and `2 x Hf/gear` (`1596-1597`). A lower headspeed to gain
  power reserve also lowers the absolute glitch threshold. At 4000 rpm it is 1000 rpm, and the first FALLBACK's logged
  1051 rpm jump would then exceed it.
- **`gov_rpm_filter`** sets the reference of the glitch test.

The autotune must score these three parameters with scenario G, not only for power or noise.

**M16 (new). The twin does not need the gear ratio.**
- The governor law and the glitch thresholds do not change when the raw RPM input is `headspeed x r1/r0`.
- R1's Gaui replay used gear `[1, 1]` without a CLI dump and matched 99.983 % of states.
- Use rotor RPM and rotor-referred Kv everywhere, as R3 and R4 do. Never ask the pilot for a ratio (CLAUDE.md gear rule).

**M17 (new). The spool-up overshoot depends on the load after handover.** All five rows are at the 80 ramp (`indep.py spool`,
`l13b.py`):

| Log | Throttle 2-4 s after handover | Overshoot |
|---|---|---|
| 13 (climb-out) | 0.72 | 8.3 % |
| 10 | 0.49 | 12.9 % |
| 11 | 0.52 | 13.2 % |
| 14 | 0.54 | 13.0 % |
| 9 (bench run) | — | 13.0 % |

Scenario S must replay the recorded collective after handover. The rule "overshoot <= 2 %" needs ground-only cases (logs 10
and 11 have no airborne flag in the 3 s after handover).

## 4. Contradictions resolved

**C1. Gaui FF weights.**

| Source | Collective | Cyclic | Yaw |
|---|---|---|---|
| R1 | 50 | 10 | 10 → 30 → 40 → 80, "mid-log changes in 40/43/46" |
| R3 | 49.5-49.9 | 6.1-6.9 % | "not identified" |
| R4 | | 7.5 | "78 (?)" |

- **Check.** Collective 50 and cyclic 10 are fixed. I solved the yaw weight alone for each log, each `govRequest` and each half
  log (`indep.py ff`).
- **Result.** The RMS is 0.27-0.33 count in every cell, which is the truncation floor (0.289).
  - 2300 rpm: 10 (log 38), 30 (39), 40 (40, 41, 43, 45), **60 (46)**, 80 (47-49).
  - 2500 rpm: 10 up to log 46, then 80 (48, 49).
  - 2700 rpm: 10 (38), then 80 (48, 49).
- **Resolution.** R1 is correct except for log 46 (60, not 40). R1's "mid-log changes" are PID profiles with different yaw
  weights in one log, pooled. Both halves of each log agree. R3 and R4 pooled logs, so their cyclic weight is biased. The true
  value is 10.

**C2. Fireball "Kv".**

| Source | Value | Quantity |
|---|---|---|
| R1 | 245 rpm/V | loaded H/(u·V) = Kmot/V |
| R3 | 300-320 | Kv |
| R4 | about 270 | Kv, as an illustration |

- H/(u·V) is a lower bound of Kv when the motor current is >= 0. I took 1 s blocks in ACTIVE (`check.py kv`):
  - Fireball p99.5 per flight 259-288;
  - Gaui 153.9-156.2, against 157.8 from the current.
- **Resolution.** Kv is about 265-320. The R4 spool-up bound `10 x Kv x V / a_ss` gives 94-145 over Kv 265-320, a_ss 555-698
  rpm/s and V 24.7-25.2 V. R4 gives one value (105).
- Do the power-limit analysis in the D·V domain, which does not need Kv.

**C3. Time bases.**
- R4 uses real log time: fallbacks at 54.61, 159.50 and 193.58 s. R1, R2 and R3 use index time: 54.334, 158.707 and 192.676 s.
- The ramp slopes are exact per frame in index time: 50.0, 100.0, 125.0 and 500.0 ‰/s (`check.py ramps`).
- In real time they read 0.5 % low (Fireball) or 1.3 % high (Gaui). This explains R2/G15 "12.43 %/s → 80.4" and R4 "≈198 /
  ≈149".
- **Rule.** Identify the slew rates per frame x loops per frame. Show the evidence in log time.

**C4. "One FALLBACK inside a rescue"** (R3 §6.2, §9).
- In log 14 the rescue starts 0.367 s after the FALLBACK entry and lasts to +2.76 s (`indep.py fallback`).
- **Resolution.** No FALLBACK was in a rescue. The rescue came after it, and its states were RECOVERY and ACTIVE.

**C5. gov_handover_throttle.** R1 says "bounds only". R3 says 25.
- In the log 10 AUTOROTATION with the stick at 1000, `motor[0]` is exactly 250 for 373 frames (`ho2.py`). This is
  `clamp(in, auto, handover)` (`flight_governor.c:1063-1064`).
- **Resolution.** The value is identifiable when the throttle reaches handover in IDLE or AUTOROTATION. The Gaui never does:
  its IDLE maximum is 133-148, which gives only a lower bound.

**C6. Spool-up overshoot (corrected from the first pass).**
- **R4 "+22 % once".** This is log 13. The peak of 4273 rpm comes 3.0 s after the ACTIVE entry, after the request changed to
  4500 at +1.94 s. 4273/3500 = 1.22. Before the change the peak is 3789 rpm, 8.3 % (`l13b.py`).
- **Log 15.**
  - It is armed at 3500 rpm: `govRequest` is 3500 from frame 0. The request changes to 4500 at 6.37 s, inside SPOOLUP
    (1.43-8.01 s). SPOOLUP then ends by the 95 % throttle rule at 0.833 of 4500 (`l15.py`).
  - R3 6.1 says "armed in PID profile 2". The first pass said "armed at 4500". Both are wrong.
  - Its 9.1 % comes from a profile switch, so leave it out, as R1 does.
- **Resolution.** At the 80 ramp, the clean flights give 8.3 % (log 13), 12.9 % (10), 13.2 % (11) and 13.0 % (14), and bench
  log 9 gives 13.0 %. R3's median of 12.9 % includes log 15. See M17 for the load effect.

**C7. FUNCTION and autorotation.** R4 (§0.3, 7.2, 7.3-5) says "every RUN→IDLE switch is treated as an autorotation" and
recommends "auto > idle".
- Code: FUNCTION maps `0.333 <= in < 0.666` to `autoThrottle` (`flight_governor.c:449-461`), and
  `isAutorotation = useAutorotation && in >= autoThrottle` (`389-392`).
- The pilots' middle position (rcCommand 509) is therefore AUTO. It always gives AUTOROTATION when the timeout is > 0, whatever
  the idle value.
- Data (`indep.py fmode`):

  | `rcCommand[4]` | Fireball states | Gaui states |
  |---|---|---|
  | 1000 | OFF, IDLE, SPOOLUP, RECOVERY, ACTIVE, FALLBACK, AUTOROTATION (872 frames, log 10 before the BAILOUT), BAILOUT | IDLE, SPOOLUP, ACTIVE |
  | 509 | OFF, IDLE, AUTOROTATION (44,528 frames) | OFF, IDLE, AUTOROTATION (9,238 frames) |
  | 0 | OFF only | OFF, or HOLD (6,825 frames) |
  | any other value | never logged | never logged |

- "Auto > idle" changes only a low position that is not "off". These switches have no such position.
- **Resolution.** R1 is correct. For log 10 the levers are:
  - position 0 for a ground stop (HOLD → OFF);
  - `gov_autorotation_timeout`;
  - a transmitter change that puts a not-off position below 0.333.
  
  The last lever is outside the CLI file (open question 10).

**C8. Gaui throttle ceiling.** R2's probe guesses a ceiling of 904-939, flags G6 for log 49 profile 3 and gives L1 0.10-0.57 s.
R3 says the Gaui never reaches a ceiling.
- The `health_gov.cjs:284-286` pile rule fires on log 49 at 2700 rpm: 904, with 90 frames against 29 per value below.
- At those frames `govSum - motor[0]` is at most 0, so there is no clamp (`pile2.py`).
- **Resolution.** R3 is correct. Before calling a pile a ceiling, require `govSum > motor[0]` (the G7 identity).

**C9. Saturation seconds per flight.**

| Source | Value | Definition |
|---|---|---|
| R1 | 1.9-6.3 s | per long flight |
| R2 | 2.1-6.7 s | L1, all phases |
| R3 | 18.1 s in total | flight phase |

- At 100 % in the flight phase, by flight: log 5 2.0 s, 10 2.4 s, 11 5.8 s, 13 2.5 s, 14 2.4 s and 15 2.7 s (`indep.py sat`).
- R2's 6.7 s for log 10 includes 3.95 s of ESC-limited acceleration on the ground after the BAILOUT (M4).
- **Resolution.** Split the saturation evidence by cause:
  - power or load;
  - ESC acceleration (BAILOUT/SPOOLUP exits, headspeed < 50 % of the request).

**C10. Throttle drift and loop-gain change over a pack.**

| Source | Throttle drift | Loop-gain change |
|---|---|---|
| R3 | 73.5 → 90.6 % | "the same 23 %" |
| R4 | +6-8 points | ±7 % |
| R2/G11 | +7.31 ± 0.33 points at equal collective | |

- R3's 90.6 % is the median of the 21.5-22.0 V bin. Sag puts high-load samples in that bin, so it includes load.
- At hover-like load (|collective| 0.05-0.25, cyclic < 0.15, |yaw| < 0.2, 4500 rpm), I compared the first and the last 60 s
  (`indep.py drift`):
  - D·V stays at 17.5-18.1 V (±3 %);
  - the throttle rises +1.7 to +7.0 points while Vbat falls 0.95-1.98 V.
- The throttle need and the plant gain both scale with 1/Vbat. That is 8-10 % over 24.4 → 22.0-22.5 V.
- **Resolution.** R4 and G11 are correct, and R3's 23 % is too large. For vcomp the important point is this: F is in absolute
  throttle units, so precomp sized at full pack is about 10 % short at the end of the pack.

**C11. Power-limit demand.** R3 says "p99 D·V demand 21.6-21.7 V ≈ end-of-pack voltage".
- R3 computes the demand on unsaturated samples only. At 4500 rpm, 1.66 % of ACTIVE flight samples are at >= 98 %
  (20.0 of 1206 s). The true p99 is therefore in the censored part.
- The unsaturated p99 is 21.46 V (`dv.py`). The agreement is partly circular.
- **Resolution.** Estimate the demand above p98.3 with the load model of the twin at those instants, or with a censored
  estimator.

**C12. FALLBACK cause.** R2 (the app's G20) labels all 3 events "overload". R1, R3 and R4 say "RPM glitch".
- ACTIVE → FALLBACK happens only when `!motorRPMGood` (`flight_governor.c:1163-1164`). That needs one of these
  (`584-606`):
  - an RPM error, which means a headspeed near zero;
  - a glitch;
  - a forced fallback.
- An overload cannot cause it. Getting `|raw - PT2(raw)| > 1125` from a real deceleration would need about 55,000 rpm/s.
- G20 looks for a glitch only on samples below the high throttle (`health_rescue.cjs:162`). A glitch at 100 % can therefore
  never be classified "signal". This is a structural defect.
- The logged jump measure depends on the window: 894/1258/858 rpm up to +2 ms, 1051/1276/1316 rpm up to +100 ms. The
  FALLBACK state itself proves the raw fault.

**C13. Rotor-speed authority without current.** R4 (5.2, 6.1) says τ_m is identifiable without current. R3 (5.3) finds
a_u = 37 (free fit) against 115-280 (from the current), with the same closed-loop fit: 11.7 against 13.5 rpm RMS.
- **Resolution.** τ_m is identifiable in structure, but not in practice from closed-loop ACTIVE data.
- Spool-up and BAILOUT are limited by the ESC acceleration (M4), so they give a_ss, not τ_m.
- What is left:
  - Fireball: the three FALLBACK throttle steps (-28 to -33 %) and about 20 s at 100 %.
  - Gaui: the current.
- A factor of 3-7 in authority is 10-17 dB of loop gain. R4's "GM >= 6 dB" cannot be evaluated robustly without it.

**C14 (new). Glitch statistics.**
- R4 4.6 gives "chance ≈ 2·10⁻¹¹" for all 6 glitches falling in the 1.6 % saturated share. That assumes independent events.
- R3 6.2 shows clustering: 65 jumps in only 5 of 51 runs at 100 %.
- Count runs or time blocks. The association stays strong: below 90 % R3 finds 3 jumps in 1337 s, which predicts 0.04 jumps in
  the 18.1 s at 100 %. The stated p-value is still wrong in kind.
- Only 5.4 s were at 98-99.9 %. "100 % duty" and "highest current" therefore stay confounded.

**C15 (new). Vcomp in the twin.** R4 1.1 says the WASM host "can reproduce both cases" through `getBatteryVoltageSource`.
This is true only after the CLI `battery_meter` → `voltage_meter` mapping exists, and after `battery_cell_count = 0` gets the
firmware auto rule (R1 10.3-1/2, R2 item 2). Until then the diagnostic default is ADC, which turns vcomp on where the
firmware cannot.

**C16 (new). Gaui battery source.** R3 7.1 says it is ESC. R2 and R4 do not say. M10 has the evidence: it is unknown.

**C17. Smaller items.**
- **Vbat updates.** R3 says 20 ms (Fireball) and 10 ms (Gaui). The others say 28.6-32 per s and 41-56 per s. Both are true:
  value changes against the 10 ms task grid (`vbat_update_hz = 100`).
- **"WASM runs the full governor" (R1) against "the governor path can never become active" (R2).** Both are true:
  - the pipeline's `compatibility` refuses the Fireball CLI (`schema.cjs:20-21`);
  - R1's replays bypass this with `direct: {battery_cell_count: 6, voltage_meter: 2}` (`replay_fireball_log*.json`).
- **health_gov comment.** The comment "lower with SWITCH/FUNCTION" (`health_gov.cjs:150`) is wrong for FUNCTION (R2 is
  correct).
- **PID profile labels.** R1 writes p0/p1/p2 (CLI numbering). R2 and R3 write PID profile 1/2/3. Keep the CLAUDE.md convention.

## 5. The five decision-relevant claims, checked

**V1. The governor never reads current. Vcomp needs ADC + ELECTRIC, and gv = 1 in all logged flights. CONFIRMED.**
- `flight_governor.c` has no current accessor (grep).
- The only battery reads are at `495-496`. The gate is at `1556`: `flag && getBatteryVoltageSource() == VOLTAGE_METER_ADC &&
  useElectricMotor`, evaluated in `governorInitProfile`.
- `pg/battery.h` at 118e912 has NONE=0, ADC=1, ESC=2, FBUS=3. The schema range [0, 2] (`schema.cjs:21`) leaves out FBUS.
- Data (`indep.py vcomp`): in 1,473,196 Fireball and 1,400,250 Gaui ACTIVE frames, 0 have
  `|motor[0] - clamp(govSum, 100, 1000)| > 1`.
- **Consequence.** Current can be optional for the governor. It only gives scale to the plant (C13). The vcomp advice is
  definite for the Fireball and conditional for the Gaui (M10).

**V2. The WASM runs the whole governor with replay parity, and the boundary has defects. CONFIRMED.**
- I re-ran `scripts/replay.cjs` on Fireball log 5, 0-23 s:
  - state agreement 0.99987 of 23,000 frames, with 2 one-frame offsets (frames 2462 and 8230);
  - ACTIVE throttle RMS 1.94 counts, max 5;
  - P/I/F RMS 0.26/2.4/1.37, target 0.05.
  
  These equal R1 10.4. The I offset is M14.
- The first pass re-ran log 10 and got 0.99975 and throttle RMS 0.52.
- Defects confirmed in source:
  - `battery_cell_count` minimum 1 (`schema.cjs:20`; firmware range 0-24, `settings.c:885`);
  - no `battery_meter` alias (`firmware_controller.cjs:55` has `voltage_meter:{NONE,ADC,ESC}` only);
  - `gov_mode` enum without `OFF` (`:55`, against `settings.c:474-476`);
  - fast-RPM stub (`host.c:53`);
  - `memset(&gov, 0, ...)` on reset (`bridge.c:7`).
- A FALLBACK in a replay: 1 of 3 missed, 2 of 3 late (M11). A log 11 test also needs profile switches, at 11.49 s and 32.44 s
  before the event (`req.py`).

**V3. FALLBACK and RECOVERY mechanics. CONFIRMED, with numbers for the levers** (`indep.py fallback`).

| Event | Throttle >= 999 in the prior 0.4 s | FALLBACK throttle | = 0.9 x govI | With precomp ON, 0.9 x (I+F) | RECOVERY entry (logged = model) | Kmot |
|---|---|---|---|---|---|---|
| Log 11, 54.334 s | 151 frames | 688 | 687.6 | 855 | 649 = 649 | 5585 |
| Log 11, 158.707 s | 226 frames | 672 | 671.4 | 900 | 555 = 555 | 5363 |
| Log 14, 192.676 s | 257 frames | 719 | 719.1 | 1021 → clamped to 1000 | 521 = 521 | 5432 |

- The RECOVERY entry model is `min(T/Kmot, H/R)`. My EWMA reconstruction of Kmot reproduces it to the count.
- Precomp ON would have held 86-100 % for the 0.2 s FALLBACK window. RECOVERY then still starts at T/Kmot, because the
  firmware sets it there whatever the FALLBACK throttle was (M6).
- So recommend precomp ON and a smaller drop only together with `gov_recovery_time` and `gov_tracking_time`, scored in
  scenario G. The cause to fix is the RPM signal.

**V4. Governor values change between logs with identical headers, and the log identifies them. CONFIRMED.**
- Fireball ramp slopes in index time, ‰/s, with the implied value in brackets (`check.py ramps`):

  | Log | Startup | Spool-up | Spool-down | Recovery |
  |---|---|---|---|---|
  | 5 | 50.0 (200) | 100.0 (100) | -100 (100) | |
  | 6, 8 | 50.0 (200) | 100.0 (100) | -133.3 (75) | |
  | 9 | 100.1 (100) | 125.0 (80) | -200 (50) | |
  | 10, 11, 13, 14, 15 | 100.1 (100) | 125.0 (80) | -125 (80): logs 10, 11, 15 | 500 (20): logs 10 (BAILOUT), 11, 14 |

- Gaui:
  - `gov_spoolup_time` goes 200 → 150 at log 46 (66.64 ‰/s);
  - startup is 250 and spool-down is 30;
  - the yaw weights are as in C1.
- No INFLIGHT_ADJUSTMENT changed a governor value (M7).
- The brief's "logs 6-16 no parameter changes" is wrong for 1-based 6-16 (0-based 5-15). Only flights 10-15 match the
  2026-10-13 CLI.

**V5. Fireball power limit. PARTLY CONFIRMED** (`indep.py sat`, `check.py kv`, `dv.py`).
- At 4500 rpm, 20.0 of 1206 s (1.66 %) of the ACTIVE flight phase are at >= 98 %, and 15.3 s at 100 %. R3 gives 1.68 %.
- At 5000 rpm: 3.1 of 183 s (1.69 %).
- The pile at exactly 1000 is real (`govSum > motor[0]` there).
- Corrections:
  - log 10's L1 total is mostly ESC acceleration (C9, M4);
  - the p99 demand is censored (C11);
  - the drift is 8-10 % relative at equal load, not 73.5 → 90.6 % (C10);
  - Kv is uncertain (C2), so state the limit in D·V.

## 6. Open questions

1. **Authority without current (C13).** How do we bound J·R_m/Kt on the Fireball and on other helis without current? Options:
   - the FALLBACK steps;
   - the saturation runs;
   - a requested test flight;
   - gain changes only inside a trust region where the bootstrap twins agree on stability.
2. **Cause of the glitches at 100 % throttle.** The candidates are frequency-sensor edges at 100 % ESC duty, the current, and
   an ESC endpoint below 1940 µs. The logs cannot separate them (C14). Which test do we recommend?
   - `gov_max_throttle` 97-98, with its exit side effect (M15);
   - the `freq_input_*` settings;
   - `debug_mode = RPM_SOURCE` or `FREQ_SENSOR` to log the raw RPM.
3. **ESC soft start.** Is a_ss (555-698 rpm/s) an ESC setting? The answer decides whether the spool-up advice is an RF ramp time
   or an ESC setting. `EscThr` and `EscPwm` would show it (M1).
4. **Gaui battery source (M10).** Is it ADC or ESC? Until a log with `blackbox_log_esc` answers this, the vcomp text must be
   conditional.
5. **Fireball Kv** (265-320). We use the D·V domain wherever possible. Which spool-up bound do we publish with this
   uncertainty (C2: 94-145)?
6. **"From" values (M8).** May log-identified governor values serve as "from" values and give CLI text without a dump? These
   are the timing values, weights, handover and fallback drop.
7. **Scope (M3).** Are NITRO, DIRECT, LIMIT and the SWITCH/NORMAL throttle types in scope for this round? Or are they out of
   scope with an explicit message?
8. **Headroom rule.** Which statistic and threshold go into RULES?
   - the doc's 15-25 % reserve at the median;
   - the reserve at end-of-pack voltage;
   - the reserve at the p95 load.
   
   How do we treat the censored top 1.7 % (C11)?
9. **Kmot seeding (M12).** When a log continues a power cycle, do we reconstruct Kmot from the previous log, or seed it from the
   first SPOOLUP? What does the twin assume when the previous log is missing?
10. **Remedies outside the CLI file.** The log 10 bailout needs one of these:
    - a pilot procedure (position 0 for a ground stop);
    - `gov_autorotation_timeout = 0`, which also removes the bailout;
    - a transmitter change of the switch positions (C7).
    
    The ESC soft start and the RPM wiring are also outside the CLI. How does the export present advice that has no `set` line?
