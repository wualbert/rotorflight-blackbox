# Filter autotune

The **Autotune** button in **Tuning → Filters** searches filter configurations by replaying recorded gyro samples through the Rotorflight compute path. Upstream NOMAD 4.5.1 optimizes numeric settings within fixed filter topologies. Measured attenuation and delay problems remain correction targets. Setup recommendations, RPM-notch locations and D-term power percentages are reference information, not sufficient evidence of a physical failure. Spectra suggest initial notch frequencies; every candidate score comes from time-domain replay.

The result includes the complete evaluated configuration, per-axis noise changes, baseline agreement, reserved-period validation, signal previews, the original filter checklist before and after replay, and a **Save filter CLI file** button. Export requires a validated candidate. Preview remains available when validation fails and is labeled accordingly. No command is sent to a flight controller.

Signal previews contain one scored window per log segment and PID profile, up to 18 windows. Recorded observations retain their logging rate; the original and candidate replay traces use the native filter rate. The final comparison runs continuously from the start of each selected configuration interval, retaining state throughout that interval. The UI displays selected portions of that trajectory and reports reconstruction error on observations excluded from the inverse calculation.

## Flight-specific filter workspace

The workflow is **Overview → Filters → Governor → Cyclic gains → Tail gains → Cyclic compensation → Tail compensation → Export**. Control tuning uses the recorded-configuration selector. Filter tuning instead selects a log or flight source and evaluates all its eligible configuration intervals. Each source retains its own filter draft. The recorded-configuration table identifies time ranges, PID profiles, value sources and freshness flags; selecting a control configuration does not change the filter workspace.

The Filters block in Overview contains the explanation and Autotune action. In the full workspace:

- One **Filter parameters** table contains recorded and proposed values. It includes low-pass types, static and dynamic notches, features, custom RPM-bank arrays, decimation and known per-profile gyro/D cutoffs. **Show changed values only** compares the proposal with every recorded interval. Unknown values remain explicit. **Maximum added time delay** defaults to 0.5 ms and accepts 0–20 ms. It limits the measured increase over the recorded filter path in coherently excited control bands, not the helicopter's total response delay.
- **Autotune** fills the table for the selected source, inputs and delay limit. **Simulate again** evaluates manual changes using retained decoded data and reconstruction. **Use autotune values** restores the proposal. **Use recorded values** replays each interval's own original values and produces no proposed change or CLI export. Unreplayed edits cannot enter Export.
- **Filter checks** pairs the recorded and replayed results using the same judges, thresholds, masks and scored intervals. Each row identifies check, log, configuration, profile, axis and time range; RPM attenuation retains its source number. Previous measured problems appear first. The summary distinguishes corrected, remaining, new and unavailable results. Setup guidance stays visible as information. Raw-vibration measurements retain their original input; unavailable mixer/servo outputs and unknown PID paths are not fabricated.
- **Gyro signals** shows roll, pitch and yaw, each with a time plot and spectrum. One selector chooses the log, configuration, profile and interval for all axes. **Raw data**, **Previous filter** and **New filter** share visibility controls. Spectra use the selected scored window at its recorded sample rate without display decimation; replay time traces retain native-rate samples. Changing a curve's visibility does not rerun analysis or replace edits. Recorded-only replay disables the new-filter curve.
- Detailed model agreement and filter coverage remain in the checklist. P+D previews are omitted because they represent only the modeled gyro contribution, not the full PID output or helicopter response. The optimizer still evaluates P+D energy and per-path delay where the PID values are known.

Manual candidates must pass baseline agreement, the measured-problem progress rule and the selected delay, gain-loss and per-axis noise limits. They need not pass the autotuner's noise-improvement or candidate-selection holdout test. Failed replay retains its preview and states the reason; it cannot clear an unverified signal problem or produce deployable CLI text.

Each step updates a shared pending record. Accepted filter changes enter it automatically. Export selects one recorded configuration per helicopter PID profile and combines compatible changes across steps. Selecting an older control configuration restores its known values before applying its proposal. Unknown required restorations, incompatible global changes, failed replay and blocked prerequisites prevent export. The final page shows the parameter differences and CLI commands.

## Method selection and literature

The numeric optimizer is the authors' [NOMAD 4.5.1 implementation](https://github.com/bbopt/nomad/releases/tag/v.4.5.1), compiled to synchronous WebAssembly, rather than an independently written approximation to MADS. [Audet et al., Algorithm 1027, ACM TOMS 2022](https://doi.org/10.1145/3544489) describe NOMAD's mesh adaptive direct search, poll steps and progressive barrier. A successful iteration can enlarge the search frame; an unsuccessful complete poll refines it. Constraint violation guides progress from infeasible points. The adapter uses integer variables, `ORTHO 2N` polling, deterministic seed 17 and five progressive-barrier constraints. Optional quadratic-model and Nelder–Mead searches are disabled. The algorithm source is unmodified.

The surrounding application remains a hybrid. A finite, heuristic catalogue proposes filter types, active stages, RPM sources and tracker counts. Screening chooses at most three topologies for NOMAD. Each solve uses one fixed set of 24 training windows, the same objective and constraints on every call, and integer firmware units. Full-training ranking and reserved-period validation happen outside NOMAD. Their thresholds are application design choices, not consequences of a convergence theorem.

The applicable guarantees must be distinguished:

