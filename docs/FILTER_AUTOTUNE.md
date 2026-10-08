# Filter autotune

The **Autotune** button in **Tuning → Filters** searches filter configurations by replaying recorded gyro samples through the Rotorflight compute path. Every candidate score comes from time-domain replay. Spectra describe replay outputs and suggest notch frequencies; an analytical frequency response never substitutes for a candidate replay.

The result includes the complete evaluated configuration, per-axis noise changes, baseline agreement, reserved-period validation, signal previews, the original filter checklist before and after replay, and a **Save filter CLI file** button. Export requires a validated candidate. Preview remains available when validation fails and is labeled accordingly. No command is sent to a flight controller.

Signal previews contain one scored window per log segment and PID profile, up to 18 windows. Recorded observations retain their logging rate; the original and candidate replay traces use the native filter rate. The final comparison runs continuously from the start of each selected configuration interval, retaining state throughout that interval. The UI displays selected portions of that trajectory and reports reconstruction error on observations excluded from the inverse calculation.

## Configuration-specific tuning workspace

The workflow is **Overview → Filters → Governor → Cyclic gains → Tail gains → Cyclic compensation → Tail compensation → Export**. The recorded-configuration selector sits below the flight list and above those tabs. Its recorded values, sources and configuration comparison are reference material for every step. Selecting a configuration selects its PID profile, exact flight intervals, curves and recommendations. Different LUA variants of one PID profile keep independent drafts.

The Filters block in Overview contains the explanation and Autotune action directly. The full Filters workspace provides:

- Before/after cards, a table of changed filter values, and a spectrum with three independently selectable curves: **Raw data**, **Previous filter (recorded)** and **New filter (calculated)**. All three start visible. The same selection applies to the collapsible gyro time plot and persists across axis, flight-window and result changes. Native-rate candidate traces retain samples absent from the original recording. Missing curves are unavailable.
- **Change filter values**, initially collapsed, contains the complete evaluated setup and editable candidate. This includes low-pass types, static and dynamic notches, features, custom RPM-bank arrays, decimation and known per-profile gyro/D cutoffs. Values in other signal paths appear as recorded references. Unknown values are explicit rather than substituted from another PID profile. **Maximum added time delay** defaults to 0.5 ms and accepts 0 to 20 ms. It bounds the measured increase over the recorded filter path in the coherent control bands, not the total helicopter response delay.
- **Simulate changed values**, **Use autotune values**, and **Use recorded values** operate on that candidate. The retained worker reuses the same decoded data and reconstructed native input for subsequent candidates. Any changed value makes the pending filter recommendation unavailable until replay completes. Curve selection updates plots without rerunning analysis or replacing edited inputs.
- The collapsible filter checklist evaluates the original checks before and after, using the same judges, thresholds, sample masks and scored intervals. Each row identifies the check, log, profile, axis and time range. The summary distinguishes cleared, remaining, new and unevaluated issues. Raw-vibration checks retain the same input. A mixer/servo result or an unknown PID path remains unevaluated when the replay lacks the necessary output.
- Old-filter replay appears only in **Replay checks and filter coverage**, where recorded and calculated outputs check model agreement. P+D time and spectrum previews are omitted because they show only the gyro contribution, not the full PID output or helicopter response. Autotune retains the P+D energy objective and per-path delay constraints where PID values are known.

Manual candidates must pass baseline agreement and the chosen delay, gain-loss and per-axis noise constraints. They need not satisfy the autotuner's 3 dB minimum improvement or candidate-selection holdout test. This distinction permits inspection and export of a validated manual tradeoff without labeling it an autotune improvement.

Each step updates one pending parameter record. Export selects at most one recorded configuration for each helicopter PID profile and combines its selected changes across steps. Selecting an older LUA configuration restores its known profile values before applying its tuning changes. Whole-array and enum restorations follow the pinned firmware schema. An unknown required restoration prevents export. Global settings apply to all profiles; incompatible global candidates are shown as conflicts and cannot be compiled. The final page shows the resulting parameter diff and complete CLI commands.

## Method selection and literature

The implementation uses deterministic constrained direct search with successive-halving resource allocation: evaluate many configurations on a small set of flight windows, promote candidates to more windows, and evaluate finalists on all training windows. The resources are recorded samples, with the filter rate and algorithm unchanged at every stage.

