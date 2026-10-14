# Helicopter rate digital twin

`tools/autotune/system_id.cjs` identifies a reusable plant from logged mixer
commands, collective and headspeed. `helicopter_model.cjs` replays that plant
without a controller. The controller and gyro filter chain belong outside this
module. Controller changes require a separately validated firmware execution
path and an independent closed-loop test.

The model predicts three angular-rate sensor channels. It does not predict
position, attitude, acceleration, motor current or headspeed. Headspeed and
collective are measured external inputs. Consequently this model cannot tune
the governor. The output is the conditional rate response to the recorded
commands. Unmeasured gusts and structural vibration are residual disturbances,
not regenerated copies of measured noise.

The collective plant input is logged `mixer[3]` in firmware permille units.
Pilot `setpoint[3]` is retained separately as `pilotColl` for identification
instruments. This preserves the same boundary used by controller simulation,
which supplies the firmware's collective mixer output multiplied by 1000.
The artifact records `collectiveField`. A missing mixer collective permits
an explicitly labelled `setpoint[3]` identification proxy, but disables control
tuning. Mixed collective input fields cannot be pooled.

## Model and scope

Let $\omega\in\mathbb{R}^3$ be body angular rate in degrees per second and
$\phi\in\mathbb{R}^3$ its effective rotor/body rate-derivative state in degrees
per second squared. This second state represents a reduced rotor/body mode.
It is not a measured blade-flapping angle. Let $K$ be a positive diagonal
matrix of squared modal angular frequencies, $D$ a positive diagonal damping
matrix, and $G$ a skew-symmetric matrix with one fitted cyclic coupling:

$$
\dot\omega=\phi,\qquad
\dot\phi=-K\omega-D\phi+G\phi+K\rho.
$$

Here $\rho\in\mathbb{R}^3$ is the equilibrium rate drive. The off-diagonal
cyclic entries of $G$ are equal in magnitude and opposite in sign. They transfer
energy between rotor states and therefore change cross-axis phase. A full
input-gain matrix additionally represents cross-axis command response.

For each axis index $i$ in the set $\{1,2,3\}$, define $a_i\in\mathbb{R}^9$ as its
filtered input feature vector and $\beta_i\in\mathbb{R}^9$ as its fitted gain
vector. The nine features are the three mixer commands, signed collective,
absolute collective, a constant, squared collective, squared headspeed and
headspeed derivative. Collective and squared-headspeed features are centred on
training means. The squared collective and headspeed features are normalized.
Mixer features optionally have squared normalized-headspeed scaling. Features
without training variation are omitted from estimation and get zero gains.

$$
\rho_i=\beta_i^{\mathsf T}a_i.
$$

Each axis has a fitted transport delay and a first-order effective command lag.
This is part of the measured airframe input response. There is no separate
physical servo, motor, linkage, swashplate or ESC dynamics model. The legacy
parameter name `actuatorTauS` denotes this effective lag. The
implementation first advances the lag recurrence, then holds its new
value constant for the rotor/body state update. The rotor/body update uses an
exact matrix exponential of the six-state linear system. It uses fractional
sample interpolation for delays. All three outputs share the same coupled
state transition. The zero-coupling model is an explicit nested candidate.

Yaw also has a torque-balance candidate. Let $d\geq0$ be yaw damping in inverse
seconds. Its yaw equation replaces the oscillator equation with

$$
\dot\omega_3=-d\omega_3+\beta_3^{\mathsf T}a_3.
$$

For this family the gain vector produces angular acceleration, not equilibrium
rate. Zero damping is an exact rate integrator. Positive damping gives a
first-order rate response. Effective command lag and transport delay remain separate.
This family does not force yaw to have a nonzero rotor/body stiffness. The
export records the family and its gain units for each axis. The unused yaw
rotor state is numerically inactive. The augmented matrix exponential handles
constant-input forcing correctly even at zero damping.

