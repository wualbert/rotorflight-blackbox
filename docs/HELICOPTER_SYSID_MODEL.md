# Helicopter six-degree-of-freedom digital twin

`tools/autotune/heli_twin.cjs` is the plant: a stateful six-degree-of-freedom helicopter model with position, velocity,
attitude, body rates, rotor flapping, rotor speed and actuator states. `tools/autotune/twin_fit.cjs` identifies its
parameters from flight logs and tests it on reserved flights. `system_id.cjs` selects the log data and calls them, and
`control_pipeline.cjs` closes the loop with the native Rotorflight 4.6 controller (`firmware_controller.cjs`, the pinned
C source compiled to WebAssembly) for closed-loop identification and the gain search.

It replaces the rate-only "rotational-rotor-body" surrogate (twin file version 1). That model replayed recorded commands
open loop for 16 s windows and was never accepted on real flights. Reasons, from the Codex work log of 2026-10-13/14 and
this rewrite: an open-loop helicopter diverges over seconds, a plain prediction-error fit of feedback data lowers the
control power (the disturbances correlate with the feedback commands), and a rate-only model has no place for attitude,
speed, rotor speed or barometer data.

## Boundary

- **Plant input** is the stabilized mixer command that every flight-controller law produces: `mixer[0..2]` (roll, pitch,
  yaw; logged value / 1000) and `mixer[3]` (collective / 1000). One unit is 12 degrees of main blade pitch and 24 degrees
  of tail pitch (Rotorflight 4.6). The logged mixer is after the PID, feedforward, B and O terms, yaw stop gains, cyclic
  and collective precompensation, cross-coupling, swash ring and mixer limits. Swash mixing and servo geometry are inside
  the fitted actuator lag and delays.
- **Other inputs**: throttle `motor[0]` / 1000 and battery voltage `Vbat` / 100. A log without battery voltage (or with
  zeros) uses a constant 1: the motor gain is then per throttle unit.
- **Closed loop**: the native controller gets the recorded pilot setpoints and collective and the twin gyro through the
  native gyro filter chain, and its mixer output drives the twin. A check with recorded gyro shows that this controller
  reproduces the logged mixer to 1-4 % relative error in most 10 s windows of the reserved Fireball flights.
  Not executed: the stick-to-setpoint rate curves (the logged setpoint is used), rescue and level modes (excluded
  periods). The governor runs in the loop only when its settings are known; else the recorded headspeed and throttle are
  external inputs.

## State

| States | Meaning |
|---|---|
| `x, y, z` | position, world north-west-up, m |
| `vx, vy, vz` | velocity, world frame, m/s |
| `qw..qz` | attitude quaternion body to world (body forward-left-up, the gyro frame) |
| `p, q, r` | true body rate, rad/s |
| `bx, by` | tip-path-plane tilt about body x and y, rad |
| `omega`, `lambda` | main rotor speed rad/s, induced inflow ratio (dynamic inflow) |
| `aLat, aLon, aTail, aColl` | actuator positions (first-order lag after the transport delays) |
| `dMx, dMy, dMz`, `dFx, dFy, dFz` | moment and force disturbances (observer random walks, held during a prediction) |
| `baroAlt, baroVario` | barometer filters: altitude lags height, vario lags the derivative of the filtered altitude |
| `esc`, `hsSensor` | ESC response to throttle, headspeed measurement filter |
| `gyroP, gyroQ, gyroR` | rate after the firmware gyro low-pass filter, the value the log records as `gyroADC` |

The logged attitude is ZYX Euler (roll about +x, pitch about +y with nose down positive, yaw = -heading). A positive mixer
command gives a positive gyro rate on each axis. These conventions were checked against the logs (kinematic residual of
about 1 deg/s) and are tested in `test/heli_twin.test.cjs`.

## Equations

Minimum-complexity model in the manner of Gavrilets (2001) and Mettler (2003), integrated with fourth-order Runge-Kutta at
the sample rate (500 Hz for fitting, the gyro rate in the closed loop):