This choice follows the sample-allocation principle in [Hyperband, Li et al., JMLR 2018](https://arxiv.org/abs/1603.06560). It is an adaptation of successive halving, not an implementation of every Hyperband bracket or its random proposal distribution. [BOHB, Falkner et al., ICML 2018](https://arxiv.org/abs/1807.01774) combines this approach with Bayesian proposals; [FlexHB, Zhang et al., 2024](https://arxiv.org/abs/2402.13641) develops more flexible allocation and surrogate modeling. A surrogate was not selected here: filter topology is discrete, available RPM sources constrain proposals, and short direct replays are cheap. The current implementation claims no global optimum or benchmark superiority over these methods.

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

One in five gyro-output observations and the corresponding D observations are excluded from the inverse calculation. The UI reports error on those samples, compared with interpolation from raw gyro alone. These checks are conditional on the recorded settings and observer calibration; they are distinct from the reserved flight blocks used to test a chosen configuration.

A cyclic PID observer can be identified from recorded P/D terms when its profile configuration is absent: its fit must explain at least 99.5% of P energy and 99% of D energy, with RMS residual below 0.001 and at least 3,000 samples. A derivative-only observer can also use yaw D, or a cyclic D signal when P identification fails. It must meet the same D fit requirements. Its two filter poles need not be separately identifiable, so it supplies only the combined D response, with no P constraint. Observer estimates provide reconstruction constraints; they do not become exportable PID settings. Calibration uses the original configuration's recorded signals, including the outputs subsequently omitted from the sample fit.

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

A configured gear ratio is a physical input, not a free noise-minimization parameter. When it is absent, the existing notch-identification estimator can supply a measured RPM-source mapping only after its own checks pass. Unresolved active sources prevent export. Source proposals that cannot be driven from recorded RPM data are excluded explicitly.

Every candidate represents one complete target configuration applied to all selected logs, while their loop rates, gains and physical gear ratios remain specific to each log. The newest available settings form the target baseline. Every known profile's target cutoffs are also fixed across logs. This prevents scoring per-log configurations and exporting a different configuration.

## Objective and constraints

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
- Training improvement must be at least 3 dB. The combined reduction must exceed two block standard errors. At least three flight blocks and five held-out windows are required.

Every fourth block is reserved before candidate selection. For a three-block input, the last block is reserved. Candidate generation uses native-rate training spectra only. Up to 360 proposals per round are interleaved across families; eight stratified windows screen candidates, 24 windows test promoted candidates, and up to twelve distinct finalists use all training windows. Three rounds allow interacting changes. Finalists preserve the best simpler design from earlier rounds so that an overly aggressive refinement cannot eliminate every feasible fallback. Proposal order is deterministic; a wall-clock budget can change how many proposals are evaluated. The default proposal-stage budget is 120 seconds; final validation still runs after this budget. Browser cancellation terminates the dedicated worker.

The best feasible training candidate is then frozen. Reserved data can accept or reject it, but cannot select another candidate. Its noise must decrease in at least 80% of reserved blocks and in their mean, with the same delay/gain/axis constraints. Blocks from one flight remain correlated; their standard error is a descriptive uncertainty measure, not a calibrated confidence interval or proof of generalization to new flights.

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

`test/filter_autotune.test.cjs` checks excluded inputs, reserved blocks, full-configuration consistency, parameter-family coverage, per-profile delay constraints, complete CLI integrity, and a regression where 300 Hz and 700 Hz vibrations cancel at 1 kHz logging but retain their full native-rate noise score. Existing filter, worker, UI and advice tests cover integration, browser cancellation, Chromium 99 compatibility and packaging. No test establishes flight stability or flight-controller CPU capacity for an arbitrary increased bank count.

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

## Recorded-flight validation, 2026-10-07

The full-file run below predates the configuration-specific workspace. It is retained as numerical history, with its own source hashes. The later workspace validation selects one recorded configuration and therefore has different intervals, window counts and scores.

### Configuration-specific workspace validation

The current worker was run on configuration B (PID profile 2) of `fireball_0929_3.bbl`, without a CLI dump. Its selected intervals are 12.058–54.534 s and 78.747–342.170 s, totaling 305.899 s of flight. The flight threshold is 2000 RPM. The 15-second proposal budget is followed by complete validation. The same worker then evaluates a manual edit and the recorded setup with its cached reconstruction.

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
