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
13. [Analysis and Tuning views](#13-analysis-and-tuning-views)

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
| Health checks of the toolkit | `test/health_setup.test.cjs`, `health_gov`, `health_loop` | `node --test ...` |
| Analysis and Tuning views: our checks, catalog, tuning sequence, evidence, advice, worker, plots, snippet reader, views, log lens | `test/health_track.test.cjs`, `health_more`, `health_phase`, `catalog`, `hierarchy`, `evidence`, `advice`, `tuning_worker`, `tuning_plot`, `tuning_snippet`, `tuning_dialog`, `log_lens`, `views` | `node --test ...`; see section 13 |
| Regressions of the upstream log viewer that a Node test can cover (the analyser handlers after a log change; the log picker during "Show in the log" is in `views`) | `test/viewer_regression.test.cjs` | `node --test test/viewer_regression.test.cjs` |
| ASD-STE100 lint of every text that the app shows | `test/ste_text.test.cjs` | `node --test test/ste_text.test.cjs` (about 30 s; it runs the tests of the views and the toolkit again) |
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
| Analysis UI | `graph_spectrum*.js`, `graph_stepresponse*.js`, `log_lens.js`, `analysis_view.js`, `tuning_*.js` (`flight_analysis_dialog.js`: upstream, not used) | | Canvas plots, the Analysis view (verdict and log lens) and the Tuning view ([section 13](#13-analysis-and-tuning-views)) |
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

`FlightAnalysisDialog` (`js/flight_analysis_dialog.js`) renders the result and caches it per log. It runs the analysis
synchronously inside a `setTimeout(0)`. This code is upstream (PR #84) and stays byte-identical to it, but the app does not
use it any more: the verdict of the Analysis view comes from the TuningResult, in STE, with evidence links (section 13).

## 7. Adding a feature

Adding a JavaScript file takes three edits:

1. Create `js/<name>.js`.
2. Add `<script src="js/<name>.js"></script>` to `index.html`, **after** everything it
   depends on and before `js/main.js`.
3. Add `'./js/<name>.js'` to `distSources` in `gulpfile.js`.

Skipping step 3 gives a feature that works under `make dev-server` and is missing from
`make apps` and every release. CSS files need the same treatment (`<link>` in `index.html`
plus the `distSources` entry).

Analysis and Tuning are full-screen views at the level of the log viewer, not modals. To add a view, copy the Tuning
view end to end:

| Piece | Location |
|---|---|
| Tab | `index.html`, `.rf-view-tabs`: a `button.rf-view-tab` with `data-view` |
| View markup | `index.html`, before the dialogs: `section.rf-view` with an id, `role="tabpanel"`, `tabindex="-1"` and a body div |
| Constructor | a classic script with one global, `{ show(flightLog), hide() }` (`js/tuning_dialog.js`) |
| Construction and registration | `js/main.js`, `$(document).ready`: `views.<name> = ...` |
| Switch | `showView(name)` in `js/main.js`: it pauses the viewer, calls `hide()` of the old view and `show()` of the new one |
| Styles | `css/main.css` "Views" (the layer below the navbar) and the view's own CSS file |

Rules for a view: the viewer stays laid out under it (`visibility: hidden`), so a handler that is only for the viewer must
examine `activeView` (the keyboard and wheel handlers do). "Show in the log" (`viewInLog`) keeps a copy of the pilot's
graphs, zoom, marks and analyser and puts them back (`endEvidence`): it never calls `newGraphConfig`, which writes the saved
workspace. A small dialog (settings, header) stays a Bootstrap modal, as `header_dialog.js` is.

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
| 3. In the app: a Flight Analysis lab that shows the same numbers | Done: the Tuning view runs the toolkit unchanged in the app, and the Analysis view shows its verdict and the log lens. See section 13 |

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
| `js/graph_spectrum_calc.js:47` | Fixed with the views: `analyserTimeRange.in` was `this._analyserTimeRange.in`, and `setOutTime` with a range over 5 minutes threw `ReferenceError`. "Show in the log" sets such ranges. |
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

## 13. Analysis and Tuning views

"Log viewer", "Analysis" and "Tuning" are tabs at the same level. Analysis and Tuning are full-screen views, not modals:

- **Tuning** runs the toolkit of section 12 inside the app. The diagram is HTML (it scales with the text size): a band
  "Before the first flight" with the prerequisites (Blackbox log, RPM signal and motor poles, Battery and power, Mechanical
  parts, Rescue, Flight controller: "No problem found", "No data" or a problem), then the tuning blocks, parameters only
  (1 Filters, 2 Governor, then 3a Cyclic gains -> 4a Cyclic compensation and 3b Tail gains -> 4b Tail compensation and
  authority), each with its parameters, its checks as evidence and a chip per PID profile. `TuningDialog.focus({ node, fid,
  recs })` opens a block and its recommendation (the Analysis view links use it). The view also has recommendations with CLI
  text for the pilot to review, the export panel, error curves and the coverage of every parameter group.
- **Analysis** is the overview of subsystem health: ten cards from `f.area` (Battery and power, Motor and ESC, Governor,
  RPM signal, Vibration and mechanical parts, Control limits and authority, Tail, Cyclic, Transmitter and rescue, Blackbox
  log). A finding with `f.tuner` (its home is a tuning block) has "Open in the Tuning view"; a hardware or setup finding has
  "Items to examine". "Show in the log" opens a panel under the link with the logged fields of the check over the span of
  the result, so the text stays on screen ("Open in the log viewer" in the panel goes to the viewer). "Show the measurement"
  opens the plot of one result against its limit, with its caption. The Analysis view has no log lens (removed 2026-10-06:
  it repeated the log viewer).
- Every claim links to the part of the log it comes from ("Show in the log") and to a plot of the measured behaviour
  against its limit ("Show the measurement", with a caption of one STE sentence).
- Nothing is sent to the flight controller. All text that the views show is ASD-STE100 (`docs/STE_GLOSSARY.md`).

The upstream Flight analysis (`js/flight_analysis.js`, `js/flight_analysis_dialog.js`, its CSS and the `#dlgFlightAnalysis`
markup, PR #84) stays byte-identical to upstream and is not used. Only its toolbar button went: the tabs replace it.

### Files

| File | Role |
|---|---|
| `index.html`, `js/main.js`, `css/main.css`, `css/branding.css` | The tab strip `.rf-view-tabs`, the view sections `#viewAnalysis` (`#analysisVerdictBody`) and `#viewTuning` (`#tuningBody`), `showView`, `viewInLog`, `endEvidence`, the evidence bar, the keyboard and wheel guards |
| `js/tuning_worker.js` | Web Worker. Loads the decoder scripts (`importScripts`) and the toolkit `.cjs` files (`fetch`, then a CommonJS shim), analyses, posts progress and one result. A second, persistent instance is the "derive" worker (`init`, `derive`) |
| `js/tuning_dialog.js`, `css/tuning_dialog.css` | The Tuning view: context bar (logs, flights, bench runs, phases), scope, flight rpm, CLI dump, PID profile menu, tabs "Tuning steps", "Recommendations", "CLI file", "Error curves", "Governor", "Filters and vibration", "Tail", "All checks", "Parameter groups" |
| `js/tuning_snippet.js` | `TuningSnippet.Reader`: the raw columns of one span of a log on the main thread, in frame seconds |
| `js/analysis_view.js` | `AnalysisView`: the Analysis view. The verdict from the TuningResult, with the "Show in the log" and "Show the measurement" panels |
| `js/log_lens.js`, `css/log_lens.css` | The pieces that the verdict shares (`LogLens.internals`), and the `LogLens` class, which the app no longer builds |
| `js/tuning_plot.js` | Canvas plots: linear and log axes, two y axes, NaN gaps, uncertainty bands, hover readout, click to seek |
| `tools/autotune/catalog.cjs` | One entry for each check id: STE noun, unit, scale, home item, subsystem (`areaOf`), Tuning tab, evidence spec, the lead texts (symptom, why, good, info) and the summary template; `summary(f)`, `lead(f, status)`, `status(f)`, `display(f)`, `tunerOf(f)` |
| `tools/autotune/hierarchy.cjs` | The prerequisites (`PREREQ`: 6) and the tuning blocks (`BLOCKS`: 6, parameters only), 22 edges (`EDGES`: gate with an optional `scope`, order, cause with an optional `viaRules`, validity), K rules K1-K27 (`RULES`), `graph()` (the K1 shape), `status`, `causesOf`, `gateUpstream`, `homeOf`, `isPrereq`, `isBlock`, `LEGACY` (the round 1 ids) |
| `tools/autotune/health_config.cjs` | Check D9: `rescue_mode` of each PID profile, from the CLI dump, a rescue state in the log or a header value |
| `tools/autotune/health_power.cjs` | Checks P1 (the battery voltage at the load steps, for each flight log) and P2 (the voltage decrease for each 1 A, for each battery) |
| `tools/autotune/evidence.cjs` | The spans in frame seconds, the viewer request and the plot spec of each finding (`timeMap`, `toFrame`, `locate`, `forFinding`, `forDecision`) |
| `tools/autotune/health_track.cjs` | Checks C12/T11 tracking error, C13/T12 time delay, R1 stick-to-setpoint time delay, C5/T1 fast oscillation; `curves()` |
| `tools/autotune/health_more.cjs` | `normalMask` and D6 (rescue, level modes, failsafe), F10, F11, T13, C14, T14, G14; `curves()` |
| `tools/autotune/health_phase.cjs` | Flights and flight phases (`phases`, `flightMask`), D7 log class, G15-G18 and C15 |
| `tools/autotune/health_rescue.cjs` | The checks at each rescue start: G19 headspeed, T15 tail, D8 PID profile change (all phases, rescue included) |
| `tools/autotune/health_limits.cjs` | Control outputs at their limits (CLAUDE.md "Control limits"): L1 throttle, L2 collective, L3 cyclic, L4 tail, L5 servos, L6 I-term, L7 collective stick at its end, in all phases with no guard time |
| `tools/autotune/advice.cjs` | Findings and `report.cjs` decisions to recommendations: tuning sequence, guards, causes, CLI text, `exportScript`; the coverage matrix; the configurations of a recommendation (`dataset`, `supportedBy`, `ab`, `slope`), `comparisons`, `filterRecommendations` |
| `tools/autotune/datasets.cjs` | The configurations (SPEC3 J): one PID profile with one exact set of the values that change the flight. `datasets(logs, cli)`, the classification table of every 4.6 name, `labelArray`, `profileMap`, `compare` (A/B, slopes, 2 SE), `predict` |
| `tools/autotune/filter_tune.cjs` | The filter search (SPEC3 G): a model of the 4.6 gyro filters, its parity with the recorded gyroADC, the search, leave-one-out, `texts` (STE). The worker command `filterTune` runs it on demand |
| `docs/STE_GLOSSARY.md`, `test/ste/vocabulary.json`, `test/ste_text.test.cjs` | The STE rules, words and lint |

Tests: one file for each part (`test/catalog.test.cjs`, `hierarchy`, `evidence`, `health_track`, `health_more`,
`health_phase`, `advice`, `tuning_worker`, `tuning_plot`, `tuning_snippet`, `tuning_dialog`, `log_lens`, `analysis_view`, `views`,
`ste_text`), with simulated ground truth for every check, one test for each advice generator and guard, and real-data smoke
tests. `test/tuning_worker.test.cjs` with `AUTOTUNE_REAL_LOG` set to the path of the Gaui X4 dump
`RTFL_BLACKBOX_LOG_20261004_113720.BBL` also runs on its log #50.

Every new file needs its `index.html` tag (app scripts and CSS) and its `distSources` entry in `gulpfile.js` (also every
`.cjs` the worker fetches). The registration tests in `test/tuning_dialog.test.cjs`, `test/log_lens.test.cjs` and
`test/tuning_worker.test.cjs` (T0) fail when one is missing. Script order in `index.html`: `js/tuning_plot.js`,
`js/tuning_snippet.js`, `js/tuning_dialog.js`, `js/log_lens.js`, `js/analysis_view.js`; `css/log_lens.css` after
`css/tuning_dialog.css`.

### Views and "Show in the log"

- `showView(name)` pauses the viewer, calls `hide()` of the old view and `show(flightLog)` of the new one. The viewer stays
  laid out under the views (`visibility: hidden`), so its canvas keeps its size. A keyboard or wheel handler that is only for
  the viewer examines `activeView`.
- `viewInLog({ log, fromS, toS, atS, graphs, analyser, title, text, from })` opens the log viewer on a span:
  - It keeps a snapshot of the pilot's graphs, zoom, time, marks and analyser, then shows the fields of the evidence. It never
    calls `newGraphConfig`, because that writes the saved workspace (`prefs.set('graphConfig', ...)`).
  - It sets the in and out marks on the span and fits the zoom to 1.1 x the span, within the zoom levels of the viewer
    (`fitGraphToSpan`, `zoomForWidth`).
  - The evidence bar says what the span shows, with "Back to Tuning" or "Back to Analysis". `endEvidence` puts the
    snapshot back.
  - A log that the pilot picks in the log picker of the legend while the bar shows ends the bar (`evidenceLogPicked`, a
    delegated change handler after the picker's own one): the pilot's graphs, analyser, zoom and legend title come back and
    the picked log stays. Before 2026-10-06 "Back to ...", a view tab and the close button opened the log of the snapshot again,
    so the pilot could not select another log after a "Show in the log" (NW.js audit V3).
- Every log that the viewer opens makes a new grapher, and so a new analyser (`selectLog`). `grapher.destroy()` now destroys its
  analyser and step response, and the analyser binds its handlers on the shared controls (spectrum type, overdraw, zoom, canvas)
  in its own event namespace. Before, the handler of an analyser that never drew threw at the next spectrum type change
  (`dataBuffer.curve` 0) and stopped the handler of the open log: in 2.3.0 and upstream too, but "Show in the log" opens logs
  more often (`test/viewer_regression.test.cjs`).
- `js/graph_spectrum_calc.js:47` now reads `this._analyserTimeRange.in`: an analyser range of more than 5 minutes threw a
  `ReferenceError` before, and "Show in the log" sets such ranges.

### Time base

Every span in the evidence and every seek use frame seconds from the log start, the clock of the viewer:
`frameS = (frame time - getMinTime(log)) / 1e6`, and `us = getMinTime(log) + frameS x 1e6`. The modules give index time
(`w.fromS + i / actualRate`). `actualRate` is the mean rate of the longest part with no gap, and the frame clock drifts from
it: about 0.6 ms for each second on the Gaui X4 #58 (196 ms at 320 s), 70 ms at most on the Fireball #3. The worker keeps a
time map for each segment (`evidence.timeMap`: the frame time of every 250th sample, from `w.extra.time`) in
`records[].timeMap`, and `evidence.toFrame` converts. The plots and the lens use the same map.

### How the worker reuses the toolkit

The toolkit files are not copied. The worker fetches them as text and compiles each one as a function expression
through an indirect eval, `(0, eval)('(function (require, module, exports, process, __dirname, __filename, console) {...})')`,
with a `sourceURL` so that stack traces name the file:
- `require` returns sibling modules, a virtual in-memory `node:fs`, a posix `node:path` and a `node:vm` whose
  `runInContext` is an indirect `eval` in the worker.
- `process.env.AUTOTUNE_FLIGHT_RPM` carries the flight rpm. Each flight rpm gets its own module registry, because the toolkit
  reads it at load.
- `require.main` is undefined for library use. `health_report.cjs`, `extract.cjs` and `report.cjs` run as "virtual CLIs" over
  the in-memory fs.
- Optional modules (`health_track`, `health_more`, `health_phase`, `health_rescue`, `health_limits`, `health_config`, `health_power`, `advice`, `catalog`, `hierarchy`,
  `evidence`, `datasets`): a module that is missing or that throws gives a note, and the rest of the result stays. `filter_tune` (`ON_DEMAND`) is fetched with
  the others and loaded only by the command `filterTune` (`K.require`).
- Rules for anyone editing `tools/autotune`:
  - no Node API calls when a module loads (the `require('node:*')` lines are fine);
  - keep `module.exports` followed by `if (require.main !== module) return`;
  - add every file the worker loads to `distSources` in `gulpfile.js` (`APP_ASSET_SOURCES` on the web-app branch).
- `test/tuning_worker.test.cjs` fails on drift. With `excludeAbnormal: false` and `phases: false` the worker's records and
  findings must equal the CLI's byte for byte. `coreFindings` removes the fields that only the app adds (`fid`, `summary`,
  `evidence`, `node`, `phase`, `pidProfile`, `explained`, `filterPass`).

**This log** (a few seconds):
1. The view slices the selected log out of the file (`FlightLogIndex.getLogBeginOffset`) and transfers the slice.
2. The worker decodes it with unmodified `lib.segments`, and finds the flights and the flight phases (`health_phase.cjs`).
   A bench run stops here.
3. It derives the flight rpm: 85 % of the lowest per-profile governor target in flight, in 100 rpm steps (1900 on the Gaui X4,
   2900 on the Fireball). The user can override it.
4. It runs `health_setup`, `health_gov`, `health_loop`, `health_track`, `health_more` and `health_phase`. The flying mask of
   the attitude-loop checks is the flight phase (`flightMask`) without rescue, level modes and failsafe (`normalMask`).
5. It judges with the virtual `health_report.cjs`. Then each finding gets `fid`, `summary`, `node`, `evidence`, `phase` and
   `pidProfile`. Then advice, then `hierarchy.status`, then curves.

**All flights in the file** (the default of the "Logs" control since 2026-10-06; the worker command `analyseFile`):
- Every flight log is run as above, with one flight rpm for the file, and judged together. Bench runs are listed, not
  analysed.
- `extract.cjs` and `report.cjs` then add the gain decisions (three or more flights per gain set, section 12), with
  evidence (`forDecision`, check C7).
- Cost in Node: about 40 s for the 108 MB Gaui file and 110 s for a 131 MB Fireball file, 1.7 GB peak. NW.js under Rosetta
  is about twice as slow.

**The derive worker.** The Tuning view keeps one more worker for the whole session, and the Analysis view uses it through
its hooks. `{ cmd: 'init' }` loads `lib`, `health_track`, `health_more`, `health_gov` and `catalog` once; it never decodes a log.
`{ cmd: 'derive', id, kind, rate, cols, params }` answers `{ id, type: 'derived', result }` for the kinds `bandpass`,
`lowpass`, `pt2`, `shift`, `spectrum` (Welch, Hann), `transmission` (raw to filtered gain, phase, coherence and time delay)
and `window` (the values of the log lens). The raw columns come from `TuningSnippet.Reader` on the main thread: the open log
through the viewer's own `FlightLog` (`getChunksInTimeRange`, 12 s or less for each call, so the chunk cache stays small),
another log of the file through a `FlightLog` over its bytes (one kept). `Reader.sync()` forgets that copy when a new file
opens; every read and each view's `show()` call it. `derive(kind, cols, rate, params, transfer)` sends the column buffers in
the transfer list when `transfer` is true.

### Findings for the app

The worker adds these fields to every finding before advice:

| Field | Value |
|---|---|
| `fid` | `module\|id\|log\|segment\|profile\|axis\|k`, unique in the result; with configurations `module\|id\|log\|segment\|profile\|axis\|dataset\|k`. Recommendations, links and `explain()` use it |
| `dataset` | the configuration of the finding ('A', ...; round 3 M1), or null: a header or global check, or a PID profile label with more configurations in its log. `datasetLabel`: the label of the module (see "Configurations") |
| `summary` | `catalog.summary(f)`: two paragraphs joined by `\n` (SPEC3 F): what the helicopter does and why it matters, then the number against its limit. STE, 6 sentences or fewer in each paragraph, 25 words or fewer each, from the fields only. A value to monitor starts with "Possibly," |
| `node` | `hierarchy.homeOf(f.id, f.axis)`: a prerequisite or a tuning block id |
| `tuner` | true when `node` is a tuning block: a "poorly tuned parameters" item that the Analysis view links to the Tuning view; false for a prerequisite (hardware or setup) |
| `area` | `catalog.areaOf(f)`: the subsystem of the Analysis overview: power, motor, governor, rpm, vibration, limits, tail, cyclic, radio or logging |
| `evidence` | `evidence.forFinding(f, ctx)`: spans, viewer request, plot spec, expected behaviour, overlapping findings |
| `phase` | the flight phases that the check uses: `flight`, `all`, one phase of `health_phase.cjs`, or `null` for a header check |
| `pidProfile` | 1-6, or `null` (unknown, or not a PID profile: D4, F4, H) |
| `filterPass`, `explained` | F5: the measured gyroRAW to gyroADC transmission at each line. A flag that every recommendation treats as information |
| `status`, `noun`, `display` | from `catalog.cjs`: the status word, the noun, and `display = { value, bound, limit, unit, scale, profile, phase }`. `display.value` is the value in the unit of the rule (for example "1 loop stall", "54.6 x the median level at 3 x the rotor frequency"), and `display.bound` the limit in that unit, the same in log and file scope. The views show these, never the raw toolkit `value` or `threshold` |

The other session's modules write text that is not STE, and we do not edit it. The views show the catalog summary of every
finding, and the raw `text` in a collapsed `<details data-ste="quoted">` "Toolkit text (not STE)". "Save report" keeps both.
Our modules mark a result with too little data with `thin: true` (not a text that code parses).

### Catalog

`catalog.cjs` has one entry for each check id: D1-D9, H, SETUP, F1-F11, G0-G20, C1-C15, T1-T15, R1, C7, L1-L7, P1 and P2. Each
entry gives an STE noun of three words or fewer, the display unit and scale, its home item, its subsystem, its Tuning tab, the
evidence spec (source, pads, fields, analyser field, plot kind and reference lines, expected behaviour), the lead texts and a
summary template. Limits come from the finding's `threshold` and the modules' `DEFAULT_RULES`; a threshold that is only a string
is shown as quoted text.

Texts that a pilot understands (SPEC3 F): `LEAD` gives each check `sym` (what the helicopter does when the result is a problem or
a value to monitor), `why` (why it matters), `good` (when satisfactory; else the expected behaviour of the evidence spec) and `info`
(the lead of a result that only reports). The summary puts them first, then the number against its limit. Internal quantities
get their meaning: C14 is "deg of cyclic pitch for each 1 deg of collective" (both in mixer units, 1000 = 12 deg), not I-term
units. The 2-SE rule is a sentence of `display.limit` (`SE_NOTE`), not a "(2 SE test)" in the summary. C10 with no axis (the rotor
at flight speed while the firmware shows "landed") is information only: the helicopter becomes airborne slowly.

`status(f)` maps a finding to the status words of the glossary: flag to Problem, note to Monitor (Information for report-only
checks), a thin note to Not sufficient data, ok to Satisfactory, skipped to Not measured, error to Analysis error. A check can
give its own status (`statusOf`): D2 is a problem only for a loss of 1 % of the frames or more (a loop stall alone is
information, a smaller loss a value to monitor), C10 "landed" and G20 are information.

### Evidence, "Show in the log" and "Show the measurement"

`evidence.forFinding` gives `{ v: 1, fid, id, log, profile, axis, spans, view, plot, expected, summary, facts, context }`:
- `spans`: 3 or fewer, worst first, in frame seconds, with the pads of the check (D2 ±0.25 s, G3 from 0.3 s before the step
  to the end of the recovery, C6 4 s after the step, ...). The blocks, windows and runs that the modules count but do not
  time (G2, G9, G11, C8, C10, C11, F5, D5) are found again by `evidence.locate` in the worker, while the segment is decoded,
  with the masks and `RULE` values of the modules. Their counts equal the modules' counts, or the group is dropped.
- `view`: the viewer request (span, the time to show, the graphs, the analyser field). Header checks (D1, D3, D4, F1-F4, F8,
  F9, H, SETUP) have no span: their plot is a table of the header keys and values.
- `plot`: the kind (time, spectrum, transmission, phase, governor, events, scatter, table), the curve in the result curves of
  that log or a snippet spec (`fields`, `derive`), the reference lines and bands of the limit, and `caption`: one STE sentence
  that says what the curves are and where the limit is (`evidence.CAPTION`, else the sentence of the plot kind).
- `context`: the other findings whose spans overlap (D6, D2, C2, T8, C5, T1, G1, G6), so that a plot shows them.

"Show in the log" opens the same inline panel below the selected result in Analysis and Tuning. Both use
`LogLens.internals.logPreview` to read the same padded frame window, shade its evidence spans and show its freshness flags.
The shared `logPreviewHtml` and `logPreviewBody` render the same controls, layout and plots with the `analysis-compare`
styles. In Tuning tables, the panel occupies a row below the result. A second click on the same link closes the panel.
"Open in the log viewer" calls `hooks.viewInLog` with the original evidence request. Closing the preview does not move the
viewer or change its graphs. Tuning discards pending preview reads when the panel closes, the result changes or another file
opens. "Show the measurement" draws the measured values inline: from the curves, or from a snippet that `TuningSnippet.Reader`
reads and the derive worker filters, with the spans shaded.

### Tuning sequence

Tuning displays readable parameter labels, such as "Roll P", "Pitch I" and "Governor D", throughout its steps,
recommendations and parameter tables (`parameterLabel` in `js/tuning_dialog.js`). Tooltips retain the firmware identifiers.
CLI commands and exported reports keep the original names.

`hierarchy.cjs` holds the Rotorflight tuning order from the rotorflight.org documentation (2.3.0), the Configurator help texts,
the firmware and the old wiki (SPEC3 A, B, K1). Every item and edge has its source. `graph()` gives the diagram:
`{ prereq, blocks, edges, rules, nodes }`.

- **Prerequisites** ("Before you tune", done before the maiden flight): Blackbox log (D1-D4, H), RPM signal and motor poles (G1,
  G12, G20; the gear ratios in the configuration are correct), Battery and power (D5, G13, G11, P1, P2), Mechanical parts (F7, C15,
  T4, the cyclic I rule of SETUP), Rescue (D9, D8, D6), Flight controller (`pid_mode`, `rates_type`, D7, R1, L7). They are assumed
  to be correct: a status `ok` ("No problem found", with `checksRun`), `problem` (a clearly measurable issue: a flag with an
  action or a check; D4 never, D2 only for a loss of frames) or `noData`. Never "Blocked", never "Start here". Their problems are
  in `prereqProblems`, and they gate the blocks that need them.
- **Blocks** (parameters only, names of 4.6 settings.c): 1 Filters, 2 Governor (one block), then two lanes: 3a Cyclic gains -> 4a
  Cyclic compensation, 3b Tail gains -> 4b Tail compensation and authority (precompensation, stop gains, the tail output limits,
  the tail torque assist; the headspeed gives the tail more authority). The measurements (D-term noise, tracking error, time
  delay) are evidence in the blocks. `chips` are groups of parameters with the checks that inform each.
- **Edges**: gate (rpm > filters with `scope` F3, F5, F6, F9: the RPM signal holds only the RPM notch filters), order, cause
  (`tailcomp > tail` with `viaRules`: the tail authority causes tail gain symptoms only through a K rule with its time test),
  validity (D1).

Status of a block (`status(findings, recommendations, { logs, coverage })`, for each PID profile and for all):
- **Blocked**: a problem with a problem upstream along gate edges (a prerequisite or a block).
- **Possible result**: a problem with a problem upstream along a cause edge or a matching K rule.
- **Start here**: a problem that is neither, and no block before it (filters, governor, its lane) has a problem or a gate upstream
  with a problem. A later block never starts while an earlier one waits: it gets **Problem** and `after` (the items to correct
  first). When a prerequisite problem gates the blocks, `startHere` is empty.
- **Satisfactory**, **Not measured** (the reason comes from the coverage), **Not applicable** (the governor in DIRECT or LIMIT),
  **Not accurate** (all findings from logs at less than 1 kHz, check D1).

`advice.cjs` takes `blockedBy` and `gate` from the same gate table, so the diagram and the list agree: a recommendation is
blocked if and only if its node is Blocked (`test/hierarchy.test.cjs`, `test/advice.test.cjs`). A gate with a scope holds only the
changes of its checks (a low-pass filter change keeps its CLI text with a G1 problem). `causesOf` gives the K rules that make a
finding or a recommendation a possible result of upstream flags (same log, compatible PID profile and axis). `LEGACY` maps the
ids of round 1 (setup, servos, mixer, tailmech, rotor, rpm, gears, log, notches, lowpass, dnoise, govset, govgain, tta, rates,
rescue, result) to the new ones.

### Recommendations

`advice.advise(input)` is pure. The list follows the tuning sequence: step and row, then the documented sequence inside
a step (D, P, I, then FF on the same axis: K7), the axis and the severity. Every text is STE and is written by advice, not
copied from a finding. Guards, each with a test in `test/advice.test.cjs`:
- gates from `hierarchy.cjs`: no gain increase while an upstream step (filters, output range, governor setup, mixer) has a
  problem;
- a recommendation with a cause (K rule) is a "Possible result" and gets no CLI text until its cause is resolved, unless the
  cause is only a watch or information;
- the 2-SE gate;
- steps of at most 20 %, except the documented absolute steps (governor F 10, I 25, P 10; TTA 10; tail D 10);
- never a gyro low-pass filter below 60 Hz or a notch filter Q below 2.0;
- no governor gains in DIRECT;
- known misleading raw flags (loop stalls after disarm, F5 without a CLI dump) become checks, never actions;
- the gear ratios in the configuration are correct (CLAUDE.md "Gear ratios"): a line that is not a rotor harmonic is a
  resonance, a target for a notch filter and a mechanical vibration to examine. G12 names `motor_poles` or the RPM sensor.

The Coverage tab ("Parameter groups") lists every parameter group with what was assessed, or why not: the log does not record
the values (`not-in-log`, formerly `needs-cli`: the log is the only necessary input, CLAUDE.md "No access to the flight
controller"), log fields are necessary, more flights are necessary, or a log cannot show it.

### PID profiles

- Every finding, span, lens flag, recommendation and export line has its PID profile. The UI writes "PID profile 1" to
  "PID profile 6", as the Configurator does. Only CLI text writes `profile 0` to `profile 5` (CLI `profile q` is log profile
  q + 1).
- The log before the first profile switch has three labels in the toolkit: `'arm'`, `0` and an inferred profile. The worker
  gives the modules the raw label 0 for that stretch, never the guess of `lib.profilesOf`. `f.pidProfile` maps 0 to the
  arming profile only when `records[].profiles.arming.confirmed` (basis `event`, `cli`, `cliTarget` or `headspeed`) is true.
  An inference from the governor target (`govTarget`, `fileTarget`) goes to `arming.estimate`, and the stretch stays "PID
  profile unknown", with no CLI text and no export. Advice, the catalog, the hierarchy and the views read `f.pidProfile` first.
- `headspeed` needs no CLI dump: `govRequest` before the first PID profile change is the `gov_headspeed` of the active PID
  profile (governor.c), and the logged PID profile changes of the file (bench runs too) give the headspeed of each PID profile
  (`hsInfo`, `hsMap`). A value that exactly one PID profile has at those changes confirms it, except when the first change of
  the log goes to that profile. `arming.headspeed` has the evidence: `{ headspeed, why (null | noField | zero | changes |
  none | shared | excluded | cliShared), profile, profiles, values, observations: { switches, logs }, map, dumpSections }`.
  Limit: a PID profile that no logged change shows can have the same headspeed.
- The log wins over a CLI dump. A `gov_headspeed` of the dump that the logged changes contradict is older than the log and is
  not used (`staleHeadspeeds`: not by `cliTarget` either). A dump whose section of the profile does not agree with the header
  does not stop the headspeed step: the `cli` basis goes and `dumpSections` lists the sections that agree. Only a dump that
  agrees with the log can stop it (`cliShared`: the dump gives the same `gov_headspeed` to another candidate).
  `result.cliStatus = null | { name, used, conflicts: [{ what: 'gov_headspeed' | 'header' | 'profile', text, ... }] }` with
  a note; `used` is true when the header of an analysed flight log agrees with a section of the dump. With the Fireball dump of
  2026-09-04 (every `gov_headspeed` 1800) the six flight logs of 2026-10-05 were "PID profile unknown"; now they keep the PID
  profile of their headspeed.
- D4 marks a CLI value as old only when `cliSection.usable` is true: the compared section is the one of the confirmed arming
  profile, not one that a guessed label chose.
- A "from" value of PID profile p comes only from the CLI section `profile p-1`, from the gains that `report.cjs` recovered
  for p (an estimate, no CLI), or from the log header when p is the confirmed PID profile at arming.
- The diagram has a PID profile menu: one PID profile, or "All PID profiles" with one status for each PID profile.
  `hierarchy.status` gives `byProfile` (the status of each PID profile), `profiles` (their keys, `'0'` for unknown) and,
  for each node, `profiles: { [key]: status }`. The findings of a bench run do not count.
- Rate profiles: the worker finds the rate profile changes (adjustment function 1) and keeps them in
  `result.profiles.rateChanges`. When a log has one, a note says that check R1 uses the rate values of the log header, which
  are those of the rate profile at the start of the log.

### Values that are possibly not current

CLAUDE.md "Values that are possibly not current": firmware 4.6.0 writes the log header once, at the first arm of the log, with the
values of the PID profile and the rate profile active then. A re-arm in the grace period (`blackbox_grace_period`, 5 s) goes on in
the same log with no new header and no event, and an MSP write while armed (the Lua script of the transmitter, the Configurator)
leaves no record. `tools/autotune/param_epochs.cjs` (another session; the worker loads it as `K.epochs`) cuts a log into spans with
the reasons `grace`, `rearm`, `switched`, `unlogged` (a `govRequest` step with no PID profile event), `adjusted` and `resume`.

- The worker keeps the epoch events of each analysed log while it decodes it (`decode` -> `epochEvents`: SYNC_BEEP,
  INFLIGHT_ADJUSTMENT, LOGGING_RESUME, DISARM, FLIGHT_MODE, LOG_END in frame seconds) with `frameS` and `govRequest` cut to the
  first and last sample of each run of one value (`epochCollect`, before a flight selection cuts the log). After advice, when the
  PID profile at the start of each log is final, `freshnessOf` runs `paramEpochs` once for each log with that profile.
- `result.epochs = [{ log, spans: [{ ...span (t0, t1 frame s), source: { pid, rate }, text }] }]`. Source: `header`, `cli`,
  `log N` (the header of log N, 0-based as `datasets.cjs` sources), `recovered` (advice used the gains that `report.cjs` recovered),
  `adjustment` or `none`, from the configuration labels of `datasets.cjs` (no configurations: the CLI section, else `none`). `text`
  is '' for a fresh span, else one STE sentence for each reason and the source.
- `result.freshness = { caveat, reasons: { [reason]: text } }`: the caveat applies to every span, also a fresh one.
- `f.stale = null | { reasons, text, spans (3 or less) }`: the time of a finding is its events (a period, an entry: frame seconds
  `tS`/`t1S` when it has them) or its times; else what it measured: the phases of `f.phases` while armed, in the spans of its PID
  profile (label 0: the start). A grace span counts only for events and times. The checks of the log itself (D1, D2, D3, D6, D7, H)
  get null. Each period of L1-L7 (`events`) has its own `stale`; `r.stale` and `issues[].stale` are `{ reasons, text, findings }`
  over the results that they cite.
- `f.stale`, `r.stale` and `issues[].stale` also have `source`: the STE sentences of the source of the values (CLAUDE.md: each
  flag gives the source, or "unknown"), the source of the largest part first. A `cli` source of a dump that the log contradicts
  says "a CLI dump that does not agree with the log".
- Real files (2026-10-06, file scope, no dump unless named): Fireball 2026-10-05 (16 logs, 14 with data): 59 spans (fresh 15,
  grace 20, rearm 8, switched 22); stale findings 793 of 955 (rearm 159, switched 731), flags 84 of 110, limits periods 60 of 70,
  recommendations 41 of 53 (rearm 25, switched 40). The pilot arms in PID profile 1 and flies most of the time in PID profiles 2
  and 3: the values of PID profile 2 come from the header of the nearest log armed in it (`datasets.cjs`: logs 7 and 12), those of
  PID profile 3 are unknown. With the dump of 2026-09-04:
  the same PID profiles at the start (logs 6, 11, 14 to 16: PID profile 1, log 12: PID profile 2, basis `headspeed`; before: all
  six "PID profile unknown"), `cliStatus.used` false with three `gov_headspeed` conflicts (1800 against 3500, 4500 and 5000 rpm) and
  one `header` conflict, PID profile 3 from the dump. Gaui X4 113720 (2000 rpm): 213 spans in 59 logs (fresh 65, grace 80, rearm
  34, switched 51), stale findings 474 of 800 (all switched), recommendations 15 of 25; logs 50, 51 and 59 start in PID profile 1,
  log 52 in PID profile 2; PID profile 3 from the header of the bench run 33.
- Synthetic tests: `test/tuning_worker.test.cjs` "values that are possibly not current" (a re-arm at 4 s in the grace period of a
  disarm at 3 s; a switch to a PID profile whose header is in another log; a rate profile switch and an adjustment; a
  `govRequest` step with no event) and "a CLI dump that disagrees with the log". `test/helpers/bbl_encode.cjs` writes DISARM,
  FLIGHT_MODE and SYNC_BEEP events (`log.events`).

### Flights, phases and bench runs

`health_phase.cjs` (the health module contract: `EXTRA`, `RULE`, `DEFAULT_RULES`, `analyse`, `judge`, `curves`):
- `phases(w, ctx)` gives `{ flight, spans: [{ phase, i0, i1 }], liftoffs, touchdowns }` in samples. The phases are idle (armed,
  governor OFF or IDLE), spool-up (SPOOLUP, or the headspeed ramp before ACTIVE), ground (ACTIVE before the liftoff and after
  the touchdown), flight (liftoff to touchdown) and spool-down (throttle cut, AUTOROTATION, OFF). The worker converts them to
  frame seconds (`records[].phases`, `records[].flights`, `result.flights`).
- `flightMask(w, ctx)` is the flight phase. The worker ANDs it into `ctx.flying` for the attitude-loop checks.
- Signals: AIRBORNE_STATE (on the Gaui it sets 1.2-4.3 s before the liftoff and drops 0.5-1.3 s after the touchdown, so it
  only bounds the search), the headspeed at the flight rpm with the governor ACTIVE, the collective (more than 300 for 0.5 s),
  the body motion, and the touchdown jolt (106-226 deg/s roll that rings at about 10 Hz on the Gaui). Logs without
  AIRBORNE_STATE use the data only.
- A log with one or more flights is a flight log. A log with no flight is a bench run: the analysis does not use it, and the
  views list it as "Bench run (no analysis)". A candidate is a flight if its roll and pitch movement (0.1-2 Hz) is 3 deg/s
  rms or more, or 1 deg/s or more with a touchdown jolt or an altitude rise of 0.5 m. On both Gaui dumps flights move 14.8-60
  deg/s and bench runs 0.08-0.17 deg/s. The AIRBORNE flag and the governor do not decide it: bench spool tests set both.
- In file scope the advice uses the header of a flight log: the selected log if it is one, else the last flight log
  (`result.headerLog`, with a note).
- `report.cjs` gets a segment only if 90 % of it is in the attitude mask (flight phase without rescue, level modes and
  failsafe) and it lies between the liftoff and the touchdown + 0.1 s (`SEGMENT` in the worker). On the Gaui dump this keeps
  4 of 10 segments, too few for a gain decision (3 flights for each headspeed bin).
- The governor runs three times in a flight log (`metrics.gov.phaseMasks`): all phases for D5, G12, G13 and the states;
  ground and flight phases for the G1 glitch test; ground and flight at the flight rpm or more, without rescue, level modes and
  failsafe, for G0 and G2-G11 (health_gov adds its own ACTIVE gate). The findings carry `phase` ('all' or 'ground+flight')
  and `phases`.
- The attitude-loop checks (C*, T*, tracking error, time delay, oscillation, gain recovery, the `report.cjs` segments) and
  the filter and vibration checks use the flight phase only, without rescue, level modes and failsafe. The governor, motor,
  ESC and power checks use all phases of a flight log, with rules for each phase.
- New checks: D7 log class and phase seconds; G15 spool-up (ramp rate, duration, yaw rate during the ramp: a throttle ramp of
  101/s spun the Gaui in 5 of 5 spool-ups, 34-41/s in 0 of 7); G16 governor handover from SPOOLUP to ACTIVE (overshoot or
  undershoot of the headspeed, throttle step, settling time); G17 motor kick (a step of `motor[0]` or of the headspeed that the
  throttle does not cause, at arming, idle or spool-up, and a headspeed drop at constant throttle, a sign of sync loss); G18
  idle; C15 ground resonance before the liftoff (a roll or pitch oscillation on the skids; keep the collective low until the
  governor is ACTIVE).
- Ground truth: Gaui #49, #50, #51 and #58 are flights, the other 55 logs of the dump are bench or ground runs
  (`analysis/gaui-x4/`, the peer census), and simulated logs have a known liftoff and touchdown.

### Export

The "CLI file" tab is the export panel. `advice.exportScript(recommendations, picks, meta)` writes the script;
`advice.defaultPicks` gives the first selection: actions with CLI text. Checks and items to monitor are never selected by
default.
- The script starts with a backup step ("Save `diff all` before you paste this"). Comment lines (`#`) give the craft, the log
  file and flights, the firmware, the PID profiles analysed, the date, and for each change the from and to values, the
  evidence (finding summary, value ± SE, limit) and the rule.
- Then `profile N` sets, `rateprofile N` sets, the other sets, and `save`.
- A change with `r.stale` (its results use values that are possibly not current, `js/tuning_worker.js`) stays selected. Its
  comment block gives "Values possibly different." and `r.stale.text`, and a comment line before its first command (or the
  same command of an earlier change) gives the flag again: "Change N uses values that are possibly not the values of the log
  header. Before you use these commands, read change N above." The worker writes `advice.script` (the CLI file of the saved
  report) again after `freshnessOf`, so that it has these lines too.
- Every value is range-checked against advice `RANGE` (from the firmware `settings.c`). A name that is not in `PARAMS` is
  refused.
- Buttons: "Copy commands" and "Save CLI file" (`.txt`). The pilot pastes the commands in the CLI tab of the Configurator, or
  uses its "Load from file" (Configurator 2.3.0 reads `.txt` or `.config`, and "Execute" sends each line; the firmware CLI
  ignores the text after `#`). There is no preset file: the Presets tab of 2.3.0 loads presets only from a source with an
  `index.json` (`advice.cjs`, the comment above `exportScript`).
- The export only writes a file or the clipboard. Nothing is sent to a flight controller.
- A "from" value names its source for each setting (`fromSources`): the CLI dump by its name (`cliName`) when the dump has
  the same value, else the log header.
- A CLI dump belongs to the file that was open when the pilot loaded it. Opening another file removes it. When the dump and
  the log header both have a craft name and they differ, the app does not use the dump.
- Each rule ends with one quoted "Source:" sentence (`rec.sources`). A source that is a result on another helicopter says so,
  and the text gives only the numbers of the pilot's logs. `confidence` is `measured` when the new value comes from a
  measured result, `predicted` for C7, and `advisory` for header values only.
- F5 reads every line of the finding: a main rotor harmonic (order within `RULES.harmonicTol`, 1 %, of an integer 1-8) that is
  rotor-locked, has a prominence of 5 or more, no notch filter within 2 % and a measured filter pass of `RULES.weakPass` or
  more gets the RPM notch action, also when a stronger resonance is in the log. Lines at the resonance order ± 1 are its
  sidebands and get no RPM notch.
- A line within `RULES.harmonicTol` of tail rotor harmonic j (1-4, j x the tail rotor order of the CLI dump, else of the log:
  `c.gear`, below) is a rotor harmonic, not a resonance: it gets the same RPM notch action with source 20 + j.

### Log lens and the Analysis verdict

The app no longer builds the log lens (2026-10-06). The rest of this list describes the `LogLens` class of `js/log_lens.js`,
which `test/log_lens.test.cjs` still tests; the verdict uses only `LogLens.internals`.

- `LogLens(container, hooks)` renders into a container: `show(flightLog)`, `hide()`, `setResult(result)`, `goTo(log, t0, t1)`.
- A timeline of the whole log: the headspeed (or the throttle), the PID profile strip, the flight phases with the time out
  of flight shaded, the evidence spans by status, and the window as a box to pull.
- Under it: strip charts of the window (setpoint and gyro with the error on each axis, headspeed against the target, tail
  output against its limits, D-term) and the panel "In this time window": the findings whose spans overlap the window, and the
  window values of `derive('window')` with their limits and checks (tracking error against 0.30 and 0.45, oscillation in the
  wag bands against 20 deg/s, headspeed error against 1 % and 2 %, time at the tail output limit, D-term power share at more
  than 30 Hz against 0.5, the strongest gyro lines). "Show" draws a plot of the window.
- The wheel over the charts moves the window by 10 % of its width, Ctrl or Cmd and the wheel zoom (0.5 s to 60 s), a pull on
  the timeline moves it, and so do the arrow keys. Requests wait 150 ms with no change. The lens keeps one request on its
  way at most and sends only the latest window next, and an answer for an older window is dropped. The viewer follows the window (`setViewerWindow`: time and zoom, no view switch).
- Without a TuningResult the lens shows the window values. The "Start the analysis" button is in the verdict; the lens shows
  its own only when its hooks have `runAnalysis`.
- The verdict (`js/analysis_view.js`) is our analysis, from the same TuningResult: a summary (the results for each
  status, the areas with a problem, the first steps of the tuning sequence, the flights and the bench runs), then one STE card
  for each subsystem area (see "Analysis" above). Each primary
  result has its status, value, limit and PID profile, "Show in the log" and "Show the measurement". One panel is open at a
  time, at the link that opened it (a row, an item, or one of the 3 most important items). "Show in the log" reads
  `evidence.view.graphs` (else the setpoint and gyro of the axis, else the headspeed) over the span plus 5 % on each side
  with `TuningSnippet.Reader` (60 s at most), one `TuningPlot` for each graph, the evidence spans shaded.
- "Start analysis" stays enabled while a run goes: it stops that run and starts one with the selected values (a run that has
  those values keeps going).
- The lens head lists every PID profile in the window, with its seconds when there are more than one. "Show" puts its plot
  above the values of the window and scrolls it into view.
- `TuningDialog.runAnalysis()` stops a run for another file or log first. It returns a Promise of the result, which rejects
  with `reason` "failed", "canceled", "replaced" or "start" (false when no file is open). The views show the error or the
  cancel, and give the button back.
- The views copy no catalog table: they show `f.status`, `f.noun` and `f.display` from the worker, and the "Start here"
  titles from `result.hierarchy.graph`. A raw-span compare plot puts the columns of a second unit (servo µs) on a y2 axis.

### Checks added for the views

Thresholds are in `DEFAULT_RULES` at the top of each module, each with its source. They are pipeline choices, not
validated in flight. Flags that have a standard error must pass a 2-SE test.

| ID | Measures | Rule |
|---|---|---|
| C12 roll, pitch / T11 yaw | rms(gyro(t + τ) − setpoint) / rms(setpoint), low-passed at 30 Hz, samples with \|setpoint\| > 5 deg/s, τ the best time delay in 0-150 ms; jackknife over 10 s blocks | note 0.30, flag 0.45 (the levels of the PID lab in `js/flight_analysis.js`) |
| C13 / T12 | that τ, the setpoint-to-gyro time delay | report; flag above 120 ms |
| R1 | rcCommand to setpoint time delay (rate shaping) | report; flag above 40 ms |
| C5 / T1 | stick-free band-passed error in the `wag.cjs` bands; shares at 10/20/40 deg/s; bursts that grow from < 30 to >= 150 deg/s | flag on a self-excited burst; note when the 20 deg/s share passes 0.05 |
| D6 | seconds excluded by `normalMask` | note; flag failsafe while airborne |
| F10 | share of axisD power above 30 Hz (yaw too); mixer rms above 30 Hz | flag yaw D share above 0.5 |
| F11 | gyroRAW to gyroADC time delay at 8-16 Hz | report; flag above 10 ms |
| T13 | median hover yaw I as a share of the yaw output range | flag above 0.15 |
| C14 | pitch I + O against collective, the implied `pitch_collective_ff_gain` change | flag at 20 per 1000 collective and a change of 10 or more |
| T14 | yaw at governor headspeed ramps, regressed to a `yaw_inertia_precomp_gain` change | 3 or more events, 80 % of one sign, change above max(15, 0.15 x header gain) |
| G14 | time and entries per governor state, spool-up ramp | note; flag airborne bailout, or autorotation above hover collective for more than 0.5 s |
| D7, G15-G18, C15 | log class and phase seconds, spool-up, handover, motor kick, idle, ground resonance | `DEFAULT_RULES` of `health_phase.cjs` |
| G19 | at each rescue, from 2 s before its start to 2 s after its end: the headspeed (0.2 s running median) against govTarget (govRequest in RECOVERY, SPOOLUP and BAILOUT, where the firmware starts the target from the headspeed), the time 10 % or more under it, the time with motor[0] at 95 % or more, the governor changes, the large load (the headspeed decreases with the throttle at 95 % or more before the governor changes) | flag: more than the G3 limit (5 %) by 2 x the signal change (median absolute deviation around the median; one rescue has no SE, the mean of 3 or more rescues has one), or ACTIVE to FALLBACK, RECOVERY or BAILOUT |
| T15 | the first 1.5 s of a rescue: the largest yaw error against the largest one from 2 s to 0.2 s before, and the time at the tail output limit (T8, else the clamp in the data) | flag: an increase of more than the T6 kick (30 deg/s), or a sample at 0.5 % of the tail limit or nearer |
| D8 | a PID profile change from 1 s before to 0.1 s after a rescue start, with both PID profiles and govRequest | flag: one change |
| F11 offset | the log writes gyroRAW 1 gyro sample after the filter input (firmware 4.6.0 core.c, blackbox gyroRAW timing; measured by the parity of `filter_tune.cjs`): F11 subtracts 1 gyro sample (the header `looptime`, 0.5 ms on the Fireball, 0.25 ms on the Gaui) from the measured time delay | `measuredMs`, `logOffsetMs` on the finding |
| D9 | `rescue_mode` of each PID profile (`health_config.cjs`): the CLI dump (`profile` sections; a `diff` without the line is the default OFF, firmware 4.6.0 pg_pid.c), else a rescue state in the log (the firmware runs the rescue only when `rescue_mode` is not OFF, rescue.c), else a header value (not in 4.6). The PID profiles that the analysis cannot read are listed | flag: a PID profile with `rescue_mode` OFF |
| P1 | at each load step (motor[0] up by 10 points or more in 0.5 s with the governor ACTIVE): the voltage before the step (0.3 s median) against the lowest 0.1 s median in the step (Vbat lags motor[0] by 68 ms), for each cell; the lowest cell voltage at a step; cells from the CLI or the firmware rule (battery.c) | flag ("possibly a weak battery"): a step from the warning level (`vbat_warning_cell_voltage`) or more to less than the minimum (`vbat_min_cell_voltage`), the levels of the log header; monitor: the lowest cell voltage at a step under the warning level |
| P2 | with `Ibat`: the voltage decrease for each 1 A at the steps with 10 A or more, for each battery (a new battery when the start voltage is 0.15 V for each cell or more over the end of the previous flight log) | information; monitor when 1.3 x the median of the other batteries by 2 SE |
| G20 | at each change to FALLBACK (LOST_HEADSPEED before 4.6), with or without a rescue: overload (the G19 overload test: the throttle at 95 % or more, a headspeed fall of 2 % or more, 0.3 s or less before the change), signal (the glitch rule of governor.c with the throttle under 95 %, before the change) or none | information. A G1 flag whose FALLBACK entries are all overload is `G1:overload`, a watch with rule K22: no problem of the RPM signal |
| L1-L7 | each sample at 0.5 % of its limit or nearer, gaps of less than 50 ms joined; for each period the frame times, the phase, the PID profile, the rescue state, the other outputs at their limits (a servo that follows its mixer input, correlation 0.9 or more, is the same output), the headspeed error, the rate error and the tracking ratio at the best time delay (C12) | Monitor for a period; flag for a period of 100 ms or more, an error more than G3, T6 or C12, or two outputs at their limits at the same time. Limits: L1 gov_max_throttle (CLI) or the firmware 100 %; L2 collectiveRange of the header (else `mixer input SC`); L3 the clamp in the flight data (the C2 rule, else `mixer input SR, SP`); L4 the T8 limits (else the clamp in the flight data, else `mixer input SY`); L5 the `servo` lines of the CLI dump only (the extreme of a servo in the data is the servo at the stick end, Gaui X4 #50); L6 SCALE.I x I gain x error_limit (CLI section, else the header for the PID profile at the start); L7 rcCommand[3] at ±500 (rc.c), in flight and in a rescue. Else "limit unknown" (skipped). The firmware has no PID sum limit: the mixer input limits are the output limits of the axes |

### The rescue checks and the control limits

- The worker runs `health_rescue.cjs` and `health_limits.cjs` after `health_loop.cjs` (they read its T8 limits) on all phases of a
  flight log (`allCtx`), with no guard time: the rescue and the time before it are where these checks matter. Their findings have
  `phases` = all phases, and `phase` = the phase at the rescue start or of the longest period. They give no curves.
- G1 and G19 (rule K22): a FALLBACK whose time lies at the large load of a G19 rescue (the governor change that ends it, 0.05 s or
  less) gets the recommendation `G1:overload`, a watch with the cause. The worker sets `f.resultOf` on such a flag, the catalog
  summary says "This is possibly a result of the problem of check G19 (rule K22).", and its status is "Monitor". Thus the RPM step
  does not gate the governor step. The other G1 flags stay a repair of the RPM source.
- Homes: G19 and L1 the Governor block, T15 and L4 "Tail compensation and authority" (the tail authority of SPEC3 B), D8 the Rescue
  prerequisite, L2, L3 and the cyclic servos (L5) "Cyclic gains", the tail servo (L5 with axis yaw) with L4, L6 the cyclic or tail
  gains by axis, L7 the Flight controller prerequisite (a command of the pilot). K22-K27 link them to the checks that their errors
  can cause. G20 (every FALLBACK) is evidence of the RPM signal: an overload makes G1 a watch with rule K22.
- The verdict has a card "Control limits" for L1-L7; the lens shows their periods (up to 10 spans each, `evidence.maxSpans`).

### Flight selection

`options.flights = [{ log, flight }]` (file scope, SPEC3 D; `flight` 0-based in its log, the order of `result.flights`; `flight: null`
is every flight of that log): the worker analyses only those logs, and the auto flight rpm comes from them only. A log with one flight, or with all its flights selected, is the whole log. In a log with more flights a
selected flight keeps the time from the touchdown of the flight before it to the liftoff of the flight after it (the segment is cut
by sample: `sliceSegment`). `result.selection = { flights: [{ log, flight, t0, t1 }], windows: [{ log, t0, t1 }], logs, all, text }`
in frame seconds (`all`: the logs with every flight); `result.flights` has the analysed flights only. The text ("Flights in the
analysis: log 1 (all flights), log 2 flight 2 (50.0 s to 83.0 s).") is a note, the first line of `reportMarkdown` and a line of the
verdict. `result.scope` stays "file". extract.cjs and report.cjs get only the segments of the selected time.

The "Logs" control (2026-10-06) has "All flights in the file" (the default: the worker leaves out the bench runs and the logs with no
data), "Selected flights" and "This log". The value stays for the session, and the Analysis view has the same control
(`TuningDialog.scopePanel()`, `scopeAction(act)`, `onSettings(cb)`; the hooks `scopePanel`, `scopeAction`, `onSettings` of `js/main.js`), so
the two views use one setting. Both views start their runs with it, also the automatic run of the Tuning view (`show()`, for "All
flights in the file" and "This log"; for "Selected flights" the pilot starts the run). With "Selected flights" of every flight and a
result of all flights on display, the result is not for other settings (`sameFlights`):
- The key of a file or flights run has `*` for the log (`keyFor`): the result is of the file, and another log in the viewer shows the
  same result, with the notice that its curves and header are of the log that was on display when it ran. "Start analysis" runs
  again with the log on display. A "This log" key keeps the log.
- "Selected flights" starts with every flight that the analysis can use (`selectionMap`: each log that is not a known bench run or
  a log with no data, with all its flights); `selection()` drops the logs that a result knows as a bench run.
- The flight list is a `<details>` with the counts in its head ("Flights in the analysis: 6 of 6 flights (8 bench runs, 2 logs with no
  data)", `selectionHead`). Its first drawing in the session closes it when a selection exists; then it keeps the pilot's state
  (`fselOpen`). A log with more than one flight collapses its flights under its row ("2 of 3 flights"). The control that had the
  focus gets it again when a list is drawn again (`fselFocus`, `fselRefocus`), so Enter and Space on a summary work.
- The context bar, the progress text and the report write "All flights in the file (3 logs)", and the report has the row "Flights in
  the analysis" (`fileFlightsText`: "6 flights in 3 logs, 1 bench run").

### Configurations (round 3 M1)

`datasets.cjs` (SPEC3 J) finds the configurations of the file: one PID profile with one exact set of the values that change the
flight. A value that does not change the flight (rescue, blackbox, OSD, ...) never splits a configuration. The worker:
- **First pass** (`firstPass`, file scope): one decode of every log of the file with the columns of the governor target and the
  flight phases, also with a flight rpm of the user. It gives the flight rpm evidence (auto) and the input of each log (`dsInput`):
  the header, the PID profile runs, the rate profile changes and the other in-flight adjustments, the flights (`[]` for a bench
  run), and the PID profile at arming when it is confirmed (`armingLite`: armingOf with the D4 counts of `compareCli`, the same
  result as after the analysis). A log with no data gives its header only, and no stretch.
- **Labels** (`relabel`, before the modules run): the main pass makes the input of each log again at the flight rpm of the file,
  runs `datasets()` (milliseconds), and gives every sample the label of its configuration (`labelArray`, the ends snapped to the
  samples of the PID profile runs: `SNAP_S`). A label is the same for one configuration in every log (`J.dsReg`, by its values), so
  a module that pools over logs pools by configuration. `ctx.profile` is the label (1-255, 0: no configuration), `ctx.pidLabels`
  the PID profile labels, `ctx.pidProfileOf(label)` the PID profile, and `gov_headspeed` / `gov_max_throttle` of each label
  (`health.cjs cliContext` by label). `p.ctxPid` keeps the ctx of the PID profiles (armingOf).
- The modules that get the labels: `health_gov`, `health_loop`, `health_track`, `health_more`, `health_phase`, `health_rescue`,
  `health_limits` (`DS_MODULES`). `health_setup` (D4, F5, F6, F9) and `health_config` keep the PID profile labels; so do check D8
  (`ctx.pidLabels`), the F5 spans of `evidence.locate`, and the curves of the views (`pidCtx`).
- **Findings** (`annotate`): `f.datasetLabel` (the label of the module), `f.dataset`, `f.pidProfile` of the configuration, then,
  after the evidence (it reads the metrics by the label), `f.profile` and the profiles of `other`, `events`, the evidence and its
  spans become the PID profile label. The toolkit text names the configuration where it names the label ("configuration B (PID
  profile 2)"). A finding of `health_setup` gets the configuration of its PID profile label when that label has one configuration
  in its log (`profileMap`). `dsFinal` maps each label to the configuration of the last `datasets()` run: by its values, else by the
  time of its stretches (a note when neither works).
- **result.datasets** (`dsResult`): `datasets()` of every log of the file (`datasets[]`, `labels[]`, `diff[]`, `pairs[]`, `info[]`,
  `notes`, `newest`, `newestByProfile`, `unknownNames`, ...), the labels cut to the analysed time (the analysed logs, the windows
  of a flight selection), with `analysed`, `analysedSeconds` and `analysedFlightSeconds` for each configuration, and `comparisons`
  (`advice.comparisons`). `options.datasets: false` turns all of this off (`result.datasets` null): with `excludeAbnormal: false`
  and `phases: false` the worker is the CLI (T1 tests); the CLI's view (toolkitView) never relabels. In log scope the
  configurations are those of the analysed log.
- **Advice**: a from-value comes from the newest configuration of the PID profile (`newestByProfile`, the newest of the file for
  a global value; `dsValue`): the log header or the CLI section with CLI text; the header of the nearest log armed in that PID
  profile only when the logs before and after it agree (`bracketed`); an estimate, an in-flight adjustment, or no value: no CLI.
  `r.dataset`, `r.supportedBy` (the configurations of its results with a problem), `r.ab` (A/B pairs of its check in
  configurations that differ in 3 or fewer parameters, only when the parameters change that check: `relevantChecks` from the
  blocks of `hierarchy.cjs`, `DS_RULES`), `r.slope` (`datasets.predict`: 3 or more configurations, 2 SE, only inside the measured
  range). A problem only in older configurations, with a satisfactory result in the newest one, is a watch with no CLI text.
- **comparisons**: every pair of configurations with a few different parameters, the results of the checks that those parameters
  change first. The checks of an output at its limit (T8, C2, L1-L7: `RATE_CHECKS`) compare the periods at the limit for each
  minute (flight or all time) with the SE of a count; a result with no SE is listed as "no 2-SE test". On the Gaui X4 dump, the yaw
  stop gains 120/80 (E, log 51) against 140/100 (F, log 59): L4 25.5 ± 6.0 against 41.1 ± 7.9 periods for each minute, T8 120 ± 16
  against 105 ± 16 for each minute of flight, neither by 2 SE; T11 and T12 have no SE.

### The filter search (round 3 M2)

`{ cmd: 'filterTune', id, bytes (the whole file), fileName, options: { cliText, cliName, flightRpm, logs, flights, blockedBy,
budgetMs, loo } }` -> `{ id, type: 'filterTuned', result }`. The worker decodes the flight logs (`options.logs`, else every log;
bench runs and logs with no data out) with `filter_tune.EXTRA` and the columns of the phases, masks each segment with the flight
phase less rescue, level modes and failsafe (`health_more.normalMask` over the flight phase, as the CLI of `filter_tune.cjs`), and
runs `tune()`. The result has `text` (`filter_tune.texts`: status, summary, parity, recommendation, delay, validation, why, rows,
in STE) and `recommendations` (`advice.filterRecommendations`): an action only when `recommended.status` is "recommended" and
`model.passed` (the model agrees with every flight log); else one check `F:filters` that gives the reasons (the log does not give
the tail rotor notch filters: no fit of `tailOrder`; the model does not agree; less than 3 dB; leave-one-out). The global part (`feature` lines and
global sets) and one part for each PID profile with cutoffs are a group (`F:filters`): the export takes all or none. Guards: PARAMS
of the scope, RANGE, the filter floors, a gyro low-pass filter stays on, a static notch Q of 2.0 or more, a from-value of the log
header or the CLI dump. The export writes `feature NAME` / `feature -NAME` lines of the global values first (`FEATURE_NAMES`, 4.6
cli.c). Real logs: Fireball 2026-09-29 #3 with its dump: an action, the dynamic notch on (count 2, Q 4.0, 170-370 Hz), -7.01 ± 0.48 dB,
0.33 ms more delay; Gaui X4 and Fireball 2026-10-05 without a dump: checks (the model does not agree: no tail notch filters).

### The notch orders of the log (no CLI dump)

The log header has no gear ratio, so without a dump the frequency of the tail rotor notch filters (sources 21-28, h x T x the
rotor frequency) and of the main motor notch filter (source 10, M x the rotor frequency) is unknown: F6 "not measured", F9
"Monitor", tail lines uncovered in F5 and F8, no tail notch markers in the curves. `filter_tune.tailOrder` finds T and M from the
dip that each firmware notch leaves in |gyroADC / gyroRAW| (the configured values, not the mechanics: CLAUDE.md "Gear ratios").
The worker (`gearPlan`) runs it when no CLI dump is loaded, not in the CLI's view (no phases and `excludeAbnormal: false`:
health.cjs has no fit, so parity holds) and not with `options.logGear: false`:

- file scope: in the first pass, one log at a time (`tailOrderStart`, `tailOrderAdd`: the sums of the order spectra of each log,
  not its samples; `tailOrderFit` before the main pass). analyseFile runs a first pass for it also with a user flight rpm and no
  configurations. The mask: the flight phases of each log less rescue (the default of `filter_tune.maskOf`);
- log scope: on the log, in `addLog` before its checks (30 s periods as units: a log needs 90 s of flight);
- a fit that passes is `ctx.gear` of every segment (`health_setup` gearOf: `setup.rpm.gear.source` and `F5.gear` 'log notch';
  `health_more` notch markers) and `c.gear` of advice (F5 tail rotor harmonics); `motorisedTail` is null when only the motor
  fit passed (source 20 stays, with an unknown frequency);
- a fit that does not pass changes nothing, and a note gives the cause from the log (`filter_tune.fitCauseText`);
- `result.notchFit = { used, logs, tail, motor: { passed, order, se, n, unit, axis, depthDb, sources, Q, reasons } | null, ms }`,
  null when the fit did not run. The `filterTune` command does its own fit (`tune()`), with the mask of the filter search.

Real files, no dump, file scope (2026-10-06): Fireball 2026-10-05: tail 4.0019 ± 0.0016 (6 flight logs, yaw, -40 dB; the dump has
76/19 = 4.0000), F6 "not measured" 18 -> 0, F9 "Monitor" 6 -> 0, and the F checks and their recommendations equal the run with
the dump. Gaui X4 113720 (2000 rpm): tail 4.056 ± 0.0064 (4 flight logs, -33 dB), F6 "not measured" 12 -> 0, F9 "Monitor" 4 -> 0.
The fit adds 1-2.5 s.

### Issues of the overview (round 3 M3) and logs with no data (M4)

- `catalog.issues(findings)` -> `result.issues`, `result.top` (3 keys), `result.areas` ({ status, issues, problems, monitors } of each
  card). One issue is one check and axis over the logs, PID profiles and configurations: its results with the status problem or
  monitor. `size` = value / limit of the largest result (display value and bound, the same unit; limit / value for a minimum:
  `MIN_IDS`; L1-L7 by the longest period against 0.1 s and the error against its limit; P1 by the lowest cell voltage), null for a
  limit of 0 (ranked as 2). Rank: problem first, not small first, then size. A card whose issues are all small (size < 1.2) is
  "Monitor" (`ISSUE_RULES`).
- A log whose records are all skipped and have no class has `noData: true` and `noDataReason` (the reason of the decoder) on
  each record, `result.noData = [{ log, reason }]`, and the flights line of the export says "no data that the app can read".

### Round 3 in the views

- **Configurations** (`result.datasets`, `hierarchy.byDataset`). The Tuning view has the tab "Configurations" (key `configs`): the
  table of the configurations (id, PID profile, logs, flights, flight time, values; marks for the PID profile values from a different
  log, the unknown values and the newest configuration), the table "Parameters that are not the same", the values that do not change
  the flight, the names that the app does not know and the notes of `datasets.cjs`. The configuration menu (`view.dataset`: "all" or
  an id) filters the diagram (`hierarchy.byDataset[id]`: the nodes, `startHere` and `prereqProblems` of that configuration in its PID
  profile) and the lists. The views write "Configuration A". Hooks of the Tuning view: `configuration()` ("all" or an id), `setConfiguration(id)` (false when the result has no such
  configuration), `onConfiguration(cb)` (cb after each change; it returns the function that removes cb). The lens head has the same
  menu. `TuningDialog.focus({ tab })` opens a tab (the Analysis view links "Configurations"); `focus({ node, fid, recs })` stays.
  A recommendation shows `r.dataset`, `r.supportedBy`, `r.ab` ([{ a, b, check, axis, names, delta, se, significant, unit, scale,
  text }]) and `r.slope` ({ name, perUnit, se, datasets, change, changeSe, together, range, check, unit, scale, text }).
- **Filter values from the flight logs** (the filter search, M2). The Filters step of the diagram and the tab "Filters and vibration"
  have the panel with the button "Find the best filter values". It starts a new worker with `{ cmd: 'filterTune', id, bytes (the
  whole file), fileName, selectedLog, logCount, options: { flightRpm (the pilot's value, else the one of the result on display),
  cliText, cliName, flights (with "Selected flights"), blockedBy (the ids of `hierarchy.nodes.filters.blockedBy`, for example 'rpm') }
  }` and shows its progress. The view keeps the last 4 results by file, flights, flight rpm and CLI dump, and says when the result on
  display is for other values. It shows `result.text`, the model check, the test on each flight and the spectra (`result.curves`:
  raw, recorded, model, candidate and the PID output). Its `recommendations` go into the list of the "CLI file" tab after those of the
  analysis (the global part and the PID profile parts as one group).
- **Items of the overview** (M3). The Analysis view shows `result.issues` (one item for each check and axis) in their rank, the three
  of `result.top` at the top in plain words, and the cards ranked by their items; `result.areas[area].status` gives the condition of a
  card (a card of small items is "Monitor"). Without `result.issues` the view makes the items from the findings.
- **No data** (M4). A log with `records[].noData` (or in `result.noData`) shows "No data that the app can read", with the reason of the
  decoder as quoted text.

### Steps of a correction (round 3 M5)

When the 20 % step limit (or a documented step) makes the change smaller than the measured correction, the text gives both:
"The full change is an increase of 62. Make the change in steps. Set pitch_collective_ff_gain on PID profile 1 from 10 to 12 (...).
After the flight, do the analysis again." (STE has no word "correction": the text says "change".)

### Error curves

| Plot | Data |
|---|---|
| Tracking error over time | setpoint, error, error at the best time delay (rms per 0.1 s), unusable spans shaded, finding times as markers; a click seeks the viewer |
| Band-passed error amplitude | the C5/T1 statistic over time with the 10/20/40 deg/s lines; stick-driven windows shaded |
| Error and response spectrum | \|error\| / \|setpoint\|, \|T\| from setpoint to gyro, coherence; \|T\| is drawn solid only where its random error sqrt(1 − coh) / sqrt(2 n coh) is under 20 % |
| Phase | phase of T (same mask) against the fitted time delay line −360 f τ |
| Mean \|error\| by \|setpoint\| | the error against stick rate, raw and at the best time delay |
| Governor | headspeed and target with the governor states, error % with ±1/±2 % lines, throttle and collective |
| Filters and vibration | gyroRAW against gyroADC per axis and PID profile with rotor harmonics, notch filters and low-pass cutoffs; transmission; D-term and control spectra |
| Tail | mixer[2] against its limits; yaw error |

### STE (ASD-STE100, Issue 9)

All text that the views show, and the text that `tools/autotune` writes for them, is Simplified Technical English (the
CLAUDE.md rule). `docs/STE_GLOSSARY.md` gives the rules we apply, the status words and labels, the terms, the gear-ratio
wording, the substitutions and our technical nouns and verbs. The words are in `test/ste/vocabulary.json`: headwords with
their part of speech and forms, our technical nouns and verbs with their categories, a denylist with the STE alternative of
each word, British spellings and unit symbols. The repository holds no copy of the standard or of its dictionary (license).

`node --test test/ste_text.test.cjs` (about 30 s) finds the texts at run time:
- the catalog summary of every check id for synthetic findings in every severity, PID profile and phase, and the
  hierarchy titles, chips, edge texts, K rules and status reasons;
- the tests of the other parts run again in worker threads with the exports of our modules wrapped: every finding text of
  `health_track`, `health_more` and `health_phase`, every advice output, the comment lines of `advice.script` and
  `advice.exportScript`, every evidence text;
- the node:vm harnesses of the Tuning view, the log lens and every `js/*_view.js` run again, with `$`, the DOM stand-ins and
  `TuningPlot.attach` wrapped: every rendered text and plot spec;
- the literals of `js/tuning_worker.js` (notes, progress, window values) and `js/tuning_snippet.js`, the view shell, and the
  STE rules of CLAUDE.md;
- with `AUTOTUNE_REAL_LOG`, the TuningResults of the real log, and with `AUTOTUNE_RESCUE_LOG` also set, those of the
  Fireball dump (rescues, PID profile changes at a rescue, 6 flight logs). In each TuningResult it also reads the texts of
  "Values that are possibly not current": `epochs[].spans[].text`, `freshness`, the `stale` text and source of each
  finding, limits period, recommendation, issue and gains decision, and `cliStatus.conflicts[].text`. The integration run of
  2026-10-06 found 6 text templates with STE errors in the Fireball results (with and without the dump of 2026-09-04) and
  in the second Gaui X4 dump that the first Gaui result does not show: the D8 and G16 texts, the P1 text and rule, the
  limit of the "Result of check" comment line (F1), and the L1 text with a CLI dump.

It skips `<code>`, `<pre>`, `[data-ste="quoted"]`, the strings that the harness gives as data, and the upstream text.
Failing checks: LEN, SEMI, CONTR, LATIN, DENY, ING, LIMIT, GB, TENSE, THAT, NOTEIMP,
MATH, PARA, CASE, SAFE, VOCAB and GEAR (the gear-ratio rule).
Report only: PASSIVE, POS, NOUN4, SYN. It prints the counts for each check and source, and `STE_LINT_OUT=<file>` writes every
hit. A source that is missing is a line in the table, not a stop.

### Verified

- 2026-10-05, before the views: 237 tests passed, including the pre-existing ones. In NW.js 0.62.2 (Chromium 99) the worker
  gave the same findings as Node. The web build was tried in Chrome, from a merge with the fork's web-app commits #85-#87.
- Against the peer analysis of the Gaui X4 (`analysis/gaui-x4/`):
  - rescue excluded 10.59 s against 10.60 s;
  - gyro filter time delay 7.0-7.6 ms against 7.15-7.23 ms;
  - pitch time delay 70-79 ms against 72-75 ms;
  - yaw at ramps 35.5 ± 2.1 against 34.8 ± 1.6 deg/s;
  - the roll mode is not flagged as self-excited;
  - the 4.06 x rotor line is reported as already filtered out (0.1-0.5 % passed; the peer measured 0.0-0.2 %).
- Merging the fork's origin/master conflicts only in `gulpfile.js`: move the new entries into `APP_ASSET_SOURCES`.
- 2026-10-06, round 3 (Node, worker harness): the Gaui X4 dump in file scope 40 s (6 configurations: A, E and F "PID profile
  unknown" with other yaw values, B, C and D PID profiles 2, 3 and 1), the Fireball dump of 2026-10-05 64 s (8 configurations: the
  expo of the rate profile changes between logs 14 and 15, so PID profile 2 is B and G), Fireball 2026-09-29 #3 16 s. With
  configurations the Fireball #3 findings are those of the PID profiles (210 of 210 keys the same); on the Fireball 2026-10-05 dump
  only G3, G4 and G5 change (pooled over the logs of B and of G, not of PID profile 2). `filterTune`: 7.5 s, 13 s and 27 s.
