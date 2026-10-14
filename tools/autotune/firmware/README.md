# Rotorflight controller execution

This directory contains a portable build of the actual Rotorflight 4.6.0 PID,
mixer, governor and servo C sources, pinned to commit
`118e9120260bb33f46df4f92052fb0e9fd4e9ebc`.
The original files retain their GPL notices. `manifest.json` records every
upstream file hash. The repository root license also applies to the adapter.

`controller.wasm` has no host imports. The worker verifies its SHA-256 before
instantiation. `controller.json` records its compiler, source hashes, adapted
translation-unit hash and exports. `build.cjs` verifies original file hashes,
removes platform includes, provides explicit hardware inputs, and compiles the
original algorithm bodies. The float contract uses single precision with fused
operations and fast-math disabled. It does not claim bit identity to every MCU
compiler or physical sensor implementation.

Build with a WASI SDK, then run the native/WASM comparison:

```sh
WASI_CC=/path/to/wasi-sdk/bin/clang node tools/autotune/firmware/build.cjs
node --test test/firmware_controller.test.cjs
```

If the artifact changes, update `ARTIFACT` in `firmware_controller.cjs` to the
new recorded hash and inspect the source differences. The checked-in artifact
allows desktop and worker execution without a compiler on the pilot's computer.
`bridge.c` field assignments follow `schema.cjs` order. A regression checks that
each assignment retains that order.

The default boundary is filtered gyro and rate setpoint to stabilized mixer
inputs. `firmware_controller.create` returns synchronous `step`, `seed`, and
`reset` methods after loading the artifact. PID modes 0, 3 and 4 execute the
original source. Internal PID filters, HSI, I-term relaxation, decay, yaw stop
gains, cyclic cross coupling, precompensation and mixer saturation execute in
the same state and order as the firmware. No PID sum clamp is added.

Each tick requires rate setpoint and filtered gyro in degrees per second,
normalized collective and throttle, headspeed in RPM, spool-up ratio and the
airborne and spooled-up states. Output PID terms and mixer channels are
normalized, so logged terms and mixer fields require division by 1000.
The simulator retains preceding mixer state. A controller-only replay may
explicitly provide preceding recorded mixer channels and saturation instead.
That replay mode is not a plant prediction.

The native PID uses the configured nominal loop time. The physical plant uses
measured sample timestamps. Their frequencies may differ by at most one percent
for clock drift, provided every PID update is logged. Configured decimation
still fails the control-pipeline rate check. The measured rate never replaces
the nominal time step inside the original C controller.

Set `config.executeGovernor` to execute the original governor inside the mixer
update. This additionally requires raw mechanical motor RPM, battery voltage in
volts, throttle command, throttle-off state, armed state and four RC deflections.
Governor mode switches and the timestamp can also be supplied. Gear ratios,
battery source and cell count are explicit configuration values. The ratios are
treated as correct configuration inputs. An exogenous headspeed trace cannot
validate a throttle-to-RPM plant or qualify governor tuning.

Supply `config.servos = {count, parameters, sources, unknown, verified}` to run
original servo output processing. Each parameter row is `[mid,min,max,rneg,rpos,
rate,speed,flags]`, matching the firmware CLI. `step` returns `servoPwm` in the
integer microseconds stored in the flight log. Original geometry correction,
shared cyclic speed limiting, reverse flags, positive and negative scaling,
travel limits, center and saturation feedback execute directly. PWM timer
initialization and physical servo motor dynamics remain external. `rate` sets
the physical timer update frequency and does not change the logged PWM value.

`mapMixer({u,collective,throttle})` starts at the measured stabilized mixer
boundary. It executes the original swash mapping and servo code without rerunning
PID or applying input limits twice. This is useful to verify the physical command
mapping against the same log's servo fields. It keeps speed-limiter state between
calls and resets that state with `reset`. Normalized mixer output remains available
as `servo`; `servoPwm` is null when the servo path is disabled. A complete optional
CLI hypothesis is executable for diagnostics but remains unverified until its
mapping has independent recorded-data checks. Compatibility rejects an enabled
servo path with unverified settings.