```
thrust      Ct = sa/2 (theta_c/3 (1 + 1.5 mu^2) - lambda/2),   T = rho pi R^2 (Omega R)^2 Ct
            theta_c = 12 deg * aColl - th0,   lambda = w_body/(Omega R) + lambda_i,   lambda_i' = (Ct / (2 sqrt(mu^2 + lambda^2)) - lambda_i) / 0.05 s
flapping    tau b' = -b + G R(phiU) (12 deg * [aLat, aLon]) - tau R(phiW) [p, q] + kmu [v, -u] / (Omega R),   tau = tauF Omega_ref/Omega
force       F_body = T * tilt(b) + (0, tail force, 0) - drag;   v_world' = R F_body / m - g + dF
moments     p' = lb n^2 bx + tail roll arm + gyroscopic + dMx,   q' = mb n^2 by + gyroscopic + dMy
            r' = nt n^2 (24 deg * aTail - tht0) + nr n (v/l_t - r) + Q_motor / Izz + nc n^2 (aColl - c_ref) + ncd aColl' + dMz
rotor       Omega' = (Q_motor - Q_aero) / I_r,   Q_motor = max(0, kmV esc Vbat - kmW Omega),   Q_aero = rho pi R^2 (Omega R)^2 R (cq0 (1 + 4.6 mu^2) + Ct lambda)
sensors     gyro = first-order low-pass at the logged gyro filter cutoff, baroAlt' = (z - baroAlt)/tauB, baroVario' = (baroAlt' - baroVario)/tauV
```

`n` is rotor speed over the reference speed (the median of the fit data), so control power scales with rotor speed squared
and the flapping time constant with the inverse of rotor speed. The body reaction torque is the motor torque, because the
motor stator turns with the frame. Mass, rotor radius and roll/pitch inertia come from the craft geometry prior
(`helicopter_model.craftPrior`); yaw and rotor inertia are fitted inside a factor of that prior.

## Observer

Predictions start from a state that only past measurements set. Attitude and headspeed replace the model values. Body rate,
moment disturbance and the vertical channel use steady-state Kalman gains of two linear sub-models (rate and moment random
walk per axis; height, vertical speed, force random walk and the two barometer filters). Flapping, inflow, horizontal
velocity and actuators evolve with the model: no logged sensor measures them. A test changes every measurement after an
origin and requires identical predictions.

## Identification

`twin_fit.STAGES`, then the closed-loop stage of `control_pipeline.tune`:

1. **Rotor speed** (motor, rotor inertia, ESC and sensor lags) from headspeed predictions.
2. **Vertical** (thrust, heave damping, barometer filters, collective delay) from altitude and vario predictions.
3. **Frequency**: flapping, hub stiffness, cross-coupling, tail authority and damping, delays and actuator lag fitted to
   the 3 x 3 actuator-to-rate frequency responses, estimated with the pilot setpoints as instruments
   (H = S_yx S_ux^-1, Hann windows, log bins, weight from coherence). With feedback, a plain fit of rate to command lowers
   the control power; the setpoint does not depend on the disturbances, so this estimate has no feedback bias (indirect
   closed-loop identification, as in CIFER). One linearization of the nonlinear model gives the model responses.
4. **Short-horizon joint**: all except the vertical parameters, from 0.01-0.2 s predictions, with the frequency term at a
   high weight. Longer open-loop horizons are not used for fitting: the open-loop helicopter diverges and the cost becomes
   too rough.
5. **Rotor speed again**, then **yaw trim** (tail trim, collective torque terms, yaw inertia) with a penalty on the
   observer moment disturbance: the trim must come from the model, else the closed loop runs away when the collective
   changes.
6. **Closed loop** (`control_pipeline.tune`, design periods only): the native controller flies the twin from the
   recorded pilot inputs; the fit minimizes the low-passed gyro and the controller mixer errors together, with the
   frequency term. Matching the mixer as well as the gyro is necessary: a wrong plant can track the setpoint.

Fits are Levenberg-Marquardt with forward-difference Jacobians in log space, pseudo-Huber residuals and parameter bounds.

## Checks on reserved flights

`twin_fit.assess` and the closed-loop agreement of `control_pipeline`:

- prediction error of each output at 0.01-1 s against holding the last value (roll and pitch rate at 0.1 s must be under
  90 % of it, attitude at 0.2 s under it);
- frequency response agreement on coherent bins (median magnitude error under 42 %, median phase error under 35 degrees);
- closed-loop gyro and mixer agreement with the native controller.

Per axis: roll and pitch need the prediction and frequency checks, yaw the frequency check. The open-loop yaw prediction
is shown but is not a gate: a replay of the recorded tail command integrates every torque disturbance that the command
cancelled. A model that agrees on some axes only is "partial": it can test the control steps of those axes
(`eligibleSteps`). This model does not tune the governor: the governor model (`gov_tune.cjs`) tunes it (user, 2026-10-15). In the
closed loop of the other steps, the model calculates the governor only with governor parity.

