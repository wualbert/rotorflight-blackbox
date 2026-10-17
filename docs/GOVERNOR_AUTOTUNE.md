# Governor digital twin and governor autotune (design and implementation guide)

Status: implemented 2026-10-15 (toolkit, worker command `governorTune`, the "Governor model" panel of the Governor tab, the CLI file;
section 8 has the end-to-end results on the real dumps; the review of 2026-10-15 corrected the flags and their sources, the FALLBACK
acceptance of each PID profile and the NOMAD time). This file was the specification that the implementation follows, and is now
its documentation.
Research inputs (read them before you change this design): `analysis/governor-20261014/`:

- `firmware_parameters.md` and `.json`: every governor parameter, its semantics and its log evidence;
- `app_governor_stack.md`: what the app already has, and its gaps;
- `log_evidence.md`: measured evidence;
- `models_and_guidance.md`: the plant model and the official guidance;
- `critique.md`: corrections. Where `critique.md` disagrees with the other reports, `critique.md` is correct.

User requirements (2026-10-14):

1. Build a governor digital twin with an appropriate model. Battery current is optional, because not all helicopters
   record it. The Fireball has no current sensor but has ESC voltage telemetry. The Gaui X4 II has both.
2. Make the autotune cover **every** governor parameter. There are 42 names, listed in section 5.
3. Make each problem that the research found part of the recommendations:
   - the power limit and the battery-voltage tradeoff;
   - voltage compensation that cannot work with an ESC voltage source;
   - FALLBACK after RPM glitches at 100 % throttle;
   - spool-up overshoot that the ESC soft start causes;
   - autorotation and bailout behaviour with FUNCTION throttle;
   - unlogged parameter changes;
   - the RECOVERY entry throttle;
   - the WASM boundary defects.

All CLAUDE.md rules apply. The rules that bite most here:

- write STE text;
- keep the PID profile labels;
- the log is the only necessary input, and a CLI dump is optional;
- flag values that are possibly not current;
- never question gear ratios;
- examine each output that is at its limit;
- give every recommendation a number, its uncertainty and its rule;
- keep thresholds in `RULES`;
- `tools/autotune/*.cjs` files have no Node API at load, export with `module.exports`, then
  `if (require.main !== module) return`, and need a `distSources` entry;
- tests run locally.

## 1. Architecture

```
log (worker decode, all phases of flight logs) ──► gov_data.runOf()  ──► run objects (section 2)
                                                        │
             gov_params.cjs  (configuration recovered from the log, epochs, sources) ◄──┤
             gov_twin.cjs    (plant: ESC + motor + drivetrain + load + battery + sensors)
             gov_fit.cjs     (identification, bootstrap, open-loop and closed-loop validation, plot data)
             firmware_controller.cjs  govCreate(): native Rotorflight 4.6 governor only (controller.wasm, rf_gov_step)
             gov_sim.cjs     (configOf: the configuration of each log; run: the native governor flies the twin or the record)
             gov_scenarios.cjs (GC1-GC9: power and battery, spool-up, tracking, FALLBACK, maximum throttle, BYPASS, BAILOUT)
             gov_search.cjs  (GS1-GS7: feedforward, gains with the margin test, filters, NOMAD, limits, acceptance)
             gov_tune.cjs    (one row per governor parameter, the rule rows, recommendations, autotune(): the one call)
                                                        │
worker command `governorTune`  ──►  Tuning view, Governor tab: twin quality plots, parameter table, CLI recommendations
```

The governor twin is separate from the 6-DOF twin (`heli_twin.cjs`). It takes the recorded stabilized mixer inputs as the
rotor load. This is valid because the speed loop has weak coupling to attitude; only the yaw torque reaction couples
back. The 6-DOF twin keeps its own simple drivetrain. A later step can replace it with `gov_twin.step` (not in this
round).

## 2. Run objects (shared by gov_params, gov_fit, gov_tune)

`gov_data.cjs` builds one run per decoded log segment of a **flight log**. Bench runs are not used (CLAUDE.md).
The run keeps all flight phases: idle, spool-up, ground, flight and spool-down. All arrays are at the logged frame
rate (`rate`, Hz):

| field | source | unit |
|---|---|---|
| `log`, `segment`, `rate`, `n`, `t0Us` | decode | |
| `pidHz` | header `looptime × pid_process_denom` | Hz; Fireball 1000, Gaui 2000 (logged every second loop) |
| `time` | `time` | s from segment start |
| `hs` | `headspeed` (lib `w.hs`) | rotor rpm |
| `u` | `motor[0]` / 1000 | 0..1 (governor output) |
| `thr` | `rcCommand[4]` / 1000 | 0..1 (throttle stick, governor input) |
| `roll`, `pitch`, `yaw`, `coll` | `mixer[0..3]` / 1000 | stabilized mixer inputs |
| `vbat` | `Vbat` / 100, or null | V; null if missing, all 0, or not finite |
| `ibat` | `Ibat` / 100, or null | A; null if missing, or non-zero in < 50 % of motor-running frames |
| `govP/I/D/F/Sum`, `target`, `request` | `govP` ... `govSum` (/1000), `govTarget`, `govRequest` | null if not logged |
| `state` | GOVERNOR_STATE events (`govStateAt`) | 0..9; null if not logged |
| `profile` | `profileAt` (1..6, or 0 unknown) | |
| `armed`, `airborne`, `rescue`, `phase` | `armedAt`/log start, `airborneAt`, `rescueAt`, health_phase | |
| `vario` | `vario` / 100 or null | m/s |
| `header` | flight header | |

`hasVoltage`, `hasCurrent` and `hasGovernor` are booleans on the run. A missing field gives a reason in STE text, never
an exception.

The dev harness reads the same columns from `analysis/governor-20261014/data/{fireball,gaui}/*.f32`, with
`meta.json` and `phases.json`. `gov_data.fromColumns(columns, meta, phases)` and the worker path give identical run
objects.

## 3. Governor twin (`tools/autotune/gov_twin.cjs`)

A grey-box averaged model. It uses the voltage-domain form (`models_and_guidance.md` 5.1-5.2) so that every quantity the
governor sees can be identified without current. In the formulas below, H is rotor rpm, d is ESC duty and V is volts.

```
ESC        d* = clamp(u, 0, 1)                         (u0 is not an offset: duty = throttle in steady state, models 4.1; the
                                                        static regression with current gives a residual of 0.22 V with d = u,
                                                        0.38 V with d = (u − 0.116)/(1 − 0.116))
           normal:      d += (d* − d)·(1 − e^(−dt/te))
           soft start (armed from a stopped motor, or after d* < dOff for softOffS = 1 s, also inside an unfinished soft start):
                        the ESC waits with d = 0 until d* ≥ u0, then it holds the rotor on a speed ramp lim: lim(0) = max(H, as0),
                        dlim/dt = min(ass, as1 + asr·lim). Under the ramp d follows d* (lag te); at the ramp d is the duty
                        that holds H = lim. It ends when H reaches softEnd (0.75) of the no-load speed kv·d*·OCV from
                        under it (a restart with the rotor above it keeps the ramp: Fireball log 8, 1183 rpm), or when
                        lim passes kv·OCV.
           off:         if d < dOff (0.02) → motor current 0 (coast); no brake torque
Motor      e = H/kv,  s = d·V − e  (slip voltage = R_m·I_m),  s ≥ −sneg (regenerative limit)
Battery    V = (OCV + β·d·e)/(1 + β·d²)  (solves V = OCV − β·d·s with s = d·V − e); recompute after the s clamp
           OCV = V0 − κ·Q,  Q̇ = d·s     (Q in V·s; κ in 1/s)
           a start from rest (initState rest, gov_sim at the log start): V0 = rest voltage − vp
Rotor      Ḣ = (kv/tm)·(s − sL)
Load       sL = n²·(q0 + qc·|coll − c0|^pc + qx·cyc + qy·|yaw|) + qf·n + qs·[H > 0],  n = H/Href,
           cyc = √(roll² + pitch²), coll is the signed mixer collective
Sensors    hsLog: first order th;  vLog: first order tv;  iLog: first order ti on I = d·s/rm + i0 (current only)
```

`Href` is a constant of the run set: the median governed request of the training flights.

Evidence for the terms that the first design did not have (dev data, `analysis/governor-twin/dev.cjs`):

- **ESC soft start as a speed ramp.** Every Fireball start from rest (RF ramps 0.100/s and 0.125/s, and the log 10 bailout
  at 0.5/s) gives the same speed against time: about 300 rpm/s at 500 rpm, then 550-730 rpm/s. A collective pull inside
  the soft start (log 15, 7.6 s) is followed by 1200-1900 rpm/s back to the ramp. That is a speed limit, not a duty ramp.
  On the Gaui the rate is 112 + 0.187·H rpm/s (RMS 23 rpm/s, 10 spool-ups, ages 2-7 s): the offset term `as1`.
- **ESC start throttle `u0`.** Both ESCs start a stopped motor only at u 0.10-0.12 (Fireball median 0.108, Gaui 0.116).
- **`c0`.** The Fireball load at a negative collective is smaller than at the same positive collective: with `c0`
  free the fit gives c0 = −0.22, and |coll|^pc alone leaves 0.52 V RMS of 1-s steady slip against 0.33 V.
- **`qs`, a constant load while the rotor turns** (the no-load current of the motor and the ESC, R_m·i0). In the Gaui
  ground spool-ups the measured slip is 0.1-0.45 V above the n², n load model. Fit: Gaui 0.19 V (`qf` goes to 0), Fireball
  0.11 V.
- **`vp`, the rest offset** (needs voltage; held: section 4 step 4). The battery has no polarization (RC) element. In the
  logs the voltage falls 0.26-0.36 V more than R0 explains in the first 20-60 s and comes back 0.3-0.5 V in the 20 s after
  landing. The twin OCV at a start from rest is the rest voltage less vp (Fireball 0.36 V, Gaui 0.26 V, Gaui without current
  0.07 V): the closed-loop Vbat RMS goes from 0.36 / 0.38 / 0.20 V to 0.31 / 0.17 / 0.17 V (Fireball / Gaui / Gaui without
  current), and the throttle RMS from 0.021 / 0.016 / 0.010 to 0.019 / 0.011 / 0.010. The
  twin is 0.3 V low in the first seconds of a flight instead (`c_battery.png`).

**Data used for the structure choices.** `qs`, `as1` (this round) and `softEnd` (earlier) were chosen with data that
includes the test flights: the Gaui `as1` rate from the spool-ups of logs 38-49, the `qs` gain from the closed loop of the
test logs, `softEnd` from the log 48 overshoot. Held-out evidence (`dev.cjs --test-logs`, `--zero qs|as1`, bootstrap 0, the
gate of section 4, 0-based logs; `analysis/governor-twin/out/heldout.json`):

| split (test logs) | status | closed-loop HS RMS: full / without qs / without as1 | open-loop window HS RMS: full / without qs / without as1 |
|---|---|---|---|
| Fireball 11, 15 (default) | partial (tmBand) | 1.17 / 1.17 / 1.16 % | 1.80 / 1.79 / 1.79 % |
| Fireball 5, 13 | partial (clBand 0.74) | 1.05 / 1.03 / 1.06 % | 1.41 / 1.42 / 1.41 % |
| Fireball 10, 14 | validated | 1.40 / 1.41 / - % | 1.37 / 1.40 / - % |
| Gaui 40, 45, 48 (default) | validated | 0.48 / 0.48 / 0.66 % | 1.34 / 1.41 / 1.34 % |
| Gaui 38, 41, 46, 49 | validated | 0.45 / 0.46 / 0.48 % | 1.28 / 1.35 / 1.81 % |
| Gaui 39, 43, 47 | validated | 0.50 / - / - % | 1.59 / - / - % |
| Gaui without current 38, 41, 46, 49 | validated | 0.42 / - / - % | 1.01 / - / - % |

On the held-out Gaui flights `as1` lowers the open-loop window RMS from 1.81 to 1.28 % and `qs` from 1.35 to 1.28 %. On the
Fireball neither term changes a held-out number by more than 0.03 points: the Fireball twin is as good without them. The
test flights of these splits were in the data that chose the structure, so these numbers are not a strict hold-out of that
choice.