The RC rate generator, rescue and level controllers, receiver transport and
physical actuators are outside this runtime. The gyro sensor chain uses the
separate native module described below. Custom mixer
rules and motorized-tail tuning are not qualified. A rescue or level sample is
rejected. A caller must validate its external paths and the model before exporting
a candidate.

`fromHeader` records values and sources. The parser's `loggedHeaderFields`
journal identifies the translated header names actually read from the log,
including after cloning or configuration materialization. A copied parser
default cannot become a recorded value through that path. Plain headers
supplied directly by an API caller retain their explicit-field contract.
Missing settings remain unknown; diagnostic
execution supplies release defaults but retains failed compatibility status.
Inactive controller paths and servo-only settings do not block a model whose
plant input is the stabilized mixer. A firmware version string alone does not
confirm the source revision. The exact release hash is required.

`calibrate` searches finite candidate grids for missing PID mode and I-term
relax levels by replaying the native controller against each logged PID term.
Training chooses parameter candidates, a separate contiguous interval selects
the mode and tests separation from alternatives, and the final interval tests
the frozen result. Four selection blocks give a conditional score-difference
standard error. Each reserved term must agree within the larger of 0.0015
normalized units and 5 percent of its training RMS. These thresholds are
engineering acceptance rules, not sensor specifications. Equivalent candidates
remain unknown. Identified values retain their estimated source, and all other
unknown settings continue to block eligibility. Logged initial I/O terms seed
integrator state where possible; filter-state transients require warmup.

The regression suite compares native compiled C and WASM on coupled, saturated
trajectories for modes 3 and 4 and the electric governor. It also checks gain
scaling, stop asymmetry, anti-windup, mode-4 coupling, governor state changes,
disarm, missing configuration and corrupt artifacts. These checks verify the
software execution boundary. They do not establish flight-model accuracy.

## Gyro sensor execution

`sensor.wasm` directly executes the same pinned revision's `gyro_filter_impl.c`,
RPM notch filter, dynamic-notch SDFT and common filter bodies. `sensor.json`
records its source hashes, adapted translation unit and compiler. The module has
no host imports. `firmware_sensor.create(config)` verifies its SHA-256 and returns
a synchronous `tick(raw,headspeed,tailSpeed)` method. Build it with
`WASI_CC=/path/to/wasi-sdk/bin/clang node tools/autotune/firmware/build_sensor.cjs`.

The input boundary is decimated raw gyro, which is the firmware's `gyroADCd`
and the logged `gyroRAW` channel. Physical acquisition, driver filtering and the
earlier decimator are external. The module requires equal filter and PID rates,
known active settings, complete custom RPM banks and the required RPM inputs.
Governor-dependent dynamic LPF execution remains unsupported. Original header
fields supply recorded global settings; optional CLI settings remain explicit
configuration hypotheses. Baseline sensor replay must pass independently.

The Fireball scheduler records decimated raw gyro half a millisecond after the
filtered gyro used by PID. Offline sensor replay reconstructs that phase with
recorded-band windowed sinc and marks its use of future recorded samples. This
does not recover the unobserved high-frequency gyro sample. Autonomous simulation
instead advances the physical model at the gyro rate, evaluates the native sensor
and PID at their scheduler phase, and advances to the logger phase. It uses no
measured gyro after initialization. Tests cover all ten filter types, changing
RPM and dynamic notches, the phase offset, missing configuration and independence
from later measured outputs.

Closed-loop baseline checks compare generated mixer outputs as well as gyro.
They use the same analysis filter and warmup; all four stabilized mixer channels
must meet the existing 30 percent relative RMS or 0.008 normalized absolute RMS
rule. An enabled servo path additionally compares recorded PWM excursions from
configured center, using 30 percent relative RMS or the one-microsecond logged
resolution floor. It retains trim error and rejects missing recorded servo
channels. Both the central model and reserved-flight model variants must pass
these actuator checks. A regression doubles physical plant gain and demonstrates
that gyro agreement alone can pass while generated mixer agreement fails.