For the unforced continuous oscillator-family subsystem, define the nonnegative
quadratic energy $E=(\phi^{\mathsf T}\phi+\omega^{\mathsf T}K\omega)/2$.
Differentiate this definition and substitute both state equations above.
The two mixed terms cancel because $K$ is symmetric. The term
$\phi^{\mathsf T}G\phi$ vanishes because $G$ is skew-symmetric. Therefore
$\dot E=-\phi^{\mathsf T}D\phi\leq0$. The stable model family is a deliberate
identification constraint. A helicopter whose unstable modes require a more
general model must fail this model's validation, rather than receive an
unsupported control recommendation.

This is a coupled rotational surrogate. It is not a complete six-degree-of-
freedom fuselage model, an eight-degree-of-freedom helicopter model, a blade-
element rotor solver or a simulator of arbitrary aerobatics. The architecture
permits replacing the plant with a higher-order model while preserving logged
input replay and independent validation. A good fitted response is evidence
only within the recorded operating envelope and tested frequency range.

## Geometry and inertia prior

The [GAUI X4 II manufacturer manual](https://nexrc.com/image/data/Brand/Gaui/X4%20II/GAUI%20X4%20II%20Instruction%20Manual.pdf)
gives 900 mm length, 320 mm height, 165 mm width and a rotor diameter of
970–1040 mm. Its 1780 g mass does not establish the user's ready-to-fly mass.
The prior assumes 2.3 kg with a broad 1.61–3.22 kg range.

The [SAB Fireball manufacturer manual](https://sabusa.com/pdf/GOBLIN_FIREBALL_280_MANUAL_RELEASE_1.0L.pdf)
gives 580 mm length, 626 mm rotor diameter, 280 mm blades and 735 g excluding
battery. The prior assumes 0.95 kg with a broad 0.665–1.33 kg range. Its 120 mm
width and 190 mm height are modelling assumptions, not manufacturer
measurements of this user's helicopter.

Let $m$ denote assumed flight mass and $L,W,H$ the assumed bounding-box length,
width and height. The prior inertia tensor $J$ is the diagonal uniform-box
estimate:

$$
J=\frac{m}{12}\operatorname{diag}(W^2+H^2,L^2+H^2,L^2+W^2).
$$

Each diagonal component has a range from 0.2 to 3 times its nominal value.
This deliberately allows substantial uncertainty in battery position, rotor
mass and the light tail boom. It is not a CAD mass model or an inertia
measurement.

The estimate affects identification. A broad assumed rotor moment scale,
0.3 times mass times gravity times rotor radius per unit command, is divided
by inertia and modal damping to set the diagonal gain prior. A factor-20 gain
spread and one equivalent sample make this a weak regularizer. Both the
moment scale and damping conversion are modelling choices. Flight data
dominates the fit. Unknown craft geometry disables this prior.

The identified command-to-rate or command-to-acceleration gain combines control torque and inertia.
Angular-rate logs without independent torque measurements do not identify
those two physical quantities separately. The exported artifact explicitly
sets `physicalInertiaIdentified: false`.

## Autonomous interval selection

`prepareSegments` requires an authoritative eligible-flight mask. The caller
must derive that mask from complete flight-phase and mode information before
cutting configurations. Rescue, level, failsafe and bench portions must not be
passed as eligible. The backend additionally excludes rescue flags, nonfinite
samples, explicitly supplied mixer bounds and control-limit masks, profile/configuration
changes, and nonmonotonic or irregular sample clocks. It never joins gaps or
separate source segments. Mixer values are firmware values divided by 1000.
A magnitude of one is not assumed to be a mechanical or firmware limit.
The source metadata records whether limits were known. Unknown physical servo
limits are not silently treated as checked limits.

Repeated flash dumps are deduplicated before the fitting budget, random split
and confidence calculation. A recorded log start time and craft name identify
the physical flight independently of capture length or concatenated log index.
Raw sample times align capture windows. Identical overlapping windows retain
one observation. Shifted overlapping windows retain the first complete window
and exclude the later window conservatively. Exact time matches with different
data prevent identification. Each exclusion records both original sources.
Different non-overlapping captures of the same flight remain in the same
random-split group. If aligned sample times are missing, only one capture is
retained for that flight. Missing recorded flight start times are explicitly
reported; parser-generated captures with unknown starts are grouped together
conservatively. Arbitrary caller-supplied flight identifiers without recorded
start times cannot prove physical-flight independence.

Each new valid run has a one-second settling exclusion. The default fitting
windows are 8–16 seconds, with at most four windows per flight. The selector
scans the entire flight before applying this budget. It greedily selects
windows with diverse pilot-setpoint excitation, using only setpoint statistics
and input eligibility. It does not prefer low prediction error or the first
minute of the flight. Every rejected
sample interval has a reason and exact source sample indices. Each window must
contain pilot excitation and measurable input/output variation. Across the
training windows, both command and pilot-input covariance must have adequate
rank. Correlated inputs cannot establish independent axis
dynamics merely by providing many samples.

The same physical craft may contribute several controller configurations when
raw gyro is present. Configuration transitions remain boundaries, and each
window retains its original configuration. Filtered gyro requires a single
configuration because the identified plant then includes its sensor filtering.
Different craft names are refused. The caller must keep physical modification
epochs separate. A craft name alone cannot detect a changed blade or servo.

Actual measured sample rates are preserved. Clock differences up to one percent
between logs use the corresponding continuous-model discretization. Larger
rate differences require separate identification. Controller-rate replay uses
`atRate`; it does not add identified bandwidth above the logging bandwidth.

## Estimation, model choice and final test

The algorithm first searches bounded modal frequencies, damping, effective command lags
and delays, including the separate tail torque-rate family. For each candidate
it simulates unit-input response bases from the actual commands. Its
coefficient fit uses two-stage instrumental-variable moments. The instruments
are pilot setpoints at zero, 80 ms and 240 ms delay, plus available collective
and RPM load features. This retains a command-to-gyro plant. It does not fit
setpoint-to-gyro as a substitute for the plant. The regression uses simulated
command-response bases, not measured gyro derivatives or previous measured
gyro states. Rates are never injected into later predicted states.

The centered fraction of each command-response basis explained by the
instruments must exceed five percent. Direct command gains must be positive
under the logged body-axis convention. These are explicit identification
gates. Pilot inputs are not guaranteed exogenous: a pilot may react to
disturbances. Thus this instrumental-variable construction reduces one source
of feedback bias without proving that its independence assumption holds.

The search ranks eligible candidates by free-running training error and retains
a shortlist for each physical family. It chooses axis dynamics on
selection flights, then fits and selects coupled cyclic-state candidates using
the same training/selection separation. The final test flights are opened for
scoring only after the model and plausible-model ensemble are fixed. With at
least three flights the partition is a seeded random assignment of complete
flights. Approximately 20 percent are final-test flights and 20 percent are
selection flights, with at least one flight in each set. The remainder fits
parameters. The artifact stores the seed, complete assignment, requested
fraction and actual flight/sample fractions. The worker seeds this assignment
from the source file hash unless another seed is supplied.

With fewer than three flights, random non-overlapping intervals can produce a
diagnostic model. One-second exclusions on both sides of every interval give
at least a two-second temporal gap between neighbouring retained intervals.
These intervals can still be statistically dependent. They receive lower
confidence and cannot enable control tuning. Individual frames are never
randomly mixed between fitting and validation.

A one-second rollout warmup follows the single initial measured-rate state.
Initial rotor states are zero. Each complete interval then runs freely. The
initial-state assumption and excluded warmup are recorded in the result.
The current fit does not estimate a disturbance innovation process. Weak or
endogenous pilot instruments and RPM-dependent disturbances can still bias
estimates. Reserved flights, residual tests and different controller
configurations reduce the risk; they do not prove causal identification.

The estimation and scoring filter both measured outputs and predicted bases with
the same causal fourth-order Butterworth 20 Hz analysis filter. Its two
biquad sections suppress rotor vibration before fitting-sample decimation.
The initial homogeneous response receives the same filter. This filter is external to the exported
plant and is never applied twice in controller simulation. Evaluation reports
both full-band raw error (`axes`) and control-band error (`controlledAxes`).
The latter contributes to rate-response eligibility. This filter
does not eliminate all vibration above its cutoff, and its cutoff does not prove
identification throughout 0–20 Hz. Full-band error is retained even when structural
vibration lies outside the controllable response. No stochastic noise
realization is presented as a prediction of the actual logged vibration.

An independent spectral check divides reserved flights into non-overlapping
four-second Hann windows. At fixed frequencies it measures pilot-to-command
and pilot-to-gyro coherence, pilot excitation power, approximate relative
uncertainty and agreement between measured and predicted pilot cross-spectra.
Only individually passing frequencies enter `validatedFrequenciesHz`.
`validatedBandHz` stores their minimum and maximum when at least two common
frequencies pass. It does not certify gaps between these points. Rejected
models have no validated band. Control eligibility additionally requires two
frequencies supported on all axes. These spectral checks are diagnostic
evidence under the stated instrument assumptions, not guaranteed causal
frequency-response confidence bounds.

Final checks apply per axis: normalized RMS error, bias, residual correlation
with every control input, and residual correlation at a 100 ms lag. Correlation
gates are inactive below 0.5 degrees per second RMS, where blackbox integer
quantization dominates interpretation. Thresholds are engineering acceptance
rules in `RULES`; they are not flight-safety guarantees.

The confidence result reports measured held-out error per axis and a 95-percent
bootstrap interval. With at least three held-out flights, entire flights are
the resampling units. Otherwise contiguous held-out intervals are the units,
and the result states their possible dependence. Fewer than two units cannot
give an error interval. The normalized interval divides by the observed
held-out output standard deviation; uncertainty in that denominator is not
included. These are empirical error intervals conditional on the selected
flight portions, not a probability that the model is correct.

High confidence requires at least three test flights, at least six retained
test intervals, error intervals within the declared limits and frequency
coverage on every axis. Moderate confidence requires whole-flight separation,
at least three error resampling units and error intervals within the limits.
Failed model checks yield low confidence when errors were measured. Missing
model output yields unavailable confidence. The reasons and sample counts
remain explicit rather than being replaced with an arbitrary numeric score.

The ensemble contains three selection-ranked parameter models. Its range is
model-choice sensitivity, not a statistical confidence interval. It does not
cover unmodelled instability, unseen mechanical changes or arbitrary operating
conditions. A robust tuning search must check every ensemble member, preserve
the observed input envelope, and forbid relying on response above the
validated band.

## Reusable artifact and APIs

The model stores craft identity, geometry assumptions, model parameters,
parameter ranges, input/output units, native sample rate, source flights,
configuration/sample ranges, operating envelope and final validation. Optional
prediction records include the actual mixer, headspeed and collective inputs,
measured outputs and complete predicted traces. The parent twin artifact also
contains firmware provenance and its parity evidence.

- `prepareSegments(input)` returns normalized windows and an exclusion audit.
- `splitSegments(windows)` returns training, selection and final-test windows.
- `fit(input)` returns the model, ensemble, independent scores and eligibility.
- `evaluate(model, windows)` replays new logs without fitting parameters.
- `createState`, `step` and `rollout` run the plant with no Node dependency.
- `serialize` and `deserialize` validate reusable model parameters.
- `atRate` changes numerical integration rate while retaining identified rate.

Raw gyro is necessary for control eligibility. A `gyroADC` fallback is labelled
an identification-only sensor-output proxy. It cannot be placed before the
firmware gyro filters because that would count those filters twice.

Development uses Fireball logs. GAUI X4 logs are reserved for an external test
of the frozen identification procedure. A Fireball parameter artifact is not
a GAUI model. Successful external validation requires fitting a separate GAUI
artifact using the frozen algorithm and its predeclared data split.

## Verification coverage

`test/system_id.test.cjs` checks synthetic parameter recovery, cross-axis
response, independent partitions, absence of measured-output feedback, interval
exclusions, rank deficiency, corrupt artifacts and filtered-output restrictions.
Regression checks also cover repeated and partial captures, confidence sample
counts, conflicting copies, missing clocks, and the mixer collective boundary.
These tests establish implementation behaviour, not real-airframe accuracy.
Real-flight reports must retain failed checks rather than turn a failed twin
into a proposed gain change.

`HELICOPTER_SYSID_NOTATION.json` registers all mathematical quantities and
indices in this document. The notation checker checks declared symbol roles
and component notation. It does not verify the model's physical adequacy or
prove the identification assumptions.