Parameters (`PARAMS`: name, unit, lo, hi, scale log|lin, `needs`):

- always: `kv` [rpm/V], `tm` [s], `te` [s], `ass` [rpm/s], `asr` [1/s], `as0` [rpm], `as1` [rpm/s], `u0` [-], `sneg` [V],
  `q0` `qc` `qx` `qy` `qf` `qs` [V], `pc` [-] (1..3), `c0` [-], `th` [s];
- needs voltage: `beta` [-], `kappa` [1/s], `tv` [s], `vp` [V];
- needs current: `rm` [Ω], `i0` [A], `ti` [s].

Without voltage, V is a constant `V0`, β = κ = 0, and `kv` is in rpm per throttle unit. The battery results then have
the status "not available", with a reason. Current without voltage is not used: with V0 = 1 only R_m/V is identifiable.

Physical values when current is recorded:

- R_m = `rm`;
- R0 = β·rm;
- dOCV/dQ[Ah] = κ·rm·3600;
- J follows from tm = J·R_m/(Ke·Kt), with Ke = Kt = 60/(2π·kv·N). Report J only with current.

API (pure functions, no DOM, no Node API):

```js
GT.PARAMS, GT.PARAM, GT.paramNames({voltage, current}), GT.encode/decode/copy (one object shape keeps step() fast)
GT.defaults({kv, Href, V0, current}) -> p
GT.initState(p, {hs, u, vbat, ibat, stopped, below, lim, d, accel, coll, cyc, yaw, rest}) -> x
                                                             // x: {H, d, soft (0, 1 armed or started, 2 under the end
                                                             //  speed), lim, off, Q, V0, hsLog, vLog, iLog, s, V, sL, I}
                                                             // rest: vbat is a rest voltage, V0 = vbat − vp
GT.step(x, inp, p, dt) -> x                                  // inp: {u, coll (signed), cyc, yaw}; allocation-free, ~90 ns
GT.outputs(x, p) -> {hs, vbat, ibat, H, d, s, sL, V, I}
GT.ramp(p, age, h) -> rpm                                    // the soft-start ramp age s after a start from rotor speed h
GT.load(p, H, coll, cyc, yaw) -> V                           // sL
GT.simulate(p, run, {from, to, stride, x0}) -> {hs, vbat, ibat, d, x}   // recorded u (open loop)
GT.steady(p, {H, coll, cyc, yaw, ocv}) -> {d, s, V, sL, feasible, headroom}   // bisection on d
GT.maxHeadspeed(p, load, ocv, headroom) -> rpm                // highest H with d ≤ 1 − headroom
GT.physical(p, N) -> {Rm, R0, dOcvPerAh, Ke, Kt, J, i0} | null
```

`simulate()` without `x0` starts from the one sample at `from` (d = u, V0 = vbat + β·d·s, the soft start only with the rotor
under softHs·Href). The numbers of section 4 use the start estimate of `gov_fit.stateAt` (pass its state as `x0`: the same
numbers). With the one-sample start, the test windows have an HS RMS of 2.89 % against 1.80 % (Fireball: the windows that
start on the ESC ramp) and a Vbat RMS of 0.20 V against 0.11 V (Gaui: the one-point OCV).

One step: the ESC lag is an exact first-order update; the rotor speed uses the mid-step duty and a linearly implicit step
(trapezoid on smooth steps, implicit Euler on stiff ones), so the 100-Hz fit rate agrees with the PID rate within 0.05 %
of the speed. The sensors are exact first-order responses to an input that moves linearly over the step. Keep `te`, `tm`,
`th`, `tv`, `ti` ≥ 4 ms (`RULES.minTau`).

## 4. Identification and validation (`tools/autotune/gov_fit.cjs`)

`RULES` at the top: fitHz 100, windowS 5, bootstrap 12, blockS 20, jackknife, horizons [0.1, 0.25, 0.5, 1, 2, 5] s, status.

1. **Qualification.**
   - Use flight logs only.
   - Take motor-running frames (`u > 0.02` or `hs > 0.1·Href`) with the rotor turning (`hs ≥ 0.01·Href`).
   - Leave out the first 0.5 s after a motor start from rest (`soft.skipS`): the data sees the start only when hs passes the
     sensor floor (tens of ms late), so the duty at a window start there is wrong (synthetic plant: qf +13 %).
   - A grid point with an input or hs that is not finite is not fit data; a Vbat or Ibat sample that is not finite has no
     residual (`VM`, `IM`). The arrays hold the last finite value, so that the start values and the static analyses stay
     finite. A fit cost that is not finite gives the status `failed` with a reason (`TEXT.fitFail`), never an exception.
   - Classify voltage and current with the rules of section 2. In the validation of a model, a channel that one run does not
     record is not compared, with the reason `TEXT.noChannelV` / `noChannelI`.
   - The split: the test flights are every third flight log (index % 3 == 2) if there are 3 or more flight logs. Else the
     last 40 % of each flight is the test data. `Href` comes from the training data only.
   - The throttle ceiling (`ceilingOf`): the highest logged u in ACTIVE if the log holds it for 0.25 s or more and it is under
     0.995 (`gov_max_throttle` under 100 %), less 0.005; else 0.995. With a configuration (validation), the ceiling of each
     frame is the `gov_max_throttle` of its PID profile (`satLevel`).
2. **Initial values (no LM).** The static analyses use 1-s ACTIVE blocks out of a possible soft start (`STEADY`: not in
   the 20 s after a motor start; there the ESC duty is not u).
   - kv is 1.02 × the p99.5 of the 1-s block ratio `hs/(u·vbat(t+lag))` in ACTIVE. This value is a lower bound: critique
     C2.
   - With current, kv and R_m come from the regression `u·V = H/kv + R_m·(I − i0)/u` (i0: the median current with u < dOff).
   - The loads q0, qc, qx, qy, qf, qs come from the non-negative least squares of the steady slip `u·V − H/kv` on the load
     features, on a grid of pc and c0.
   - te 0.1, tm 0.4, β 0.1 without current (R0/R_m from the regression with current), tv 0.06, ti 0.09, th 0.01.
   - ESC soft start: u0 is the median throttle at the motor starts from rest (the first frame with hs > 0). The ramp (as0,
     as1, asr, ass) comes from a kinematic fit of `ramp()` to the speed against the age, then (values of the model) from
     an output-error fit of the twin on each start from rest (`softFit`: 0.5 s before the start to 2 s after the SPOOLUP
     exit, from two start points). The kinematic fit alone is biased where the duty limits the rotor (synthetic plant:
     as0 0, asr −61 %). The soft start is fitted again after the first LM pass, and held in the LM (`RULES.fixed`).
3. **Output-error Levenberg-Marquardt**, with bounds in log or linear space, a pseudo-Huber loss and an active set at
   the bounds (`lm()`). Two passes: LM, then κ (step 4) and the soft start, then LM again.
   - Windows of `windowS` of motor-running data. Each window starts from the data: H and hsLog from centred means of hs (± 10
     ms) read th later; the soft start from the data (`softAt`, as gov_twin); the duty from the measured acceleration at the
     ramp, else u with the lag te over the last 1 s (from 0 at a motor start in that time); V0 from the mean of
     vbat + β·d·s over the 0.5 s before the window (`ocvS`: one point is wrong by β·Δ(d·s) after a fast load change; out of
     a soft start). The centred and lagged reads are for the fit only (errors in the variables); the validation uses causal
     starts (step 6).
   - Residuals: (hsLog − hs)/σh with σh = 1 % of Href; (vLog − vbat)/σv with σv = 0.05 V; (iLog − ibat)/σi with
     σi = 2 A. A channel that is not recorded gives no residuals.
   - The residual vector has a constant length (the 6-DOF lesson). A step in which the duty crosses dOff is split at the
     crossing (else the cost jumps with te).
   - Weight the open-loop periods ×3 (on the square). These are throttle at the ceiling (step 1), the governor states other
     than ACTIVE, the throttle cuts and 0.3 s after them. They carry the authority information that closed-loop ACTIVE data
     does not give (critique C13).
   - Held: κ and vp (step 4), th (under the 10-ms grid: synthetic 25-55 % error; on the Fireball a free th goes to 0.45 s), u0
     and the ramp (step 2).
4. **κ and vp** (voltage only): for each flight, regress OCV(t) = vbat + β·d·s (from the fitted model on measured H, u) on
   Q(t) = ∫d·s dt. Use a common slope and an intercept for each flight. `restOffset`: the rest voltage before each flight
   less the regression OCV at Q = 0 (the polarization that an R0-only battery does not model). vp is its median (≥ 0); its
   p5-p95 is the spread of the flights.
5. **Uncertainty**, from the main fit:
   - a block bootstrap: 12 refits with resampled 20-s blocks of the training windows (8 LM iterations). With 25 iterations
     (Fireball, 8 refits, 11.6 s against 9.6 s) the ranges of kv, tm, q0, qc, qf and β change by 2 % or less; only the lower
     bounds of te (0.020 against 0.025 s) and qs (0.024 against 0.048 V) go down. The iterations do not make the range narrow;
     the training flights do (next point);
   - leave-one-flight-out refits (`RULES.jackknife`, with 3 or more training flight logs, 20 LM iterations): the jackknife
     standard error, an interval of ± 1.645 se, and the pseudo-sets ẑ + √(n − 1)·(z_i − z̄) in the fit space.
   - The p5-p95 of each parameter is the wider of the bootstrap quantiles and the jackknife interval (`source`). `samples`
     (the parameter sets for the robust tuning) holds both. The soft-start parameters get the spread of the single-start
     fits, u0 the spread of the start throttles.
   - The block bootstrap alone was too narrow on the Fireball: the fits of other training sets gave kv 308.6 and 313.3 rpm/V
     against 316.3-336.5. With the flights: kv 311.7-336.5. The training sets that contain log 11 (+0.42 V of unexplained
     slip, below) still move the load split outside the range: qs 0.35-0.40 V against 0-0.22, qf 0.32-0.42 V against
     0.78-1.81. The Fireball q0/qf/qs split is not identified: only the load curve over n 0.9-1.1 is.