| Result | Assumptions and actual scope |
|---|---|
| [MADS, Audet and Dennis, 2006](https://doi.org/10.1137/040603371), with its erratum | Continuous-variable local stationarity results require a refining subsequence, local regularity, sufficiently rich limiting poll directions and the stated feasible-set conditions. They are asymptotic statements, not a global minimum or finite-time success guarantee. |
| [Progressive barrier, Audet and Dennis, 2009](https://doi.org/10.1137/070692662) | Extends constrained direct search using objective and constraint violation. An infeasible stationary limit need not become feasible. Its assumptions cannot be replaced by a time budget. |
| [Granular MADS, Audet, Le Digabel and Tribes, 2019](https://www.gerad.ca/en/papers/G-2018-16) | Treats controlled precision and discrete variables through mesh updates. Integer firmware settings have finite granularity; the continuous Clarke-stationarity statement does not directly certify an integer result. |
| Implemented finite audit | After a solve, the adapter attempts every admissible one-unit coordinate neighbour of its best feasible point. Only a complete audit with no improving feasible neighbour establishes this explicitly limited neighbourhood property. It concerns that topology and the fixed 24-window objective, not the final full-training selection. |
| Whole autotuner | Adaptive peak switching can be discontinuous. The outer topology catalogue is incomplete, the run is budgeted, and validation changes the evaluated sample set. No end-to-end stationarity, global-optimality, physical-feasibility or flight-stability guarantee is claimed. |

The result records native stop reasons, evaluation counts, variable bounds and audit coverage. Budget exhaustion is reported as a budget stop. An incomplete audit is not a certificate. For comparison, [DFLINT, Liuzzi, Lucidi and Rinaldi, 2020](https://optimization-online.org/wp-content/uploads/2018/02/6471.pdf) obtains stronger integer-neighbourhood results by enriching primitive directions under its assumptions. The implemented coordinate audit is not DFLINT and makes no such claim.

Recent [CatMADS research, 2025](https://arxiv.org/abs/2506.06937) extends MADS to mixed categorical settings under specified neighbourhood and regularity assumptions. Its fixed-dimensional formulation does not automatically cover changing bank counts and parameter dimensions. It is not the library used here. [Convex FIR magnitude design, Wu, Boyd and Vandenberghe, 1998](https://web.stanford.edu/~boyd/papers/magdes.html) offers global guarantees for its FIR formulation; Rotorflight's causal, adaptive IIR stages are a different feasible set. Neither result licenses a global-optimum claim for this application.

The complete source archive, LGPL notice, bridge and artifact hashes are in `tools/autotune/optimizer/`. Rebuild offline with `node tools/autotune/optimizer/build.cjs --emsdk /path/to/emsdk`, using Emscripten 4.0.18, CMake and a host C++17 compiler. The only build adaptation generates attribute headers with the host compiler before cross-compilation. Build paths can change embedded diagnostic strings and artifact hashes; functional and source-hash checks are separate from byte-for-byte reproducibility.

[AutoTune, Loquercio et al., IEEE RA-L 2022](https://arxiv.org/abs/2103.10698) demonstrates sampling-based controller optimization for high-speed flight. Its trajectory and physical-flight objectives differ from this application's objective: filter and PID feedback outputs for a fixed, reconstructed sensor trajectory.

For reconstruction, [Yu et al., DAFx 2024](https://arxiv.org/abs/2404.07970) show how to differentiate time-varying recursive filters directly. This supports the implementation choice of a sample-wise forward operator and its transpose. The local refinement additionally differentiates Rotorflight's SDFT peak interpolation and notch-coefficient updates. [Rota et al., revised September 2026](https://arxiv.org/abs/2603.02794) use a learned controller with a differentiable biquad cascade for speech denoising. That result is relevant to differentiable filtering, but its learned controller and speech objective are not substitutes for Rotorflight's existing algorithms.

[Van Haren, Smith and Oomen, Control Engineering Practice 2025](https://www.sciencedirect.com/science/article/pii/S0967066125001881) use regularization to identify fast-rate models from fast-rate inputs and slow-rate outputs. Here the firmware model is known and native input samples are missing, so this implementation solves a different inverse problem. A multichannel input reconstruction is needed before any candidate configuration can be evaluated.

Rotorflight's [filter tuning guide](https://rotorflight.org/docs/Tuning/First-Flight-Filter-Tuning) and [RPM filter documentation](https://rotorflight.org/docs/setup/rpm-filters) establish the noise/delay tradeoff and rotor harmonics as relevant filter targets. Their suggested cutoff and width values inform interpretation, but do not impose hidden search floors. Candidate acceptance uses the replay constraints below. Recent adaptive-filter research that introduces a new onboard filter cannot be deployed through existing Rotorflight CLI options; this search uses the algorithms already present in the firmware.

## Firmware path and data requirements

The source reference is [Rotorflight 4.6.0, commit 118e912](https://github.com/rotorflight/rotorflight-firmware/tree/118e912). `filter_replay.cjs` ports these operations:

1. RPM notch banks, state updates while faded out, minimum-frequency fade, frequency limits, center offsets, and three-bank round-robin coefficient updates.
2. Gyro LPF2, gyro LPF1, static notch 2, static notch 1, and dynamic notches, in firmware order.
3. Damped sliding DFT, sample averaging, batch scheduling, peak tracking, and incremental notch coefficient updates.
4. PID gyro first-order filtering, the derivative filter applied to negative gyro, and the gyro contribution to P plus D with the recorded gain scaling. The reconstruction also inverts the asymmetric yaw P stop-gain function when that function is known or identified.
5. Filter/PID scheduling from the loop denominators, motor-update timing, and the Blackbox observation offset and `lrintf` quantization. Dynamic LPF updates use the firmware's 5 ms interval and full-headspeed ratio.
6. The two Bessel biquads in the fourth-order gyro decimator, motor-RPM Bessel filtering, and the governor's separate PT2 RPM path.

Coefficients use the firmware rate, including the cycle-rate correction for RPM notches. `schedulerGetCycleTimeMultiplier()` follows the gyro interrupt clock; delayed task execution must not reduce that coefficient rate. The reconstruction estimates this clock from the median recorded frame interval, rather than total frame count divided by elapsed time. Timestamp quantization and unrecorded interrupt timing limit this estimate. LPF aliases and all ten firmware types are supported.

Screening windows have two seconds of unscored history. Reconstruction advances chronologically, carrying the complete gyro-filter and SDFT state along the committed trajectory: filter memory and coefficients, RPM fades and update cursor, DFT buffers, adaptive-notch state, and scheduler phase. Frequencies persist when no peak is detected. Frequencies alone are insufficient to restart the adaptive algorithm at an arbitrary sample. Finalists and final baseline checks retain all filter and tracker state through each complete log segment. PID coefficient changes preserve filter state, as `pid.c` does.

`blackboxResetIterationTimers()` resets the logging counter, but does not reset the adaptive filter. Consequently, the first recorded frame does not identify the SDFT's averaging, processing-step and axis phase. Before reconstruction, the app enumerates the finite phase cycle using up to twelve stratified training windows and the original configuration. It minimizes gyro/P/D observation error from raw-only input interpolation. It excludes reserved flight windows and the same one-in-five gyro/D observations excluded from reconstruction. A minimum must be at least 2% below the next phase to be used; otherwise the phase remains zero and the report marks it unidentified. This separation is a design choice, not a statistical confidence level. Calibration results are retained per log in `model.coverage`.

The update clock advances even when dynamic notches are OFF. A candidate that enables them, changes their sample-averaging period, or starts at an interior screening window retains the corresponding subtask clock. Unrecorded filter memory before the log still requires initialization; baseline checks measure the residual error. No estimated timing value is exported as a firmware setting.

A log must contain all three `gyroRAW` and `gyroADC` axes, headspeed, firmware/settings metadata, and continuous sample timing. Profile changes, gaps, rescue, leveling, failsafe, and non-flight samples exclude windows, including their warmup. The worker preserves confirmed arming-profile identity. Header values describe that first profile; other profiles require a known configuration. Unknown PID values are never tuned. Their objective uses gyro output energy; the UI shows no P/D preview based on fallback header values.

### Filter equations and firmware choices

The authority for the implemented stages is the pinned [Rotorflight 4.6.0 source, commit 118e912](https://github.com/rotorflight/rotorflight-firmware/tree/118e912), particularly `common/filter.c`, `common/filter.h`, `sensors/gyro_filter_impl.c` and `flight/pid.c`. The source order is decimator → RPM banks → LPF2 → LPF1 → static notch 2 → static notch 1 → dynamic notches → PID paths. Changing that order changes the adaptive tracker input.

Here, $f_s$ is a stage's sample rate, $f_c$ its characteristic cutoff or notch-center frequency, $n$ the integer sample index, and $x_{n}$, $y_{n}$ its input and output. For constant coefficients, $H(z)$ denotes its transfer function and $z$ the complex transform variable. The numerator coefficients are $b_0,b_1,b_2$; denominator coefficients are $a_0,a_1,a_2$. These equations describe ideal arithmetic. Replay uses the firmware's trigonometric approximations, cutoff clamps, coefficient normalization and state update order; it does not substitute host-library filter designs.

- **PT1:** define $g=f_c/(f_c+f_s/(2\pi))$. The implemented recurrence is $y_{n}=(1-g)y_{n-1}+g x_{n}$. Moving the previous-output term to the left and taking the zero-state transform gives $H(z)=g/(1-(1-g)z^{-1})$. This is a backward-Euler first-order section, not the prewarped `FIRST_ORDER` section below. PT2 and PT3 cascade two or three PT1 sections. Their per-section cutoff multipliers are 1.553773974 and 1.961459177. For $N$ identical analog first-order sections with individual cutoff $\gamma f_c$, define $\gamma>0$ as their cutoff multiplier. The product of their squared magnitudes at $f_c$ is $(1+\gamma^{-2})^{-N}$. Set this product to $1/2$ and take its reciprocal $N$th root to obtain $1+\gamma^{-2}=2^{1/N}$. Subtract one and take the positive inverse square root: $\gamma=(2^{1/N}-1)^{-1/2}$. This compensates the analog cascade's cutoff; it does not create a different Butterworth pole distribution.
- **FIRST_ORDER:** define $W=\tan(\pi f_c/f_s)$. The firmware sets $a_1=(W-1)/(W+1)$ and $b_0=b_1=W/(W+1)$, then computes $y_{n}=b_0x_{n}+b_1x_{n-1}-a_1y_{n-1}$. These are the prewarped bilinear low-pass coefficients. PT1 and FIRST_ORDER therefore differ even at the same cutoff.
- **Biquads:** define $Q>0$ as the quality factor, $\omega=2\pi f_c/f_s$ and $\alpha=\sin(\omega)/(2Q)$. Before normalization, $a_0=1+\alpha$, $a_1=-2\cos(\omega)$, $a_2=1-\alpha$. A low-pass uses $b_0=b_2=(1-\cos(\omega))/2$, $b_1=1-\cos(\omega)$. A notch uses $b_0=b_2=1$, $b_1=-2\cos(\omega)$. Divide all five stored coefficients by $a_0$, then use $y_{n}=b_0x_{n}+b_1x_{n-1}+b_2x_{n-2}-a_1y_{n-1}-a_2y_{n-2}$. These match the coefficient structure in the [W3C Audio EQ Cookbook](https://www.w3.org/TR/audio-eq-cookbook/). Rotorflight's approximation functions and rate limits still govern the replay.
- **D path:** the input is the negative measured gyro rate, not setpoint error. With the same definition of $W$, set $a_1=(W-1)/(W+1)$ and $b_0=2f_sW/(W+1)$. The recurrence is $y_{n}=b_0(x_{n}-x_{n-1})-a_1y_{n-1}$. This is a bandwidth-limited differentiator; the D gain is separate. Replay follows the executable coefficient signs rather than relying on the nearby source comment's denominator convention.

The biquad low-pass families use these constants from `common/filter.h`. Each section receives the configured cutoff multiplied by the listed factor before the implementation's frequency clamp.

| Filter family | Section Q values | Section cutoff multipliers |
|---|---|---|
| Butterworth, order 2 | 0.707106781 | 1 |
| Bessel, order 2 | 0.577350269 | 1.272019649 |
| Critically damped, order 2 | 0.5 | 1.553773974 |
| Butterworth, order 4 | 0.541196100; 1.306562965 | 1; 1 |
| Bessel, order 4 | 0.805538282; 0.521934582 | 1.603357516; 1.430171560 |

For a static notch, let $f_{\mathrm{center}}$ and $f_{\mathrm{lower}}$ be the CLI center and lower cutoff frequencies. The firmware computes $Q=f_{\mathrm{center}}f_{\mathrm{lower}}/(f_{\mathrm{center}}^2-f_{\mathrm{lower}}^2)$, requiring a positive lower cutoff below the center. The common clamp is $0.475f_s$; gyro configuration additionally limits relevant cutoffs to $0.45f_s$. The D initializer applies the common clamp at half its sample rate, giving $0.2375f_s$. The replay preserves these distinct limits.

RPM and dynamic notches change coefficients and fade during the flight. A transfer function above describes a frozen stage only. Stable frozen poles do not prove stability of arbitrary coefficient switching or of the helicopter's feedback loop. The offline replay measures filtering of a fixed trajectory; it cannot supply the new closed-loop trajectory after a real filter change.

### Reconstruction from firmware observations

`blackbox.c` records `gyroRAW = lrintf(gyroADCd)` **after** gyro decimation. It records the latest `gyroADCf` at a different scheduler tick. In these recordings, Fireball samples the gyro at 2 kHz, filters at 1 kHz and logs at 1 kHz; Gaui samples at 4 kHz, filters at 2 kHz and logs at 1 kHz. The raw observation follows the corresponding filter input by 500 µs and 250 µs, respectively. `axisP` and `axisD` provide additional filtered observations, with 0.001 control-output quantization.

`filter_reconstruct.cjs` uses these channels jointly. This follows the multichannel reconstruction principle in [Unser and Zerubia, IEEE TCAS-II 1998](https://bigwww.epfl.ch/publications/unser9801.html): samples of several filtered versions of a signal can carry information that one channel alone omits. The implementation is a regularized numerical inverse of Rotorflight's time-varying path, not the paper's shift-invariant closed-form algorithm.

The calculation is:

1. Initialize the post-decimator trajectory on the sensor-rate grid with offset-corrected windowed-sinc interpolation. The upstream sensor input is recovered in step 5.
2. Run the recorded firmware configuration and retain every stage's coefficients, RPM fade, and adaptive-notch updates.
3. Solve the weighted multichannel least-squares problem with conjugate gradients and an exact transpose of the frozen-coefficient filter chain. Subtract the affine output contribution from retained filter states in the inverse's observation equations; the forward replay keeps those states. A quadratic penalty on changes in slope regularizes the correction to the initial trajectory. Weights account for gyro, setpoint and PID quantization. Regularization is 0.003 with an accepted nonzero D response or a usable P observation with resolution of one degree/s or better, and 0.015 otherwise. These are design choices. A known but weak P gain alone does not justify weaker regularization.
4. Rerun the nonlinear SDFT tracker on each proposed reconstruction. Up to eight frozen-coefficient iterations use a line search from one through 1/32. Up to eight additional damped Gauss–Newton iterations differentiate the SDFT, peak interpolation, and moving notch coefficients. Peak selection is held fixed only for the local derivative; each trial reruns the actual branching algorithm. The local solve adds a 0.1 quadratic damping weight on its step, and backtracking extends to 1/2048. When an axis stalls during this refinement, test the same proposed direction separately over consecutive 250 ms intervals, with step lengths from one through 1/32. This permits different intervals to cross different discrete peak boundaries. Every accepted step reduces the original fit objective after a complete nonlinear replay; excluded observations do not select steps. Stop when no axis improves. The linear case needs one solve. Up to eight adjacent analysis windows share one reconstruction block. A later block holds its previously committed prefix fixed. The solver subtracts that prefix's contribution and solves only for the remaining samples. Adaptive-notch history and preview seeds follow the same committed trajectory.
5. Invert the recorded gyro decimator with a regularized inverse, then feed that fixed sensor-rate input through each candidate decimator. The inverse has a dimensionless power regularizer of 1e-9. The original-decimator closure error is measured. Spectral inversion constructs inputs only; every candidate output and score comes from causal time-domain firmware replay.
6. Join the reconstructed intervals into one fixed trajectory. Replay the original configuration and each finalist continuously, including intervals outside the scoring mask. Those intervals advance filter state but do not contribute to the objective.

The repeated linear solves run in a binary64 WebAssembly kernel, with the same reduction order, conjugate-gradient iterations and stopping rules as the JavaScript reference. The kernel includes the forward filter, transpose, observation penalties and adaptive-notch derivative. Local nonlinear trials retain the unchanged prefix score and complete gyro, adaptive-notch and PID-observer states. Each trial replays its changed suffix, while shared scheduler phases advance for every axis. RPM coefficients and recorded driver interpolation are reused only within one reconstruction with the same configuration and driver samples. These changes preserve every measurement and objective term.

Filter preparation, coefficients, reconstruction and scoring use one bundled math library across the desktop and Node runtimes. Previously, last-bit differences in host transcendental functions could change adaptive peak selection and iterative steps enough to change a baseline verdict. The portable library has no host imports and does not replace global Math. It fixes this runtime dependency; it does not establish the physical correctness of the inverse model.

On the saved eight-window Gaui Log 50 block, the combined implementation took 34.9 seconds versus 101.4 seconds for the JavaScript reference using the same portable math, with exactly equal reconstructed samples and diagnostics. On a different eight-window block from Gaui Log 25, the actual Chromium 99 worker took 94.0 seconds versus 186.7 seconds. Its prepared data, reconstructed samples, states and iteration trace exactly matched Node. These are block timings under concurrent load, not whole-flight guarantees. The [validation records](../analysis/gaui-numerics-20261014/) retain the comparisons. Reconstruction precedes the proposal-stage time budget. Subsequent manual candidates in the retained worker reuse the reconstructed input.

One in five gyro-output observations and the corresponding D observations are excluded from the inverse calculation. The UI reports error on those samples, compared with interpolation from raw gyro alone. These checks are conditional on the recorded settings and observer calibration; they are distinct from the reserved flight blocks used to test a chosen configuration.

Inherited PID values marked as assumed are checked before they become reconstruction constraints. The check uses training windows only. Reserved flight windows and every fifth reconstruction observation are removed from both the PID observations and the gyro history used for calibration. Calibration windows require complete filter history outside reserved periods, with a fixed 32-frame margin for interpolation support. Missing gyro positions are interpolated from training samples for this check only; the actual recording and replay inputs remain unchanged. With at least 128 training observations, a declared gain is contradicted if its RMS residual exceeds all three bounds: 0.001 control-output units, four propagated rounding-noise standard deviations, and 5% of observed PID RMS. These conservative identification bounds do not replace the replay acceptance limits.

An inconsistent P or D gain can be identified at its declared cutoffs if the existing fit-quality requirements below are met. Otherwise that channel is omitted from the inverse constraints. Consistent channels remain unchanged. Diagnostics retain declared gains, identified gains, residuals, bounds and each channel's action. A contradicted profile axis is unavailable for P+D objective weighting and PID-cutoff export; its gyro output still participates in candidate comparisons. Identified values do not alter the recorded configuration or become CLI values.

The first two-window interval of Gaui Log 49 reproduced the failure caused by inherited yaw gains: withheld gyro RMS was 77.22 degree/s and decimator closure RMS was 9.507 degree/s. With contradicted constraints removed, these became 0.857 and 0.0472 degree/s; raw-only interpolation gave 1.240 degree/s withheld RMS. Timing calibration also selected a different phase once the contradictory constraints were removed. This is a reconstruction check on that interval, not a whole-flight recommendation or a flight-stability result.

A cyclic PID observer can also be identified when its profile configuration is absent. Its fit must explain at least 99.5% of P energy and 99% of D energy, with RMS residual below 0.001 and at least 3,000 samples. A derivative-only observer can use yaw D, or a cyclic D signal when P identification fails, with the same D fit requirements. Its two filter poles need not be separately identifiable, so it supplies only the combined D response, with no P constraint. Unlike the inherited-value contradiction check, this pre-existing missing-profile calibration uses the complete original recorded signals, including outputs subsequently omitted from the inverse fit. Its withheld-output diagnostics remain conditional on that calibration.

Yaw P uses the firmware's transition between clockwise and counterclockwise stop gains. The inverse is used only where the complete function is monotone; a maximum-to-minimum gain ratio of three or greater is rejected. When a profile is unknown, the two effective P gains are fitted jointly for each trial gyro cutoff. The accepted fit must explain at least 99.5% of P energy on at least 3,000 samples. Its RMS limit includes setpoint rounding multiplied by the identified gain: twice the combined standard deviation of one-per-mille P rounding and one-unit setpoint rounding. An accepted D response supplies an additional constraint. These identified gains and cutoffs remain reconstruction observers.

Observer calibration accounts for quantization in its measured gyro input, following the bias-compensation principle surveyed by [Söderström, Automatica 2007](https://www.sciencedirect.com/science/article/pii/S0005109807000714). For integer observations, it approximates rounding as independent white noise with variance 1/12. It propagates that variance through interpolation and each trial observer, then removes its expected contribution from the regression. Yaw stop-gain regression uses first-order propagation through its two basis functions. Acceptance still uses the actual residual. The white-noise approximation is a calibration assumption, not an exact property of every quantized signal.

For dynamic LPF, `getFullHeadSpeedRatio()` returns one in OFF/DIRECT modes. In ELECTRIC/NITRO modes, the app can reconstruct raw motor RPM from logged headspeed and the recorded motor Bessel cutoff, apply the governor PT2 and its one-motor-update delay, divide by the configured full profile headspeed, and apply the governor state rules. An explicit ratio array is also accepted. Governor request is never substituted for full profile headspeed. The governor mode, filter cutoffs and full profile headspeed must be known to choose this path.

Reconstruction estimates unobserved states; it does not make every inverse uniquely identifiable. In particular, an alternate physical gyro, undocumented sensor-internal filtering, and unrecorded ESC event timing cannot be identified solely from the firmware source. These settings remain unchanged. The counterfactual output is conditional on the recorded sensor trajectory; predicting changed helicopter motion would require a separate plant model.

## Search scope

The coverage table in every result accounts for each filter family. “In analysis” denotes an eligible family; the budget limits the evaluated combinations, not an exhaustive enumeration of every legal integer value.

| Family | Treatment |
|---|---|
| Gyro LPF1/LPF2 | All ten types, NONE, cutoff grid, and coupled LPF/notch proposals |
| Static gyro notches | Both slots, removal, center and width |
| Dynamic notch | Feature on/off, count including zero, Q, minimum and maximum frequency |
| RPM filter | Feature on/off, all presets, custom mode, minimum frequency, every one of 16 banks on each axis, Q, source, center, addition/removal |
| Dynamic LPF1 | Minimum/maximum and base cutoff when its driving signal is available |
| PID gyro/D cutoffs | Separate values per known profile and axis, including PID gyro bypass; D cutoff is not set to zero to obtain a trivial noise reduction |
| Gyro decimation | OFF and cutoff proposals, with recovered upstream samples and native-rate Bessel replay; nonzero cutoffs stay between 100 Hz and the smaller of 1000 Hz and 30% of the gyro sample rate |
| Motor RPM smoothing | Cutoff proposals when original cutoffs are known; the same recovered motor input drives every candidate |
| Hardware gyro, sensor choice, loop denominators | Retained; sensor substitution and scheduler changes require separate hardware and timing validation |
| ESC sensor filtering | Retained when protocol and event timing are unrecorded |
| Setpoint, boost, relax, precompensation, deadband and cross-coupling filters | Reported separately: their control-response effects cannot be judged from fixed gyro replay |
| Governor, accelerometer, voltage/current, RSSI and other sensor filters | Reported separately: they require their own inputs and objective |

A configured gear ratio is a physical input, not a free noise-minimization parameter. When it is absent, the existing notch-identification estimator can supply a measured RPM-source mapping only after its own checks pass. A single-flight replay retains the accepted estimate from the current file analysis when that flight contributed to it. The source logs remain in the replay result. Changing the analysis inputs or its estimate invalidates the reconstruction workspace; a CLI configuration takes precedence. Without applicable file evidence, the replay estimates the orders from its own selected flights. Unresolved active sources prevent export. Source proposals that cannot be driven from recorded RPM data are excluded explicitly.

Every candidate represents one complete target configuration applied to all selected logs, while their loop rates, gains and physical gear ratios remain specific to each log. The newest available settings form the target baseline. Every known profile's target cutoffs are also fixed across logs. This prevents scoring per-log configurations and exporting a different configuration.

## Objective and constraints

NOMAD minimizes the fixed-training-window noise objective below, subject to measured delay, control-band gain and per-axis noise constraints. Full-training selection then prioritizes correction or significant improvement of recorded **measured** filter problems, with no new or worsening measured problem. This additional checklist ranking is outside the numeric optimization problem. A recommendation can leave explicitly listed problems unresolved; it must not claim that all checks are satisfactory.

The shared finding policy distinguishes setup guidance from measured failures:

| Check | Interpretation |
|---|---|
| F1–F4: LPF presence, cutoff guides, notch Q guide and D cutoff guide | Reference settings. They do not establish that a flight needs a particular LPF or cutoff. Legal firmware ranges, available inputs and measured replay constraints still apply. |
| F5: raw vibration lines without nearby RPM notches | RPM placement information. It does not measure the combined attenuation of static, dynamic and low-pass filters. Requiring an RPM notch on every such line incorrectly rejects alternative filter designs. |
| C11 / D-term F10: fraction of power above 30 Hz | Spectral composition, not absolute noise. Scaling the entire D signal changes its power but leaves the fraction unchanged. A 50% threshold cannot establish servo damage or justify reducing D gain. RMS and replay changes remain visible. The separate mixer-output F10 measurement retains its own interpretation. |
| F6: measured RPM-line attenuation; F11: measured delay | Measured application checks, retained with their existing thresholds and uncertainties. Those thresholds are engineering design choices, not universal stability criteria. |

This follows the distinction in the [Rotorflight gyro setup guidance](https://doc.rotorflight.org/configurator/tabs/gyro/): filtering trades noise reduction against delay, and RPM, static and dynamic notches serve different vibration sources. Its typical initial settings are useful starting points, not necessary conditions for every successful filter design. The policy is shared by the recorded analysis, replay checklist, advice and hierarchy. Raw measurements and diagnostic severities remain available for compatibility, but guidance cannot silently become a tuning prerequisite or an unvalidated parameter-change recommendation.

For a remaining F6 or F11 failure, a significant improvement exceeds twice the quadrature combination of unchanged-replay and candidate standard errors. The desired direction is larger attenuation for F6 and smaller delay for F11. This is a conservative comparison threshold, not a paired confidence interval. Unknown uncertainty cannot establish improvement; a measured worsening then counts as regression. Noise-only improvements do not clear an unrelated measured failure.

The seed catalogue includes optional setup-guide proposals, and also preserves alternatives without those changes. Thus neither a 100 Hz LPF nor a Q floor of 2 is forced. RPM source proposals use the configured source mapping and measured rotor harmonics; non-harmonic resonance proposals use static or dynamic notches. Every seed and every numeric refinement still requires causal replay.

Missing measurements cannot satisfy a correction target. A recorded measured failure must also occur in unchanged replay before its disappearance can count as a correction. Removing a failing RPM bank retains its original source-specific target as unavailable. Physical vibration sources, mixer/servo response and unknown PID paths remain explicit limitations. A gyro replay cannot establish their correction.

Configuration and recorded-input measurements do not depend on modeled gyro output. Signal checks are confirmed only with matching baseline validation for the relevant log and axis on supported firmware. An unconfirmed signal result remains labeled as such in the calculated-value column. It is not presented as a satisfactory measurement.

A valid flight/profile period shorter than the warmup plus one spectral window has no independent signal measurement. It is listed separately with its duration and the required window length. It does not invalidate measurements from longer periods. Missing raw input, nonfinite samples, timing gaps, unknown required filter inputs, and an unsupported firmware model remain blocking failures. An input containing only short periods still cannot meet the minimum flight-block and window requirements. Predictions and export comments identify the short periods for which no signal change was measured.

Each scored window has approximately one second of samples, rounded to a power-of-two FFT length. A Hann window is applied after replay. Gyro noise energy is integrated from 30 Hz through 80% of the native filter Nyquist frequency. PID energy uses actual native PID ticks and 80% of their Nyquist frequency. Scoring precedes Blackbox downsampling: aliased components that cancel in recorded-rate observations still contribute native-rate energy. For a non-power-of-two rate ratio, the largest power-of-two native interval within the scored window is used. Low-frequency delay/gain checks and the overview spectra remain at the observation rate.

For each window and axis, divide candidate P-plus-D gyro-contribution energy by baseline energy when PID values are known; otherwise use the corresponding gyro-energy ratio. Average those dimensionless ratios within a 30-second flight block. Denote that positive mean by $\rho$, and denote the block's noise change in decibels by $d$. The power-to-decibel definition gives

$$
d = 10\log_{10}(\rho).
$$

The reported score is the mean block change. Its standard error uses the sample variance of block changes divided by the number of blocks. Equal axis normalization prevents a loud axis from dominating the objective. The per-axis gyro-energy check is separate from this objective.

The following thresholds are **design choices**, not firmware limits or guarantees from the cited optimization papers:

- No axis may gain more than 0.25 dB of gyro noise.
- For each PID profile, coherent output/input cross-spectra measure added phase delay and gain loss around 10, 15, 20, 25 and 30 Hz, in bands of ±2 Hz. The gyro, PID gyro and D paths are checked separately where known. Coherence must be at least 0.8. Added delay must satisfy the user-selected maximum, default 0.5 ms; control-band gain loss is at most 0.5 dB. At least three measured comparisons are required.
- Baseline replay must agree with recorded gyroADC on every evaluated log and axis: band-power error at most 1 dB, median resolved-line error at most 1 dB, and median coherent 10–30 Hz delay error at most 0.3 ms. The phase comparison uses the cross-spectrum of recorded and replayed outputs directly, with coherence at least 0.8 and recorded output spectral density above 0.001 squared degrees per squared second per Hz. It does not require an adaptive filter's output to remain coherent with gyroRAW. The replay is rounded through the Blackbox observation model before these spectral comparisons. Quantization-floor residuals below 0.15 squared degrees per squared second per window are omitted from dB comparisons. RMSE and the maximum line error are reported. On the gyro observations excluded from reconstruction, error power may not exceed raw-only interpolation error power by more than the same 1 dB allowance; the denominator has a two-channel rounding-noise floor of 1/6 squared degrees per squared second.
- When the training replay corrects a recorded problem and passes the progress and regression checks, the correction supplies the benefit criterion. Otherwise training noise improvement must be at least 3 dB. In both cases, the combined noise reduction must exceed two block standard errors. At least three flight blocks and five held-out windows are required.

Every fourth block is reserved before candidate selection. For a three-block input, the last block is reserved. Candidate generation uses native-rate training spectra only. Up to 360 seeds are screened on eight stratified training windows, within the first quarter of the default 120-second search budget. The best twelve eligible seeds use 24 training windows. At most three distinct topologies start NOMAD solves on those same windows. Each solve has at most 180 distinct evaluations, including its attempted coordinate audit, and a share of the remaining time. Numeric frames, bounds and starts are recorded. A seed can remain a finalist even when numeric refinement fails. If screening supplies no eligible seed, the recorded topology supplies an initial point; progressive barrier can start infeasibly.

The candidate catalogue, 24-window objective and at most twelve full-training finalists are computational choices. The coarse screen has no convergence guarantee. Wall-clock limits can change which candidates are reached. Preparation, reconstruction and final continuous validation run outside the search budget, so 120 seconds is not a total-runtime guarantee. Browser cancellation terminates the dedicated worker.

Final selection first retains candidates meeting the checklist constraints and training benefit requirement, when any exist. Within the best checklist-priority group, it identifies the lowest training noise score. Candidates no more than one standard error of that score above it form a comparison set. The candidate with the least added training delay is selected from this set; noise breaks a delay tie. This one-standard-error allowance is a design choice that preserves delay margin instead of pursuing noise differences below the measured uncertainty. Unknown uncertainty gives no allowance. The comparison uses a fixed reference, so it is independent of pairwise sorting order. It neither changes the acceptance limits nor uses reserved observations. The result records the reference score, allowance, comparison-set size and selected delay in `search.selection`.

The selected training candidate is then frozen. Reserved data can accept or reject it, but cannot select another candidate. Progress is required on the training periods and combined record when they contain replayable original problems. Reserved periods must retain measurements, pass setting checks and introduce no new or worsening problem; they need not contain the particular failure corrected in training. Their noise must decrease in at least 80% of reserved blocks and in their mean, with the same delay/gain/axis constraints. Blocks from one flight remain correlated; their standard error is a descriptive uncertainty measure, not a calibrated confidence interval or proof of generalization to new flights.

Delay and gain constraints cover the coherently excited measured bands. They do not establish a stability margin for unexcited axes, frequencies or unknown PID paths.

If the configured RPM-source mapping is absent, the notch-identification calibration uses all selected recordings. Reconstruction and optional PID-observer identification also use original-configuration observations across the recording. The reserved-period test is conditional on these physical-input calibrations; it tests candidate selection, not an independent recovery of the calibration parameters.

## Export, tests and limitations

The complete CLI contains filter type names, feature commands, all nine custom-bank arrays, known per-profile cutoffs, metadata, previous/new values, current-value caveats, a backup instruction, and `save`. Long provenance comments wrap within the firmware line buffer without truncation. CLI profiles are zero-based. The previous selected profile is restored before `save`. Unknown setting sources, illegal values, unresolved profile identity, mismatched firmware, mixed craft names, failed replay checks, and blocked prerequisites prevent a deployable export. A stale UI result cannot be saved.

`test/filter_replay.test.cjs` compiles the pinned firmware's original filter, RPM and dynamic-notch C routines with hardware/configuration stubs. It compares the JavaScript implementation against twenty filter-type/rate combinations with varying RPM and dynamic LPF input. A further comparison combines both static notches, LPF2 and all 48 custom RPM banks with center offsets and fade. Interpolation is checked independently. The wrapper reproduces relevant scheduling; it does not compile the complete flight-controller firmware. Floating-point arithmetic differs: JavaScript uses doubles internally, firmware uses floats. Tolerances and measured errors are printed by the test.

`test/filter_reconstruct.test.cjs` additionally compiles the original `gyro_filter_impl.c`, decimator initializer, `gyroFilterReady()` and `taskMainPidLoop()` with hardware stubs. It generates quantized recordings from known native sensor inputs containing a 713 Hz component, reconstructs them, and compares a different LPF and a different decimator against separately generated native-C outputs. Reference outputs include every native filter tick, including ticks absent from the reconstruction's input recording. A further LPF comparison includes six adaptive notches. It checks the time-varying adjoint, Blackbox rounding, governor-RPM reconstruction and the derivative-only PID observer.

A block-boundary regression verifies that later inverse calculations cannot change committed samples, that each preview reproduces continuous replay of that trajectory, and that weak quantized P observations retain stronger regularization. Retaining only notch frequencies failed this test with 0.4774 deg/s RMS disagreement; retaining the complete state reduces disagreement to 0.000000127 deg/s. A quantized-observer regression checks the identified response against the original unrounded signal. The adaptive-notch derivative is checked against finite differences of the complete replay with nonzero initial states; its transpose is checked independently. Yaw tests cover the stop-gain inverse, rejection of a nonmonotone response, and identification from quantized P/D observations.

A separate native-C fixture discards the first 3.003 seconds of a recording with seven moving vibration lines. Calibration recovers the remaining recording's six-update phase offset in the twelve-update cycle. Changing reserved outputs does not change that estimate. An unexcited input is marked unidentified. Another regression verifies exact phase continuity across seven averaging periods, including non-divisors of the twelve-step cycle, periods with idle processing ticks, activation of dynamic notches from OFF, and a long zero-input prehistory. These tests establish recovery in the specified fixtures, not identifiability for every recording.

In this test, changing the first-order gyro LPF from 100 to 160 Hz gives the following RMS errors against the native-C reference. Both reconstruction methods receive the same 1 kHz quantized recording. These controlled tests measure counterfactual output accuracy, separately from agreement with the original configuration.

| Gyro rate | Filter rate | Adaptive notches | Raw-only interpolation error | Multichannel reconstruction error |
|---:|---:|---:|---:|---:|
| 2 kHz | 1 kHz | 0 | 3.4945 deg/s | 0.4178 deg/s |
| 4 kHz | 2 kHz | 0 | 1.8996 deg/s | 0.4069 deg/s |
| 4 kHz | 2 kHz | 6 | 2.3418 deg/s | 1.6559 deg/s |

Changing the Bessel decimator from 500 to 250 Hz gives native-filter-tick RMS errors of 0.2989 deg/s at the 2 kHz gyro rate and 0.3150 deg/s at 4 kHz. The source input is recovered once from the original recording and reused for the changed decimator. The native RPM regression also checks a gyro interrupt clock that differs from average Blackbox throughput.

The [native replay audit](../analysis/filter-autotune/audit-native-replay.cjs) also sends reconstructed Gaui inputs through the original C kernels at every native filter tick. Across 141.312 seconds in log 1 and 47.104 seconds in log 2, JavaScript-versus-C RMS differences range from 0.0173 to 0.0779 deg/s, depending on axis and log. The maximum pointwise difference is 4.993 deg/s: discrete peak decisions can amplify floating-point differences locally. The C outputs retain the same baseline-check failures as the JavaScript outputs. These results check the port on realistic input trajectories; they do not establish that the reconstructed inputs equal the unrecorded sensor samples. The two audit reports retain settings, source hashes and per-axis errors: [log 1](../analysis/filter-autotune/gaui-log0-native-replay-audit.json) and [log 2](../analysis/filter-autotune/gaui-native-replay-audit.json).

`test/filter_autotune.test.cjs` checks excluded inputs, reserved blocks, full-configuration consistency, parameter-family coverage, per-profile delay constraints, complete CLI integrity, and a regression where 300 Hz and 700 Hz vibrations cancel at 1 kHz logging but retain their full native-rate noise score. Correction regressions rank corrected measured checks ahead of larger noise reductions, retain missing measurements and removed RPM-bank targets, reject unresolved measured faults through both export paths, and verify that setup guidance does not block a synthetic flight with a strong rotor line. Existing filter, worker, UI and advice tests cover integration, browser cancellation, Chromium 99 compatibility and packaging. No test establishes flight stability or flight-controller CPU capacity for an arbitrary increased bank count.

`test/filter_optimizer.test.cjs` compares the bundled solver with an exhaustively enumerated constrained integer optimum, checks infeasible/budget/error results, and executes the synchronous asset through a browser-style CommonJS shim without Node APIs. Manifest tests verify the complete upstream archive, bridge, export shim and compiled asset hashes. These tests establish behavior on their fixtures, not convergence of a budgeted real flight search.

Run `make test-filter` for replay/search/UI/export tests and the scoped notation check. `make notation` checks declared symbol roles in this document and the development guide. It does not verify signal processing, statistical independence or mathematical correctness.

For a recorded file, use Node 20.19+ or 22.12+:

```sh
node tools/autotune/filter_tune.cjs analysis/my-filter-run /path/to/flight.bbl --flight-rpm 2000 --budget-ms 120000
```

Add `--cli /path/to/dump.txt` when available. `--logs 0,1` selects zero-based log indices. The output is `filter_tune.json` and, only for a validated recommendation, `filter-autotune.txt`. The desktop worker also supplies its richer confirmed profile identity and current-value flags.


To reproduce the desktop worker, including profile identification and stale-value annotations, use:

```sh
node tools/autotune/filter_validate.cjs analysis/my-worker-run /path/to/flight.bbl --flight-rpm 2000 --budget-ms 120000
```

The validation tool loads the actual worker and its modules in a Node VM. The separate worker regression suite checks Chromium 99 syntax and APIs. This tool does not replace browser UI tests.

For a search-only change, `--reuse-report` can reuse reconstruction caches from a previous full run. The validator requires matching replay/reconstruction source hashes, the same recording hash, and identical settings, observers, observations and flight windows. It then reruns candidate selection and continuous validation through the actual worker. A mismatch stops reuse. This is a validation-tool option; the application computes its own reconstruction.

## Fireball validation, 2026-10-14

The comparison used the installed application scripts, Node 22.17.0, no CLI dump, a 120-second proposal budget and the unchanged 0.5 ms added-delay limit. Seven selected flights were replayed: all six flight logs in the October 5 file and Log 3 in the September 29 file. This is not replay coverage of every Fireball flight. Full-file analysis of six recordings identified 67 flight logs without module failures on the preceding build. A fresh October 5 analysis on the NOMAD build again identified six flights, with no module failures.

Both searches reused exactly matched reconstructed inputs. Cache reuse checked the complete observations, settings, timing, profile masks, windows and reconstruction source hashes. Candidate replay and continuous validation ran again. These timings exclude first-time reconstruction. October 5 input SHA-256 is `d8aabafc236310994407618c61045f16df2b08c37c9661662accef3e73adf70f`. Local machine-readable evidence, complete source manifests and per-flight results are retained in `analysis/fireball-nomad-final-20261014/`; the comparator is `analysis/fireball-filter-20261014/` at commit `45a12c3`.

| Recording date | Log | Replay result | Noise objective change | Combined added delay | Reserved-period added delay | Cached runtime |
|---|---:|---|---:|---:|---:|---:|
| September 29 | 3 | Rejected: reserved-period delay | −6.594 dB | 0.416 ms | 0.611 ms | 143 s |
| October 5 | 6 | Accepted | −6.015 dB | 0.418 ms | 0.426 ms | 143 s |
| October 5 | 11 | Accepted | −7.512 dB | 0.362 ms | 0.375 ms | 142 s |
| October 5 | 12 | Accepted | −6.526 dB | 0.446 ms | 0.420 ms | 165 s |
| October 5 | 14 | Accepted | −7.923 dB | 0.389 ms | 0.391 ms | 161 s |
| October 5 | 15 | Accepted | −9.970 dB | 0.428 ms | 0.432 ms | 145 s |
| October 5 | 16 | Accepted | −11.653 dB | 0.397 ms | 0.443 ms | 155 s |

All seven unchanged baselines passed agreement checks. All six accepted candidates passed the original per-axis noise, control-band loss, delay and reserved-period requirements. The comparator accepted five October 5 flights; Log 11 was rejected solely because C11's recorded power-fraction flag was not reproduced. Reclassifying that fraction removes an unsupported obstruction. It does not count as correcting a measured physical fault. The September 29 candidate remains rejected despite its improved noise objective: the reserved-period delay exceeds the limit, and reserved observations cannot select a replacement candidate.

NOMAD contributed finalists in five October 5 searches. Nevertheless, the one-standard-error selection rule preferred a catalogue candidate in all six accepted searches. The September 29 selection came from NOMAD and failed reserved-period validation. Thus this batch does **not** establish improved end-to-end tuning quality from NOMAD over the earlier heuristic. All 20 numeric solves stopped at time or evaluation budgets. Nine coordinate audits completed, but each found an improving feasible neighbour; none certified coordinate local optimality. The algorithm is from the published implementation, but these budgeted results are not convergence certificates.

Replay acceptance did not authorize an October 5 CLI export. The existing RPM prerequisite remains blocked by governor FALLBACK findings in Logs 12 and 15, propagated through their shared configurations. Main-rotor frequency-scale checks passed; the unresolved findings concern the FALLBACK events and associated RPM/power response. The filter optimizer does not establish their cause or clear that prerequisite.

Across the replay/filter suite and 113 additional Analysis view, log-lens and recommendation-path tests, 614 tests passed with 8 environment-dependent skips. The staged-tree integration rerun passed 420 tests with 4 skips, including repeated UI tests and the STE suite (45 passed, one skipped). These rerun counts overlap the preceding coverage. The filter test target now includes the additional integration suites. CLI-name/range tests use an unmodified, hash-checked copy of the pinned official firmware settings source, so they no longer depend on an untracked local file. The scoped notation checks passed on the two filter/development documents and the separate control survey; these checks enforce declared roles, not mathematical correctness.

The NOMAD source archive rebuilt successfully with the documented Emscripten toolchain. Both the shipped and rebuilt assets reached the enumerated optimum on the constrained integer fixture. The actual NW.js 0.62.2 / Chromium 99 worker reached the same point and completed its four-neighbour audit in 1.55 seconds. This checks a numerical fixture, not every Fireball replay across both runtimes. Production `make apps` replaced and verified the installed bundle. Final desktop relaunch/visual verification remained blocked by the computer-control service reporting `Sky Computer Use native pipe startup failed`; automated renderer and worker tests are separate evidence.

## Recorded-flight validation, 2026-10-07

The full-file run below predates the configuration-specific workspace. It is retained as numerical history, with its own source hashes. The later workspace validation selects one recorded configuration and therefore has different intervals, window counts and scores.

### Configuration-specific workspace validation

These historical results precede the correction objective introduced on 2026-10-13. The earlier search selected by noise alone and accepted remaining checklist failures. They document that failure mode, not acceptance under the current rules.

The worker used in that historical run evaluated configuration B (PID profile 2) of `fireball_0929_3.bbl`, without a CLI dump. Its selected intervals are 12.058–54.534 s and 78.747–342.170 s, totaling 305.899 s of flight. The flight threshold is 2000 RPM. The 15-second proposal budget is followed by complete validation. The same worker then evaluates a manual edit and the recorded setup with its cached reconstruction.

| Candidate | Vibration change | Maximum added delay | Checklist changes |
|---|---:|---:|---|
| Autotune, 0.5 ms limit | −10.876 ± 0.212 dB | 0.401306 ms | 0 cleared, 4 remaining, 0 new |
| Manual LPF2: Bessel, 180 Hz; 2 ms limit | −6.933 ± 0.084 dB | 1.030370 ms | 2 cleared, 2 remaining, 0 new |
| Recorded values | 0 dB | 0 ms | 0 cleared, 4 remaining, 0 new |

All three pass baseline replay agreement. Autotune evaluates 340 candidate sets, 211 training windows and 58 reserved windows, executing 13,458,624 native-rate samples. The manual edit removes the F1 low-pass warnings in both intervals. F5 RPM-line coverage remains flagged. Autotune's noise reduction alone does not clear the original F1 or F5 rules, and the workspace reports that distinction. Other checklist rows include insufficient excitation, unknown PID paths and unavailable mixer/servo counterfactuals: 19 unevaluated rows for autotune and the recording, 17 for the manual edit.

These results are retained in [autotune](../analysis/filter-autotune/workspace/configuration-B-autotune.json), [manual replay](../analysis/filter-autotune/workspace/configuration-B-manual.json) and [recorded replay](../analysis/filter-autotune/workspace/configuration-B-recorded.json). The browser verification harness uses these precomputed results for UI interactions and the real worker for compiled CLI export; separate worker tests execute decoding, configuration selection and replay. The tests also cover per-configuration curves/advice, independent drafts, one configuration per PID profile, restoration of LUA-changed values and rejection of conflicting global changes.

### Earlier full-file validation

The final worker validation used a 2000 RPM flight threshold, no CLI dump, and a 120-second proposal budget per recording. It evaluated 2,140 scored windows across 11 flight logs: 2,191.360 seconds (36.52 minutes), excluding warmup. Candidate evaluation executed 193,604,976 native-rate samples. These are replay counts, not additional recorded data.

The full reconstruction run is retained in [the reconstruction report](../analysis/filter-autotune/reconstruction-phase-report.json). After adding the firmware's decimator configuration limit, the final search reused those reconstructions with source, recording, settings, observation and window checks. It reran candidate selection and continuous validation through the actual worker. Every baseline result is identical to the full reconstruction run. Source hashes remained unchanged during each reported run. The two Gaui proposal searches reached their time budget; their final validation still completed.

| Recording | Flight logs | Scored seconds | Candidate sets | Result |
|---|---:|---:|---:|---|
| `fireball_0929_3.bbl` | 1 | 345.088 | 1,012 | Recommendation and complete evaluated CLI exported |
| `fb1005.bbl` | 6 | 1,337.344 | 995 | Recommendation and complete evaluated CLI exported |
| `gaui_49_51.bbl` | 3 | 257.024 | 883 | Preview only: baseline errors and no feasible improving candidate |
| `gaui_58.bbl` | 1 | 251.904 | 897 | Baseline replay passes; improvement is below 3 dB |

The accepted `fireball_0929_3.bbl` configuration enables two dynamic notches with Q 60 and a 200–370 Hz search range. It sets static notch 1 to 233 Hz with a 211 Hz lower cutoff, and static notch 2 to 287 Hz with a 260 Hz lower cutoff. Other evaluated filter values are retained. The objective changes by −9.980 dB with a descriptive block standard error of 0.914 dB. All three reserved blocks improve, with a mean change of −8.546 dB. Maximum measured added delay is 0.430473 ms over all periods and 0.456539 ms on reserved periods. Maximum control-band gain loss is 0.083 dB over all periods. The largest baseline band-power error is 0.250 dB.

For `fb1005.bbl`, the accepted configuration enables one dynamic notch with Q 30 and a 200–370 Hz range. It enables the first-order gyro LPF1 at 400 Hz. Other evaluated values are retained. The objective changes by −6.445 ± 0.304 dB. All thirteen reserved blocks improve, with a mean change of −6.703 dB. Maximum added delay is 0.441889 ms over all periods and 0.464724 ms on reserved periods. All six logs pass baseline agreement; the largest band-power error is 0.306 dB.

Gaui 58 now passes baseline agreement on all axes at its native 2 kHz filter rate reconstructed from 1 kHz observations. Its largest band-power error is 0.600 dB and largest absolute phase-delay error is 0.234 ms. The best feasible proposal changes yaw gyro cutoff to 80 Hz, but improves the objective by only 0.122 ± 0.030 dB. This is below the 3 dB requirement, so it remains a preview with no deployable export.

The remaining baseline failures in `gaui_49_51.bbl` are listed below. Log numbers here match the UI and are one-based. All excluded-observation error checks pass. No feasible candidate produces the required improvement, so the displayed configuration is retained and no CLI is exported.

| Log | Axis | Failed comparison | Result | Limit |
|---:|---|---|---:|---:|
| 1 | Roll | Maximum band-power error | 1.004 dB | 1 dB |
| 1 | Yaw | Absolute phase-delay error | 0.305 ms | 0.3 ms |
| 2 | Pitch | Maximum band-power error | 1.012 dB | 1 dB |
| 3 | Pitch | Absolute phase-delay error | 0.511 ms | 0.3 ms |

The thresholds were not relaxed to produce an export. The native-C audits above reproduce the corresponding residuals in logs 1 and 2, separating reconstruction error from the JavaScript port's floating-point differences.

A [supplementary Fireball run](../analysis/filter-autotune/fireball-with-cli-validation.json) uses the existing `fireball_cli_dump.txt`. Its known motor-RPM cutoffs and DIRECT governor mode make twelve filter families eligible, including motor-RPM smoothing and dynamic LPF. It evaluates 1,021 configurations and selects the same design. The objective changes by −9.975 ± 0.914 dB with maximum added delay 0.433475 ms. This run also exports a complete evaluated CLI, including the known motor-RPM settings. It is an additional check on the same recording, not an independent flight validation.

The full regression run passed 316 tests, with 8 environment-dependent tests skipped. After the final configuration-limit, cache and CLI-comment changes, all 13 targeted search/cache/export tests passed. The STE suite passed 39 tests with one environment-dependent skip, and the scoped notation check passed on two documents. The browser preview was checked with the actual result renderer and plotting component; these checks do not substitute for hardware flight testing.

After numerical validation, the CLI exporter was corrected to wrap long provenance comments instead of truncating them. The October 5 export was regenerated with identical executable commands and numerical results. Its report records this separate export refresh, the exporter source hash, and the previous/current artifact hashes; numerical-run hashes remain unchanged.

Full results, source/input hashes and reproduction settings are in [the final validation report](../analysis/filter-autotune/validation-report.json). The accepted outputs are [the first Fireball CLI](../analysis/filter-autotune/fireball-worker/filter-autotune.txt) and [the October 5 Fireball CLI](../analysis/filter-autotune/fb1005-worker/filter-autotune.txt). Reproduce all four runs with:

```sh
node analysis/filter-autotune/validate-recordings.cjs /path/to/recording-root
```

The recording root must contain the `logs/` and `fb1005/` paths listed in the report. Original recordings are not copied into the repository. To repeat candidate selection with verified reconstruction caches, pass the previous validation report as a second argument. A fresh run without that argument performs reconstruction again.