## Results (2026-10-14)

Fireball, log file `RTFL_BLACKBOX_LOG_SAB_Fireball_20261005_204823.BBL`, captures 6-16 (no parameter changes, user
confirmed); fit 921 s, reserved captures 12 and 16 (525 s, 1015 prediction origins). Development harness
`analysis/twin6dof/` with a worker pool; figures in `analysis/twin6dof/out/cfit4_eval/`.

| Reserved flights, RMS error | 0.1 s model / hold | 0.5 s | 1 s |
|---|---|---|---|
| roll rate, deg/s | 24.1 / 29.2 | 32.1 / 55.8 | 43.1 / 56.7 |
| pitch rate, deg/s | 17.8 / 30.1 | 35.6 / 79.1 | 50.4 / 89.0 |
| yaw rate, deg/s | 35.2 / 28.0 | 285 / 67 | 596 / 71 |
| roll / pitch angle, deg | 2.6 / 11.8, 1.2 / 6.9 | 25.4 / 35.8, 20.8 / 26.4 | 46.8 / 44.9, 33.1 / 32.4 |
| altitude m, vario m/s | 0.28 / 0.51, 0.58 / 0.86 | 1.15 / 1.65, 2.04 / 2.65 | 2.08 / 2.69, 2.43 / 3.46 |
| headspeed, RPM | 43 / 41 | 109 / 118 | 127 / 130 |

Frequency responses on reserved flights: roll median magnitude error 12 %, phase 3 degrees; pitch 8 %, 5 degrees, also at
5000 RPM, a headspeed with no frequency-fit data. Yaw: not enough coherent bins in the reserved flights.
Closed loop with the native controller, 35 reserved 10 s windows: gyro RMS error roll 14.3, pitch 11.4, yaw 13.5 deg/s
(medians 13.5, 11.1, 9.8; maximum 20.4, 16.9, 47.4), against 16.2, 15.8, 13.1 for the setpoint as the prediction.
Controller output error over its standard deviation: median 0.55 roll, 0.63 pitch, 1.21 yaw.

In-app identification (`system_id.fit`, one thread, the data selection of the app: 313 s of fit periods, 56 s reserved)
on the same 9 Fireball logs takes 189 s and validates all three axes: 0.1 s rate error roll 25.4 / 38.2, pitch 20.7 /
29.0, yaw 25.7 / 31.5 deg/s (model / hold); frequency agreement roll 26 % / 6.5 degrees, pitch 18 % / 7 degrees, yaw
16 % / 15.6 degrees (3 bins). The frequency weight of each stage is limited to half the time-domain cost, so a small
data set is not dominated by the frequency term.

Gaui X4 II (external aircraft, own fit, no Fireball coefficients), dump `RTFL_BLACKBOX_LOG_20261004_233406.BBL` logs 38-49:
pitch and yaw pass (yaw frequency 11 %, 16 degrees over 27 bins; yaw 0.1 s rate 32 against 54 deg/s), roll fails the
0.1 s rate check (29 against 23 deg/s) while its frequency response agrees (13 %, 9 degrees): status partial before the
closed-loop stage.

## Limits

- The yaw open-loop prediction is worse than holding the last value after about 0.1 s. The tail trim, the collective
  torque and the low-frequency yaw damping are the weakest parts; the closed loop and the frequency check carry the yaw.
- No logged sensor measures horizontal position or speed. The model estimates them; speed effects (blowback, drag, tail
  inflow) are as good as that estimate.
- Wind, vibration, servo motor dynamics, blade flexibility and ground effect are not modelled.
- Thresholds are model-check limits of this app, not flight-safety limits. A new flight must test every gain change.

## Files and commands

- `tools/autotune/heli_twin.cjs`: model, observer, linearization (`frequencyResponseMatrix`).
- `tools/autotune/twin_fit.cjs`: runs, prediction errors, instrumented responses, fit stages, `identify`, `validate`, `assess`.
- `test/heli_twin.test.cjs`: frames, hover, signs, linearization against a simulated sine, causality, observer stability,
  instrumented responses under feedback.
- `analysis/twin6dof/`: `extract.cjs` (logs to float32 runs), `dev.cjs` (staged fit with a worker pool), `closedfit.cjs`
  (closed-loop stage), `closed.cjs` (closed-loop check), `parity.cjs` (controller reproduces the logged mixer), `plot.py`.