6. **Validation**, on the test data only. Each open-loop start is causal (`stateAt`, `prepare({ causal })`): hsLog and
   vbat are the end points of the least-squares lines over the 20 ms before the start, H and V add th and tv times their
   slopes, and the acceleration and the OCV look back only.
   - **Open loop** (recorded u): HS error in % of target. Give the median |e| and the RMS in ACTIVE, Vbat RMS and Ibat
     RMS, on the 5-s windows (the status) and on whole motor-on stretches.
   - **Horizon curve**: from start points every 0.5 s, simulate h seconds from the estimated state. Baselines: "hold the
     start value" (the start value of the twin's hs sensor: the same information) and, for the horizons that stay in ACTIVE,
     the logged target at the horizon (it uses the future target of the governor). Groups: all, in ACTIVE to the horizon,
     and crossing a state change or a throttle cut (there the twin has the recorded throttle and hold has not).
   - **Closed loop**: the native governor (`gov_sim.run`, plant 'twin') and the twin, from the log start (arm) to the end,
     with the OCV at the rest voltage less vp. The inputs are the recorded stick throttle, mixer inputs, PID profile changes,
     arming and the logged FALLBACK entries (forced: critique M11). Compare HS, u, Vbat and the state sequence (agreement
     fraction). Baselines on the same samples: the logged tracking error (hs − govTarget: a model that always has the
     target), and the fast part of the errors (the mean over 0.1 s less the mean over 1 s, about 1-10 Hz, where the log and
     the twin are in ACTIVE under the ceiling). When the test part has logged FALLBACK entries, the closed loop runs again
     without them (`unforced`). A log, or a part of a log after a logging pause, that starts later than IDLE is not
     simulated (`gov_sim TEXT.midStart`): the governor starts in its reset state. The rows, events and plot traces carry
     the segment.
   - **tm scan**: the closed loop again with tm × 0.5, 0.7, 1.4 and 2 (`tmScan`, with the fast part of each log).
   - **Events**: the spool-up exit throttle and overshoot, the saturated duration (u at the ceiling of step 1), and the
     FALLBACK droop and recovery time (`forced`: the entries are forced at the logged times), the twin against the log
     (RULES.events: ±0.05, ±2 % points, ±30 %, ±5 % points, ±30 %). They are reported, not part of the status.
   - **Status**: `validated` / `partial` / `rejected`, from `RULES.status` (an open-loop failure: rejected; another
     failure or no closed loop: partial):
     - open-loop HS median |e| ≤ 1.5 %; Vbat RMS ≤ 0.15 V;
     - closed-loop HS RMS ≤ 1.5 %, pooled over the test logs, and ≤ 2.25 % (1.5 × the limit) in each test log;
     - `clSkill`: the closed-loop HS RMS ≤ 0.75 × the logged tracking error (the trivial model has 1: 0.91 % on the Gaui and
       1.96 % on the Fireball test logs, both under the 1.5 % limit);
     - `clBand`: the fast part of the closed-loop HS error ≤ 0.7 × the fast part of the logged tracking error (the twin gives
       half of its variance);
     - `tmBand`: no tm of the scan gives a fast part under 0.95 × that of the model (else the test flights do not show tm);
     - closed-loop u RMS ≤ 0.03; state agreement ≥ 0.98. The state sequence follows the stick and the timers: the governor
       on the recorded headspeed gives ≥ 0.995 (parity), and no change of the twin of the sensitivity tests below gives
       less than 0.993. It is a check of the configuration, not of the plant.
     - Sensitivity of the gate (`dev.cjs --sensitivity`: changed twins, the same data): tm × 2 and × 0.5 give `partial` on all three
       twins (tmBand 0.58-0.87, clBand 0.71-0.93 where it fails); kv ± 10 %, loads ± 30 % and β × 2 give `rejected`. With
       the true plant structure (the synthetic native-governor test) the fast part is 0.03 at the fit and 0.33-0.63 at the
       scanned tm.
   - **Plot data** (decimated to ≤ 2000 points per trace):
     - measured, open-loop and closed-loop HS;
     - u (measured and closed loop);
     - Vbat and Ibat (measured and predicted);
     - the horizon curve;
     - the steady-state map: required throttle against collective at each profile headspeed, at the OCV of the full and the
       end-of-pack rest voltage (less vp), with the measured points.

Synthetic recovery (`test/gov_fit.test.cjs`, a gov_twin plant with a PI governor, 20 min): every parameter within 5 %, with
two documented exceptions. u0 is +5.0 % (Fireball-like): the data sees a start from rest when hs passes the sensor floor,
about 40 ms late on the 0.125/s ramp. qf and qs (the n and constant load terms) trade with q0 at n 0.9-1.1 (qf −8.7 % and
+25 %, qs −5.7 %): the test checks the load curve at zero collective instead (within 1.44 % and 1.25 %, limit 2 %).

Results on the dev data (2026-10-15, `analysis/governor-twin/out/<craft>/result.json`, figures by `plot.py`):

| | Fireball (test logs 11, 15) | Gaui (test logs 40, 45, 48) | Gaui without current |
|---|---|---|---|
| open-loop HS median \|e\| (≤ 1.5 %) | 0.53 % | 0.76 % | 0.66 % |
| open-loop Vbat RMS (≤ 0.15 V) | 0.068 V | 0.110 V | 0.102 V |
| closed-loop HS RMS (≤ 1.5 %) | 1.17 % | 0.48 % | 0.47 % |
| worst test log (≤ 2.25 %) | 1.47 % (log 11) | 0.55 % (log 40) | 0.57 % (log 40) |
| clSkill (≤ 0.75) | 0.60 (logged 1.96 %) | 0.52 (logged 0.91 %) | 0.51 |
| clBand (≤ 0.7) | 0.54 | 0.55 | 0.55 |
| tmBand (≥ 0.95) | 0.93 (tm × 1.4) ✗ | 1.02 | 1.02 |
| closed-loop u RMS (≤ 0.03) | 0.019 | 0.011 | 0.010 |
| state agreement (≥ 0.98) | 0.9990 | 0.9994 | 0.9992 |
| status | partial | validated | validated |
| closed loop without the forced FALLBACK | HS 1.32 %, u 0.019, states 0.9964 | (no FALLBACK) | (no FALLBACK) |
| closed-loop Vbat RMS (not in the status) | 0.31 V | 0.17 V | 0.17 V |
| identify / validate time | 28 s / 3.1 s | 37 s / 3.8 s | 30 s / 3.8 s |

Horizon curve (twin / hold / logged target, % of target, horizons in ACTIVE to the end): Fireball 0.1 s 0.78 / 0.81 / 1.98,
1 s 1.78 / 3.20 / 1.94, 5 s 1.79 / 4.35 / 1.90; Gaui 0.1 s 0.61 / 0.62 / 0.91, 1 s 1.33 / 1.58 / 0.88, 5 s 1.31 / 2.94 /
0.88; Gaui without current 5 s 1.08 / 2.94 / 0.88. The twin beats hold at every horizon (at 0.1 s by 0.01-0.10 points only),
and on the Fireball also the logged target. On the Gaui the logged target beats the open-loop twin from 0.25 s (with current)
or 0.5 s (without): the open loop has no feedback, and the governor holds the target. The closed loop compares with that
baseline (clSkill 0.51-0.52).

Limits that the data show:

- **Fireball tm.** The fast closed-loop error is smaller with tm × 1.4 in all six Fireball flights (by 0.1-12 %; tmBand 0.93,
  0.955 and 0.956 on the three splits), while tm × 1.4 raises the closed-loop HS RMS of the training flights from 1.24 to
  1.51 %. The fast small-signal response and the large signals (saturation, spool-up) want different values: a structure
  that the twin does not have (te and tm together, or the ESC). On the Gaui the fit tm is the best of the scan.
- **Fireball log 11** has 6.3 s at full throttle and the twin 3.7 s (5.3 s without the forced FALLBACK entries). Its
  FALLBACK droops are −20 / −43 % against −13 / −30 % in the twin: in the minutes 1-2 of that flight the steady slip is
  0.42 V above the load model (no climb-rate term helps: R² 0.01-0.05).
- **Battery.** vp is an offset, not a polarization element: the twin is 0.3 V low in the first seconds of a flight.
- **No battery voltage.** Without Vbat both crafts give `rejected`: Fireball open-loop HS median 2.27 %, closed-loop u RMS
  0.033; Gaui 1.89 % (`dev.cjs --no-voltage`). The reason text says that the headspeed errors are larger (`TEXT.noVoltage`;
  `gov_tune.autotune` adds it, and `mixedV`, `mixedI`, to the reasons of a rejected model and to the limitations of a model that it
  uses: before 2026-10-15 a rejected result lost it). The Gaui closed loop is also excluded then: without Vbat and Ibat (and without
  a CLI dump), `gov_sim.configOf` cannot choose `gov_mode` ELECTRIC from the candidates (its rule needs a rest voltage above 9 V or
  a current), and the `gov_mode` row says so (`gov_tune TEXT.mode.noSim`, not "The analysis uses ELECTRIC").

## 5. Coverage of the 42 governor parameters (`gov_tune.cjs`, `gov_search.cjs`, `gov_scenarios.cjs`)

The 42 CLI names are the records with scope `global` or `profile` in `analysis/governor-20261014/firmware_parameters.json`
(`settings.c:956-973` and `1202-1226`). `gov_tune.cjs` has them as a constant list (`REGISTRY`, the same order as
`gov_params.NAMES`) with the `firmware/schema.cjs` fields for the ranges:

- `gov_X_ff_weight` ↔ `gov_X_weight`;
- the four `gov_use_*` flags ↔ the bits 2, 3, 4 and 6 of `gov_flags`;
- `gov_bypass_throttle` ↔ `gov_bypass_throttle[0..8]`.

Each name has **one row or more** in each result, and a profile name one row or more for each PID profile with 2 s or more of
ACTIVE in the flight logs (`RULES.minProfileS`). `tune()` returns the check (`coverage.missing`); `autotune()` throws when a name has
no row or when a model family gives a `pending-model` row (a programming error: `defaultRows` gives a row to each name).

The rows come from three modules. Each module adds its rules to `gov_tune.RULES` at load (`toRecommendation` reads the rule of a
row there), with its own ids:

| module | rule ids | rows |
|---|---|---|
| `gov_tune.cjs` | GT1-GT20 | the rule rows: numbers from the logs only (state census, FALLBACK and BAILOUT events, spool-ups, the control limits, the measured reserve, the drift, the RPM signal, unlogged changes), the related rows |
| `gov_search.cjs` | GS1-GS7 | the families `precomp`, `gains`, `filters`, `limits` (section 7.4-7.7) |
| `gov_scenarios.cjs` | GC1-GC9 | the families `power`, `spoolup`, `tracking`, `fallback`, `maxThrottle`, `bypass` (section 7.3) |

`tune(runs, { recovered, cli, model, search, scenarios })` takes the families of `gov_search` (`FAMILIES`, from `ctx.sim` = the
search result) and of `gov_scenarios` (`families(S)`) from their results (`familiesOf`). Without a model (no `search`, `scenarios`
or `families`) the model families give `pending-model` rows with the reason `NOTES.model`. With a model that is not available
(`o.modelReason`: the identification failed, or the validation is `rejected`) they give `not-applicable` rows with that reason.

Row fields:

- `name`, `scope` (global | profile | related), `profile`;
- `current`: the value and its `source`. The source is "CLI dump", "log header" or "calculated from the log: <method>"
  (gov_params). If the value is unknown, the source is "unknown". In the recommendation and the CLI file comment a calculated
  value has the source "analysis of the log" (the method is in the row: a sentence of 25 words or less);
- `status`: `change` | `keep` | `check` (a measurement or the model shows a problem, with no CLI change, or with opt-in CLI text)
  | `not-applicable` (with the reason) | `not-recorded` (the log cannot show it, and the row says how to record it) |
  `pending-model` (no model given);
- `to` (for a change), `evidence` (numbers with `lo`/`hi`, `se`, `n`, `log`, `t0`; every evidence row of a model row has its number,
  because the CLI file shows it), `rule` (a key of RULES), `method` (model | simulation | rule | firmware | data), `stale` (flags),
  `caveats`, `notes` (text past the 6 sentences of STE Rule 6.6: the Governor tab can show it, the CLI file does not), `optIn` (the CLI
  text of a check that the pilot can select: `gov_tune.optIn`; `gov_scenarios.finish` puts it in the recommendation, and
  `advice.exportPlan` writes it only when the pilot selects it), `group`, `groupSize` (the changes that one acceptance tests together:
  `advice.cjs` takes all of them or none, in the CLI file and in the export panel).
- `stale` of a row that simulates the logs (method `simulation`) also has the flags of the values that its simulations use
  (`gov_tune.simStale`, CLAUDE.md "Values that are possibly not current"): for each name that the family uses (the governor values of
  ACTIVE flight, and for the spool-up, FALLBACK and BAILOUT rows also the state machine values), each gov_params flag of a simulated log
  (a change between logs with no record, an in-flight adjustment) with its values and the source, and a second arm or a pause in a
  simulated log (all values). A flag of a PID profile applies only to the rows of that PID profile.
- A recommendation has in `fromSets` the values of the `advice.govLinks` rules that the analysis knows (`gov_tune.linkedOf`:
  `gov_mode`, `gov_throttle_type`, `gov_handover_throttle`, `gov_idle_throttle`, `gov_auto_throttle`, and of its PID profile
  `gov_max_throttle`, `gov_min_throttle` and the four `gov_use_*` flags). Else the CLI file says that a known value is unknown.

A change of the model has at most 4 sentences in its text (`toRecommendation` adds 2), a keep or a check at most 6.

