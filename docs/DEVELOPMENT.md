# Rotorflight Blackbox: Development Guide

How to build, run, test and extend this codebase, with a focus on the parts that matter for
adding **automatic controller tuning**.

Everything marked *verified* was executed on 2026-09-26 (macOS arm64, Node v22.17.0) against
commit `5009e5e`. Anything not executed is marked as such.

## Contents

1. [Quick start](#1-quick-start)
2. [Build system](#2-build-system)
3. [Tests and CI](#3-tests-and-ci)
4. [Architecture](#4-architecture)
5. [Data model](#5-data-model)
6. [Existing analysis code](#6-existing-analysis-code)
7. [Adding a feature](#7-adding-a-feature)
8. [Headless development](#8-headless-development)
9. [Automatic tuning: what the logs give you](#9-automatic-tuning-what-the-logs-give-you)
10. [Automatic tuning: status and next steps](#10-automatic-tuning-status-and-next-steps)
11. [Known issues](#11-known-issues)
12. [Tuning analysis toolkit](#12-tuning-analysis-toolkit)
13. [The Tuning dialog](#13-the-tuning-dialog)

---

## 1. Quick start

```sh
nvm install            # Node 24 per .nvmrc; anything in ^20.19.0 || >=22.12.0 works
make init              # yarn install --frozen-lockfile (Yarn 1.22.22 via npx, no global Yarn needed)

make dev-server        # terminal 1: Vite on http://localhost:8080, full reload on save
make dev-client        # terminal 2: NW.js desktop shell pointed at the dev server

node --test test/save_file.test.cjs test/video_export.test.cjs
```

The app only works inside NW.js. `index.js` calls `require('nw.gui')` on load, so opening
`http://localhost:8080` in a normal browser fails. `dev-client` downloads the NW.js SDK into
`cache/` on first launch, and the launched window has Chromium DevTools available (SDK flavor).

Verified: `make dev-server` serves the app (HTTP 200 for `index.html`, JS, CSS and
`node_modules` assets); the test command passes 7/7. Not exercised in this pass:
`make dev-client`, `make debug`, `make apps`, `make release` (the GUI was not launched; `apps/`
and `debug/` already held osx64 builds from an earlier run, and dependencies were already
installed).

## 2. Build system

Two toolchains sit behind one Makefile. **Vite is development only; Gulp packages everything
that ships.**

| Command | Runs | Output |
|---|---|---|
| `make init` | `yarn install --frozen-lockfile` | `node_modules/` |
| `make dev-server` (`make web`) | `vite` | none, serves the working tree |
| `make dev-client` | `gulp dev-client` | `dev-client/` (generated manifest) |
| `make debug` | `gulp debug` | `debug/` SDK build, then launches it |
| `make apps` | `gulp apps` | `apps/` production build |
| `make release` | `gulp release` | `release/` installers (dmg, zip, deb, rpm, exe) |
| `make version SEMVER=x.y.z` | `sed` on `package.json` | version bump |
| `make clean` / `realclean` / `distclean` | `rm -fr` | progressively removes build output, `dist/`, then `cache/` and `node_modules/` |

Details worth knowing:

- **NW.js 0.62.2** is pinned in `gulpfile.js:31`. It is an x86_64 binary, so on Apple Silicon
  it runs under Rosetta.
- **Platform flags**: `yarn gulp <task> --osx64 | --linux64 | --win64` (also `--linux32`,
  `--win32`, unsupported). Default is the host platform. Cross-building Windows from
  macOS/Linux needs Wine.
- **`gulp dist` copies an explicit file list** (`gulpfile.js:294-375`) into `dist/`, then runs
  a production `yarn install` there. A file missing from that list works in dev and is absent
  from every packaged build. See [section 7](#7-adding-a-feature).
- **Vite does no bundling.** `vite.config.mjs` only serves files and forces a full page reload
  when a `.js` or `.json` file changes. There is no transpile step anywhere, so write code
  that Chromium 99 (bundled with NW.js 0.62.2) runs directly.
- `dev-client` writes a copy of `package.json` with `main` and `node-remote` set to the dev
  server URL, which is what gives the remotely served page access to Node and NW.js APIs.
- ffmpeg codec libraries in `library/` are copied into packaged apps by `post_build`.
- All build output directories are gitignored.

## 3. Tests and CI

| What | Where | How it runs |
|---|---|---|
| Save dialog and video export | `test/save_file.test.cjs`, `test/video_export.test.cjs` | `node --test ...` |
| Tuning analysis, against simulated flights with a known airframe | `test/autotune.test.cjs` | `node --test test/autotune.test.cjs` (about 30 s) |
| Expo curve | `test/index.html` + `test/index.js` | Legacy: open in a browser, reports through `alert()` |

The `.cjs` tests show the pattern to copy: load a production script into a `node:vm` context
with stubbed browser globals, then assert with `node:assert/strict`. No test framework is
installed and none is needed.

**CI does not run tests or lint.** All five workflows in `.github/workflows/` only build
release artifacts for Linux, macOS, win64 and win32 (`pr.yml` and `push.yml` on `master` and
`RF-*`; `release.yml`, `snapshot.yml`, `testing.yml` on tags). `.jshintrc` exists but jshint
is neither a dependency nor invoked. Run tests locally before pushing.

## 4. Architecture

There is no module system. Every file is a classic script listed in `index.html:3520-3581`,
and they communicate through globals. **Load order is the dependency graph.**

Conventions in use: `"use strict"`, 4-space indent, constructor functions
(`function FlightLog(logData) { ... this.method = ... }`) or singleton objects
(`var StepResponseCalc = StepResponseCalc || { ... }`), jQuery 1.11 for DOM, Bootstrap 3 for
modals. Newer files mix in `const`, `let` and arrow functions.

### Layers

| Layer | Files | Lines | Role |
|---|---|---|---|
| Byte decoding | `datastream.js`, `decoders.js`, `tools.js` | 171, 281, 471 | Byte stream, variable-byte decoders, helpers (`binarySearchOrPrevious`, `constrain`, `firmwareGreaterOrEqual`, `parseCommaSeparatedString`) |
| Log parsing | `flightlog_parser.js` | 1886 | Header to `sysConfig`, frame decoding with predictors, events |
| Indexing | `flightlog_index.js` | 291 | Finds logs in a file, builds the I-frame directory and activity summary |
| Log facade | `flightlog.js` | 1147 | **The API everything else uses.** Chunk cache, merged frames, computed fields, smoothing |
| Definitions | `flightlog_fielddefs.js`, `flightlog_fields_presenter.js` | 1076, 1375 | Enums per firmware version; friendly names and unit conversion for display |
| Math | `complex.js`, `real.js` | 292, 300 | FFT (`FFT.complex`), arbitrary length |
| Analysis | `graph_spectrum_calc.js`, `graph_stepresponse_calc.js`, `flight_analysis.js` | 401, 342, 969 | Pure computation. See [section 6](#6-existing-analysis-code) |
| Analysis UI | `graph_spectrum*.js`, `graph_stepresponse*.js`, `flight_analysis_dialog.js` | | Canvas plots and the Flight Analysis modal |
| Graphing | `grapher.js`, `graph_config.js`, `graph_legend.js`, `seekbar.js`, `sticks.js`, `craft_3d.js` | | Main time-series canvas and overlays |
| Dialogs | `header_dialog.js`, `user_settings_dialog.js`, `graph_config_dialog.js`, `video_export_dialog.js`, `keys_dialog.js` | | Bootstrap modals |
| App shell | `main.js`, `index.js`, `gui.js` | 2414, 72, 172 | Wiring, file loading, toolbar, keyboard, NW.js integration |
| Persistence | `pref_storage.js`, `default_workspaces.js`, `workspace_selection.js` | | `chrome.storage.local` or `localStorage` |
| Export | `csv-exporter.js`, `webworkers/csv-export-worker.js`, `save_file.js`, `screenshot.js`, `flightlog_video_renderer.js` | | CSV, PNG, WebM |

`index.html` is 3581 lines because it holds the markup for every dialog.

### Load path for a log file

```
drop/open file
  -> main.js loadFiles()            picks log / video / workspace by extension
  -> main.js loadLogFile()          FileReader -> Uint8Array
  -> new FlightLog(bytes)           builds FlightLogIndex + FlightLogParser
  -> selectLog(null)                flightLog.openLog(i) on the first parseable log
  -> new FlightLogGrapher(...)      creates FlightLogAnalyser + FlightLogStepResponse
```

One file can hold several logs (one per arm cycle), **each with its own header**. The sample
log used for this guide holds two flights whose yaw gains differ (`85,120,10` then
`90,100,0`).

## 5. Data model

### FlightLog API

| Call | Returns |
|---|---|
| `getLogCount()`, `openLog(i)`, `getLogError(i)` | Log selection within the file |
| `getSysConfig()` | Parsed header: gains, filters, rates, loop timing |
| `getMainFieldNames()`, `getMainFieldIndexByName(name)` | Column names and indexes; index is `undefined` when a field is not logged |
| `getMinTime()`, `getMaxTime()` | Microseconds |
| `getChunksInTimeRange(t0, t1)` | Array of chunks, raw values |
| `getSmoothedChunksInTimeRange(t0, t1)` | Same, with display smoothing applied. **Do not use for analysis** |
| `getActivitySummary()` | Coarse per-chunk `times`, `avgThrottle`, `collective`, `hasEvent`, `pidProfile`, available without decoding frames |
| `getStats()` | Per-field min and max |

A **chunk** is `{ index, frames, events, gapStartsHere }`. `frames` is an array of plain
arrays, one per logged sample, indexed by field index. Column 0 is `loopIteration`, column 1
is `time` in microseconds. A chunk starts at every 4th I-frame (`flightlog_index.js:124`),
which is 32 frames in the sample log. `gapStartsHere[frameIndex]` marks a discontinuity after
that frame (dropped data or logging resumed); analysis that assumes uniform sampling must
split at gaps.

Reading a column:

```js
var idx = flightLog.getMainFieldIndexByName('gyroADC[0]');
var chunks = flightLog.getChunksInTimeRange(flightLog.getMinTime(), flightLog.getMaxTime());
for (var c = 0; c < chunks.length; c++)
    for (var f = 0; f < chunks[c].frames.length; f++)
        use(chunks[c].frames[f][idx]);
```

`readColumns()` in `flight_analysis.js:92` already does this for a list of fields and drops
columns that are all zero. It is private to the `FlightAnalysis` closure; see the note on
exports in [section 6](#6-existing-analysis-code).

### Fields

Order: main I-frame fields, then slow-frame fields (`flightModeFlags`, `stateFlags`,
`failsafePhase`, ...), then fields computed by the viewer in `flightlog.js:512`.

| Field | Unit and scaling | Source |
|---|---|---|
| `time` | µs | log |
| `setpoint[0..2]` | deg/s | log, firmware `getSetpoint(i)` |
| `setpoint[3]` | collective, raw | log |
| `gyroADC[0..2]` | deg/s, **after** firmware filtering | log, `gyro.gyroADCf` |
| `gyroRAW[0..2]` | deg/s, downsampled, not the filtered signal | log, `gyro.gyroADCd` |
| `axisP/I/D/F/B/O[0..2]` | PID term × 1000 (1000 = 100 % authority) | log |
| `mixer[0..3]` | stabilised roll, pitch, yaw, collective × 1000 | log |
| `rcCommand[0..4]` | roll, pitch, yaw, collective, throttle | log |
| `headspeed`, `tailspeed`, `govTarget`, `govRequest` | rpm | log |
| `Vbat`, `EscV` | 0.01 V | log |
| `Ibat`, `EscI` | 0.01 A | log |
| `EscThr`, `motor[0]` | 0.1 % | log |
| `axisSum[0..2]` | P+I+D+F+B+O, clamped to `pidSumLimit` if the header has one | computed |
| `axisPD[0..2]` | P+D | computed |
| `axisError[0..2]` | `setpoint - gyroADC`, deg/s | computed |

Which fields exist depends on the pilot's blackbox configuration (`fields_mask`, decoded by
`FlightLog.prototype.isFieldEnabled`). Always handle a missing field.

### sysConfig

`sysConfig` is created with `Object.create(defaults)` (`flightlog_parser.js:511`), so
**own properties are exactly what the log header contained** and defaults are inherited.
`JSON.stringify(sysConfig)` therefore shows only parsed values. Header names are normalised
through `translationValues` (`flightlog_parser.js:412`). Headers the parser does not know
land in `sysConfig.unknownHeaders` as `{name, value}`; in the Rotorflight 4.6.0 sample that
was only `gyro_decimation_hz`.

### Sample rate

```
rate = (1e6 / looptime) * frameIntervalPNum / frameIntervalPDenom / pid_process_denom
```

Both calc modules compute this in `initialize()`. Verified on the sample log: header
`looptime:250`, `P interval:8`, `pid_process_denom:2` gives 250 Hz, and timestamps measure
250.04 Hz with a constant 4000 µs step.

Logging rate bounds what tuning can see. At 250 Hz the Nyquist limit is 125 Hz and step
response resolution is 4 ms, which is coarse for D-term and filter work. Check the rate
before trusting high-frequency conclusions.

## 6. Existing analysis code

Three pure-computation modules already exist. Tuning logic should build on them.

### GraphSpectrumCalc (`js/graph_spectrum_calc.js`)

Singleton. `initialize(flightLog, sysConfig)`, `setInTime`, `setOutTime`,
`setDataBuffer({fieldIndex, curve, fieldName})`, then one of:

- `dataLoadFrequency()`: single FFT over the whole range. Returns
  `{fftOutput, fftLength, blackBoxRate, maxNoiseIdx}`. Bin to Hz is
  `bin * (blackBoxRate / 2) / fftLength`.
- `dataLoadFrequencyVsThrottle()`: 300 ms FFT chunks bucketed by throttle percent.
- `dataLoadPidErrorVsSetpoint()`: mean absolute error bucketed by setpoint magnitude.

Capped at 5 minutes. Reads the global `userSettings.analyserHanning`. `curve` must provide
`lookupRaw(value)`; pass `{ lookupRaw: v => v }` for raw units.

### StepResponseCalc (`js/graph_stepresponse_calc.js`)

Estimates the closed-loop step response (setpoint to gyro) per axis from ordinary flight
data. The header comment in the file documents the algorithm in full: 1 s Hanning windows at
4x overlap, reject windows with under 20 deg/s peak-to-peak setpoint, Wiener deconvolution
with regularisation at 1 % of mean input power, inverse FFT, cumulative sum, outlier
rejection at 2 sigma, average.

`calculate()` returns `{roll, pitch, yaw}`, each `{time, response, windowCount, valid}` with
a 0.5 s response. `valid` means at least 10 windows survived.

**Measured accuracy.** Feeding the estimator synthetic data from a known second-order system
(60 s, random stick steps, light noise). These are single runs with one random seed, so
treat them as indicative:

| Rate | Natural freq | Damping | Stick hold | Peak (true) | Peak time (true) | Value at 0.5 s (true 1.0) |
|---|---|---|---|---|---|---|
| 1000 Hz | 6 Hz | 0.45 | 0.3 s | 1.16 (1.21) | 89 ms (93) | 0.93 |
| 250 Hz | 6 Hz | 0.45 | 0.3 s | 1.12 (1.21) | 88 ms (93) | 0.88 |
| 250 Hz | 6 Hz | 0.70 | 0.3 s | 0.98 (1.05) | 104 ms (117) | 0.88 |
| 250 Hz | 3 Hz | 0.70 | 0.3 s | 0.92 (1.05) | 168 ms (233) | 0.86 |
| 250 Hz | 6 Hz | 0.45 | 1.0 s | 0.94 (1.21) | 88 ms (93) | 0.80 |
| 250 Hz | 12 Hz | 0.30 | 0.3 s | 1.27 (1.37) | 40 ms (44) | 0.96 |

Conclusions:

- **Amplitude is biased low by 4 to 20 %**, and the bias depends on how the pilot moved the
  sticks (slower inputs give a larger bias) and on logging rate. Absolute overshoot read from
  this curve is not trustworthy.
- **Overshoot normalised by the final value** (peak divided by the value at 0.5 s) stayed
  within 0.08 of the truth, so use ratios rather than absolute levels.
- **Peak time is good only for underdamped responses.** With damping of 0.45 or less it was
  within 5 ms. At damping 0.70 the peak is shallow and the estimate came out 13 to 65 ms
  early, so peak time is a poor metric for a well-damped axis. Rise time to a fraction of
  the final value should hold up better, but that was not measured.

### FlightAnalysis (`js/flight_analysis.js`)

`FlightAnalysis.build(flightLog)` returns `{context, labs, verdict}`. It is the closest
existing thing to a tuning advisor and the best template to follow.

**Only `build` is exported** (`flight_analysis.js:968`). Every helper named below lives
inside the closure. To reuse one from another file, add it to the returned object instead of
copying it.

- **Stable-flight detection** (`detectStableFlightPhase`, line 172): finds steady governed
  flight, preferring governor target tracking, then headspeed plateau, then low gyro activity.
  Keeps runs of 3 s or more and trims 3 s off each end.
- **Labs**, each returning `{status, story, metrics}` with status `good`, `watch`,
  `attention`, `info` or `insufficient`:

  | Lab | Scores | Thresholds (watch / attention) |
  |---|---|---|
  | `governor` | 99th percentile of 100 ms averaged headspeed sag | 2.5 % / 5 % |
  | `esc` | Throttle headroom and time at 97 % or more | headroom under 12 % / saturated over 2 % |
  | `battery` | 1st percentile of 0.5 s averaged voltage per cell | 3.45 V / 3.3 V |
  | `vibration` | Strongest gyro spectrum peak per axis, matched to rotor harmonics | informational only |
  | `pid` | Delay-compensated tracking error, PID sum saturation | 30 % / 45 % error, 1 % / 5 % saturated |

- **`delayCompensatedTracking`** (line 674) finds the lag (up to 150 ms) that best aligns
  gyro with setpoint and reports the residual error and that delay. It is a ready-made loop
  delay estimate.
- Logs longer than 240 s are analysed over only the steadiest 240 s window
  (`findSteadiestWindow`), chosen from the activity summary without decoding.

Every lab scores **stable flight only**. That suits health checks but is the wrong window for
tuning, which needs the opposite: segments with strong stick excitation.

`FlightAnalysisDialog` (`js/flight_analysis_dialog.js`) renders the result and caches it per
log. It runs the analysis synchronously inside a `setTimeout(0)`.

## 7. Adding a feature

Adding a JavaScript file takes three edits:

1. Create `js/<name>.js`.
2. Add `<script src="js/<name>.js"></script>` to `index.html`, **after** everything it
   depends on and before `js/main.js`.
3. Add `'./js/<name>.js'` to `distSources` in `gulpfile.js`.

Skipping step 3 gives a feature that works under `make dev-server` and is missing from
`make apps` and every release. CSS files need the same treatment (`<link>` in `index.html`
plus the `distSources` entry).

To add a dialog, copy the Flight Analysis pattern end to end:

| Piece | Location |
|---|---|
| Modal markup | `index.html:3505` (`#dlgFlightAnalysis`) |
| Toolbar button | `index.html:145` (`.open-flight-analysis-dialog`) |
| Dialog constructor | `js/flight_analysis_dialog.js` |
| Construction | `js/main.js:1517` |
| Click handler | `js/main.js:1542` |
| Styles | `css/flight_analysis_dialog.css` |

Keep computation and rendering in separate files, as `flight_analysis.js` and
`flight_analysis_dialog.js` do. That separation is what makes headless testing possible.

Other notes:

- User settings live in the global `userSettings` (`js/main.js:4`), persisted through
  `PrefStorage` under the key `userSettings`. Defaults are in `user_settings_dialog.js:55`.
- Escape any log-derived string before inserting it as HTML (`escapeHtml` in
  `flight_analysis_dialog.js:26`). Craft names come from the log file.
- Localisation is vestigial: `_locales/en/messages.json` has seven strings and UI text is
  hard-coded English.
- User-facing changes are listed in `Releases.md`.
- This app is a **viewer only**. It has no serial or MSP connection to a flight controller,
  so nothing here can write settings to an aircraft.

## 8. Headless development

The decoder and all three analysis modules run in plain Node with a small jQuery stand-in. *Verified*: the harness below parsed a 9.6 MB, 5-minute Rotorflight 4.6.0 log and
ran the step response and flight analysis in about 2 seconds.

The loader lives in `tools/autotune/lib.cjs`:

```js
const lib = require('./tools/autotune/lib.cjs');
const app = lib.loadApp();                       // decoder scripts in a node:vm context, jQuery stubbed
for (const seg of lib.segments(app, 'flight.bbl')) {
    if (seg.skipped) continue;                   // seg.flight says which log, seg.skipped says why
    // seg.sp, seg.gyro, seg.u, seg.P ... are Float64Array columns per axis, see section 12
}
```

To reach the app's own analysis modules as well, add `graph_spectrum_calc`, `graph_stepresponse_calc` and
`flight_analysis` to the script list and set `userSettings = { analyserHanning: true }` in the context.

Things to know:

- Globals declared with `var` or `function` are reachable as `app.Name`. Globals declared
  with top-level `const` or `let` (for example `STEP_RESPONSE_FRAME_LEN_SEC`) are visible to
  other scripts in the context but **not** as properties; read them with
  `vm.runInContext('NAME', app)`.
- The `$.extend` stand-in is shallow. It is enough for reading logs. `setSysConfig` needs a
  real deep merge.
- For pure math, skip the decoder: pass a fake log object implementing `getMinTime`,
  `getMaxTime`, `getMainFieldIndexByName` and `getChunksInTimeRange`. That is how the accuracy
  table in section 6 was produced.

**Sample logs.** The repository contains none. A public Rotorflight 4.6.0 log (two flights,
250 Hz, governor and ESC telemetry) is attached to
[rotorflight-firmware issue 506](https://github.com/rotorflight/rotorflight-firmware/issues/506):

```sh
curl -sSL -o log.zip https://github.com/user-attachments/files/32339591/RTFL_BLACKBOX_LOG_COMPETIZIONE_20260916_175522.BBL.zip
unzip log.zip
```

It is a third party's flight, so keep it out of version control. Tuning work needs a set of
logs from known airframes with known-good and known-bad tunes; collecting those is a
prerequisite, not an afterthought.

## 9. Automatic tuning: what the logs give you

### Gains in the header

Verified against the firmware source (`rotorflight-firmware` master on 2026-09-26,
`src/main/blackbox/blackbox.c` and `src/main/cli/settings.c`) and against the 4.6.0 sample.
Parameter names can change between firmware versions, so confirm against the tag matching
`sysConfig.firmwareVersion` before emitting commands.

| Header (`sysConfig` key) | Values, in order | CLI parameters |
|---|---|---|
| `rollPID` | P, I, D, F, B | `roll_p_gain`, `roll_i_gain`, `roll_d_gain`, `roll_f_gain`, `roll_b_gain` |
| `pitchPID` | P, I, D, F, B | `pitch_*_gain` likewise |
| `yawPID` | P, I, D, F, B | `yaw_*_gain` likewise |
| `hsi_gain` | roll O, pitch O | `roll_o_gain`, `pitch_o_gain` |
| `hsi_limit` | roll, pitch | `offset_limit` (array of 2) |
| `rollBW`, `pitchBW`, `yawBW` | gyro cutoff, D cutoff, B cutoff (Hz) | `<axis>_gyro_cutoff`, `<axis>_d_cutoff`, `<axis>_b_cutoff` |
| `govPID` | P, I, D, F, master gain | `gov_p_gain`, `gov_i_gain`, `gov_d_gain`, `gov_f_gain`, `gov_gain` |
| `yaw_stop_gain` | CW, CCW | `yaw_cw_stop_gain`, `yaw_ccw_stop_gain` |
| `yaw_precomp` | cutoff, cyclic FF, collective FF | `yaw_precomp_cutoff`, `yaw_cyclic_ff_gain`, `yaw_collective_ff_gain` |
| `yaw_inertia_precomp` | gain, cutoff | `yaw_inertia_precomp_gain`, `yaw_inertia_precomp_cutoff` |
| `yaw_tta` | gain, limit | `gov_tta_gain`, `gov_tta_limit` |
| `cyclic_coupling` | gain, ratio, cutoff | `cyclic_cross_coupling_gain`, `_ratio`, `_cutoff` |
| `pitch_compensation` | gain | `pitch_collective_ff_gain` |
| `error_limit` | roll, pitch, yaw | `error_limit` (array of 3) |
| `error_decay` | time, limit (cyclic) | `error_decay_time_cyclic`, `error_decay_limit_cyclic` |
| `iterm_relax_type`, `iterm_relax_cutoff` | type; roll, pitch, yaw | same names |

The arrays in `flightlog_parser.js:249-252` are declared with six slots, but Rotorflight
writes five. The O gain arrives separately in `hsi_gain`.

Also in the header and relevant to tuning: gyro low-pass filters (`gyro_lpf1_*`,
`gyro_lpf2_*`), dynamic notch settings (`dyn_notch_*`), the RPM notch bank
(`gyro_rpm_notch_*`), rates (`rates_type`, `rc_rates`, `rc_expo`, `rates`) and loop timing.

### Gain scaling

Integer gains map to controller coefficients through constants in the firmware's
`src/main/flight/pid.h`:

| Term | Roll | Pitch | Yaw |
|---|---|---|---|
| P | 6.667e-6 | 6.667e-6 | 6.667e-5 |
| I | 2e-4 | 2e-4 | 5e-4 |
| D | 0.1e-6 | 1.0e-6 | 1.0e-6 |
| F | 2.5e-5 | 2.5e-5 | 2.5e-5 |
| B | 0.1e-6 | 0.1e-6 | 1.0e-6 |

The O gain uses the I scale. Some coefficients are rescaled again depending on `pid_mode`
(for example roll D is multiplied by 0.2 in mode 4), so a model-based tuner must follow
`pid.c` for the mode in use.

### What the logs do not give you

- **`pid_mode` is not logged.** Neither the 4.6.0 sample nor firmware master writes it to the
  header. A tuner that simulates the controller has to assume it or ask.
- **PID sum limits are not logged.** `sysConfig.pidSumLimit` and `pidSumLimitYaw` are `null`
  for Rotorflight, so `axisSum` is never clamped and the saturation check in the PID lab is
  silently skipped ([section 11](#11-known-issues)). Detect saturation from `mixer[]` or
  `servo[]` against their ranges instead.
- **The header describes the PID profile active at arming.** After a profile switch the log carries an
  `INFLIGHT_ADJUSTMENT` event (function 2, value = profile number) but not the new profile's gains. This is
  normal use, not a fault. `recoverGains` in `tools/autotune/lib.cjs` measures the gains in effect from the
  logged PID terms instead, to within 1 % for P, D and F on real logs (R² above 0.98).
- **Airframe facts**: blade count, rotor size, tail type (motorised or driven), servo speed.
  The vibration lab already infers a variable-speed tail from `tailspeed` variance.

### Observations from the sample log

Flight 1, 303.6 s, roll `50,100,0,100,0`, pitch `50,100,40,100,0`, yaw `85,120,10,0,0`:

| Axis | Windows | Step peak | Value at 0.5 s | Tracking error | Delay |
|---|---|---|---|---|---|
| Roll | 275 | 1.31 | 0.98 | 30 % | 24 ms |
| Pitch | 234 | 1.19 | 1.11 | 36 % | 60 ms |
| Yaw | 463 | 0.87 | 0.60 | 10 % | 44 ms |

Step response figures cover the first 300 s of the flight; tracking figures come from the
PID lab, which scores stable flight inside the steadiest 240 s.

The two yaw results disagree: a response that settles at 0.60 implies a steady-state error
near 40 %, yet measured tracking error is 10 %. The likely cause is the estimator's
low-amplitude bias under slow inputs (section 6), which sustained pirouettes would
aggravate, but that is unconfirmed. Either way it shows why a tuning decision should not
rest on one metric.

## 10. Automatic tuning: status and next steps

| Phase | Status |
|---|---|
| 0. Foundations: headless loader, ground-truth tests | Done. `tools/autotune/lib.cjs`, `test/autotune.test.cjs` |
| 1. Metrics: gains in effect, frequency responses with uncertainty, tracking and disturbance measures | Done, as offline scripts. See section 12 |
| 2. Advice: validated predictions and rule-based recommendations | Done, as offline scripts. See section 12 |
| 3. In the app: a Flight Analysis lab that shows the same numbers | Done: the Tuning dialog runs the toolkit unchanged in the app. See section 13 |

Next steps, in order:

1. Fly a recommended change, log it, and rerun the analysis. The toolkit has been checked against simulated
   flights only; a before/after pair on the real aircraft is the missing validation.
2. Collect three or more flights per gain set and headspeed. Groups with fewer are skipped because no
   uncertainty can be computed, which is why most yaw groups in the first analysis produced no result.
3. Port the computation into the app as a lab, following section 7. `lib.cjs` has no Node dependency apart
   from the loader and `fs`, so the analysis functions can move into `js/` unchanged.

Constraints that apply throughout:

- **Every recommendation cites its evidence.** A number, its uncertainty, and the rule it passed.
- **Suggest, never apply.** The app cannot write to a flight controller and should not learn to.
- **Bound each step** to 20 % per gain and never raise feedback gain where the airframe was not measured.
- **Refuse when data is thin.** A failed gate or too few flights produces an explanation, not a number.

Open questions: PID modes other than 3 are not modelled; the I-term is modelled through a measured
linearisation of I-term relax, which is the largest known source of prediction error (section 12).

## 11. Known issues

Found during this survey. None are fixed here.

| Where | Issue |
|---|---|
| `js/graph_spectrum_calc.js:47` | `analyserTimeRange.in` should be `this._analyserTimeRange.in`. Calling `setOutTime` with a range over 5 minutes throws `ReferenceError` (*verified*). `StepResponseCalc` clamps correctly. |
| `js/flight_analysis.js:719`, `:751` | PID sum saturation is never evaluated for Rotorflight logs because the header has no PID sum limits. The lab reports no saturation rather than "unknown". |
| `js/flight_analysis.js:186`, `:942` | Stable-flight detection assumes `govTarget` is a target. When the Rotorflight governor is not regulating (`govSum` logged as 0, motor output constant), `govTarget` follows the measured headspeed, no segment passes, and every lab returns "insufficient". Seen on all four flights longer than 150 s in a 51 MB log flown that way. |
| `js/flightlog.js:251` | Cell count is a heuristic from the start voltage. The sample reports 11S at 48.7 V, which may be a partly charged 12S pack. |
| `HOWTO.md:44-73` | "Setting up and building on a Mac" still says Node 8 and `brew install yarn`. Use the Setup section above it. |
| `test/index.html`, `test/index.js` | Legacy browser test using `alert()`, not run by `node --test`. |
| `CONTRIBUTING.md` | Developer link points at Betaflight docs. |
| `.github/workflows/*` | No workflow runs tests or lint. |
| `js/graph_stepresponse.js:117` | `captureImage()` refers to an "AI Analyse feature" that does not exist in this repository (carried over from the WingFlight port). Unused. |

## 12. Tuning analysis toolkit

Offline scripts that turn blackbox logs into measurements, validated predictions and recommendations.

```sh
node tools/autotune/extract.cjs <out dir> <log file> [more log files...]   # decode, about 1 min per 100 MB
node tools/autotune/report.cjs  <out dir>                                  # analyse, a few seconds
node --test test/autotune.test.cjs                                         # ground-truth checks
```

`extract.cjs` writes `segments.json`. `report.cjs` reads it and writes `report.md` (every table and
decision) and `results.json` (the same numbers for programs). Decoding is the slow part, so the two are
separate: changing a rule only needs `report.cjs` again.

| File | Role |
|---|---|
| `tools/autotune/lib.cjs` | Loader, segmenting, firmware filter replicas, gain recovery, spectra with jackknife uncertainty, prediction, plant fitting |
| `tools/autotune/extract.cjs` | Logs to `segments.json` |
| `tools/autotune/report.cjs` | `segments.json` to report. The `RULES` object at the top holds every threshold |
| `tools/autotune/wag.cjs`, `wag_report.cjs` | Oscillation and tail wag, see below |
| `tools/flash_read.py` | Reads the flash of a flight controller over MSP, read-only, timing every request |
| `tools/download_watchdog.sh` | Watches a Configurator download and nudges it when it stalls (`analysis/download-stall/README.md`) |
| `test/autotune.test.cjs` | Simulates the firmware control law around a known airframe and requires the analysis to recover it |
| `tools/autotune/health.cjs`, `health_report.cjs` | Health checks of section 10 of `TUNING_KNOWLEDGE.md`, see below |
| `tools/autotune/health_gov.cjs`, `health_loop.cjs`, `health_setup.cjs` | The checks: governor/ESC/power (D5, G0-G13), cyclic and tail loops (C1-C11, T2-T9), data validity and filters (D1-D4, F1-F9) |
| `test/health_*.test.cjs` | Simulated logs with injected defects that each module must find |

### Health checks and the full pipeline

```sh
node --max-old-space-size=12000 tools/autotune/health.cjs <out dir> <log files...> [--cli <cli dump>]
node tools/autotune/health_report.cjs <out dir>
node --test test/health_gov.test.cjs test/health_loop.test.cjs test/health_setup.test.cjs
```

`health.cjs` reads every log start to end (`lib.segments` with `whole: true`, the governor state per sample
from GOVSTATE events in `govStateAt`), runs each module's `analyse` and writes `health.json`: measurements,
no verdicts. The loop and governor modules run only on logs that were flown (`wag.cjs` `RULE.flight`).
`health_report.cjs` runs each module's `judge` against its `RULES`, the thresholds of all three modules in
one place with their source, and writes `report.md` (data validity; setup and tuning history; governor, ESC
and power; cyclic; tail; filters and vibration; every check with threshold, source and outcome, skipped ones
with the reason; all findings by severity with log numbers and times) and `results.json`. 19 logs take
about 75 s and 2 GB.

The full pipeline is `health.cjs` + `health_report.cjs` (is the data sound, is the setup sane), then
`wag.cjs` / `wag_report.cjs` / `spectra.cjs` (oscillation, wag, vibration: C5, T1, T3, T10, F7), then
`extract.cjs` / `report.cjs` (gains, airframe response, recommendations: C7). The checks, their thresholds
and sources are defined in [`TUNING_KNOWLEDGE.md`](TUNING_KNOWLEDGE.md) section 10.

**Slow rotors.** "In flight" means airborne with the rotor at or above 3000 rpm, and the steady segments need a
median of 2500 rpm. Both come from one setting, `AUTOTUNE_FLIGHT_RPM` (default 3000; segments use 5/6 of it, rotor-order
windows 1.1 times it). Set it below the lowest governor target for a helicopter flown slower, for example
`AUTOTUNE_FLIGHT_RPM=2000` for a 2300-2700 rpm rotor (`analysis/gaui-x4/`), and use the same value for every script of one
analysis.

### Method

1. **Segments.** Airborne, spooled up, one PID profile, no logging gaps, 20 s or more. Grouped by headspeed
   in 250 rpm bins, and by gain set.
2. **Gains in effect.** Each logged PID term is regressed on its input through sample-exact replicas of the
   firmware filters (`firstOrderLPF`, `difFilter`, `pt1`). Filter cutoffs and the I-term relax level are
   searched as well, because they belong to the profile and are not logged after a switch. The yaw F gain is
   measured after regressing out the collective and cyclic precompensation that shares the logged term.
3. **Frequency responses.** Closed loop `T = Sry / Srr` and airframe `G = Sry / Sru`, from 2 s Hann windows.
   Using the setpoint as instrument keeps `G` unbiased in closed loop. Standard errors come from
   leave-one-flight-out resampling.
4. **Prediction.** The firmware control law (PID mode 3) is applied to the measured `G`, bin by bin. No
   airframe model is assumed; fitted models are reported for description only.
5. **Gates.** A group yields predictions only if its single-axis estimates survive holding the other sticks
   constant (V1) and the control law reproduces the measured closed loop and tracking error (V2, V3).
6. **Decision.** Rules 6 to 8 at the end of every report.

### What the tests establish

On simulated flights with rounding, noise, disturbances and I-term relax, as the flight controller logs them:

| Quantity | Truth | Required by the test |
|---|---|---|
| P, D, F, B gains | 50, 15, 100, 25 | within 1, 1, 0.5, 3 |
| I gain, relax level, relax cutoff | 100, 35 deg/s, 18 Hz | within 5, 5, 4 |
| Gyro and D-term filter cutoffs | 80, 35 Hz | within 5, 3 |
| Airframe gain, resonance, damping, delay | 400, 15 Hz, 0.25, 12 ms | within 20, 0.6 Hz, 0.05, 2 ms |
| Step response of the modelled loop against a time simulation | | peak within 0.06, peak time within 3 ms |
| Closed loop predicted for a changed tune, against flights flown with it | | stick-weighted error under 3 % |
| Tracking error predicted for six changed tunes | | within 2.5 % of the setpoint RMS, direction always right |
| Disturbance predicted for a changed tune that tracks no worse | | within 3 % |
| Cross-axis check on a deliberately biased case | gain 1.0, biased to 1.4 | recovers 1.0 within 0.05 |

The last two rows are the prediction floors that `report.cjs` adds to every predicted change. They are
lower bounds on the real uncertainty: the simulation shares the control law with the aircraft but not its
aerodynamics.

### Oscillation and tail wag

```sh
node --max-old-space-size=14000 tools/autotune/wag.cjs <out dir> <log file> [more log files...]
node tools/autotune/wag_report.cjs <out dir>
node tools/autotune/spectra.cjs <out dir> <log file> [log numbers for spectrograms]   # vibration spectra
node tools/autotune/wag_report.cjs <out dir>                                          # again, to add the vibration tables
node tools/autotune/line.cjs <out dir> <log file> [order]                               # one vibration line, window by window
node tools/autotune/line_report.cjs <out dir>                                          # what makes it: candidates and fingerprints
python3 tools/autotune/spectra_plot.py <out dir>                                      # figures; needs numpy, matplotlib
```

Oscillation comes and goes, so flight-averaged spectra hide it, and pilots switch PID profile in flight, so
stretches on one profile can be short. `wag.cjs` therefore reads every log from start to end
(`lib.segments(..., { whole: true })`) and counts every sample in flight for the profile active at that
moment. Only the airframe response comes from the steady stretches of 20 s or more
(`lib.steadySegments`). `wag_report.cjs` writes `report.md` and `results.json`;
`analysis/fireball-wag/` is a worked case.

| Step | What is computed |
|---|---|
| Groups of flights | From the pilot: `<out dir>/groups.json`, `{ "starts": [log numbers], "why": "what changed", "note": "status text" }` (`analysis/fireball-wag/groups.json` is an example). Without it, all flights form one group. What was changed on the helicopter is not in a log |
| Amplitude by profile | Half-second windows of gyro minus setpoint in the band of each axis, per group and profile; windows where the stick moves in the band are not counted as oscillation |
| Spectrum by profile | Amplitude per 1 Hz band, to tell a hump (oscillation) from a slope (tracking error) |
| Sticks | Amplitude at equal stick movement (collective, yaw stick, overall activity), and the share of the motion that the four sticks together explain, band by band (multiple coherence). A pilot who flies harder in later flights changes every other comparison |
| Vibration | rms between 40 and 497 Hz per profile, raw and filtered, split into rotor lines, other lines and the rest (`spectra.cjs`) |
| A line's source | `line.cjs` measures a line against the main rotor line in every window of 512 revolutions, with the conditions of the window. A part turned through teeth holds its ratio exactly; one turned by friction creeps with load; a ball bearing's ball-pass frequency moves with thrust; a blade mode moves when the blades change; an alias does not scale with rotor speed. `line_report.cjs` tests each |
| Bursts | Runs of regular cycles (`lib.oscillationBursts`), large yaw events half cycle by half cycle |
| Rotor orders | Raw gyro resampled against rotor revolutions (`lib.byRevolution`); lines as multiples of the main rotor's own line; what the gyro filters pass at each |
| Airframe response, margins | Per group and headspeed, with jackknife standard errors |
| Decisions | Yaw: gain margin above the largest at which the loop went unstable by itself. Roll, pitch: single gain changes scored on the model |

Three things that went wrong in the first version, kept here as warnings:

- Dropping stretches under 20 s dropped most of the time on profiles that the pilot visits briefly.
- Printing every n-th sample of a signal that carries vibration aliases it. 167 Hz sampled at 50 Hz looks
  like a 17 Hz oscillation. Look at band-passed data or spectra, never at a thinned excerpt.
- Grouping flights by the quantity under study, then reporting that it differs between the groups. Group
  boundaries come from the pilot.
- Comparing flights without comparing how they were flown. The later flights of the worked case threw the
  collective through 60 % of its range and more; the earlier ones never did, and that is where the tail
  events were.
- The loop runs off the gyro's clock. These logs hold 994.4 frames per second, not 1000
  (`flight.actualRate`). Ratios between lines are immune; absolute frequencies are not.

The test `the gain margin says when the loop starts to oscillate by itself` simulates an airframe that
responds 0.8 and 1.2 times the gain margin more strongly than the model, and requires the first to stay
quiet and the second to oscillate at the predicted frequency.

### Limits

- Predictions are confined to the validated band, typically 1 to 15 or 20 Hz at the logging rates seen so
  far. Above it the airframe is not measured and candidates may not raise feedback gain there.
- When a change makes tracking worse, the disturbance prediction was off by up to 12 % in simulation. Such
  candidates fail the rule anyway.
- Step-response figures are not used for decisions. The estimator in the app is biased (section 6).

## 13. The Tuning dialog

The toolbar button with the sliders icon opens it. It runs the toolkit of section 12 inside the app, shows error curves and
lists every check with its number, uncertainty and rule. It also gives recommendations, with CLI text for the pilot to review.
Nothing is sent to the flight controller.

### Files

| File | Role |
|---|---|
| `js/tuning_worker.js` | Web Worker. Loads the decoder scripts (`importScripts`) and the toolkit `.cjs` files (`fetch`, then a CommonJS shim), analyses, posts progress and one result |
| `js/tuning_dialog.js`, `css/tuning_dialog.css` | The modal: context bar, scope (this log / all flights in the file), flight rpm, CLI dump, tabs, plots, save report |
| `js/tuning_plot.js` | Canvas plots: linear and log axes, two y axes, NaN gaps, uncertainty bands, hover readout, click to seek |
| `tools/autotune/health_track.cjs` | New checks: C12/T11 tracking error, C13/T12 lag, R1 stick-to-setpoint lag, C5/T1 fast oscillation; `curves()` for the error-curve tab |
| `tools/autotune/health_more.cjs` | `normalMask` and D6 (rescue, level modes, failsafe, ground contact), F10 D-term and control noise, F11 measured gyro filter delay, T13 hover tail I, C14 pitch vs collective, T14 yaw at headspeed ramps, G14 governor states; `curves()` for governor, vibration and tail |
| `tools/autotune/advice.cjs` | Findings and `report.cjs` decisions to recommendations: tuning order, guards, CLI text; the coverage matrix of every Rotorflight parameter group |
| `test/health_track.test.cjs`, `test/health_more.test.cjs`, `test/advice.test.cjs` | Simulated ground truth per check, one test per advice generator and guard, real-data smoke tests |
| `test/tuning_worker.test.cjs`, `test/helpers/bbl_encode.cjs` | The worker in a Node realm: byte parity with `health.cjs` + `health_report.cjs` on a synthetic `.bbl`; with `AUTOTUNE_REAL_LOG` set to the path of the Gaui X4 dump `RTFL_BLACKBOX_LOG_20261004_113720.BBL`, also on its log #50 |
| `test/tuning_plot.test.cjs`, `test/tuning_dialog.test.cjs` | Plots on a fake canvas; the dialog on a synthetic result (every tab, escaping, worker protocol, seeking, registration in `index.html` and `gulpfile.js`) |

### How it reuses the toolkit

The toolkit files are not copied. The worker fetches them as text and compiles each one as a function expression
through an indirect eval, `(0, eval)('(function (require, module, exports, process, __dirname, __filename, console) {...})')`,
with a `sourceURL` so that stack traces name the file:
- `require` returns sibling modules, a virtual in-memory `node:fs`, a posix `node:path` and a `node:vm` whose
  `runInContext` is an indirect `eval` in the worker.
- `process.env.AUTOTUNE_FLIGHT_RPM` carries the flight rpm. Each flight rpm gets its own module registry, because the toolkit
  reads it at load.
- `require.main` is undefined for library use. `health_report.cjs`, `extract.cjs` and `report.cjs` run as "virtual CLIs" over
  the in-memory fs.
- Rules for anyone editing `tools/autotune`:
  - no Node API calls when a module loads (the `require('node:*')` lines are fine);
  - keep `module.exports` followed by `if (require.main !== module) return`;
  - add every file the worker loads to `distSources` in `gulpfile.js` (`APP_ASSET_SOURCES` on the web-app branch).
- `test/tuning_worker.test.cjs` fails on drift. With `excludeAbnormal: false` the worker's records and findings must equal the
  CLI's byte for byte.

**This log** (a few seconds):
1. The dialog slices the selected log out of the file (`FlightLogIndex.getLogBeginOffset`) and transfers the slice.
2. The worker decodes it with unmodified `lib.segments`.
3. It derives the flight rpm: 85 % of the lowest per-profile governor target in flight, in 100 rpm steps (1900 on the Gaui X4,
   2900 on the Fireball). The user can override it.
4. It runs `health_setup`, `health_gov`, `health_loop`, `health_track` and `health_more`. Rescue, angle/horizon/trainer,
   failsafe and ground contact are ANDed out of the flying mask (`normalMask`).
5. It judges with the virtual `health_report.cjs`, then runs advice, then curves.

**All flights in the file:**
- Every log is run as above, with one flight rpm for the file, and judged together.
- `extract.cjs` and `report.cjs` then add the gain decisions (three or more flights per gain set, section 12).
- Cost in Node: about 40 s for the 108 MB Gaui file and 110 s for a 131 MB Fireball file, 1.7 GB peak. NW.js under Rosetta
  is about twice as slow.

### Checks added for the dialog

Thresholds are in `DEFAULT_RULES` at the top of each module, each with its source. They are pipeline choices, not
validated in flight. Flags that have a standard error must pass a 2-SE test.

| ID | Measures | Rule |
|---|---|---|
| C12 roll, pitch / T11 yaw | rms(gyro(t + τ) − setpoint) / rms(setpoint), low-passed at 30 Hz, samples with \|setpoint\| > 5 deg/s, τ the best delay in 0-150 ms; jackknife over 10 s blocks | note 0.30, flag 0.45 (the levels of the PID lab in `js/flight_analysis.js`) |
| C13 / T12 | that τ, the setpoint-to-gyro lag | report; flag above 120 ms |
| R1 | rcCommand to setpoint lag (rate shaping) | report; flag above 40 ms |
| C5 / T1 | stick-free band-passed error in the `wag.cjs` bands; shares at 10/20/40 deg/s; bursts that grow from < 30 to >= 150 deg/s | flag on a self-excited burst; note when the 20 deg/s share passes 0.05 |
| D6 | seconds excluded by `normalMask` | note; flag failsafe while airborne |
| F10 | share of axisD power above 30 Hz (yaw too); mixer rms above 30 Hz | flag yaw D share above 0.5 |
| F11 | gyroRAW to gyroADC delay at 8-16 Hz | report; flag above 10 ms |
| T13 | median hover yaw I as a share of the yaw authority | flag above 0.15 |
| C14 | pitch I + O against collective, the implied `pitch_collective_ff_gain` change | flag at 20 per 1000 collective and a change of 10 or more |
| T14 | yaw at governor headspeed ramps, regressed to a `yaw_inertia_precomp_gain` change | 3 or more events, 80 % of one sign, change above max(15, 0.15 x header gain) |
| G14 | time and entries per governor state, spool-up ramp | note; flag airborne bailout, or autorotation above hover collective for more than 0.5 s |

### Recommendations

`advice.advise(input)` is pure. The dialog shows the recommendations in the order of `TUNING_KNOWLEDGE.md` section 9.1: preconditions, then
filters, governor, cyclic, tail, rates. Guards, each with a test in `test/advice.test.cjs`:
- filters first: no gain raise while a filter check flags;
- motor poles and gear first;
- authority before gains;
- the 2-SE gate;
- steps of at most 20 %, except the documented absolute steps (governor F 10, I 25, P 10; TTA 10; tail D 10);
- never a gyro LPF below 60 Hz or a notch Q below 2.0;
- log profile p is CLI `profile p-1`, with no CLI text when the arming profile is unknown;
- no governor gains in DIRECT;
- known misleading raw flags (loop stalls after disarm, F5 without a CLI dump) become checks, never actions.

The worker adds two fields to toolkit findings:
- `filterPass` on F5: the measured gyroRAW to gyroADC transmission at each line. A strongest line the filters pass under 5 % of
  is information, not a filter problem.
- `explained`: a flag that every recommendation on it treats as information. The dialog shows it as report-only.

The Coverage tab lists every parameter group with what was assessed, or why not: needs a CLI dump, needs fields, needs
more flights, or not assessable from a log.

### Error curves

| Plot | Data |
|---|---|
| Tracking error over time | setpoint, error, error at the best delay (rms per 0.1 s), unusable spans shaded, finding times as markers; a click seeks the viewer |
| Band-passed error amplitude | the C5/T1 statistic over time with the 10/20/40 deg/s lines; stick-driven windows shaded |
| Error and response spectrum | \|error\| / \|setpoint\|, \|T\| from setpoint to gyro, coherence; \|T\| is drawn solid only where its random error sqrt(1 − coh) / sqrt(2 n coh) is under 20 % |
| Phase | phase of T (same mask) against the fitted delay line −360 f τ |
| Mean \|error\| by \|setpoint\| | the error against stick rate, raw and at the best delay |
| Governor | headspeed and target with the governor states, error % with ±1/±2 % lines, throttle and collective |
| Filters and vibration | gyroRAW against gyroADC per axis and profile with rotor harmonics, notches and LPF cutoffs; transmission; D-term and control spectra |
| Tail | mixer[2] against its limits; yaw error |

### Verified

- The tests listed above all pass (237 tests including the pre-existing ones, 2026-10-05).
- In NW.js 0.62.2 (Chromium 99) the worker gives the same findings as Node.
- The web build was tried in Chrome, from a merge with the fork's web-app commits #85-#87. Every tab rendered real Gaui X4 data, and
  click-to-seek and "All flights" worked, with no console errors.
- Against the peer analysis of the Gaui X4 (`analysis/gaui-x4/`):
  - rescue excluded 10.59 s against 10.60 s;
  - gyro filter delay 7.0-7.6 ms against 7.15-7.23 ms;
  - pitch lag 70-79 ms against 72-75 ms;
  - yaw at ramps 35.5 ± 2.1 against 34.8 ± 1.6 deg/s;
  - the roll mode is not flagged as self-excited;
  - the 4.06 x rotor line is reported as already filtered out (0.1-0.5 % passed; the peer measured 0.0-0.2 %).
- Merging the fork's origin/master conflicts only in `gulpfile.js`: move the new entries into `APP_ASSET_SOURCES`.