| parameter(s) | rows: rule and method |
|---|---|
| gov_mode | GT1, firmware/rule. ELECTRIC with a fast RPM source. LIMIT/DIRECT/NITRO: not-applicable rows for the model parts, with the reason. OFF: everything not-applicable. `autotune()` does not make the model then (status `unavailable`). |
| gov_throttle_type | GT2. NORMAL/SWITCH/FUNCTION semantics. SWITCH sets the request from the stick (then the govRequest profile rule does not apply; the row says so). |
| gov_handover_throttle, gov_idle_throttle, gov_auto_throttle, gov_autorotation_timeout, gov_throttle_hold_timeout | GT4 state census (with FUNCTION, the middle position is AUTO, so each RUN→middle is an autorotation: critique C7); GT5 a check for each logged BAILOUT from a slow rotor. GC9 (model, check): a BAILOUT from a slow rotor (FUNCTION with AUTOROTATION from ACTIVE, or a logged one) flown by the twin set and the two soft-start twins at full and end-of-pack voltage (`switchRun`: RUN, the middle position until the rotor is at the share of the target with the motor off for the soft-start time, RUN again): the time at the maximum throttle and the overshoot, and the logged BAILOUT against the twin. The levers: stick position 0 for a ground stop, and `gov_autorotation_timeout` 0 (no bailout). |
| gov_startup_time, gov_spooldown_time | Recovered value and the ramp slope (GT6/GT19); GC3 keep with the numbers of the twin (the start throttle u0 and its time after the start of IDLE, the time to 0 from the hover throttle). |
| gov_spoolup_time, gov_use_pid_spoolup | GT6 the measured overshoot of the logs. GC3 scenario S: a spool-up from a stopped motor with the identified ESC soft start (the speed ramp `ass`, `asr`, `as0`, `as1` and the start throttle `u0` of section 3), at the ground load after the SPOOLUP exit of the recorded spool-ups (critique M17), at full and at end-of-pack voltage (E of the training flights). The smallest `gov_spoolup_time` (10-400, step 10) with the PID option at this time, and with `gov_use_pid_spoolup` ON, that keeps the overshoot ≤ 2 % for every twin of the set and the slow and fast soft-start twins. A problem: the log median > 2 %, or the main twin > 2 % by more than its error on the test spool-ups. The acceptance: **one unit for each test spool-up** (the smallest effect over its rest voltage, F and A; the same spool-up at three voltages is not three units), 3 or more units (GC1). With fewer test spool-ups, and less overshoot on each unit of each twin, the change is a check with opt-in CLI text (the unit numbers are evidence). The time and the PID spool-up changes are one group (`GC3:spoolup`): the time of the PID candidate needs the flag ON in each PID profile (a caveat says so, with the value without it). A `gov_use_pid_spoolup` that the log does not show is "unknown" in the row ("The log does not record this value. The model uses OFF, the default value of the firmware."): the model uses OFF, and the candidate keeps the flags (a change of an unknown value has no CLI text), so the value without the PID spool-up. The PID spool-up target slope is max(Hf, Kmot)·10/T (`govCalcHeadspeedRate`, flight_governor.c:562-565): the first spool-up of a power cycle has Kmot 0 (the logged spool-ups are in PID profile 1 at 3500 rpm: 350 rpm/s at 100), a second spool-up in one power cycle has Kmot of about 5400-6700 (540-670 rpm/s, inside the ESC ramp of 555-698 rpm/s). The review flew two spool-ups in one power cycle for PID profiles 1-3 with the main, tm × 1.4 and slow soft-start twins at 25.2 and 22.26 V: 100 with the PID spool-up gives 0.5 % overshoot or less on the second spool-up. |
| gov_tracking_time | GC4: the acceleration below the maximum throttle (median load, end-of-pack OCV, 80-100 % of Hf) against the target slope max(Hf, Kmot)·10/T after a PID profile change, RECOVERY and BAILOUT (critique M6). The smallest T for every twin; a change only with the acceptance on the saturated time after these events in the test flights, else a check. |
| gov_recovery_time, gov_fallback_drop, gov_use_fallback_precomp | GT12 a check for each logged FALLBACK (0.9·govI, the RECOVERY start min(T/Kmot, H/R), the droop). GC5 scenario G: an RPM error (a raw RPM spike, gov_sim `glitches`) at each logged FALLBACK, 0.2 s after the start of each load saturation period in ACTIVE, and at 3 seeded ACTIVE times of each flight (at least 8 s between two errors of one simulation). Selection on the training flights (main twin): the precomp and the drop together ({OFF, ON} × {the value at this time, 5, 15, 20}, without OFF and a larger drop), then the recovery time (10, 30): the smallest headspeed loss over 5 s (% s) with the RECOVERY overshoot ≤ max(at this time, 2 %). **The cue rule**: at each error at which the values at this time decrease the throttle in FALLBACK by 5 % or more (1 − the mean throttle in FALLBACK / the throttle before the error), the candidate must too. The parameter is not sufficient: with the precomp ON, the FALLBACK throttle is (I + F)·(1 − drop), and with a saturated PID sum at the maximum throttle I + F can be 1.13 (critique V3), so no decrease. **The recovery time** also sets the rate of the throttle increase in RECOVERY, BAILOUT, AUTOROTATION and BYPASS (flight_governor.c:1064-1071): a new value must not increase the overshoot by more than 1 % point or the time at the maximum throttle by more than 0.5 s (GC9 `over`, `satS`) in a RECOVERY after HOLD and a BAILOUT from a turning rotor (90 % of the target, the median hover load), a BAILOUT from a slow rotor (F and E), and the recorded BAILOUTs from a slow rotor (training logs for the selection; all logs, each twin and the soft-start twins for the acceptance). A change only when the logs have an RPM error (a FALLBACK, or a step of the headspeed signal at the maximum throttle) and with the acceptance on the test errors (the bootstrap and the cue rule for each twin). **Each PID profile** (review 2026-10-15): the selection gives one value for all PID profiles, but the drop and the precomp of PID profile p change only the errors of p, so the acceptance runs again on the test errors of p alone (`accept.profiles[p]`: its bootstrap, its cue rule, and the recovery cases of a new recovery time). The rows of p give the numbers of its own errors (`profiles[p]`: the mean lowest headspeed, the loss, the time under 90 %, the cue at its errors at the maximum throttle, or "no error at the maximum throttle"); the selection numbers of all PID profiles are evidence and say "all PID profiles". A change of p needs the rule on the errors of p. With fewer than 3 test errors in p and the rule passed on all errors: a check with opt-in CLI text ("The test flights have only 1 RPM signal error in PID profile 1 …"). `gov_recovery_time` (global) keeps the acceptance on all errors. A value that the rows do not know (log only) and the model takes from a configuration has its source in the text (`fallback.assumed`: "The log does not record "gov_fallback_drop". The model uses 10, the default value of the firmware."). The precomp and the drop of one PID profile are one group (`GC5:fallback:<PID profile>`: the cue rule depends on the pair). |
| gov_max_throttle | GT7 each period at the maximum (CLAUDE.md "Control limits"); GT13 the sudden changes of the headspeed signal of check G21 (`health_gov.spikeScan` and `g21Pool`: the same detector and test as the analysis, in all flight phases with the governor in RECOVERY, ACTIVE or FALLBACK) by throttle band against the time at the maximum. When check G21 gives a change for a PID profile (`gov_tune.g21Change`: k ≥ 3 changes at the maximum, binomial p < 0.001, the rate under the maximum 1/10 or less): GC6 also flies the value of that change (the maximum − 3) with the twin set, and the row gives its cost at end of pack (the time at the maximum, the droop) as evidence, a check with no CLI text of its own (the CLI text is the one of `G21:gov_max_throttle` in the analysis: no second set line in the export); without a model result for that value, the same check with no cost (never the opt-in 98). Else GC6 as before (check with opt-in CLI text 98): for a PID profile with a FALLBACK at the maximum throttle, or with 0.5 % of ACTIVE flight at the maximum and sudden changes there, the test for the RPM errors at 100 % duty and its power cost at end of pack (95 and 98 % against the value at this time). A PID profile with a period at the maximum throttle in the logs is a check (never `keep`), and the row gives the number and the time of the periods of GT7. |
| gov_min_throttle, gov_use_dyn_min_throttle, gov_dyn_min_throttle | GT15 rule + data: the floor contacts in ACTIVE. Keep unless a contact. |
| gov_headspeed | GT8 the measured reserve. GC2 scenarios E and F: the q95 of the required throttle (`dReq`, the closed form of `gov_twin.steady`) of the 0.1-s load blocks of ACTIVE flight of the training flights at the end-of-pack OCV of the training flights (the censored demand comes from the load model: critique C11), plus the part of the logged q95 throttle that the twin does not give at the recorded voltage. With a reserve under 15 %: the largest headspeed with the reserve at the same thrust (collective coll/r²: the thrust is in proportion to Ω²·θ with θ0 ≈ 0 for symmetric blades, so the pivot is the zero collective; c0 is only the collective of the smallest torque in the load law; cyclic and yaw /r², in the collective range of the flights) for each twin; the candidate is the lowest of the set, a decrease of 10 % at most (`maxChange`: the model extrapolates the load law), and different from the headspeed (at this time, or recommended) of each other PID profile by a step of 10 rpm or more (CLAUDE.md "PID profiles": govRequest gives the PID profile only when no other PID profile has that headspeed): the next step down when the reserve sets the candidate, else up, in [cap, Hf). **Never a change** (the user, 2026-10-15: the headspeed is the decision of the pilot): a passing headspeed is a check with opt-in CLI text that is never selected by default (`advice.exportable` and the dialog `pickDefault` also refuse each `set gov_headspeed` line as a default pick). It passes with (1) the acceptance on the test blocks at A (the lowest rest voltage of all flights; the time above 85 % throttle), (2) 0.25 s or more of load saturation in ACTIVE flight of that PID profile in the logs (`minSatS`; else a check with opt-in CLI text: the reserve rule alone is a design margin, not a measured problem), (3) a FALLBACK limit 0.25·candidate over the largest \|hs − PT2(hs, gov_rpm_filter)\| of the logged ACTIVE flight away from a FALLBACK (critique M15). Evidence: the voltage curve (time at the maximum at 3.6-4.2 V/cell), E and F with the range of the set, the log against the twin. Saturation that the ESC soft start causes is not power (critique C9). |
| gov_gain, gov_p_gain, gov_i_gain, gov_d_gain | GS4 with the margin test GS2 (section 7). Effective gains K·Kp, K·Ki, K·Kd; `gov_gain` changes only when P and I (and D) change by one factor (then `gov_f_gain` keeps the feedforward). A row of `gov_gain`/`gov_p_gain` with a larger K·Kp has the bound of the logged P-term noise at the new gain. The margin evidence of a PID profile with new gains gives the ratio of the recommended gains (worst twin, `S.margin.final`) and of the gains at this time. Without battery current, a larger effective gain is not accepted (the next families use the gains at this time): the rows are checks with opt-in CLI text (critique C13). The values of one accepted (or opt-in) decision are one group (`GS:<family>:<PID profile>`). |
| gov_f_gain, gov_collective_ff_weight, gov_cyclic_ff_weight, gov_yaw_ff_weight, gov_collective_curve | GS3: K·Kf·(w_c·\|coll\|^(curve/10) + w_x·cyc + w_y·\|yaw\|) fit (non-negative, every curve 5-40) to the twin's steady extra throttle (sL(load) − sL(0))/V at the profile headspeed and the median V of the training samples; integer values with `gov_gain` fixed; the spread over the twin set; verified on the training flights (over95 and thrHF + 10 % at most, J not larger). Per PID profile (critique C1). |
| gov_p_limit, gov_i_limit, gov_d_limit, gov_f_limit | GS6: the terms of the selected values on all flights (P and D from a PT2 of the twin headspeed at `gov_rpm_filter`, F from the mixer at `gov_ff_filter`, I from the simulation); a limit reached outside saturation for 0.05 s or more gets a larger value (the largest term ×1.2, the I-limit +5), a check when that is not accepted. |
| gov_rpm_filter, gov_ff_filter, gov_d_filter | GS5: a common grid (×0.5, 0.7, 1.4, 2) on the pooled J. `gov_rpm_filter` never goes up (the twin RPM signal has no vibration), and the rows give the FALLBACK glitch reference of each cutoff (`flight_governor.c:588`). `gov_d_filter` only with a D-gain (else not-applicable); the log cannot show D (the row says so). |
| gov_pwr_filter, gov_use_voltage_comp | GT9 the measured drift. GC8: the loop-gain change and the F mis-scaling over the pack (full and end-of-pack OCV), the predicted drift against the logged drift. With `battery_meter` ≠ ADC: not-applicable (`flight_governor.c:1556`). With ADC: the closed loop with and without for every twin, a change with the acceptance. Source unknown: the main twin and a conditional text, no CLI text. |
| gov_tta_gain, gov_tta_limit, gov_tta_filter | GT11. Not applicable unless the assist is on (`gov_tta_gain`, `gov_tta_limit` > 0); a check with a tail rotor that has no tail motor. |
| gov_bypass_throttle (9 points) | GC7 (check with opt-in CLI text, because the BYPASS switch is the pilot's choice): the steady duty at the headspeed of the PID profile with the most training data and the mid-pack OCV, at 9 collective stick points (mixer collective 1.042 per stick: `gov_data` has no `rcCommand[3]`), the median cyclic and yaw, the range over the twin set. |

The related, non-governor rows are all text only, except the cell-count mapping:

- `battery_meter` (the vcomp explanation);
- `battery_cell_count` (0 = auto, mapped with `health_power.autoCells`);
- `feature GOVERNOR`;
- `freq_input_pull`, `freq_input_edge`, `freq_input_minhz` (the RPM-signal levers for the glitches);
- `blackbox_log_esc` (EscThr/EscPwm measure the ESC soft start);
- `blackbox_log_battery` (current);
- `debug_mode` RPM_SOURCE (raw RPM).

## 6. Native governor in closed loop

1. **WASM bridge** (`firmware/bridge.c`; rebuild with `node tools/autotune/firmware/build.cjs`, wasi-sdk at
   `/private/tmp/wasi-sdk-25.0-arm64-macos`). Add two exports and keep the existing ones unchanged:
   - `rf_gov_step()`:
     - time as `rf_step`;
     - `mixer.input[1..4] = input[15..18]` (recorded roll, pitch, yaw, collective);
     - `mixer.cyclicTotal = sqrtf(roll² + pitch²)`;
     - `fw_governorUpdate()`;
     - the 13 governor outputs at `output[46..58]`.
     - No PID, no mixer update.
   - `rf_gov_profile()`: copy `config[115..135]` into `profile.governor`, then `fw_governorInitProfile(&profile)`. Do
     not reset the governor state. This is the firmware behaviour at a PID profile change (`pid.c:709`).
   - Update `ARTIFACT`, `controller.json` and the regression test of the bridge field order.
2. **`firmware_controller.govCreate({values, gear, cells, voltageSource, pidHz})`** returns:
   - `step({rawMotorRpm, batteryVoltage, throttleCommand, throttleOff, armed, mixer:[r,p,y,c], timeS?, govBypass?, govSuspend?, govFallback?})`
     → `{P,I,D,F,sum,targetHS,requestHS,currentHeadSpeed,state,ttaIncrease,spoolUpRatio,spooledUp,throttle}`;
   - `profile(values)`;
   - `reset()`.
   - Its own `requiredFields` boundary needs the governor fields, `pid_looptime`, the gear ratio, the cell count and the
     voltage meter. PID values are not needed.
3. **Configuration mapping** (`fromHeader` and govCreate):
   - CLI `battery_meter` → `voltage_meter` (NONE 0, ADC 1, ESC 2);
   - `battery_cell_count = 0` → `health_power.autoCells` from the rest voltage;
   - `gov_mode OFF` → 0;
   - an unknown gear ratio → 1:1 with H fed directly. This is equivalent, because the glitch limits scale with the same
     ratio.
4. **Profiles**: at each recorded PID profile change, call `profile(values of that PID profile)`. The values of each PID
   profile come from:
   - the CLI dump;
   - the header (the start profile only);
   - the gov_params recovery.
   A profile with unknown governor values excludes the flight from the closed-loop scores, with the reason.
5. **Kmot** starts at 0 at each flight log, as after power-up (one flight per pack). Say so in the limitations.
6. **Rate**: step the governor at `pidHz`. Hold the logged inputs between frames for the Gaui (logged at 1 kHz, PID
   at 2 kHz).
7. **Parity gate** (`gov_tune.parity`): run the native governor on the **recorded** headspeed (open loop). It must
   reproduce the logged state sequence (≥ 0.995 agreement) and motor[0] (RMS ≤ 2 ‰ in ACTIVE) before any simulation
   result counts. Report the parity for each log, and for each profile segment.

## 7. Autotune: scenarios, search, objective and acceptance (`gov_scenarios.cjs`, `gov_search.cjs`, `gov_tune.autotune`)

### 7.1 One call (`gov_tune.autotune`)

The worker command `governorTune` calls `autotune(runs, { cli, progress(text, fraction), budgetMs, cancelled() })` (tests and the
dev harness can also give `model`, `validation`, `configs` and `recovered`). The steps:

1. `gov_params.recover` and `gov_sim.configOf` (the configuration of each log), and `tune()` without a model (the rule rows);
2. `gov_fit.identify` on the flight runs (synchronous, about 30 s), then `gov_fit.validate` (closed loop with the native governor);
3. `gov_scenarios.evaluate` (section 7.3);
4. `gov_search.search` (sections 7.4-7.7), NOMAD with the rest of the time budget;
5. `tune(runs, { model, search, scenarios })` with the families of both modules, and `gov_scenarios.finish` (the opt-in CLI text).

The result is JSON only (typed arrays become arrays, numbers that are not finite become null; each plot trace has 2000 points or
less): `{ status, reasons, twin: { params, uncertainty (p5, p50, p95, unit, source), validation (no traces), plots, has, Href,
split, physical }, rows, recommendations, limitations, plots, notes, coverage, parameters, profiles, rules, families, measures,
search (summary), scenarios (summary), modelLogs, timing }`. The model uses the flight logs of `modelRunsOf` (section 8.1: the logs with
the battery voltage when some flight logs do not record it); the rule rows use every flight log.

| case | status | rows |
|---|---|---|
| no flight, or a governor mode other than ELECTRIC | `unavailable`, the reason | the rule rows; the model rows not-applicable |
| the identification fails | `unavailable`, `AUTO.failed` and the reasons of gov_fit | the model rows not-applicable with the reason |
| the validation is `rejected` | `rejected`, the reasons of the validation and the voltage reasons of gov_fit (`TEXT.noVoltage`, `mixedV`, `mixedI`) | no scenario, no search; the model rows not-applicable (`gov_search TEXT.rejected`); the current limitation without the set of models |
| `partial` or `validated` | the status and the reasons of the validation | all |
| cancelled (checked between the steps, after a `setTimeout` yield) | `unavailable`, `AUTO.cancelled` | the rule rows |

Time budget (`RUN` in `gov_tune.cjs`, not a rule): about 210 s for the analysis. NOMAD stops after `gov_search RULES.nomad.evaluations`
(24) new points, so the same logs give the same gains on each computer (review 2026-10-15: a time budget gave Gaui PID profile 2 P 56,
60/47 and 59/49 on three runs). The deadline (`o.deadline`, the end of the budget) and 90 s are safety limits only: a stop at a limit
gives the note `gov_search TEXT.nomadTime`, and less than 10 s to the deadline gives no NOMAD (`stages.nomad.skipped`, limitation
`TEXT.nomadNone`: the gains come from the grids only). 30 % of the NOMAD time is for the selection after its evaluations
(`gov_search RULES.nomad.chooseShare`; the 4 best points of each PID profile, `choose`). Tests and the dev harness can give
`scenarios` and `search` (the results of `gov_scenarios.evaluate` and `gov_search.search`) to skip these steps.

Plots (the generic spec of the Governor tab, `{ id, title, kind 'time' | 'xy', x, y, series: [{ name, role, x, y, style }] }`,
one y axis each):

- `twin.plots`: for each test flight the headspeed (log, closed loop, open loop, target), the throttle and the battery voltage; the
  horizon curve (model, hold, recorded target; the x axis is "Time after the start point"); the steady-state map (the curves of
  section 4 and the 1-s points);
- `plots`: `tune-hs`, `tune-u` the closed loop with the values at this time and with the recommended values on the longest test
  flight; `tune-battery`, `tune-battery-droop` the time at the maximum throttle and the droop95 against the battery voltage of
  each PID profile (the power and battery tradeoff); `tune-spool` the overshoot against `gov_spoolup_time` for each case, with
  and without the PID spool-up, and the 2 % limit; `tune-fallback` the RPM error with the largest loss flown with each value set of
  the FALLBACK selection; `tune-margin-<p>` the step response of the margin test with the gains at this time and the recommended
  gains.

Limitations (STE, `AUTO.limits`): no current (the rotor inertia, the tm twins of the set and the gain checks), the tm of the twin set
(tmBand), a set that does not span the p5-p95 of kv, tm or te of gov_fit (Fireball: kv 311.7-336.5 rpm/V from the single flights, the
set 315.2-337.2), the RPM signal of the twin has no vibration, the load law at a headspeed that the flights do not use, the battery
recovery after a load, a flight with the change.

### 7.2 Twin set (the robustness rule)

Both modules use the main twin, up to 6 sets of `model.samples` (the bootstrap and jackknife sets of section 4) at the extremes of
tm, kv, te and the load at the median training load, when the validation check `tmBand` fails the tm-scan winner (Fireball:
tm × 1.4), and, when the logs have no battery current (`model.has.current` false), tm × 0.7 and × 1.4 (`RULES.twins.noCurrent`:
critique C13, the logs do not give the authority without current; the review found that the Gaui gain change without current failed
the margin test on a twin of the with-current set). The samples share one ESC soft start: for the spool-up and the BAILOUT, two more
twins scale `ass`, `as1` and `asr` by the p5 and p95 of the single-start fits of `ass`. The selection uses the training flights
(`model.split`) and the main twin only. A change is a recommendation only if its constraints hold for every twin of the set and, **for
every twin**, its effect on the test flights passes the paired bootstrap (the same 10-s ACTIVE blocks, or the same events, for the
value at this time and the candidate). The interval of an effect is the range of the mean ± 2 SE over the set. The set spans the
bootstrap samples, not the single-flight spread of gov_fit: when a p5-p95 of kv, tm or te is outside it, a limitation says so.

### 7.3 Scenarios (`gov_scenarios.cjs`, GC1-GC9)

- **R**: as recorded (FALLBACK forced at the logged entries). The log and the twin with the same definitions (`stats`: ACTIVE flight,
  no rescue; a period at the maximum that starts in SPOOLUP, RECOVERY or BAILOUT, or under half of the request, is ESC acceleration).
- **E, A, F**: the OCV at the lowest end-of-flight rest voltage of the training flights (E: the selection and the model numbers; else
  3.70 V/cell), of all flights (A: the effect on the test flights, when it is lower than E; a test flight does not select a value),
  and at 4.20 V/cell (F), less vp, constant for the whole flight (kappa 0): each point of the voltage curve is the flights flown at
  one battery voltage. Also 3.6, 3.8 and 4.0 V/cell for the curve (main twin). Fireball: E 22.47 V (log 5), A 22.26 V (log 15).
- **G**: RPM errors (section 5, the FALLBACK row).
- **S**: the spool-up from a stopped motor of a synthetic run (the stick, the ground load, the rest voltage, 250 Hz frames, the
  governor at the PID rate).
- the maximum throttle test, the tracking slope, the BYPASS curve, voltage compensation and the BAILOUT from a slow rotor (section 5).
- **Acceptance (GC1)**: for each twin, the paired bootstrap (1000 resamples, seeded) of the effect of each unit (a 10-s ACTIVE block,
  an RPM error, or a test spool-up: one unit for each spool-up, not for each voltage) must give a mean of more than 2 SE with 3 units
  or more (a bootstrap of 2 units has 3 different means only); all twins must pass. The interval of an effect is the range of
  mean ± 2 SE over the set.

### 7.4 Metrics, objective and constraints (`gov_search.cjs`)

- **Metrics** for each PID profile, in 10-s blocks of logged ACTIVE samples (the same blocks for each candidate: paired), from the
  samples in which the simulation is in ACTIVE: e_rms; droop95 and over95 (the mean of the worst 5 % 1-s windows); thrHF (RMS of
  u above 5 Hz, zero-phase); satShare (u ≥ max − 0.005); iLimitOutsideSat.
- **Objective (GS1)**: J = (e_rms + 0.5·droop95 + 0.5·over95 + 0.25·thrHF) with each term divided by its value at this time (a
  floor of 0.05 % for each), divided by 2.25: J = 1 at the values at this time.
- **Constraints**: the margin test M (7.6); satShare ≤ baseline + 0.2 %; iLimitOutsideSat ≤ baseline + 0.05 %; at the end-of-pack OCV
  (scenario E, main twin; the OCV of the training flights for the selection, of all flights for the acceptance) satShare ≤ baseline
  × 1.1 + 0.2 %. This last constraint stops a gain that increases the time at the maximum throttle late in the pack.
- The logged P-term above 5 Hz of each PID profile (`S.pNoise`) is the bound of the RPM noise at a larger K·Kp: a gain row gives
  the bound at the new value (the twin has no RPM noise).

### 7.5 Search, for each PID profile, in the doc order (selection on the training flights, main twin)

1. F design (GS3, section 5), verified on the training flights;
2. I grid ×{0.5, 0.7, 1.4, 2};
3. P grid;
4. D grid {0, current, +};
5. P, I and D together (×0.7 … ×0.12) for a PID profile whose values do not pass M;
6. the rpm and ff filters (global, a common grid, the pooled J), the d filter with a D-gain only;
7. NOMAD (`filter_optimizer.minimize`, P and I of each PID profile, ×0.5-2, integers) inside its budget. The library calls the
   evaluation synchronously and a simulation is async: each new point stops the library, and it runs again from its cache (the same
   point sequence);
8. the limits (GS6).

One closed-loop simulation of a candidate evaluates all PID profiles; each PID profile takes its value from its own J. A candidate
must improve J by 1 % (`minGain`) on the training flights, pass the constraints and pass M on every twin.

### 7.6 Margin test M (GS2)

A hover window of each PID profile (logged ACTIVE, the collective SD ≤ 0.15, the throttle under 90 %; a training flight first, else
a test flight: it gives only an operating point), the flight from its arm to the window, the mixer held at the window means for
2 s, then a collective step (+0.2, else +0.1 when the twin has no 10 % reserve) for 2 s. The step response is the error with the
step less the error of the same run without it. With P, I and D ×2 (6 dB) and no F-term:

- each error peak must be less than 0.5 × the peak before it (peaks of alternate signs from the first peak of the expected sign);
- an oscillation on the slow I-term recovery does not cross 0: the swings between successive extrema (each confirmed by a reversal of
  0.05 % or more) give the ratio for each half cycle, the square root of the ratio of swings one cycle apart (with two swings only,
  their ratio), and it must also be less than 0.5. Without this second rule a ringing response on the recovery passed (the first
  Gaui run: `gov_gain` 40 → 80 and P 81 / I 39 rang with a half-cycle ratio of 0.5-0.75 at the doubled gains);
- M must pass for every twin of the set (a change of the gains); a change of another family must not increase a ratio that does
  not pass by more than 5 %.
- The evidence of a PID profile with new gains gives the largest ratio of the recommended gains (the worst twin) and, as a second
  row, that of the gains at this time.

### 7.7 Acceptance (GS7)

Each family in the doc order (precomp, gains, filters, limits), on the values accepted before it: on the test flights, **for each twin
of the set**, the paired block bootstrap (1000 resamples, the same blocks) of the J change must give an improvement of more than 2 SE
and 1 % or more, with 5 blocks or more (the same rule as GC1; the first review accepted on the main twin only, and the Fireball
`gov_ff_filter` 5 → 10 passed although 5 of the 8 twins, tm × 1.4 among them, did not); with each twin the satShare and
iLimitOutsideSat constraints and M; and the end-of-pack satShare constraint on all flights. The evidence gives the J change of the
twin with the smallest decrease and the range imp ± 2 SE over the set. A change that makes M satisfactory without a J improvement is a
check row with those values (SPEC: no recommendation without the improvement). Without battery current, a decision that increases an
effective gain is not accepted (`optIn`: a check with opt-in CLI text). Else the row status is `keep`, with the predicted effect, its
interval, and the reason. The grid evidence gives the J change of each grid value against the values of its stage (the value at this
time of the name is the reference, not an evidence row).

### 7.8 CLI and advice.cjs

- `profile N-1` then `set name = value` for profile rows; `set` for global rows. Values are integers in the schema range; the ON/OFF
  flags write `ON`/`OFF`; `gov_bypass_throttle` the 9 values. `validationOf` (GT20) refuses a throttle value that the firmware
  changes.
- advice.cjs has every governor name in `PARAMS` with its scope and header index, the ranges in `RANGE`, `cliValueOk` for the
  flags and the bypass list, and `govLinks` (the dependent limits of the throttle values over the selected changes).
- A group (`group`, `groupSize`: `GC3:spoolup`, `GC5:fallback:<PID profile>`, `GS:<family>:<PID profile>`) goes into the CLI file as one:
  `advice.exportScript` refuses a part of a group, and the export panel selects all of it (`canPick`, `membersOf`).
- `fromSets` has the known values of the `govLinks` rules (section 5): the Fireball CLI file no longer says that `gov_mode` is
  unknown.
- `analysis/governor-twin/tune.cjs` passes each recommendation with CLI text (with the other changes of its group), and all changes
  together, through `advice.exportScript`: every CLI line must be in the file, with no "Not in the file" refusal, and no value that a
  row shows as known may be "unknown" in the file (`exportCheck` in `tune.json`).

### 7.9 Results on the dev data (2026-10-15, after the second review)

`node analysis/governor-twin/tune.cjs <craft> [--cli <dump>] [--no-current]` (the flight logs only, as the worker; 0-based test logs
Fireball 11, 15 and Gaui 40, 45, 48), `out/<craft>/tune.json`, `tune.md` (every row) and the figures of `plot_tune.py`
(`tune_<plot id>.png`). Every change and opt-in check passes `advice.exportScript` with the other changes of its group, all changes
together pass, and no value that a row shows as known is "unknown" in the CLI file (`exportCheck`).

| | Fireball, CLI dump | Fireball, log only | Gaui | Gaui without current |
|---|---|---|---|---|
| status | partial (tmBand) | partial | validated | validated |
| time: total (identify / validate / scenarios / search, NOMAD budget) | 201 s (27 / 3 / 82 / 81, 32.6 s) | 202 s (27 / 3 / 83 / 81, 32.2 s) | 195 s (35 / 4 / 54 / 94, 25.5 s) | 188 s (28 / 4 / 58 / 91, 22.3 s) |
| twin set | 9 (6 samples, tm × 1.4 of the scan, tm × 0.7 without current) | 9 | 6 | 7 (tm × 0.7 and × 1.4) |
| rows (change / check / keep / not-recorded / not-applicable) | 135 (4 / 28 / 82 / 4 / 17) | 135 (4 / 30 / 85 / 11 / 5) | 132 (9 / 11 / 96 / 10 / 6) | 132 (5 / 14 / 96 / 11 / 6) |
| changes with CLI text (+ opt-in checks) | 4 (+8) | 3 (+3) | 7 (+2) | 5 (+4) |

**Fireball** (the research: power limit late in the pack, ESC soft start, glitches at 100 % throttle, ESC voltage source). E is 22.47 V
(training log 5), A 22.26 V (test log 15):

- `gov_headspeed` PID profile 2, 4500 → 4050 rpm (opt-in check since 2026-10-15; earlier a change): at E the q95 throttle is 95.5 % (set 95.5-95.8 %), a reserve of 4.5 %; the
  logs have 16.5 s at the maximum in ACTIVE flight; with the reserve and the same thrust (pivot 0) the largest headspeed is 3730-3850
  rpm (a step of 10 %); the FALLBACK limit at 4050 rpm is 1013 rpm against a largest signal difference of 861 rpm; on the test flights
  at A, 33.6 points less time above 85 % throttle (27.8 to 41.4 over the set, 35 blocks).
- `gov_headspeed` PID profile 3, 5000 → 4510 rpm (opt-in check since 2026-10-15; earlier a change): q95 104.7 % (a reserve of −4.7 %), 2.8 s at the maximum in the logs; the
  10 % step is 4500 rpm, the headspeed of PID profile 2, so the next step up; effect 55.6 points (43.8 to 64.0, 15 blocks).
- `gov_fallback_drop` 10 → 5 in PID profiles 2 and 3 (changes) and in PID profile 1 (an opt-in check: its test flights have 1 error, 2
  errors in all), `gov_use_fallback_precomp` stays OFF, `gov_recovery_time` stays 20. The test errors of each PID profile: PID profile 2
  0.68 % s (0.44 to 0.96, 24 errors), PID profile 3 0.91 % s (0.44 to 1.90, 5 errors). The
  precomp ON fails the cue rule at drops 5, 10 and 15 (the smallest decrease at an error at the maximum throttle is 0, 0 and 3.9 %);
  ON with 20 keeps the cue but loses more (8.0 against 7.7 % s on the training errors). `gov_recovery_time` 10 has a smaller loss but
  fails its cases: +3.2 % points of overshoot in the BAILOUT from a turning rotor, +0.81 s at the maximum throttle in the BAILOUT from
  a slow rotor. 63 errors: the loss 8.6 → 7.9 % s, the lowest headspeed 88.6 → 90.1 % of the request; at the 28 errors at the maximum
  throttle the smallest throttle decrease is 17.2 → 12.6 %; test effect 0.71 % s (0.48 to 1.05, 30 errors, every twin passes). The
  first review recommended precomp ON, drop 5 and recovery 10, which removed the throttle decrease at 5 of 29 errors at the maximum
  throttle (the logged FALLBACK of log 14 at 192.7 s among them).
- `gov_spoolup_time` 80 → 100 with `gov_use_pid_spoolup` ON in PID profiles 1-3: a check with opt-in CLI text, one group of 4. The
  twin overshoot at 80 is 12.6 % (set 3.1-14.5 %), the logs 13.0 %; without the PID spool-up the smallest value is 150. The test
  flights have 1 ground spool-up (log 11 at 11.7 s; log 15 is excluded, C6): 12.7 → 0.18 % at its rest voltage 25.24 V, 12.7 → 0.18 %
  at F, 10.2 → 0.12 % at A. One unit is less than the 3 of GC1 (the first review counted the three voltages as three units).
- `gov_ff_filter` 5 → 10: keep. Main twin J −1.05 % (SE 0.40, 56 blocks), but 5 of the 9 twins do not pass (tm × 1.4: −0.21 %, SE
  0.35); the set gives −2.9 to +0.5 %.
- Opt-in checks: `gov_max_throttle` 98 on PID profiles 2 and 3; the BYPASS curve 184,165,155,152,153,161,178,200,200 (4500 rpm,
  23.8 V). Checks: `gov_headspeed` PID profile 1 (a reserve of 12.7 % with the 7.3 points that the log has over the twin, 0.01 s at the
  maximum); `gov_tracking_time` (91 is necessary; no effect on the test flights); `gov_max_throttle` PID profile 1 (1 period at the
  maximum, 3.99 s, the BAILOUT of log 10); the BAILOUT of log 10.
- Kept: the gains (margin ratio 0 for every twin; PID profile 3 I 84 J +3.0 %), the feedforward of PID profile 2 (more time at the
  maximum at the end of the pack: 15.0 against 11.2 %).
- Voltage compensation: ESC source, not-applicable.
- Log only (no dump): the same headspeeds and effects. `gov_fallback_drop` has CLI text only in PID profile 2 (the log does not show
  it in PID profiles 1 and 3, and their texts say that the model uses 10, the default value of the firmware). `gov_use_pid_spoolup`
  of PID profile 3 is unknown, so the spool-up check is 150 without the PID
  spool-up (12.7 → 1.3 % on the test spool-up, opt-in). The BYPASS curve has no opt-in text.
- Every scenario and search row has the flag of the second arm in log 12; the spool-up rows also the unlogged changes of
  `gov_startup_time`, `gov_spoolup_time` and `gov_spooldown_time` (log 6), with the values and the source.

**Gaui** (the research: no power limit, no FALLBACK, a spool-up overshoot under 2 %, yaw weights changed between logs):

- PID profile 1 feedforward (one group of 4): `gov_collective_ff_weight` 50 → 195, `gov_cyclic_ff_weight` 10 → 27,
  `gov_yaw_ff_weight` 80 → 57, `gov_collective_curve` 20 → 21: J −15.8 % (SE 2.7, 30 blocks), the set −23.2 to −6.5 % (worst twin
  −13.3 %). The rows have the flag of the unlogged changes of `gov_yaw_ff_weight` of PID profile 1 (10 in log 39 to 80 in logs 48-50).
- PID profile 2 `gov_p_gain` 40 → 60 with `gov_i_gain` 50 → 47 (one group, NOMAD with 25.5 s and 17 evaluations): J −11.6 % (SE 0.60,
  17 blocks), the set −13.6 to −9.4 %; margin ratio 0.42 with the new gains (worst twin sample 9). The first run of this section gave
  P 40 → 56 only (J −10.2 %, SE 0.43) with a NOMAD time of 43 s: the gains depend on the NOMAD time (section 7.10).
- PID profile 3 P 56, I 25: J −10.7 % (SE 2.1), no CLI text (the log shows only the products K·Kp and K·Ki of PID profile 3).
- `gov_ff_filter` 5 → 10 Hz: J −5.4 % (SE 0.84, 59 blocks), the set −8.0 to −2.5 %, every twin passes.
- `gov_headspeed` PID profiles 2 and 3: checks with opt-in text, 2290 rpm (the reserve rule gives 2300, the headspeed of PID profile
  1) and 2530 rpm (pivot 0; 2540 before). At 22.46 V the reserve is 8.4 % and 11.7 %, but the logs have 0 s at the maximum throttle.
- Spool-up, FALLBACK, tracking and the maximum throttle: keep. `gov_use_pid_spoolup` is unknown in the log ("The log does not record
  this value"). Voltage source unknown: conditional text, no CLI text.
- Without current: the feedforward of PID profile 1 is the same within the set (182 / 30 / 55 / curve 17, J −15.5 %); the larger
  gains are opt-in checks now: PID profile 1 P 40 → 56 and I 50 → 100 (one group; J −16.9 %, SE 2.9, the set −23.5 to −8.9 %, margin
  0.39), PID profile 2 I 50 → 70 (J −3.6 %, SE 1.3). The review found that PID profile 1 P 56 / I 100 gives a margin ratio of 0.57 on
  a twin of the with-current set (sample 9, tm 0.164): the robustness rule of one structure does not cover the other. The PID profile 2
  headspeed is a check without opt-in (the twin s18 gives 4.4 points with 2 SE of 4.5).

### 7.10 Limits and open issues

- **RPM noise.** The twin RPM signal has no vibration. A larger P-gain or ff/rpm cutoff looks better in the model than in flight;
  the gain rows give the bound of the logged P-term noise, and `gov_rpm_filter` never goes up. A noise input of the twin (the logged
  headspeed less its smooth part) needs a `gov_sim` scenario input (not in this round).
- **The gains depend on the authority.** Without current a larger gain is an opt-in check, and the set has tm × 0.7 and × 1.4, but the
  Gaui gain results still differ with and without current (7.9). A flight with the new gains is the test.
- **Families are accepted one at a time.** The scenario changes (headspeed, spool-up, FALLBACK) and the search changes are each
  tested with the other values at this time; their combination is not simulated. Inside a family, the values of one acceptance are one
  group. A lower headspeed also moves the FALLBACK limit, which the headspeed rule checks against the logged signal.
- **The twin set** comes from the bootstrap samples: it does not reach the single-flight p5 of kv on the Fireball (311.7 against
  315.2 rpm/V; a limitation says so). A twin at the p5 with the other parameters of the main twin does not agree with the flights.
- **The headspeed rule extrapolates** the load law (exponent pc 2.1-2.2) to a headspeed and a collective that the flights do not use:
  10 % or less in one change, then fly and analyse again. Without saturation in the logs it is a check (opt-in CLI text).
- **FALLBACK selection** is the precomp and drop grid, then the recovery time (8 runs on the Fireball). The cue rule uses the errors at
  which the values at this time give 5 % or more; an error with less (a negative P-term before it) has no constraint.
- **Spool-up**: the Fireball test flights have one ground spool-up, so the change is an opt-in check. A new log with more spool-ups
  can make it a change.
- **Tracking** is conservative (the steady acceleration at the median load): a check only, unless the test flights show an effect.
- **BYPASS curve**: the mixer collective per collective stick is the median ratio of `mixer[3]` to `rcCommand[3]` in the logs (|stick| ≥ 0.2;
  1.042 on both dev crafts). Without `rcCommand[3]` the curve uses `RULES.scnBypass.mixerPerStick` (1.042) and says so.
- **Kmot** starts at 0 in each log (section 6); the PID spool-up target slope after a re-arm in the same power cycle is max(Hf, Kmot).
- **Time.** Identification is synchronous (about 30 s): the worker cannot see a cancel in that time. The Fireball scenarios take
  82-90 s (the FALLBACK grid and the BAILOUT cases: 34 s). NOMAD has a fixed number of evaluations (section 7.1), so the total time
  depends on the computer, but the result does not.
- **App** (corrected 2026-10-15, section 8.2): each opt-in check of the Governor tab gives its own cause; the BYPASS note is for the
  BYPASS curve only.
- **STE** (corrected 2026-10-15): `test/ste_text.test.cjs` passes, also on the `governorTuned` results of the real dumps (section 8.5).
- **NOMAD has a fixed number of evaluations** (corrected 2026-10-15). Before, the gains depended on the time that NOMAD had (Gaui,
  section 8.4: P 40 → 56, 60/47 and 59/49 on three runs, all accepted). The CLI file of a change from the toolkit writes "R2", not "R²" (`advice.clean` keeps ASCII and ±×°µ only).

## 8. App integration

### 8.1 Worker command `governorTune` (`js/tuning_worker.js`)

`{ cmd: 'governorTune', id, bytes, fileName, options: { cliText, cliName, flightRpm, logs, flights, budgetMs, blockedBy } }` →
`{ id, type: 'governorTuned', result }`. DEVELOPMENT.md section 13 ("The governor model and the governor autotune") has the steps. In short:

- It decodes each selected log whole with `gov_data.EXTRA`, the columns of `health_phase.cjs` and `govRequest`, classifies it
  (`health_phase.cjs`: a bench run is left out, with one note that gives their count: "The governor autotune does not use bench runs
  (36 logs)."), and makes one run for each segment of each flight log (`gov_data.fromSegment`, all phases, the DISARM events of the
  part, the adjustment events of the log, the PID profile at the start of the log from `armingFinal`).
- `gov_tune.autotune(runs, { cli, progress, budgetMs, cancelled })` makes the result. **The runs of the model** (`gov_tune.modelRunsOf`):
  when some flight logs record the battery voltage and others do not, the model uses only the logs with the voltage if they are
  `RUN.minVoltageLogs` (2) or more, and a limitation names the others ("Logs 24, 25, 26 and 33 do not record the battery voltage. Thus,
  the governor model does not use these logs. The rules use all flight logs."). Else `gov_fit` leaves out the voltage of every log
  (`TEXT.mixedV`), and without the voltage the model is `rejected` (section 4). The rule rows use every flight log. `modelLogs` in the
  result: the flight logs of the model. The note on a log without the battery voltage follows it: a log of the model gets `gov_data
  TEXT.noVbat` ("… the governor model uses a constant voltage …"), a flight log that the model leaves out `TEXT.noVbatLeft` ("… Thus,
  the governor model does not use the log …"), both with the settings that record the voltage.
- The stale of each row and recommendation (`govStale`): the parts of the log (`paramEpochs`) in the time of the result, in the stretches
  of its PID profile; a result of the model reads every governor value over the logs of the model (`modelLogs`). **The source of a
  switched PID profile** (a part that flies PID profile p in a log that does not start with it): `governorTune` has no configurations of
  `datasets.cjs`, so `govSources` gives the source from the value sources of the rows (`row.current.from`) of p: for a rule row its own
  value, for a result of the model all the values of p. 'cli' (also a value of the log that the CLI dump gives the same) → "the values
  of the CLI dump"; 'header' → "the values of the log header of log N" (the last log before this one that starts with p, else the
  first); 'log' → "the values that it calculated from the flights"; more than one → all of them, and "Some values of PID profile p are
  unknown." when a row of p has no value (review 2026-10-15: before, every such flag said "The values of PID profile p are unknown"
  while the result named its source). The flags of `gov_tune.cjs` join it (`govJoin`): for a name and PID profile with a summary flag
  (`logs: []`, from `staleOf` and `simStale`) the summary only (each flag of one log has the PID profile of its summary; one with no
  PID profile matches the summary of its name), and each part is a paragraph (a line break between them: STE Rule 6.6). The dialog shows
  each paragraph, the CLI file a comment line for each sentence.
- The flags of `gov_tune.cjs` (review 2026-10-15): a row of the model (method `model` or `simulation`) reads the values of the logs of
  the model only (`modelStale`: `staleOf` on the flags and the logs of `modelLogs`); a name with one value in these logs and no in-flight
  adjustment has no flag ("changes between logs" needs two values); `mergeStale` leaves out of the rule flag a name and PID profile that
  the simulation flag has (one text for each value). A summary of a product of gains names its CLI names ("The value of "gov_gain"
  multiplied by "gov_f_gain" and "gov_yaw_ff_weight" (PID profile 1) …").
- The result is JSON (typed arrays to arrays, numbers that are not finite to null), 2.0-2.5 MB on the real dumps (section 8.4), with
  `fileName`, `logs`, `benchRuns`, `skipped`, `flightRpm`, `cliName`, `selection`, `blockedBy`, `notes`, `modelLogs` and `timing`.

### 8.2 The "Governor model" panel (`js/tuning_dialog.js` `govModelHtml`, `css/tuning_dialog.css`)

- The Governor tab has three parts (user, 2026-10-17; `govPartHtml`, DEVELOPMENT.md section 13): 1 the problems in the logs (the
  recorded problems, the recommendations of the rule and data rows, `govSource`, the logs that the analysis does not use, the recorded
  response), 2 the model checks, 3 the changes of the model with the model tests and all rows. Each part says what it uses.
- The start button, the progress and Cancel (the bar of the tab heading); the status (`GM_STATUS`) with the table of the validation checks
  and the reasons that the table does not give, the model limits, and the notes of the worker and the toolkit ("Analysis information").
- The plots (`govPlotSpec`, the generic spec of section 7.1, drawn by `TuningPlot`): in part 2 the test flights of the model (one flight
  at a time, with its closed-loop errors), the horizon curve and the steady-state map; in part 3 the plots of the autotune in the groups
  of `GM_TESTS` (headspeed reserve, spool-up, RPM signal errors, gains), each with the parameters it tests and what to look for. **Time base**: x of a time plot is in frame seconds from the log start, `fromS + time`
  of the run, the clock of the log viewer: a click calls `env.seekFrame(log, x)`, which seeks to `log.getMinTime() + x` s (as each
  evidence time). `gov_fit.plotData` (the plot time and `stateBands`), `gov_fit.events` (`t`), `gov_search` (the margin window, its
  step response, the FALLBACK reference of `gov_rpm_filter`, the plot of the closed loop) and `gov_scenarios` (the FALLBACK plot, the
  spool-up evidence of the test flights) give frame seconds (before 2026-10-15 some gave seconds from the start of the part: wrong for
  a part after a logging pause). The real-dump test compares the plotted headspeed with the logged headspeed at the same frame seconds
  (median difference 0.000 %; 5 s later 0.4-1.7 %).
- **Governor states**: the plots of each test flight have the logged states SPOOLUP, RECOVERY, HOLD, FALLBACK, AUTOROTATION, BAILOUT
  and IDLE as bands (`gov_fit.RULES.bandStates`, 400 or less, from the first frame of the state to the first frame of the next state),
  in the colors of the recorded governor plots (`STATE_BAND`), with a label when the band is 3 % or more of the axis. The note of the
  plot says what the bands are.
- The parameter table: every row of section 5 in its family, with the value at this time and its source, the result, the recommended
  value, the evidence (with a link to its time) and the rule.
- The recommendations: the changes with CLI text are selected first; checks are not. **Opt-in checks** (`rec.optIn`) can be selected,
  and each gives its own cause (`govOptInHtml`): the BYPASS curve "If you use the governor condition BYPASS, select this change."; the
  others the sentence of the toolkit that says why the app does not select it, with its condition ("In the logs, the throttle is at its
  maximum for 0 s in ACTIVE flight of this PID profile. Thus, this is a check and not a change."), from the text and the caveats of the
  recommendation, else of the other changes of its group (the spool-up time: the rows of `gov_use_pid_spoolup`), else a text for its
  parameter (`GM_OPT_IN`: the maximum throttle is a test flight, the headspeed, the spool-up, the gains without current).
- The CLI file: `advice.exportScript` of the selected changes (`profile N-1` sections, then the global `set` lines, then `save`; a group
  is all or none; the stale as a comment line before the commands of a change).

### 8.3 Notes and texts

- The reasons of a run (`gov_data.TEXT`) are also notes of the worker. Notes give information only (STE Rule 5.5), so the texts say
  which setting records the value ("The log records the voltage only with a voltage source ("battery_meter") and with
  "blackbox_log_battery" ON.") and are not instructions. The texts of `skipped` and the reasons of an unavailable result can be
  instructions (`GOV_TEXT.noFields`).
- The evidence of a product of gains has the logs in a sentence of its own ("The value is from logs ...": 14 logs in one sentence
  gave more than 25 words).

### 8.4 End-to-end results on the real dumps (2026-10-15)

The worker (`test/tuning_worker.test.cjs`, the vm realm of the worker with the real toolkit, `AUTOTUNE_GOV_LOG`), on this machine, one
run at a time, with the code after the review of 2026-10-15 (the per-PID-profile FALLBACK acceptance, the NOMAD deadline, the flags and
their sources; `test/fixtures/governor_tuned_fireball.json.gz` is the Fireball result of this run). Dumps (read-only): Fireball
`RTFL_BLACKBOX_LOG_SAB_Fireball_20261005_204823.BBL` with or without `RTFL_cli_SAB_Fireball_20261013_184504.txt`; Gaui X4 II
`RTFL_BLACKBOX_LOG_20261004_233406.BBL` (flight rpm 2000) and the older `RTFL_BLACKBOX_LOG_20261004_113720.BBL` (Vbat logged as 0).

| | Fireball, CLI dump | Fireball, log only | Gaui 23:34 | Gaui 11:37 (no voltage) |
|---|---|---|---|---|
| flight logs (0-based) / bench runs | 5, 10, 11, 13, 14, 15 / 8 | the same | 23, 24, 25, 32, 38-41, 43, 45-49 / 36 | 49, 50, 51, 58 / 55 |
| logs of the model (`modelLogs`), test logs | all 6; 11, 15 | the same | 38-49 (10; 23, 24, 25, 32 have no Vbat); 40, 45, 48 | all 4; 51 |
| status | partial (tmBand 0.93) | partial | validated | rejected: open-loop HS median 2.30 % (limit 1.5 %), no closed loop (`gov_mode` unknown without Vbat, Ibat or a dump), and `gov_fit TEXT.noVoltage` |
| time: decode / model / total | 15 / 203 / 220 s | 15 / 203 / 220 s | 12 / 197 / 211 s | 20 / 12 / 34 s |
| NOMAD (budget, evaluations) | 26.6 s, 26 | 26.9 s, 26 | 18.2 s, 12 | none (rejected) |
| rows (change / check / keep / not-recorded / not-applicable) | 135 (4 / 28 / 82 / 4 / 17) | 135 (4 / 30 / 85 / 11 / 5) | 134 (9 / 13 / 96 / 10 / 6) | 127 (0 / 5 / 39 / 15 / 68) |
| changes with CLI text (+ opt-in checks) | 4 (+8) | 3 (+3) | 7 (+2) | 0 |
| result (JSON) | 2.06 MB | 2.07 MB | 2.42 MB | 0.45 MB |
| default CLI file | 139 lines | 105 lines | 282 lines (569 before the flag fixes) | no change |

Changes (from → to):

- **Fireball, CLI dump**: `gov_headspeed` PID profile 2 4500 → 4050 and PID profile 3 5000 → 4510 (each with the measured time at the
  maximum throttle, 16.45 s and 2.75 s against the rule of 0.25 s, and the 5 longest periods of check GT7 as evidence with their log and
  time); `gov_fallback_drop` 10 → 5 in PID profiles 2 and 3 (the test errors of each PID profile: 0.68 % s, 0.44 to 0.96, 24 errors; and
  0.91 % s, 0.44 to 1.90, 5 errors). Opt-in: `gov_fallback_drop` 10 → 5 in PID profile 1 (1 test error, 2 errors in all: "The test
  flights have only 1 RPM signal error in PID profile 1, and the minimum is 3."); `gov_spoolup_time` 80 → 100 with `gov_use_pid_spoolup`
  OFF → ON in PID profiles 1-3 (one group); `gov_max_throttle` 100 → 98 in PID profiles 2 and 3; the BYPASS curve 0,…,0 →
  184,165,155,152,153,161,178,200,200. NOMAD changes PID profile 3 in the search, and the acceptance does not keep it. The CLI file of
  the default picks: `profile 1` / `set gov_headspeed = 4050` / `set gov_fallback_drop = 5`, `profile 2` / `set gov_headspeed = 4510` /
  `set gov_fallback_drop = 5`, `save`, no refusal. Each flag of a part that flies another PID profile than at the start of its log says
  "For PID profile N, the app uses the values of the CLI dump." (before: "The values of PID profile N are unknown.", 73 times).
- **Fireball, log only**: the two headspeeds, `gov_fallback_drop` 10 → 5 in PID profile 2. PID profile 3 is a change with no CLI text
  (its value at this time is unknown; the text says "The log does not record "gov_fallback_drop". The model uses 10, the default value of
  the firmware."). Opt-in: `gov_spoolup_time` 80 → 150 (without the PID spool-up), `gov_max_throttle` 100 → 98 in PID profiles 2 and 3.
- **Gaui 23:34**: the feedforward of PID profile 1 `gov_collective_ff_weight` 50 → 195, `gov_cyclic_ff_weight` 10 → 27,
  `gov_yaw_ff_weight` 80 → 57, `gov_collective_curve` 20 → 21 (one group), `gov_ff_filter` 5 → 10, and PID profile 2 `gov_p_gain`
  40 → 59 with `gov_i_gain` 50 → 49 (one group, J −11.5 %, SE 0.5 %, the set −13.2 to −9.4 %). Opt-in: `gov_headspeed` PID profile 2
  2500 → 2290 and PID profile 3 2700 → 2530. Earlier runs gave P 40 → 60 with I 50 → 47 (NOMAD 28 s) and the dev result P 40 → 56
  only: the gains depend on the NOMAD time (section 7.10). The note of the 4 logs without Vbat says that the model does not use them
  (`TEXT.noVbatLeft`), as the limitation.
- **Gaui 11:37**: no change. The reasons give the cause of the larger errors (`gov_fit TEXT.noVoltage`), the current limitation has no
  set of models, and the `gov_mode` row says that the governor model does not calculate the closed loop (the analysis uses ELECTRIC only
  with the battery current or more than 9 V). The checks are the rule rows (the governor mode unknown, the changes of
  `gov_startup_time`, `gov_spoolup_time` and of `gov_collective_ff_weight` of PID profile 2 between logs, the tail torque assist), and two
  rows say how to record the voltage (`battery_meter`, `blackbox_log_battery`).

Differences from the dev results (section 7.9), and why:

- **More flight logs.** The worker uses every flight log of the file (`health_phase.cjs`); the dev data of the Gaui have logs 38-49 only.
  The dump of 23:34 also has the flight logs 23, 24, 25 and 32 (0-based), which do not record `Vbat`. Before `modelRunsOf`, these logs
  removed the voltage from the whole model: `rejected` (open-loop HS median 2.76 %, clSkill 1.21, clBand 0.95, closed-loop u RMS 0.040;
  test logs 25, 39, 43, 47). Now the model uses the 10 logs with the voltage: the identification and the validation are the same as the
  dev result (the same checks to 4 digits), and the rule rows use all 14 logs (134 rows against 132: the epochs of the 4 other logs).
- **The NOMAD time.** NOMAD now gets the time to the deadline less 1.3 × the search before it (section 7.1): the Fireball gets 27 s
  (none before), the Gaui 18 s (30 s before). The Gaui gains of PID profile 2 change with the NOMAD time (59/49 here, 60/47 and 56/50
  before); each passes the acceptance (section 7.7).
- **FALLBACK of each PID profile.** The change of PID profile 1 of the Fireball is now an opt-in check (one test error).

### 8.5 Tests

- `test/gov_*.test.cjs`: the toolkit (section 4 for the fit; `gov_fit` two-part test for the frame seconds and the state bands;
  `gov_tune` `modelRunsOf`, `twinPlots`, `simStale` summaries with the PID profile on each flag and no flag for one value, `mergeStale`,
  the flags of a row of the model over `modelLogs`, the seconds of the other outputs at their limits; `gov_scenarios` the FALLBACK
  acceptance of each PID profile and the assumed values, a rejected model without the voltage and the `gov_mode` row without a closed
  loop).
- `test/tuning_worker.test.cjs`: the command with a stand-in `gov_tune.cjs` (runs, protocol, progress, cancel, unavailable, stale and
  `govJoin` with the summaries of each PID profile, the source of a switched PID profile from the rows: the log header of another log,
  the CLI dump, the analysis and "Some values … are unknown", gates), the real `autotune` on the simulated file with a budget of 3 s (smoke), and with `AUTOTUNE_GOV_LOG` the real dump
  (`AUTOTUNE_GOV_CLI`, `AUTOTUNE_GOV_RPM`, `AUTOTUNE_GOV_OUT` the result, `AUTOTUNE_GOV_FIXTURE` the fixture of the dialog test): the
  status and its reasons, a row for each of the 42 names, the `profile N-1` line first in each profile change, JSON of 8 MB or less,
  each time plot with a log of the result, and the frame clock of the headspeed plots against the log.
- `test/tuning_dialog.test.cjs`: the panel with synthetic results (start, progress, plots, groups, export, gates, cancel, errors, the cause
  of each opt-in check, the band colors, the stale paragraphs), and the real Fireball result of `test/fixtures/governor_tuned_fireball.json.gz`
  (each plot series thinned to 200 points): the panel, every plot through the real `TuningPlot` (no coordinate that is not finite), the
  cause of each opt-in check, and the CLI file of the default picks (each `set` line in the section of its PID profile, no refusal, no
  known value called unknown).
- `test/ste_text.test.cjs`: the sentences of every `tools/autotune/gov_*.cjs`; with `AUTOTUNE_GOV_LOG` (or `AUTOTUNE_REAL_LOG`) also the
  texts of the `governorTuned` result of the worker test.

## 9. Dev harness

Use `analysis/governor-twin/` (new):

- `dev.cjs <craft>`: fit and validate on `analysis/governor-20261014/data/<craft>` and write `out/<craft>/result.json`.
- `tune.cjs <craft> [--cli <dump>] [--no-current]`: `gov_tune.autotune` on the dev data, `out/<craft>/tune.json` and `tune.md` (every row,
  the recommendations, the CLI file and its check).
- `parity.cjs [craft] [--logs ...]`: the native governor on the recorded headspeed (section 6.7), `out/parity.json`.
- `plot.py <out dir>` (rs-bench python): write the figures of the prediction quality; `plot_tune.py <out dir>` the figures of the
  autotune (`tune_<plot id>.png`).
- The worker on a whole dump: section 8.4 (the dev data have the selected flight logs only: Gaui logs 38-49).

Fireball CLI dump: the newest `RTFL_cli_SAB_Fireball_*` in the Drive folder (`memory/fireball-logs-and-setup.md`).
The Gaui has no dump.
