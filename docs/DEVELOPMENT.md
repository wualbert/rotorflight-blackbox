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
| `make apps` | `gulp apps`, then the macOS installer on macOS | `apps/` production build; replaces `/Applications/Rotorflight Blackbox.app` on macOS |
| `make release` | `gulp release` | `release/` installers (dmg, zip, deb, rpm, exe) |
| `make version SEMVER=x.y.z` | `sed` on `package.json` | version bump |
| `make clean` / `realclean` / `distclean` | `rm -fr` | progressively removes build output, `dist/`, then `cache/` and `node_modules/` |

Details worth knowing:

- After each implementation change, run `make apps` before reporting completion.
  On macOS this also replaces `/Applications/Rotorflight Blackbox.app` through
  `tools/install_macos_app.py`. The installer verifies a staged copy before replacing
  the existing bundle and restores the previous bundle if the replacement fails.
  Verify and launch the installed copy. Close an older running instance normally
  before relaunching, preserving any unsaved work. Direct Gulp commands still only
  produce build artifacts, so a local rebuild using Gulp must also run the installer.
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

**Receiver signal loss, in-flight cuts and the parameter snapshot (crash flight 2026-10-15, IMP-01 to IMP-12).** Section 13 has
the details; in short:
- `lib.segments` gives `rxLoss`/`rxLossAt` from `rxSignalReceived` and `rxFlightChannelsValid` (`failsafePhase` is always 0 since
  d864d6496). Every analysis mask, segment and dataset leaves out the cut; the governor, power and limit checks keep it.
- New checks: D10 (no receiver signal, `health_more`), D11 (in-flight cut and ground contact, `health_phase`) and D12 (the
  failsafe throttle, information, `health_config`). `health_phase` adds the phases `fall` and `aftercontact` after an in-flight cut.
- A log of a `blackbox_params` build (4.6.0-bbp 58a4bd5cc, 4.7.0-bbp-pr 85d7049a9) with a complete FULL snapshot is the source
  of the values of every PID and rate profile (`param_log.cjs`), ranked above a CLI dump.
- The replay accepts the release 118e912 and the audited builds of `firmware/equivalence.cjs` (IMP-06). `validation_power.cjs`
  gives the number of flights that can show a calculated change (IMP-07).
- Tests that use the crash log: `PARAM_EPOCHS_LOG=analysis/fireball-crash-20261015/crash.bbl node --test test/param_epochs.test.cjs
  test/health_limits.test.cjs test/filter_tune.test.cjs test/health_setup.test.cjs`. `health_config`, `health_more`,
  `health_phase`, `gov_data`, `validation_power`, `tuning_worker` and `ste_text` tests read it from the repository (they skip
  without it).

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
| Groups of flights | From the pilot: `<out dir>/groups.json`, `{ "starts": [log numbers], "why": "what changed", "note": "status text" }` (`analysis/fireball-wag/groups.json` is an example). Without it, all flights form one group. What was changed on the helicopter is not in a log. A group with flights of more than `RULES.baseline` dates or files (1 and 1) is a mixed period: the report flags it in section 1, before the before/after quarters and in the decisions, because a pool of other dates is no baseline (PID profile 1 roll 1.37-1.42 × a pool that was 95 % one day, 1.10 × the same period: `analysis/fireball-crash-20261015/verify/tuning-content-F6-0/by_date.txt`). `results.json` has `groups[].days`, `files`, `mixedPeriod` |
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
- Two stages, each on demand. "Start analysis" (the Tuning view and the Analysis view: one run, one result for both views) measures
  the selected flights with the checks and gives the changes of the check rules. "Autotune" then makes a model from the flights of
  that result and tests other values in it: the filter model on the Filters tab (`filterTune`), the governor model on the Governor
  tab (`governorTune`, all governor parameters) and the six-degree-of-freedom helicopter model on Cyclic gains, Tail gains and the two
  compensation tabs (`controlTune`). They need the analysis: the gates, configurations and flight rpm come from the result.
- "Autotune all" (after "Start analysis") starts the autotune of each step at once (`AUTO_STEPS`: Filters, Governor, Cyclic gains, Tail
  gains, the two compensation tabs), each in its own worker, for the configuration on display. A step with a current result or no
  data is skipped. One at a time (the first version) hid the queued steps for minutes: the pilot saw only the filter autotune. Each autotune runs in its own worker, so it continues when the pilot opens a
  different tab or view: a bar on its tab (`autoBars`) and on the "Tuning" view tab (`hooks.autotuneProgress`) shows its progress.
- The autotune of each tab has one bar (`autotuneBarHtml`, user 2026-10-17), at the right of the tab heading on Filters, Governor and
  the four control tabs: "Autotune" (the reason of a disabled button next to it), the progress with "Cancel", or "Autotune completed".
  The classes `tuning-ft-*`, `tuning-gm-*` and `tuning-ct-*` of the button, the bar and "Cancel" stay for the handlers. The control
  panes get their progress from `autoBars`; "Autotune all" has the reason of a disabled button in its title.
- A result of "Selected flights" has the key of its flights without the logs that it finds as bench runs or logs with no data
  (`unusedLogs`): `selection()` leaves them out after the result. Without this, a run that started before the flight scan ended, or a
  log that the scan gave as a flight log, made the result not current for its own selection: "Start analysis" was available again, and
  the control "Autotune" and "Autotune all" were disabled (user, 2026-10-17).
- The governor is always tuned with the governor model (user, 2026-10-15). The Governor tab has no helicopter-model autotune
  (`isModelStep`), and `control_pipeline.tune` refuses the step `governor` before a model fit (`status: 'unsupported-step'`). The
  helicopter model still calculates the governor in its closed loop when it can (`governorInputs`), for the other steps.
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
| `js/tuning_dialog.js`, `css/tuning_dialog.css` | The Tuning view: flight selection, recorded-configuration reference, then Overview, Filters, Governor, Cyclic gains, Tail gains, Cyclic compensation, Tail compensation, Export. Each configuration keeps its own draft; auxiliary checks and evidence remain accessible from their links. |
| `js/tuning_snippet.js` | `TuningSnippet.Reader`: the raw columns of one span of a log on the main thread, in frame seconds |
| `js/analysis_view.js` | `AnalysisView`: the Analysis view. The verdict from the TuningResult, with the "Show in the log" and "Show the measurement" panels |
| `js/log_lens.js`, `css/log_lens.css` | The pieces that the verdict shares (`LogLens.internals`), and the `LogLens` class, which the app no longer builds |
| `js/tuning_plot.js` | Canvas plots: linear and log axes, two y axes, NaN gaps, uncertainty bands, hover readout, click to seek |
| `tools/autotune/catalog.cjs` | One entry for each check id: STE noun, unit, scale, home item, subsystem (`areaOf`), Tuning tab, evidence spec, the lead texts (symptom, why, good, info) and the summary template; `summary(f)`, `lead(f, status)`, `status(f)`, `display(f)`, `tunerOf(f)` |
| `tools/autotune/hierarchy.cjs` | The prerequisites (`PREREQ`: 6) and the tuning blocks (`BLOCKS`: 6, parameters only), 22 edges (`EDGES`: gate with an optional `scope`, order, cause with an optional `viaRules`, validity), K rules K1-K27 (`RULES`), `graph()` (the K1 shape), `status`, `causesOf`, `gateUpstream`, `homeOf`, `isPrereq`, `isBlock`, `LEGACY` (the round 1 ids) |
| `tools/autotune/health_config.cjs` | Check D9: `rescue_mode` of each PID profile, from the CLI dump, a rescue state in the log or a header value. Check D12: the failsafe throttle (see "Receiver signal loss") |
| `tools/autotune/health_power.cjs` | Checks P1 (the battery voltage at the load steps, for each flight log) and P2 (the voltage decrease for each 1 A, for each battery) |
| `tools/autotune/evidence.cjs` | The spans in frame seconds, the viewer request and the plot spec of each finding (`timeMap`, `toFrame`, `locate`, `forFinding`, `forDecision`) |
| `tools/autotune/health_track.cjs` | Checks C12/T11 tracking error, C13/T12 time delay, R1 stick-to-setpoint time delay, C5/T1 fast oscillation; `curves()` |
| `tools/autotune/health_more.cjs` | `normalMask` and D6 (receiver signal loss, rescue, level modes, failsafe), D10 (no receiver signal), F10, F11, T13, C14, T14, G14; `curves()` |
| `tools/autotune/health_phase.cjs` | Flights and flight phases (`phases`, `flightMask`; after an in-flight cut also `fall` and `aftercontact`), D7 log class, D11 in-flight cut, G15-G18 and C15 |
| `tools/autotune/param_log.cjs`, `param_semantics.cjs`, `cli_defaults.cjs` | The parameter snapshot and the journal of a `blackbox_params` log (IMP-05), the loader and keys of each journal item for each firmware, and the CLI defaults of the audited builds (D4 with a `diff`) |
| `tools/autotune/firmware/equivalence.cjs` | The audited builds other than 118e912 (IMP-06): the changed replayed files with their sha256, the conditions of each hunk, the per-log parity limits (`RULES`) |
| `tools/autotune/health_rescue.cjs` | The checks at each rescue start: G19 headspeed, T15 tail, D8 PID profile change (all phases, rescue included) |
| `tools/autotune/health_limits.cjs` | Control outputs at their limits (CLAUDE.md "Control limits"): L1 throttle, L2 collective, L3 cyclic, L4 tail, L5 servos, L6 I-term, L7 collective stick at its end, in all phases with no guard time |
| `tools/autotune/advice.cjs` | Findings and `report.cjs` decisions to recommendations: tuning sequence, guards, causes, CLI text, `exportScript`; the coverage matrix; the configurations of a recommendation (`dataset`, `supportedBy`, `ab`, `slope`), `comparisons`, `filterRecommendations` |
| `tools/autotune/datasets.cjs` | The configurations (SPEC3 J): one PID profile with one exact set of the values that change the flight. `datasets(logs, cli)`, the classification table of every 4.6 name, `labelArray`, `profileMap`, `compare` (A/B, slopes, 2 SE), `predict` |
| `tools/autotune/filter_tune.cjs` | Filter configuration, legacy analysis helpers and the v2 entry point. `filter_autotune.cjs` performs constrained search; `filter_reconstruct.cjs` recovers native inputs from firmware observations; `filter_replay.cjs` runs the native-rate compute path |
| `tools/autotune/control_tune.cjs` | Offline control proposals from configuration-specific advice, atomic gain groups, exact model estimates and parameter-specific flight maneuvers for Export |
| `tools/autotune/system_id.cjs`, `helicopter_model.cjs` | Automatic interval selection, pilot-instrumented plant identification, physical priors, independent validation and serializable aircraft dynamics |
| `tools/autotune/control_pipeline.cjs`, `firmware_controller.cjs`, `firmware/` | Native Rotorflight replay and artifact verification, digital-twin lifecycle, controller parity, closed-loop candidate search and refusal gates |
| `tools/autotune/heli_twin.cjs`, `twin_fit.cjs` | Six-degree-of-freedom helicopter twin (state, equations, observer, linearization) and its identification, instrumented frequency responses, reserved-flight checks |
| `tools/autotune/control_validate.cjs`, `twin_replay.cjs` | Production-worker real-log validation with resource hashes, and frozen saved-model replay |
| `tools/autotune/validation_power.cjs` | IMP-07: the flights that can show a calculated change (per-flight SD, input-matched null, flights for each set of values, STE plan); `control_pipeline.tune` and advice C7 |
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

`TuningPlot` coalesces updates, resize notifications and hover drawing into one animation frame per plot. Only the latest
specification and pointer position are rendered. Hidden plots defer their data scan until they have a visible size.
Destroying a plot cancels its pending frame and disconnects its resize observer; attaching a replacement also cleans up
detached plots. The canvas regression tests cover update bursts, collapsed sections, hover bursts and removed plots.

Control-tab details and recorded-configuration references render their bodies only when opened. A captured native
`toggle` event inserts the body without replacing the summary or the primary plot; closing removes the body and destroys
its plots. This bounds the initial DOM even for large finding lists and avoids unnecessary native accessibility updates
in NW.js on macOS. Deferred callbacks are discarded when their pane or result is replaced. Routine chrome refreshes
reuse the configuration panel when its result and selected configuration have not changed. The dialog regressions cover
large finding lists, disclosure toggles, plot cleanup, stale callbacks, configuration changes and retained selections.

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
  `evidence`, `datasets`): a module that is missing or that throws gives a note, and the rest of the result stays. The filter
  modules (`filter_tune`, `filter_replay`, `filter_reconstruct`, `filter_autotune`, `filter_checklist`) are fetched with the
  others and loaded on demand by `filterTune` and `filterReplay` (`K.require`). `control_tune` is fetched with them
  and loaded on demand by `controlTune` or by `advice.exportScript` when it builds the flight maneuver list.
  `system_id`, `helicopter_model`, `control_pipeline`, `firmware_controller` and `firmware/schema` are also registered for
  lazy loading by the control pipeline. The governor modules (`gov_twin`, `gov_data`, `gov_params`, `gov_sim`, `gov_fit`,
  `gov_search`, `gov_scenarios`, `gov_tune`) are fetched with them and loaded on demand by `governorTune`.
  The full on-demand list is `ON_DEMAND` in `js/tuning_worker.js`; `test/tuning_worker.test.cjs` (T0) counts it. The compiled `firmware/controller.wasm` is fetched as bytes and hash-checked by
  the firmware adapter before instantiation. All firmware resources are included in the production distribution.
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
   2900 on the Fireball). This threshold is automatic and has no user input.
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

`catalog.cjs` has one entry for each check id: D1-D12, H, SETUP, F1-F11, G0-G21, C1-C15, T1-T15, R1, C7, L1-L7, P1 and P2. Each
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
  G12, G20, G21; the gear ratios in the configuration are correct; its parameters include `gov_max_throttle`, the remedy of G21), Battery and power (D5, G13, G11, P1, P2), Mechanical parts (F7, C15,
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
- For a block without a measured problem, use the tab precedence: analysis error, monitor, insufficient data,
  not measured, satisfactory, information. Passing checks cannot hide a missing measurement. Prerequisite items keep
  their separate rule: only a measurable problem marks them as incorrect.

`advice.cjs` takes `blockedBy` and `gate` from the same gate table, so the diagram and the list agree: a recommendation is
blocked if and only if its node is Blocked (`test/hierarchy.test.cjs`, `test/advice.test.cjs`). A gate with a scope holds only the
changes of its checks (a low-pass filter change keeps its CLI text with a G1 problem). `gatedBy` lists, for every block, the first
problems upstream along the gate edges (`fromChecks` applied, scope not applied), also when the block itself has no problem: a
proposed change still waits for them. The filter autotune sends the filters' `blockedBy` and `gatedBy`, and the worker applies the
`rpm > filters` scope to the proposal: it waits for the RPM signal only when it changes an RPM-driven value (`rpmDriven` in
`filter_autotune.cjs`: the RPM notch banks, the dynamic LPF1 and `motor_rpm_lpf`; with the dynamic LPF1 recorded on, also the
LPF1 type and base cutoff). The `rpm` gates have `fromChecks` G1, G12, G20, SETUP and C7, not G21 (user, 2026-10-15: the RPM signal
errors at the throttle maximum are sparse, and their remedy, a lower `gov_max_throttle`, does not change the other tuning). A G1 flag
whose FALLBACK entries all come 0.05 s or less after a G20 `signal` event at the throttle maximum, with a G21 flag in the findings
(`spikeFallbacks`, `opts.all` for one configuration), does not gate either, and advice guard 2 does not hold a change for it. `causesOf` gives the K rules that make a
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
  for p (an estimate, no CLI), or from the log header when p is the confirmed PID profile at arming. A complete parameter
  snapshot in the log header (blackbox_params FULL) is the log header of every PID profile (IMP-05, datasets source `log snapshot`).
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

### The parameter snapshot and the journal (firmware with `blackbox_params`, IMP-05)

A log of a build with the blackbox parameter journal (4.6.0-bbp 58a4bd5cc, 4.7.0-bbp-pr 85d7049a9; `param_mode FULL`) has in its
header a snapshot of every tracked setting: the global values, the values of all 6 PID profiles and all 6 rate profiles, the
servos, mixer inputs, mixer rules and features (`set.*`, `set@p.*`, `set@r.*`, `el.*`), the PID profile and the rate profile at
the start (`param_pid_profile`, `param_rate_profile`), and `param_end` (line count and FNV-1 hash). The C records of the journal
give each change after that. When `param_log.isParamLog(sysConfig)` and the snapshot is complete (the count and the hash agree),
the snapshot is the source of the values of the log, ranked above a CLI dump. Without a complete snapshot nothing changes.

- `param_log.snapshotCli(sysConfig, records)` gives the snapshot in the shape of a parsed CLI dump (with the records before T0);
  `snapshotOf(header)` once for each header object. Source name `'log snapshot'` (`SNAPSHOT_SOURCE`). Mixer rules have the
  names of the CLI line (`set SC S1 1000 0`: oper, input, output, weight, offset), `rxfail` the CLI shape (`{ 4: ['s', 1500] }`,
  pulse = 875 + 5 x step; `health_setup.parseCli` reads `rxfail` lines in the same shape). The worker (`decode`) and
  `datasets.inputsOfFile` give the snapshot with the records before T0 to every module through `rememberSnapshot(header, snap)`;
  `datasets.configurationHeader` copies it to its header copies.
- `param_log.journalChanges(timeline, frameS)`: the C items after the log start for every stamp kind (an interval stamp at its end
  n1, `uncertain`), at the frame at or before the stamp (`timeline.frameOf`; a stamp after the last frame at the last frame). The
  worker (`d.param.journal`) and `datasets.inputsOfFile` use it, so the two paths give the same times.
- `health.cjs buildCtx`: with a snapshot, `govHeadspeed`, `maxThrottle` (each PID profile) and `cells` (the element of
  `bat_profile` in 4.7) come from the snapshot (`snapshotContext`, `ctx.paramSnapshot`, source "parameter values in the log
  header"), not from a CLI dump; the worker does not filter them with the CLI checks (`cliMaxThrottle`). G6, G21, L1 (source
  `snapshot`), D5/G13 and P1 use them.
- `gov_sim.configOf`: priority 0 is the snapshot of the log of the run (every governor value, the gear, the voltage source and the
  cell count), source "log header (the parameter values of log N)". `gov_tune`: the snapshot of the newest flight log only (an
  older snapshot does not hide newer header epochs); a value of the snapshot has no `switched` flag, and a log with a snapshot
  (and thus a journal) has no `rearm` or `resume` flag of `logInfo` (the journal epochs of the worker give its causes).
- D9 (`health_config.cjs`): the rescue values of every PID profile from the snapshot of the newest flight log (basis `snapshot`,
  above a CLI dump; the worker gives `extra.snapshots`).
- `datasets.cjs`: every PID profile and rate profile has the snapshot values (source `log snapshot`, not assumed); the PID profile
  at the start is `param_pid_profile` + 1 when the caller does not confirm one; `logs[].journal` (`{ t, key, value }` after the
  log start) changes a value from its time (source `log journal`, a recorded value), and then the value adjustment events are
  not used. A journal `rate_profile` item is a rate profile switch. The worker gives both (`decode` collects the S-frame columns
  and the event-101 strings of a param log: `d.param`).
- The worker: the start profile has the basis `snapshot` (confirmed; `advice.cjs`, `hierarchy.cjs` CONFIRMED); the epochs of a
  log with a complete FULL snapshot are `paramEpochs({ timeline, frameS })` (`check: 'journal'`, source `journal`, the journal
  reasons with their texts in `FRESH.journalReasons`, and `changed` after a recorded change of a value in force (the PID profile
  and the rate profile of the part, or a global value), with `keys.changed`: some checks use the values at the start of the log,
  the configurations use the new value). `mixed` with no key (an A record that loads the values that the journal has) is dropped.
  The text of a part names the changed and the unknown values and the source of the other values (`journalText`); `causeText`
  fills each sentence to 25 words and 3 causes at most, and gives 2 sentences at most. No gear fit for a log whose snapshot gives
  the gear ratios; `cliStatus.conflicts` has `what: 'snapshot'` when D4 finds differences; `result.paramSnapshot { logs, all }`
  (the "No CLI dump" block of the views then names the values that the log does not record).
- `control_pipeline.gainEpochReasons`: a journal reason with keys counts only for a key that the replay reads (the schema names, the
  gains of the PID profile of the epoch, `el.mixin`/`el.mixrule`/`el.servo`); `changed` only for an element (datasets applies the
  other changes).
- D4 (`health_setup.compareSnapshot`): every snapshot value against the CLI dump. For a `diff`, a name that the dump leaves out
  has the default of the build of the dump (`cli_defaults.cjs`: tables of 85d7049a9 and 58a4bd5cc, also 874f369d5 and 118e912,
  from `dump all` and `diff all` pairs of the same session, board MATEKG474HELI: `forRevision(dump text)` also matches the
  `board_name` line, and a dump of another board or with no board line gets no table). Each difference names its PID profile.
  The log wins: the text says that the dump is not of the time of the log. `advice.cjs` makes a snapshot row of PID profile p
  stale only for PID profile p (`staleCliProfile`).
- `health_limits.cjs` (L2-L6), `health_setup`/`health_more` gear ratios (F5, F6, F9), `filter_tune.config` (source `header`),
  `filter_autotune.prepare` (governor ratio, no `cliNeeded`), `gov_tune.currentValues` (source "log header (the parameter values
  of ...)", a dump that does not agree is not a conflict), `control_pipeline.recordedGainEvidence` and `targetConfig` (an interval
  with label source `log snapshot` has recorded gains for every PID profile) use the snapshot.
- `param_semantics.forFirmware`: the 4.7.0 table (`RULES.firmware47`, only the audited build 85d7049a9; another 4.7.0 build has no
  table and its epochs are `effect-unknown`): the same loaders and keys, `error_decay_gain_cyclic` (loader pid), and `CLASSIC_47`,
  whose `vbatcellvoltage` is the element of `bat_profile` of the battery lists. `firmware_controller.fromHeader` takes that element
  of the battery lists too.
- Crash log of 2026-10-15 (`PARAM_EPOCHS_LOG=analysis/fireball-crash-20261015/crash.bbl`): PID profile 2 from the snapshot
  (pitch P 99, roll and pitch I 110, yaw P 50, yaw I 116), start PID profile 1, 19 journal epochs (18 fresh, 1 mixed), self-test
  72 keys with 0 mismatches, L6 limits of PID profile 2 990/990/2900, D4 with the 16:53 dump 12 differences of 1073 values. With
  no CLI dump, L1 and G6 have the throttle maximum 1000 of PID profiles 1 and 2 from the snapshot
  (`PARAM_EPOCHS_LOG=... node --test test/health_limits.test.cjs`).

### Receiver signal loss (IMP-01, IMP-02, IMP-11)

`failsafePhase` is always 0 on Rotorflight 4.3 to 4.7 (`failsafeStartMonitoring()` has its only statement commented out, commit
d864d6496; 4.3.0, 4.5.0, 4.6.0 118e912, the bbp builds 58a4bd5cc and 874f369d5, and 4.7.0 85d7049a9), and the FAILSAFE bit of
`flightModeFlags` is the failsafe switch. A loss of the receiver signal shows only in `rxSignalReceived`, `rxFlightChannelsValid`
and `rssi`.

- `lib.cjs` (`RX_LOSS`, `rxLossSpans`): a loss is a run of either flag at 0 with an armed frame (the field `armed` of a
  blackbox_params log, else armed to each DISARM event and again from the next rise of the ARM switch, and only with the ARM switch
  on: a 4.6 log can start with it off). Its cause (rx.c `detectAndApplySignalLossBehaviour`): `signal` (rxSignalReceived 0: the last
  RC frame is 100 ms before the flag drop, `DELAY_100_MS`, and the rxfail values come `holdS` 0.3 s after it at the 100 ms
  rechecks), `switch` (the FAILSAFE bit 7 of `flightModeFlags` at the drop: the pilot's values stop at the drop, the rxfail values
  come 0.3 s later) or `channel` (rxSignalReceived 1, no switch: a control channel out of `rx_pulse_min`..`rx_pulse_max`; the flag
  drops only with the rxfail values, 0.3 s after the last good value; also the cause without `flightModeFlags`). rssi goes to 0
  250 ms after the last link-statistics frame. The cut of a loss is [last RC frame - `guardS` 0.01 s, RX return + `settleS` 1 s).
  `lib.segments` gives `rxLoss` (the spans with a frame of the loss in the segment, in samples; null without the flags) and
  `rxLossAt` (the cut in the segment, also the guard or settle time of a loss of the segment before a logging gap) for a whole log,
  and the analysis segments (extract.cjs) end before a cut and start again only after it, with the airborne and headspeed rules.
  The worker's `sliceSegment` keeps the same rule.
- The cut is out of the health.cjs and wag.cjs flight masks, `steadySegments`, spectra.cjs, line.cjs, the filter_tune default mask
  (and the worker's fallback when `normalMask` stops), `health_more.normalMask` (reason `rxLoss`, not widened by `spanGuardS`), the
  governor tracking mask of the worker, the flights of `datasets.cutFlights` (inputsOfFile and the worker's `dsInput`: a flight
  gives a part before and after the cut, with its index `flight`; a flight fully in a cut stays an empty item) and the gov_data runs
  (`partsOf`: one run for each part out of the cut that is `rxLossMinS` 1 s or longer; the worker note gives the seconds left out).
  The governor, power and control-limit checks keep these frames in the masks of all phases and of the rotor.
- Difference that stays: without flight phases (the app with no health_phase.cjs, and health.cjs on the command line), one mask
  carries the governor tracking checks and the checks of all phases, and it leaves out the cut (the health.cjs flight mask). Thus
  there D5, G12, G13, G21 and the state census do not get the frames of a loss. The cut is not put back, because the same mask
  gives the tracking checks, which must not see the held or rxfail throttle.
- D10 (health_more): each loss with its cause, start, duration, the inferred last RC frame, the time of the rxfail values, the
  rssi 0 run, the rssi before it (dBm for CRSF with `crsf_use_rx_snr` OFF), the governor state there, and the flight phase and PID
  profile of each part. A problem when the median headspeed from the last RC frame to the RX return (at most `rotorAfterS` 0.1 s
  after the rxfail values) is at the flight rpm or more, else a value to monitor (one false RPM reading, check G21, does not
  change it). One result for each log (the records of its segments joined). The worker runs health_more also on a flight log that
  health.cjs does not call flown (a short flight, a calm hover), with the all-phase context: only D10 (`d10Only`), the other checks
  skipped. D6 counts the cut in the flight phase as flight that is not used (`rxLossS`), and its text gives the cut of D10. Crash log 2026-10-15: one loss,
  68.4444 s, 2096.5 ms, last frame 68.3444 s, rxfail values 68.6444 s (logged 68.6453 s), rssi 0 for 2016.2 ms, HOLD.
- D12 (health_config, information): the failsafe throttle of the snapshot of the newest flight log (else the CLI dump), its band of
  the FUNCTION throttle (off below rc_min_throttle - 5 µs, IDLE, AUTO, MAX), the governor state from ACTIVE, the motor stop time
  (the spool-down rate 10 / `gov_spooldown_time` for each second) and the recovery time limit, the other rxfail values with their
  risks, and the note that failsafe stage 2 does not operate. No recommendation and no export line. Crash log: `rxfail 4 a` =
  1031 µs, off, HOLD, the motor stops 0.3 s to 0.4 s after the last frame; `rxfail 4 s 1500` (option B): AUTO, AUTOROTATION, the
  motor stops after 6.1 s from the throttle 0.766 at the loss. The throttle at the loss is used only for a loss with the motor on
  and the governor ACTIVE or the headspeed at the flight rpm, else the median in flight. A CLI value that is not a step
  (`rxfail 4 s 1037` in a restore script) is calculated as the stored step (1035 µs) and the text gives both. A CLI dump with other
  values than the snapshot (`cliAlt`, `cliDiffers`) is in the summary and in the second paragraph. The recovery texts give the
  conditions of governor.c (the throttle more than the handover value with a good RPM signal; HOLD changes to OFF after its time
  limit only with the input off, else to IDLE). `gov_mode` LIMIT and DIRECT are not modelled: a thin note with the stored throttle.
- The Fireball dumps of 2026-09-19 to 2026-10-15 and the bench logs of 2026-10-13 to 2026-10-15 have no other loss.

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
  4 of 10 segments, too few for a gain decision (3 flights for each headspeed bin). Since IMP-04 the worker passes the flights
  of the flight logs to `extract.cjs --clip=<json>` (`clipSpans`): a segment is cut to the flight that it overlaps most (and
  kept if it is still 20 s or longer) instead of dropped. `lib.solve` gives null with no row, and section 5 of `report.cjs`
  writes "No result: n segments, k necessary" when it has no more observations than regressors (crash log: 0 yaw
  observations, the gain table of PID profile 2 with pitch P 98.9 and roll I 109.5). `extract.cjs --clip` takes one log file only.
- In-flight cut (IMP-03, `health_phase.cjs` head and `RULE.td`): the firmware clears AIRBORNE when the motor stops
  (airborne.c `touchdown()`: `isSpooledUp()` is false in OFF, IDLE and HOLD; the same in 4.6.0 118e912, 58a4bd5cc and 4.7.0
  85d7049a9), also at 5 m. Three cases (review 2026-10-16), each with no touchdown jolt before the end of the control:
  (1) a receiver signal loss (`w.rxLoss`) that starts after the liftoff and not after the flag drop, with the collective at the
  liftoff level or the altitude 0.5 m over the level before the liftoff at the inferred last RC frame, and the flag drop in the loss
  or up to `RX_LOSS.settleS` after the RX return, or a contact step in the loss. The cut is the first governor change into OFF,
  IDLE, HOLD or AUTOROTATION after the last RC frame (the stage-1 change), not the flag drop: with the pilot's option B (rxfail 1500,
  the AUTOROTATION band) `isSpooledUp()` stays true and the flag drops late or never. With no such change (an rxfail throttle in
  the ACTIVE band) the event has `motorCut` false and state null, and D11 writes "no RC control", not a motor cut. (2) A flag drop
  `cutTieS` 0.01 s or less after such a governor change by the pilot, with the collective at the liftoff level and an altitude
  decrease of 0.5 m or more to the ground contact (drift free: the level before the liftoff drifts up to 2.5 m at the end of a
  flight); a contact `RULE.td.landingS` 0.5 s or less after the cut is a landing (`touchdownBy` 'ground contact'). (3) A flag
  drop with `failsafePhase` > 0. Each ends the flight at the earlier of the inferred last RC frame and the cut (`touchdownBy`
  'in-flight cut'). Two phases follow: `fall` (from the end of
  the flight to the ground contact: the first gyroRAW roll or pitch step of more than `crashFactor` 2 x the largest step of the
  flight, back to the start of the steep rise; else the touchdown jolt) and `aftercontact` (to the disarm; after a cut by the pilot
  with no contact step, also to the motor start or the rotor stop). RECOVERY or ACTIVE after a contact is neither a spool-up nor
  ground. D11 is "not measured" with no AIRBORNE_STATE, or with no GOVSTATE, receiver fields and failsafePhase. Its problem threshold
  is `DEFAULT_RULES.D11.crashFactor` 2 (the 6 landings of the 2026-10-05 dump: 0.45-1.15 x, the crash 4.4 x), and its phases
  (`PHASES_OF.D11`: flight, fall, aftercontact) are the phases of the catalog. `health_more.normalMask` does not count the fall as ground contact, so the
  flight before the cut is not widened away. Check D11 (health_phase, home Rescue, area radio) reports each cut: a problem after
  a receiver signal loss or a failsafe, or with a strong contact; a cut by the pilot is a value to monitor. Crash log 2026-10-15:
  flight 22.489-68.344 s, fall to the contact at 70.4435 s (1.798 s after HOLD at 68.645 s), after contact to the disarm at
  72.841 s; normalS 44.9 s (43.2 s before), C8 PID profile 2 roll 10 windows. On the Fireball dumps of 2026-09-19 to 2026-10-05
  no flight end changes. The governor and power checks of all phases (D5, G12, G13, G21, the state census, P1, P2: `PHASE_USE.load`
  in the worker, `LOAD_PHASES` in the catalog) leave out the fall and the time after the contact (no flight load); the control
  limits, the rescue checks, D10 and G14 keep every phase.
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

The final **Export** tab compiles the selected changes from every tuning step. Control drafts in `entry.tuning.drafts`
store selections by recorded configuration and recommendation signature; `finalByProfile` selects at most one control
configuration for each PID profile. LUA variants of a profile are alternative control drafts. They are never combined
into the same profile. The initial choice is the newest analysed configuration of each profile, and each profile can
instead select "No changes". The filter draft belongs to the log or flight selected in Filters. Export shows that source
separately and includes its validated filter recommendations once, independently of the control configurations.

`compiledPlan` builds one pending parameter record, keyed by global/profile/rate scope, profile index and parameter name.
The diff shows recorded and candidate values with their configuration or flight source. Identical commands are deduplicated;
conflicting global or same-profile commands prevent export. An edited filter draft contributes no commands until replay
passes. The worker independently rejects a request containing two recorded configurations of the same PID profile.

"Selected parameter changes" (`pendingDiffHtml`) has one table for each PID profile, then each rate profile, then "Values for
all PID profiles" (the CLI order). The check box of a row selects or removes the recommendations of that parameter (with
their groups); "Changes that are not selected" lists the others to select again. A recorded configuration value has no check
box. A row with `r.stale` has its text in a highlighted row, and a CAUTION above the tables counts them. The "Source" link
opens the tuning step (and the configuration) of the change. Each step tab shows "Change recommended" (`.tuning-tab-change`,
`renderTabStatus`) when it has a change that `pickDefault` selects, whatever its status and the selection.

When the chosen configuration predates LUA changes in the same profile, `advice.configurationBases` adds the known
profile values needed to restore that configuration, then applies its selected tuning changes. Selected filter commands
replace restoration values for the same parameters. Complete arrays and enum
values use the Rotorflight 4.6 `PROFILE_CONFIG` schema from pinned `settings.c`; unknown or unsupported restorations prevent
export. Global values apply to every profile and cannot have independent final values. The export describes changes from
recorded configurations; the viewer has no live controller configuration.

`advice.exportScript(recommendations, picks, meta)` writes the script. Actions with CLI text start selected. Checks and
items to monitor are never selected by default.
- The script starts with a backup step ("Save `diff all` before you paste this"). Comment lines (`#`) give the craft, the log
  file and flights, the firmware, the PID profiles analysed, the date, and for each change the from and to values, the
  evidence (finding summary, value ± SE, limit) and the rule.
- Then `profile N` sets, `rateprofile N` sets, the other sets, and `save`.
- A change with `r.stale` (its results use values that are possibly not current, `js/tuning_worker.js`) stays selected. Its
  comment block gives "Values possibly different." and `r.stale.text`, and a comment line before its first command (or the
  same command of an earlier change) gives the flag again: "Change N uses values that are possibly not the values of the log
  header. Before you use these commands, read change N above." The worker writes `advice.script` (the CLI file of the saved
  report) again after `freshnessOf`, so that it has these lines too.
- Ordinary advice uses `PARAMS` and `RANGE`; validated filter replays use the firmware filter schema, and configuration
  restoration uses `PROFILE_CONFIG`. Each branch checks parameter names, scope, type and range before writing a command.
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
| G20 | at each change to FALLBACK (LOST_HEADSPEED before 4.6), with or without a rescue: signal (the glitch rule of governor.c with the throttle under 95 % before the change; else a sudden change of check G21, the same detector `health_gov.spikeScan`, 30 ms or less before the change at any throttle: critique C12, the Fireball FALLBACK entries come at 100 % throttle 1-22 ms after one), overload (the G19 overload test: the throttle at 95 % or more, a headspeed fall of 2 % or more, 0.3 s or less before the change) or none; `causes` lists signal and overload when both apply. `value` counts the entries with an overload sign, also with a signal error (`overloadOnly`: the overload alone), and the summary names both causes; `signal.startS`/`endS` give the first and last fast sample of the sudden change against the change (negative: after it), the words of G21 "during a sudden change or 30 ms or less after its end" (review 2026-10-15) | information. `G1:overload` describes coincident output limits (not for a FALLBACK that G20 gives to the signal, also when G19 finds an overload); G1 remains an unresolved RPM prerequisite because timing does not establish a correct RPM signal |
| G21 | `health_gov.cjs` (analyse: `spikeScan`, `ceilingsOf`, `vcompBlocks`; judge: `g21Pool`, `g21Test`): the sudden changes of the headspeed signal in each throttle band against the governed time at the throttle maximum, and each FALLBACK entry with its throttle and the change before it (docs/TUNING_KNOWLEDGE.md 10.2). With GOVSTATE the governor states select the samples, not the mask: the worker takes it from the mask of all phases (`GOV_ALL`), and the result is the same in every mask | problem: k ≥ 3 changes at the maximum, binomial p < 0.001 and the rate under the maximum 1/10 or less of the rate at the maximum, for a PID profile, or for all PID profiles together when a PID profile has 1-2 changes at its maximum and its own rates keep the 1/10 rule (`basis: 'pooled'`); note: changes with no such relation; skipped ("not measured"): no time at the maximum, no change in less than `minOkS` (12 s) at the maximum, or no sample with the governor in RECOVERY, ACTIVE or FALLBACK. A PID profile with 3 or more changes at its maximum always takes its own test. One change is one episode (review 2026-10-15: the binomial test needs independent trials): the samples faster than 40 rpm/ms with gaps of 300 ms or less (the 200 ms FALLBACK detect delay and 100 ms), 1 s long or less, with one sample or more over the limits; its throttle is the maximum of `motor[0]` in the 20 ms before its start, its sign the sign at its start, and `pulses` its runs over the limits. On the four governed Fireball dumps (38 unique flight logs): 17 of 19 changes at the maximum in 59.3 s of 5619 s (p = 4e-32), all upward, 0 in 47 s at 95-99.5 %. `DEFAULT_RULES.G21` (and `health_report.cjs` RULES) |
| L1-L7 | each sample at 0.5 % of its limit or nearer, gaps of less than 50 ms joined; for each period the frame times, the phase, the PID profile, the rescue state, the other outputs at their limits (a servo that follows its mixer input, correlation 0.9 or more, is the same output), the headspeed error, the rate error and the tracking ratio at the best time delay (C12) | Monitor for a period; flag only for a period of 100 ms or more, in flight or in a rescue, in which the output does not move the gyro rate to the setpoint (`stuckOf`: the gyro from the first to the last quarter, in the direction of the setpoint, less than `DEFAULT_RULES.stuck.progress` = 20 % of the largest error in a quarter window; L1, L2, L7: the headspeed decrease at the start less the decrease at the end) and the error at the end is more than its limit (30 deg/s, `stuck.rate`; the G3 headspeed decrease for L1, L2, L7). Not the error alone: a stick that moves to its end raises the setpoint while the gyro accelerates (Gaui X4 II 2026-10-04 log 41, 24.69 s), and a torque change can raise the error and let it fall with the output still at its limit (Fireball 2026-10-05 log 15, 9.93 s). A short period, or one in which the gyro moves to the setpoint, is the response at its maximum rate (user, 2026-10-16). A stuck rate period with the gyro under the setpoint (`stuck.unreached`) gives the rate that the helicopter gets to; the advice tells the pilot to set the full-stick rate of the rate profile to it or less. Limits: L1 gov_max_throttle (CLI) or the firmware 100 %; L2 collectiveRange of the header (else `mixer input SC`); L3 the clamp in the flight data (the C2 rule, else `mixer input SR, SP`); L4 the T8 limits (else the clamp in the flight data, else `mixer input SY`); L5 the `servo` lines of the CLI dump only (the extreme of a servo in the data is the servo at the stick end, Gaui X4 #50); L6 SCALE.I x I gain x error_limit (CLI section, else the header for the PID profile at the start); L7 rcCommand[3] at ±500 (rc.c), in flight and in a rescue. Else "limit unknown" (skipped). The firmware has no PID sum limit: the mixer input limits are the output limits of the axes |

### The rescue checks and the control limits

- The worker runs `health_rescue.cjs` and `health_limits.cjs` after `health_loop.cjs` (they read its T8 limits) on all phases of a
  flight log (`allCtx`), with no guard time: the rescue and the time before it are where these checks matter. Their findings have
  `phases` = all phases, and `phase` = the phase at the rescue start or of the longest period. They give no curves.
- G1 and G19 (rule K22): a FALLBACK at the large load of a G19 rescue also gets `G1:overload` context.
  G1 requires diagnosis of the RPM signal and the FALLBACK cause. The firmware also permits a mode-switch command,
  low RPM or a rapid RPM change to cause FALLBACK. The state alone proves neither a defective nor a correct RPM source.
  Repair is conditional on a confirmed defect. The prerequisite remains open for governor and RPM-filter changes.
- Homes: G19 and L1 the Governor block, T15 and L4 "Tail compensation and authority" (the tail authority of SPEC3 B), D8 the Rescue
  prerequisite, L2, L3 and the cyclic servos (L5) "Cyclic gains", the tail servo (L5 with axis yaw) with L4, L6 the cyclic or tail
  gains by axis, L7 the Flight controller prerequisite (a command of the pilot). K22-K27 link them to the checks that their errors
  can cause. G20 (every FALLBACK) provides RPM and output-limit context without clearing G1.
- G21 (the RPM signal at the throttle maximum, user rule 2026-10-15: for every helicopter): `advice.cjs` gives for each PID profile
  with a problem `G21:gov_max_throttle:p<N>` (`gov_max_throttle` = the maximum − `DEFAULT_RULES.G21.margin` 3, CLI `profile N-1` and
  `set gov_max_throttle = X`; the from-value: the CLI section, else the maximum that health_gov calculates from the log, else no CLI;
  a CLI value that the log contradicts (motor[0] gets to more than it) gives the log value as the from-value, with no CLI text, and the
  worker gives the modules no CLI `gov_max_throttle` of a dump that the log does not agree with (`cliMaxThrottle`); a PID profile whose
  results together break the 1/10 rate rule gets no change; the stale flag of a G21 result names the source of `gov_max_throttle`
  (`OWN_SOURCE`: the CLI dump, the value from the log, or unknown), not the log header;
  evidence k, N, p, the rates, the FALLBACK entries and the cost in the logs: the time with the governor command at the new maximum or
  more, and the time at the maximum now, for each flight) and one check `G21:signal` (the sensor wire, its supply and ground,
  `freq_input_*`, `debug_mode` `RPM_SOURCE`). Its home is the RPM prerequisite (`homeOf`), so no gate holds it (a prerequisite is
  never blocked), and guard 2 exempts it (`RPM_REMEDY`); the other governor changes stay held by the RPM prerequisite. The governor
  model (`gov_tune.cjs` GT13, `gov_scenarios.cjs` GC6) uses the same detector and test: with a G21 problem, the GC6 row of
  `gov_max_throttle` gives the model cost of that value as a check with no CLI text of its own (no second set line in the export).
- The verdict has a card "Control limits" for L1-L7; the lens shows their periods (up to 10 spans each, `evidence.maxSpans`).
- IMP-12 (`health_limits.cjs`): the mixer-input and servo limits come from the parameter snapshot of the log header (el.mixin,
  el.servo) or the CLI dump before the data; a limit from the data (cyclic, swash ring, tail) needs plateau evidence
  (`RULE.clamp.minFrames` samples at it with the PID sum, axisSum, more than it). Crash log: roll +-1250 from the snapshot (the
  data extreme +415/-435 follows axisSum: no in-flight period), the tail -1517/+1021 (in flight 32.639-32.677 s). L7 counts the
  high end of the collective stick in every phase while armed with the rotor turning (`RULE.turningRpm` = health_phase
  `RULE.spinRpm`) or in flight, the low end in flight and in a rescue only. A CLI limit that a T8 or plateau limit of this log
  contradicts by more than `RULE.pile.tol` gives way to the limit of this log (`conflict`, with a note: the dump is possibly not of
  that time). A period is split where a cause starts or ends, and each part gets its `cause`: 'receiver loss' (the cut of a loss,
  lib.cjs rxLossAt), 'fall', 'after contact'. Only the periods in flight or in a rescue decide a problem; a period on the ground
  is a value to monitor (`groundN`), and the periods out of flight (at IDLE, in the spool-up or the spool-down, or the rotor under
  `RULE.turningRpm`: the pre-flight stick check) are a finding of their own (`outOfFlight`, a value to monitor in its home block,
  no limit recommendation). judge puts the periods with a cause in a finding of their own (severity note, never "Satisfactory", no limit
  sentence, the text names checks D10 and D11), which `hierarchy.nodeOfFinding` puts under the Rescue item (the area radio in
  the catalog; `catalog.issues` keys it `<id>|<axis>|cause`): it is not a problem of a tuning block, and advice gives it no limit
  recommendation. G14 decides "in flight" from the phases (the flight and the fall, never after the ground contact), and advice
  gives a G14 with a cause no governor recommendation. G14 (`health_more`
  `RULE.hold`) records each HOLD from ACTIVE in flight (the phase 0.1 s before it is the flight or the fall), with the
  headspeed 1 s after it and the receiver signal, and flags it as a throttle hold in flight; a HOLD 0.5 s or less before the
  touchdown is a landing. When every flagged change is a HOLD with no receiver signal, G14 has `cause` 'receiver loss' and
  goes under Rescue too. Crash log: HOLD at 68.645 s, 4494 rpm, 1598 rpm 1 s later.

### Flight selection

`options.flights = [{ log, flight }]` (file scope, SPEC3 D; `flight` 0-based in its log, the order of `result.flights`; `flight: null`
is every flight of that log): the worker analyses only those logs, and the auto flight rpm comes from them only. A log with one flight, or with all its flights selected, is the whole log. In a log with more flights a
selected flight keeps the time from the touchdown of the flight before it to the liftoff of the flight after it (the segment is cut
by sample: `sliceSegment`). `result.selection = { flights: [{ log, flight, t0, t1 }], windows: [{ log, t0, t1 }], logs, all, text }`
in frame seconds (`all`: the logs with every flight); `result.flights` has the analysed flights only. The text ("Flights in the
analysis: log 1 (all flights), log 2 flight 2 (50.0 s to 83.0 s).") is a note, the first line of `reportMarkdown` and a line of the
verdict. `result.scope` stays "file". extract.cjs and report.cjs get only the segments of the selected time.

The "Logs" control (2026-10-06) has "All flights in the file" (the worker leaves out the bench runs and the logs with no data),
"Selected flights" (the default since 2026-10-15, with every flight of the scan selected) and "This log". The value stays for the
session, and the Analysis view has the same control (`TuningDialog.scopePanel()`, `scopeAction(act)`, `onSettings(cb)`; the hooks
`scopePanel`, `scopeAction`, `onSettings` of `js/main.js`), so the two views use one setting. Both views start their runs with it.

The analysis runs on demand only (user, 2026-10-15: some flights are possibly not usable). Opening a view starts no analysis; the pilot
selects the flights and clicks "Start analysis". "Start analysis" is disabled while the result on display is of the selected values and
of the log on display (`isCurrent`). For the flight list before an analysis, `ensureScan` (called by `renderChrome` and `scopePanel`,
not for "This log") posts the worker command `scanFlights` once for each open file:
- `scanFlights` runs the first pass of `analyseFile` (the flight rpm of every log), then decodes each log again with the same columns
  and finds its phases at that rpm as `selectFlights` does (`cli: null`). Thus flight k of a log in the list is flight k of a selection.
  Its result has `records` (log, segment, logClass, phases, flights, phaseSeconds, noData), `flights`, `benchRuns` and `noData` in the
  shapes of the TuningResult, so `flightsOf` reads it. `knownFlights` uses it for each log that no result of the file knows.
- No checks run. On the Fireball dump of 2026-10-05 (16 logs) the scan takes 17 s against 103 s for the analysis, on the Gaui X4 dump of
  2026-10-04 (59 logs) 23 s against 59 s (two decodes of each log; most Gaui logs are bench runs, which the analysis does not examine).
  On both dumps the flights (to 0.01 s), the bench runs and the logs with no data are the same as those of the analysis of the file.
- While the scan operates, the list help gives its progress, and the logs are full logs only. A scan that fails gives its error.

With "Selected flights" of every flight and a result of all flights on display, the result is not for other settings (`sameFlights`):
- The key of a file or flights run has `*` for the log (`keyFor`): the result is of the file, and another log in the viewer shows the
  same result, with the notice that its curves and header are of the log that was on display when it ran. "Start analysis" runs
  again with the log on display. A "This log" key keeps the log.
- "Selected flights" starts with every flight that the analysis can use (`selectionMap`: each log that is not a known bench run or
  a log with no data, with all its flights); `selection()` drops the logs that a result knows as a bench run.
- The flight list is a `<details>` with the counts in its head ("Flights in the analysis: 6 of 6 flights (8 bench runs, 2 logs with no
  data)", `selectionHead`). Its first drawing in the session closes it when a selection exists; then it keeps the pilot's state
  (`fselOpen`). A log with more than one flight collapses its flights under its row ("2 of 3 flights"). The control that had the
  focus gets it again when a list is drawn again (`fselFocus`, `fselRefocus`), so Enter and Space on a summary work. Both views
  preserve the table's vertical and horizontal scroll position on selection changes (`fselState`, `fselRestore`), including
  when a cached result replaces the whole Analysis verdict.
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
  (`ctx.pidLabels`) and the F5 spans of `evidence.locate`.
- **Curves**: selected-log curves remain available for Analysis. `result.datasets.curves` includes every analysed log,
  and each selected-log curve entry also has `configurations[]`: the same
  analyzers rerun on contiguous intervals of one configuration with its materialized header, PID identity, flight mask and
  time range. The Tuning steps select these entries by `dataset`, so a spectrum never pools different LUA variants of
  the selected profile.
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
- **Configuration advice**: `advice.byDataset[id]` reruns the recommendation generators on the selected configuration's
  findings, gain decisions and materialized header. Tuning uses these recommendations and their matching hierarchy;
  Analysis retains the file-wide advice above. `datasets.configurationHeader` maps CLI names back to header fields and
  clears unknown PID values instead of borrowing a different profile's header.
- **comparisons**: every pair of configurations with a few different parameters, the results of the checks that those parameters
  change first. The checks of an output at its limit (T8, C2, L1-L7: `RATE_CHECKS`) compare the periods at the limit for each
  minute (flight or all time) with the SE of a count; a result with no SE is listed as "no 2-SE test". On the Gaui X4 dump, the yaw
  stop gains 120/80 (E, log 51) against 140/100 (F, log 59): L4 25.5 ± 6.0 against 41.1 ± 7.9 periods for each minute, T8 120 ± 16
  against 105 ± 16 for each minute of flight, neither by 2 SE; T11 and T12 have no SE.

### Aircraft identification, control autotune and the next flight

The Governor, Cyclic gains, Tail gains, Cyclic compensation and Tail compensation tabs start with the recorded problems.
Each problem shows its explanation, measured value and limit, configuration, PID profile, log, available time spans and
evidence links. The first four results stay visible; the complete checks load when their disclosure opens.

Control autotune builds an aircraft-specific, serializable six-degree-of-freedom digital twin before searching controller values.
The result shows independent prediction errors, recorded/predicted traces, usable intervals and exclusion reasons.
The saved JSON contains the model, physical prior, model ensemble, configuration provenance, validation and replay inputs.
A failed model remains downloadable as a diagnostic artifact but cannot produce a gain recommendation.
The twin (`heli_twin.cjs`, file version 2) has position, velocity, attitude, body rates, rotor flapping, rotor speed,
inflow, actuator, disturbance and sensor-filter states. Its input is the stabilized mixer that the flight-controller laws
produce, plus throttle and battery voltage. No logged sensor measures horizontal position or speed: the model estimates
them. Flight outside the measured input envelope remains unsupported. See the
[research survey](HELICOPTER_SYSID_SURVEY.md), [model specification](HELICOPTER_SYSID_MODEL.md) and
[compiled firmware boundary](../tools/autotune/firmware/README.md).

`{ cmd: 'controlTune', id, bytes, fileName, configuration, step, analysis, options }` returns
`{ id, type: 'controlTuned', result }`. The dedicated worker decodes the selected file again at native sampling rate.
It detects flight phases and unsafe/unsupported modes before configuration cuts, carries the resulting masks through
those cuts, and retains the actual configuration of every interval. `systemIdentify` uses the same path without gain
search and returns `systemIdentified`. Missing bytes, masks or inputs cannot fall back to the legacy proposal engine.
The pipeline randomly reserves approximately 20% of flight groups for testing and another 20% for model selection.
The file SHA-256 seeds a repeatable allocation; the artifact records its seed, group assignments and actual fractions.
Whole flights stay together when sufficient flights exist. Smaller datasets use contiguous intervals with boundary
guard time. Interval-only validation remains diagnostic and cannot authorize control tuning. Selection depends on input excitation,
data quality and flight conditions; prediction error does not determine which test intervals are retained.
Mechanical source selection precedes duplicate removal, the fitting budget and partitioning. One supplied file is
selected automatically. Multiple files require an explicit SHA-256 capture order or a declared mechanical cohort.
Firmware calendar timestamps cannot select the newest source; uptime resets do not establish elapsed time between
boots. Repeated and overlapping captures are grouped before splitting. Exclusion records preserve source identity
so duplicate files cannot increase the apparent validation sample size.

The control workspace's **Parameters in selected logs** panel accepts an explicit, one-based log range and a confirmation that
parameters did not change. The confirmation applies separately to each PID profile and requires an original-header
donor for that profile. It does not supply missing gains or certify unchanged mechanics. The browser persists this
evidence under the full file SHA-256, and the worker independently verifies the hash and zero-based local log indexes.
Changing the range removes confirmation and invalidates all control results and exports for that file. API callers can
supply canonical `options.parameterContinuity` assertions or an explicit `parameterContinuityRequest`; results return the
verified assertions and source files even when model validation fails.

A CLI dump that the pilot selects (`options.cliText`, user decision 2026-10-15) supplies the values that the log header
does not record. The Rotorflight 4.6 header has no `pid_mode`, swash, mixer or servo settings, and only the gains of the PID
profile at the start of the log. `control_pipeline.userCli` maps the global section and the section of each PID profile;
`targetConfig` fills every unknown value from it (source `CLI dump that the pilot selected`), and `recordedGainEvidence`
takes the gains of a later PID profile from its CLI section. The header still wins for the PID profile at the start of the
log. With a CLI dump, a second arm, a PID profile change and a logging pause no longer remove flight periods; an in-flight
adjustment still does. These periods stay in `config.userCovered`, and each control recommendation carries the flag
`stale` (`userFlag`) with the CLI dump as the source. The native controller parity check then tests the CLI values
against the recorded PID terms: a dump that does not apply to the log fails there. Without a CLI dump, values that the
header does not record stay unknown.

`system_id.cjs` selects the data and calls `twin_fit.identify`: staged Levenberg-Marquardt fits of rotor speed, the
vertical channel, the fast dynamics against the 3 x 3 setpoint-instrumented frequency responses (no feedback bias),
short-horizon (0.2 s) predictions and the yaw trim. Each prediction starts from a steady-state Kalman observer that
uses only measurements before its origin; after the origin only recorded control inputs enter. `twin_fit.validate`
scores 0.01-1 s predictions of gyro, attitude, altitude, vario and headspeed against holding the last value, and the
frequency responses of the reserved flights. `twin_fit.assess` gives per-axis results and the control steps
(`eligibleSteps`) that a "partial" model can test. `tune()` then refines the twin in closed loop on the design periods
with the native controller (gyro and mixer agreement) before the gain search. A missing collective mixer channel permits
diagnostic fitting from its setpoint but cannot qualify control tuning. Geometry supplies the mass and inertia prior.
Model, equations, stages and the 2026-10-14 results are in [HELICOPTER_SYSID_MODEL.md](HELICOPTER_SYSID_MODEL.md);
the development harness is `analysis/twin6dof/`.

The visible model-confidence level uses held-out prediction accuracy, supported excitation frequencies and independence
of the validation data. Per-axis filtered RMS error includes an empirical 95% interval, resampling flights when enough
held-out flights exist, otherwise intervals with an explicit dependence limitation. This is uncertainty in observed
prediction error, not a posterior probability that the model is correct or flight-safe. Failed prediction checks produce
low confidence, and missing validation produces unavailable confidence.

Detailed servo motor dynamics are deliberately outside the requested model. The firmware mixer still enforces recorded
collective, cyclic, total-pitch and tail limits. The digital twin stores their angular values and sources. In Rotorflight
4.6, one normalized main-rotor command corresponds to 12 degrees, and one variable-pitch tail command to 24 degrees.
Blackbox's `collectiveRange` records collective limits; the CLI dump supplies additional mixer bounds and geometry.
These are configured angles conditional on correct calibration, not independent blade-angle measurements. Tail command
excursion is reported relative to trim. Unknown limits remain unknown rather than being replaced by observed extrema.

Builds other than the release 118e912 (IMP-06): `firmware/equivalence.cjs` lists the audited builds 58a4bd5cc and 874f369d5
(4.6.0-bbp: only journal hooks in the replayed files, no condition), a88bec8f8 and 85d7049a9 (4.7: the error decay gain, the
leveling timer and the first servo input, each with the condition that makes it inactive: `error_decay_gain_cyclic` 0, no level
mode or rescue, servo speed 0), with the sha256 of each changed manifest file (test/firmware_controller.test.cjs checks them
against the firmware repository when it is present). `compatibility()` accepts such a build only when its version is the build
version and each condition holds, and gives `equivalence` (the build, the conditions, `EQUIVALENCE.RULES`); `control_pipeline`
then also requires the per-window parity of the build (each axis: mixer relative RMS 5 % or the logging step, every axis must
pass; governor state agreement 0.995 in the recorded prefix, not in the warm-up where the replay starts in THROTTLE_OFF, and
throttle RMS 0.002). `filter_autotune.prepare` accepts a 4.6.0 log as before and a listed build whose sensor hunks have no
effect; its parity (`EQUIVALENCE.RULES.filterBandDb` 1 dB and `filterDelayMs` 0.3 ms for a listed build) decides for each log.
Every other build stays refused. `sensors/battery.c` (6 battery profiles in 4.7) is not replayed: the governor takes the logged
voltage and the cell count of the element of `bat_profile`, and the governor parity tests it.

`control_pipeline.cjs` requires plant validation, native firmware replay, sensor-chain replay and unchanged closed-loop
agreement before candidate search. The pinned Rotorflight 4.6 source implements PID, mixer and governor in WebAssembly;
the capability manifest identifies hardware adapters and external paths. A separate WebAssembly artifact executes
the pinned gyro, RPM-notch and dynamic-notch source with its own parity gate. Scheduler phase distinguishes the
recorded raw sample from the filtered value held at the PID tick. Autonomous simulation advances at the gyro rate;
the new actuator command starts at the firmware servo-output tick. For PID denominator 2, that tick coincides with
the logger tick, after gyro acquisition. For denominators 4–8, it precedes logging by one or two gyro ticks.
The recorded prefix uses the same command timing. Native PID/mixer evaluation remains batched, using the held
filtered gyro; its output is withheld from the physical model until the scheduled actuator tick.
Offline recorded-sample interpolation is never used to insert future measured gyro into a prediction.
Unknown active settings, unsupported modes and unsupported firmware
prevent control recommendations. Governor source execution alone does not identify motor dynamics, so this rate twin
cannot tune governor gains.

Changed controller outputs drive the predicted plant, whose sensors feed the controller. Recorded actuator outputs
are used only for plant identification, controller parity and initialization. A two-second recorded prefix warms the
native sensor and PID filters, and the twin observer sets its states from the prefix measurements. After that boundary,
measured gyro, attitude, barometer, PID states, mixer, servo and motor outputs cannot enter the generated trajectory.
Throttle and headspeed are recorded external inputs unless the native governor runs in the loop.
The artifact identifies this initialization interval separately from the scored forecast. Regression tests mutate
future measured feedback and actuator channels while preserving external inputs and require identical predictions.
Native-controller replay uses the same prefix boundary for I/O initialization; it still uses measured gyro as its
explicit replay input. Unknown post-update controller state remains a documented approximation.
Candidate gains are bounded and tested
against the model ensemble; a candidate is frozen before independent flight scenarios are evaluated. Prerequisites,
saturation, extrapolation, cross-axis regression and insufficient independent evidence can each reject a candidate.
The result is a simulated prediction pending a new flight. It never clears a measured problem.

`control_tune.cjs` remains the diagnostic and flight-plan library. Its all-log numeric targets cannot determine the
candidate set because they include reserved-flight observations. Control candidates come from a fixed bounded gain
grid. Export, direct copy and saved reports require a fresh successful digital-twin result for automatic control
commands. Blocked proposals retain their prerequisites and quantitative evidence. Cancellation terminates the
dedicated worker immediately. Reset and changed analysis inputs remove old accepted commands; repeated runs start
from recorded values.

The diagnostic advice engine supplies bounded proposals when the measurements identify a direction:

- C4 decreases cyclic F by 10% when the stop I-term opposes the turn. It retains the existing increase when I follows
  the turn. Conflicting flagged stop directions give no F trial. Overshoot or settling time must pass the existing
  two-standard-error check. The 10% step is a design choice, not an identified optimum or a predicted error decrease.
- C6 and T2 decrease I by 10% only when the recorded diagnostic identifies I as at least half of the control at the
  slow oscillation peak. Frequency alone does not identify a gain. Missing spectral uncertainty remains explicit.
- G5 proposes the documented 10-unit governor P trial after significant slow recovery. G10 proposes a 10% governor
  master-gain decrease after significant headspeed/yaw coherence. Both retain the two-standard-error check. Governor
  increases wait for throttle reserve (G6/L1), tail authority and the existing RPM and power prerequisites.
- C14 can start pitch collective feedforward from zero. The first integer step is the smaller of 10 units and the
  measured positive gain correction minus twice its standard error, rounded down. Unknown uncertainty, an unresolved
  direction or a result below one unit cannot start the gain. Nonzero values keep the existing 20% bound. This is a
  collection step for a new flight, not an estimate of the best final gain.

The legacy `control_tune.tune` API separates `recommendations` from display-only `proposals` and `prerequisites`.
The production `control_pipeline.tune` clears those legacy recommendations before identification and only repopulates
them after the new validation and closed-loop search gates pass.
Guard prerequisites (`holds`) remain visible even without a direct hierarchy gate or an identified control-gain target.
Output limits retain a diagnosis in `guidance`; `experiments` is empty. There is no invented input-reduction
trial. The result distinguishes selected changes, changes that must wait, prerequisite steps and further measurements.
A blocked target is not an instruction: new flight data can change it after the prerequisite is resolved.
Every numeric decision requires valid uncertainty, including pooled logs and derived compensation estimates.

Diagnostic checks remain available while numeric changes wait. Related causal checks do not tell the user to postpone
diagnosis. K22 is context only: RPM and power evidence are examined together, without a circular G1/G19 prerequisite.
An action without a known base or legal CLI values uses a descriptive title. This rule also covers missing `sets`.
Raw toolkit details and saved reports follow the same decision boundary: fitted C14/T14 values are estimates, not
commands, and measured associations do not establish a unique component or gain cause. D8 transition text retains
actual PID profile numbers rather than substituting pooled configuration labels.

Setup findings carry structured frame counts, unavailable checks, CLI differences, vibration lines, filter state,
header changes and yaw configuration values. Advice and the worker use these fields before legacy text parsing.
Header-change history follows the numeric log sequence, because an unset or reset RTC cannot order the recordings.
For the toolkit's multiple-file labels, it follows input-file order and then the log sequence within each file.
A wording change cannot suppress an RPM notch target, a missing-data diagnosis or a stale-configuration guard.
All health modules are included in the STE text harvest, including the older setup, governor and loop reports.
The legacy `No finding` and current `No result` forms both retain insufficient-data status in all views.

G3 splits collective increases into saturated and unsaturated events. An F increase requires significant droop in at
least three unsaturated events and a significant F contribution below 50% from valid positive-output changes.
G5 uses unsaturated events, stops measuring at a PID-profile transition and identifies incomplete recoveries as lower
bounds. Any incomplete contributing recovery prevents a P increase. Output-limit guidance compares the response before
full throttle with the response during it, then examines measured voltage, ESC limits and available telemetry.

Throttle-limit recommendations carry a structured `procedure` with a primary action, numbered steps, a subsequent
flight test and a success condition. Control workspaces show this procedure before Autotune and before recorded
problems. After Autotune, it remains above the supporting measurements, which use a closed details element.
Shared procedures appear once in each control workspace's guidance; each finding retains its own measurements and links.
Recommendation cards and saved reports use the same procedure. A high median throttle alone does not claim a
measured period at full throttle. Lower headspeed remains a conditional flight test after the power and response
checks, with a hover test because tail authority can decrease. The procedure does not authorize a numeric gain change.
G6 preserves the throttle-ceiling value and source in `throttleLimit`. A ceiling inferred below 100% is an estimate,
not confirmed full throttle. Its primary action is to compare the governor maximum setting with the recorded output.
The conservative gain-increase hold remains; the text cannot claim that the measured period proves exhausted reserve.
L1 carries the same distinction for a throttle plateau inferred below the firmware maximum. A CLI limit is confirmed
only for the PID profile whose section supplies it; an unrecorded profile's fallback plateau remains inferred.


The diagnostic proposals above are bounded flight-test hypotheses. Their earlier C7 tracking estimate is not evidence
for the aircraft digital twin and is not reused as a changed-loop simulation. The production result reports a gain
change only after the simulated actuator and plant respond to those exact values. A new flight must measure the result
before any recorded problem can close.

Flights to compare the values (IMP-07, `validation_power.cjs`, `RULES.validation` of `control_pipeline.cjs`). A twin result
of a few percent is often smaller than the flight-to-flight spread of every measurement of it. The 2026-10-15 field trip
predicted -0.57 ± 0.10 deg/s of cyclic tracking error against a flight-to-flight SD of about 1 deg/s, and the |1 - T| changes
needed 150 to 14,000 flights for each set of values (`analysis/fireball-crash-20261015/verify/twin-validation-F6-0`,
`tuning-content-F4-0`). After the frozen test passes, `tune` adds `validationPower` to the result and to each of its
recommendations (the same object, with `profile` and `profileLabel`). The selection, the rows and the CLI text do not change.
`validation_power.forModel` takes the recorded periods of the target configuration and of the other configurations of its
PID profile (`profilePeriods`: with an unknown PID profile, the target configuration only), the test rows of the frozen test
(model gyro with the recorded and the selected values) and the period selection of `system_id.prepareSegments` (`selection`:
the 4 periods of 16 s with the most stick input in each flight, none below 5 deg/s of setpoint movement on all axes). It
calculates three measurements, with the flight (and configuration) as the unit:

- the tracking error rms of 6 s windows after a 20 Hz zero-phase low-pass, minus a line of the window setpoint rms (regression
  over all windows). Its change is the same window measurement on the model gyro of the test flights, paired before and after,
  mean over the test flights with its SE over flights (`deltaSource: 'windows'`); without windows, the frozen test improvement.
- |1 - T| (in % of the setpoint) over the band of a centre frequency ± 1 Hz (from 0.5 Hz), weighted with the recorded setpoint
  spectrum (`bandOneMinusT`, the statistic of `matched.py`). The centre is the frequency of 1-10 Hz with the largest change of
  this band value between the two model runs, on a band with a recorded coherence of 0.5 or more. The change, the flight
  values, the pooled value and the null use the same statistic.
- the gyro rms at 0.5-8 Hz that the setpoint does not explain. Its change is the relative change of the model times the
  recorded value. The setpoint power subtracts the commanded part, so it also needs stick input.

For each one: the SD of the flight values, pooled inside each configuration, with df = flights - configurations. With df below
2, the tracking error gets the window SD / sqrt(windows of a flight), a lower bound (`lowerBound`: no flight-to-flight variance),
and the two spectral measurements get no SD. Also the input-matched null (`matchedNull`: sets of the planned window count, a
constructive draw without replacement: the targets in a random order, each from its 20 nearest unused windows in log input
power, seeded; at least 2 pool windows for each target, windows of 3 flights or more, 200 sets or more, else none) and
n = 2 (2.8 SD / change)^2 flights for each set of values (a minimum of 3), with its range (`flightRange`: the SE of the change,
and the 95 % chi-square interval of the SD with df). The plan takes the measurement with the smallest n among those with a
measured SD, a lower bound only when no SD is measured. A lower bound never gives "Flights can show this change": the text
says that the app cannot calculate the flight-to-flight standard deviation and gives the minimum n. A measured n of
`maxFlights` (10) or less gives the flights to fly in the same period, the periods that the app uses and the stick activity of
each axis (the median setpoint rms of the flights with a coherence of 0.5 or more). If the range goes above 10, the text says
that more flights can be necessary. Above 10 it says that flights cannot show the change, and the smallest change that 10
flights can show. Advice C7 gets a plan from `report.cjs` (`forDecision`: `dTrack` ± `seTrack`, and `measured.trackRmsSE` ×
sqrt(flights) as the SD with flights - 1 degrees of freedom). That measurement is the tracking error in the band of the gain
model (id `decision`), not the 6 s window measurement. The CLI file gives the plan once under "Flights to compare the values",
and a later change with the same plan refers to it ("Change N has the same text about the flights"). The Tuning view shows it
under "Effect of this change" and on recommendation cards, with the PID profile, "(minimum)" on a lower bound and the range of
n. If the plan fails, the result has the plan with no measurement and `error`. On the 2026-10-05 flights, the null of PID
profile 2 roll |1 - T| for the 16 windows of the crash flight is 0.368 ± 0.088 (pooled 0.184, 4000 of 4000 sets), as
`matched.txt`. Run `node --test test/validation_power.test.cjs`; with `AUTOTUNE_RESCUE_LOG` it also runs that real-log case
(about 15 s).

`control_tune.flightPlan` maps accepted control changes to stick maneuvers. Governor gains and collective compensation
use collective steps, including full positive collective only after a smaller step gives stable headspeed and tail control.
Axis gains use short inputs and stops in each direction. Cyclic feedforward uses constant-rate rolls or flips only when
the pilot can maintain control. Other families use cyclic steps, yaw load or headspeed changes as applicable.
The procedure follows the [Rotorflight governor](https://rotorflight.org/docs/Tuning/Tune-Governor),
[PID tuning](https://rotorflight.org/docs/Tuning/Tuning-description) and
[feedforward](https://rotorflight.org/docs/Tuning/Tune-Feedforward) guidance. Three repetitions and three-second pauses
are collection targets chosen by this app, not flight-envelope limits. Three flight logs support the existing
between-flight uncertainty estimate; their count alone does not ensure useful excitation or valid identification.

`advice.exportScript(recs, picks, meta, true)` returns `{ text, flightPlan }`; without the fourth argument it still returns
a string. It builds the maneuver list only after selection, atomic-group, conflict and firmware-legality checks.
The Export page and the saved CLI comments use this same list, labeled by PID profile and linked to the changed parameters.
The instructions use the project's ASD-STE100 vocabulary and sentence rules. The automated lint checks the text from
every maneuver family, UI states and exported comments; a manual review checks meaning and one action per sentence.

Run `make test-control` and `node --test test/ste_text.test.cjs`, then build, install and launch with the normal desktop
workflow. `tools/autotune/control_validate.cjs` runs the production worker on real logs and records resource hashes,
selection/fit results and errors. Develop the procedure on Fireball, freeze it, then identify and test a separate Gaui X4
model as an external aircraft evaluation. Do not transfer fitted Fireball coefficients to Gaui.

`node tools/autotune/twin_replay.cjs model.json replay.json` executes a saved model against its embedded reserved inputs
without refitting. An optional third argument supplies a JSON array of new twin runs (`twin_fit` run format). New
observations set the observer before each origin and score the predictions only. A replay does not change
the artifact's validation status or authorize gain export.

### The filter search

`{ cmd: 'filterTune', id, workspaceKey, bytes, fileName, options: { cliText, cliName, flightRpm, logs, flights, recordedConfigurations, maxAddMs, blockedBy, budgetMs } }`
returns `{ id, type: 'filterTuned', result }`. The dedicated worker decodes flight samples, supplies confirmed arming-profile
identity, excludes rescue/level/failsafe periods, and loads `filter_tune`, `filter_replay`, `filter_reconstruct` and `filter_autotune` on demand.
The v2 search uses native-rate time-domain replay for every candidate, with successive-halving allocation and a reserved
block holdout. Joint gyro/PID reconstruction reserves one in five gyro outputs for validation. It calibrates the unrecorded
SDFT update phase from training observations, differentiates adaptive-notch motion during refinement, and tests local
steps when discrete peak changes stall an interval-wide step. It uses the asymmetric yaw P response when known or identified. Reconstruction blocks
retain committed samples and complete gyro-filter/SDFT state. Finalists preserve state through each log, and noise is
scored before downsampling to the Blackbox rate. Original-decimator inversion also
permits testing new decimation cutoffs. Known motor-RPM and governor settings enable the corresponding upstream paths.
For equally ranked filter checks, final selection prefers lower training delay among noise scores within one SE of the best training score. Reserved periods only accept or reject the frozen choice.
It checks replay against recorded gyroADC before permitting export. Each control-band delay and gain-loss band is the mean of its
1 s windows (each window's baseline-to-candidate output response, each window counted the same), with no error allowance.
See [Filter autotune](FILTER_AUTOTUNE.md)
for the firmware path, literature, parameter coverage, assumptions, thresholds and tests.

The result includes `text`, grouped `recommendations`, `model.parity`, `model.coverage`, `capabilities`, `search`,
`parameters`, `checklist`, `recommended.fullRows`, `recommended.validation.holdout`, `curves`, `traces`,
`recordedConfigurations` and `cliFile`. Each UI request selects one log or flight. `recordedConfigurations` supplies
the configuration definitions and interval labels for that source. The worker decodes the original log and detects
airborne transitions before splitting configuration intervals. Each recorded interval retains its own filter values,
PID identity and value sources; unlabelled intervals remain explicitly unknown. One complete candidate replaces the
filter settings across the selected intervals, with cutoffs for each known PID profile. The result lists the intervals
actually used by replay, including freshness flags, and each trace identifies its recorded configuration and carries the spectrum of that same window. The legacy
single-`configuration` request remains supported. Coverage records which firmware inputs and settings support each filter family.
Validated v2 recommendations require firmware legality, measured replay constraints and progress on replayable filter
problems. The original F1–F3 judges guide screening. Finalists rank original-check corrections before noise reduction.
Combined proposals can repair a missing LPF and missing known rotor harmonics together. A partial correction or significant
improvement can qualify while other failures remain visible. F1–F3 setting failures, new or worsening problems, and lost
measurements prevent recommendation. Training and combined checks require progress; reserved checks test regressions without
requiring the same original failure to occur there. Legacy advice keeps its existing rules. Both exports preserve prerequisite gates and current-value caveats.
The direct filter CLI writes the complete evaluated setup, all custom bank arrays and profile restoration before `save`.
`filter_autotune.cliExportStatus` supplies a shared eligibility result and refusal reasons. The worker recalculates it
after attaching current prerequisite gates. Replay acceptance does not imply export eligibility: Filters and Export
show the refusal, and the combined export removes all commands from an explicitly refused filter result. Recorded-only
replay remains a no-change result.

The worker retains decoded inputs and reconstruction under `workspaceKey`. `{ cmd: 'filterReplay', id, workspaceKey,
options: { simulate, maxAddMs } }` evaluates manual edits without decoding or reconstructing again. An empty `simulate`
object replays the recorded setup. A mismatched key is rejected; changing file, flight source, recorded interval values,
RPM or CLI input invalidates the retained workspace. Selecting a control configuration does not change the filter
workspace. The maximum added delay defaults to 0.5 ms and accepts 0–20 ms. Manual candidates
still need baseline, filter-problem progress and delay/gain/axis checks. They do not need the autotuner's noise-improvement
test. Autotune requires 3 dB improvement when it corrects no recorded problem, and significant noise reduction in either case.

`filter_checklist.cjs` invokes the existing filter judges from `health_setup`, `health_more` and `health_loop` on both
recorded and replayed signals, with identical masks and scored intervals. Rows keep check id, log, configuration, profile,
axis and time range, plus the RPM source for F6. They classify cleared, remaining and new issues, or an unavailable counterfactual.
A correction must reproduce the original failure in the unchanged replay first. Missing measurements and removed failing
RPM banks cannot count as corrections. Physical raw-input checks retain their measured result. Mixer/servo output and
unknown PID paths are not fabricated from gyro-only replay. These limitations stay visible separately from correction targets.
Settings checks F1–F4 and recorded-input checks F5/F8/F9 do not depend on modeled output. Signal results use baseline
validation for the matching log and axis; a failed model cannot turn their calculated result into a confirmed pass.
Valid periods shorter than warmup plus a spectral window are `unmeasuredPeriods`, distinct from blocking `bench` exclusions.
Their ranges remain visible in the checklist and CLI comments. They do not invalidate the measured long intervals.

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

### The governor model and the governor autotune

The design, the model, the 42 governor parameters, the search and the acceptance rules are in
[Governor autotune](GOVERNOR_AUTOTUNE.md). The toolkit files are `gov_twin.cjs` (the plant), `gov_data.cjs` (the run objects),
`gov_params.cjs` (the configuration recovered from the log), `gov_sim.cjs` (the native 4.6 governor of `firmware_controller.cjs`
in closed loop with the twin), `gov_fit.cjs` (identification and validation), `gov_search.cjs`, `gov_scenarios.cjs` and
`gov_tune.cjs` (one row for each parameter, the recommendations, and the entry point `autotune`).

`{ cmd: 'governorTune', id, bytes, fileName, options: { cliText, cliName, flightRpm, logs, flights, budgetMs, blockedBy } }` returns
`{ id, type: 'governorTuned', result }` (`js/tuning_worker.js` `governorTune`):
- Input: the whole file. `options.logs` and `options.flights` select the logs; a selected flight gives its whole log (a note),
  because the model starts at the arm. The flight rpm is the user's or the automatic one of `analyseFile` (the flight phases
  need it). The CLI dump is optional and goes to `autotune` as text; without it, `cli` is null.
- Decode: each log with `gov_data.EXTRA`, the columns of `health_phase.cjs` and `govRequest`. `hsCollect`, `epochCollect` and
  `armWhole` read the whole log (the PID profile at the start of the log and the stale). `health_phase.cjs` classifies each log
  (`classOf`): a bench run is left out (`benchRuns`, one note with their count: "The governor autotune does not use bench runs (36
  logs)."; the panel lists each one), a log that does not parse or has no flight phases goes to `skipped` with its reason. A log that `lib.segments` cannot read for a
  missing field (`govLacks`, from the field list of the log header) gives the field and the setting that records it:
  `gov_data.TEXT.noHs` and `blackbox_log_rpm` for the headspeed, else `blackbox_log_setpoint`, `_gyro`, `_mixer` or `_pid`
  (rotorflight-firmware `blackbox.c` field conditions). That reason is also a reason of `unavailable`.
- The PID profile at the start of a log uses the headspeeds of every log of the file (`hsMap`), as `analyseFile` does. With a
  selection of logs, when a run has no logged PID profile at its first frame, the worker reads the other logs with `govRequest`
  only (progress "The app reads the headspeed of log N of M.", fractions 0.40 to 0.45).
- Runs: `gov_data.fromSegment(w, { phases, segment, events, name })` for each segment of a flight log, all phases. The events: the
  INFLIGHT_ADJUSTMENT events of the whole log (an adjustment before a part applies to it, `gov_params`), and the DISARM events
  (`d.epochEvents`, event 15, frame seconds) in the time of that part only (`gov_data.arming` puts an earlier DISARM at sample 0
  of a later part). Each run of a flight log has `class: 'flight'` (one run per segment of a flight log, GOVERNOR_AUTOTUNE.md
  section 2); `segmentClass` keeps the class of the segment alone ('bench' for a part with no flight of its own).
  The PID profile of each sample is `profileAt`. Before the first logged change it is the PID profile at the start of the log
  only when `armingFinal` confirms it (`run.armingProfile`, `profileFilled`), else 0 ("PID profile unknown"). A run without the
  headspeed, `motor[0]` or the governor fields is left out, and the reasons of `gov_data.TEXT` go to the notes with the log numbers
  (information only: they name the setting that records the value, they are not instructions, STE Rule 5.5).
  A part whose flight phases stop is left out with the note "The app cannot find the flight phases of a part of this log. Thus,
  the governor autotune does not use that part." (the error note of `phasesOf` loses its sentence about the airborne time).
- No run left: `status: 'unavailable'` with the reasons: the missing values (for example `gov_data.TEXT.noGov`, which says that the
  log records them only with `blackbox_log_governor` ON), else "The selected logs have no flight." when bench runs are the cause or no log
  is left, else the reasons of the logs in `skipped`. `autotune` does not run.
- Model: `gov_tune.autotune(runs, { cli, progress(text, fraction), budgetMs, cancelled() })`, a value or a promise of
  `{ status: 'validated' | 'partial' | 'rejected' | 'unavailable', reasons, twin: { params, uncertainty, validation, plots }, rows,
  recommendations, limitations, plots }`. Its progress texts map to the fractions 0.45 to 0.99 (stage `governor`). `cancelled()`
  is true after `{ cmd: 'cancel', id }`; `autotune` must yield (`await`) for the cancel to arrive, and the worker stops at the
  next checkpoint. The result goes through `toJson` (typed arrays to arrays), so it is JSON data (2.0-2.5 MB on the real dumps).
  The model uses the flight logs with the battery voltage when some logs do not record it and 2 or more do (`gov_tune.modelRunsOf`,
  `RUN.minVoltageLogs`; a limitation names the logs left out, `result.modelLogs` the logs of the model). The rule rows use every
  flight log. Without it, one flight log without `Vbat` removes the voltage from the whole model, and the model is rejected (the
  Gaui dump of 2026-10-04 23:34 has 4 such logs: GOVERNOR_AUTOTUNE.md section 8.4).
- Stale (`govStale`): each recommendation (`'recommendation'`) and each row (`'result'`) gets the parts of the log
  (`paramEpochs`) that its time touches while armed, in the stretches of its PID profile. A result of the model (`confidence:
  'predicted'`, method `model` or `simulation`) reads every governor value (`READS['G:gov']`, the 42 names) over the runs of the logs of
  the model (`modelLogs`, else all). A rule
  row reads its own parameter (`READS['G:<name>']`, `'G:global'` for a related global value) over its evidence times. The flag
  of `gov_tune.cjs` (the `gov_params.cjs` flags of a value that changes between logs, a CLI dump that disagrees) joins it
  (`govJoin`). The worker's parts give the second arm, the logging pause and the PID profile switch, so those flags of
  `gov_tune.cjs` are left out. A name and PID profile with a summary flag (`logs: []`, from `staleOf` and `simStale`) gives the summary
  only (each flag of one log has the PID profile of its summary), and each part of the text is a paragraph (a line break between them:
  STE Rule 6.6, 6 sentences or less; `staleTextHtml` of the dialog shows each one in a `<p>`, `advice.cjs` writes a comment line for
  each sentence). The source of a part that flies another PID profile than at the start of its log (`spanInfo` has none without the
  configurations of `datasets.cjs`) comes from the rows of the result (`govSources`, `row.current.from`: the CLI dump, the log header
  of a log that starts with that PID profile, the values that the analysis calculated, "Some values of PID profile N are unknown."), so
  the flag names the source that the result uses (GOVERNOR_AUTOTUNE.md section 8.1).
- Notes: the note of a log without `Vbat` comes after the model: `gov_data TEXT.noVbat` for a log of the model, `TEXT.noVbatLeft` for a
  flight log that `modelRunsOf` leaves out.
- Gates (`govGates`): `options.blockedBy` holds the ids of the steps that gate the Governor step (hierarchy `nodes.governor.blockedBy`
  and `gatedBy`: `rpm` and `power`) or texts. The ids become the texts of `advice.cjs` gate ("The prerequisite "RPM signal and motor
  poles" has a problem. Correct it before you tune this tuning block."). Each recommendation with `severity: 'action'` gets them in
  `blockedBy` and an empty `cli`, as `advice.filterRecommendations` does; checks keep their fields. `result.blockedBy` has the texts.
- The result also has `fileName`, `logs` (the flight logs of the runs), `benchRuns`, `skipped`, `flightRpm`, `cliName`, `selection`
  (`{ logs, whole: true }` with a flight selection), `blockedBy`, `notes`, `modelLogs` and `timing { decodeS, modelS, totalS }`.
- Time: every time of the result (the plots, the evidence `t0`/`t1`, `events[].t`) is in frame seconds, `run.fromS + run.time`, as
  `env.seekFrame` of the dialog needs (`log.getMinTime() + x` s). `run.time` alone is the time from the start of a part: wrong after a
  logging pause.

The Governor tab has three numbered parts (`govPartHtml`, user 2026-10-17: what is wrong in the logs, how well the model agrees with
them, what the model recommends). `govModelHtml` (exported in `TuningDialog.internals`; `gmStart` posts the command with the gates of
`gmGates`) gives the result in three pieces `{ data, fit, tune }` that `controlWorkspaceHtml` places:
1. "Problems in the logs": "Recorded problems", then `data` ("Governor checks of the logs": the recommendations whose row has the method
   rule, data or firmware, `govSource`), then "Recorded response". No part of it uses the model.
2. "Governor model checks": `fit`, the status with the table of `twin.validation.checks` (not satisfactory first), the plots of one test
   flight at a time (the menu "Test flight", `view.ctTwin['governor:gm-flight']`) with its closed-loop errors
   (`validation.closedLoop.runs`), the other model plots with a caption (`GM_PLOT_ABOUT`), the model limits and parameters.
3. "Changes from the governor model": `tune`, the changes of the rows with the method model or simulation, the plots of the autotune
   in groups of the parameters that they test (`GM_TESTS`, `govTests`), the checks of the model, and all rows (closed first).
The evidence, the sources and the notes of a change are in its closed "Data, sources and notes"; its flag "Values possibly different"
stays in its title. The cyclic and tail tabs keep their order (the next action, "Tuning result", then "Recorded problems").
The recommendations go to the CLI file (`gmDraftRecs`, appended to `exportRecsOf`, `picksOf` and `compiledPlan`):
- A change that a gate holds: `gmDraftRecs` also adds the gate ids of the result on display when the worker gave none, so
  `hasCli` and `pickDefault` leave it out and its "Blocked" list links the steps. The panel shows a notice with the gates.
- `controlCliAuthorization` permits the CLI text while the result is current: a rule change always, a change from the model
  (`confidence: 'predicted'`) only with the status validated or partial. `noCliText` gives the governor reason (`authorized.why`),
  not the reason of the 6-DOF digital twin.
- The panel lists these changes. The "Changes for export" list of the Governor step leaves them out (`stepPicksHtml`, `govDraft`).
- They are one flight test of "Different flight tests". The PID profile menus of the Export tab select the configuration of the
  control changes of the analysis only: the governor model uses the logs of the analysis, as the filter tune uses its log, and
  the Export tab says so.

The plots of the panel (`govPlotSpec`): the plots of each test flight have the logged governor states other than OFF, ACTIVE and
BYPASS as bands (`gov_fit.stateBands`, `b.state`), in the colors of `STATE_BAND`; a label only on a band of 3 % or more of the axis.
An opt-in check (`rec.optIn`) gives its own cause (`govOptInHtml`): the BYPASS condition for the BYPASS curve, else the sentence of the
toolkit that says why the app does not select it (with the sentence before it when it starts with "Thus"), from the recommendation or
the other changes of its group, else `GM_OPT_IN` of its parameter.

Tests: `test/tuning_worker.test.cjs` runs the command on the simulated file with a stand-in `gov_tune.cjs` (the runs that it gets,
the protocol, progress, cancel, the unavailable path and its reasons, the stale and `govJoin`, the gates, the class and the DISARM events
of each part, a phase failure, the PID profile at the start from the other logs of the file), and runs the real `autotune` with a budget
of 3 s on the simulated file. With `AUTOTUNE_GOV_LOG=<dump>` (and `AUTOTUNE_GOV_CLI`, `AUTOTUNE_GOV_RPM`, `AUTOTUNE_GOV_OUT`,
`AUTOTUNE_GOV_FIXTURE`) it runs the command on a real dump (about 4 min): the status, the 42 names, JSON of 8 MB or less, the profile
lines, and the frame clock of the headspeed plots against the log. `test/tuning_dialog.test.cjs` tests the panel with a fake worker
(the start message, the result, the export, the gates, the statuses, cancel and errors, the opt-in causes, the band colors) and with the
real Fireball result of `test/fixtures/governor_tuned_fireball.json.gz` (each plot through the real `TuningPlot`, the CLI file of the
default picks). `test/ste_text.test.cjs` lints the sentences of every `tools/autotune/gov_*.cjs`, and with `AUTOTUNE_GOV_LOG` (or
`AUTOTUNE_REAL_LOG`) the `governorTuned` results of the worker test.

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

- **Recorded configurations** (`result.datasets`, `hierarchy.byDataset`) sit below the flight selection and above the
  tuning tabs, except in Filters. The selector chooses one configuration for the control steps. Expand its recorded values and their
  sources or compare all configurations without leaving the step. The reference includes log/flight coverage, changed
  parameters, unknown values, values inherited from another log, and freshness flags. Configurations are not tuning steps.
  Hooks: `getConfiguration()`, `setConfiguration(id)` and `onConfiguration(cb)`. An Analysis result opens its recorded
  configuration, preserving this scope. The auxiliary `configs` route remains for existing Analysis links.
- **Step navigation** is Overview, Filters, Governor, Cyclic gains, Tail gains, Cyclic compensation, Tail
  compensation, Export. Overview contains the full tuning sequence. Every block has a corresponding step tab, and each
  step has previous/next links. The Filters block contains the explanation and Autotune action directly. Step selections
  update one shared pending record; changing the recorded configuration preserves each control draft.
  Tabs show status text and counts with red for problems or analysis errors, amber for monitor items, green for
  satisfactory checks and gray for missing data or information. Control status uses the selected configuration's
  recorded findings; selecting a proposal does not clear them. Filters uses its selected flight source and current,
  confirmed replay, retaining physical-input problems and recorded problems that replay cannot evaluate. Manual edits
  and stale results cannot retain a replay clearance. Overview combines those filter results with the selected control
  configuration. Export flags conflicts and unsupported changes in red and selected changes to examine in amber.
- **Native tuning selectors** that replace their own controls defer the change until the native popup callback returns.
  Synchronous replacement crashes the Chromium 99 macOS renderer, reproduced with the filter source and flight interval.
  The same guard covers configuration, control-reference, segment, vibration-profile and final-configuration selectors.
  Obsolete callbacks cannot change a newer selection, file, analysis, tab, configuration or filter source.
- **Filter workspace** starts with a log/flight source selector. Each source has its own filter draft.
  The recorded configuration table lists time ranges, PID profiles, value sources and freshness flags. It opens automatically for
  multiple or unknown configurations. One editable **Filter parameters** table contains recorded and proposed values.
  Autotune fills this table once for each source, input set and delay limit. Afterward, **Simulate again** evaluates the current draft.
  Changing the delay limit permits a new search. **Use recorded values** immediately replays each interval's own values,
  including mixed configurations, without converting the first interval into a common target. This baseline replay
  does not propose a change or enable a CLI download. Filters, Overview and replay diagnostics identify it as an
  unchanged recorded replay. Loading recorded values alone still leaves the initial Autotune
  action available. There is no separate
  parameter-difference table or Before/After overview. **Show changed values only** compares against every recorded configuration, normalizes
  enum and array representations, retains unknown values, and preserves edits across replay and tab changes.
  The maximum added delay defaults to 0.5 ms. Manual edits, recorded-value reset and autotune-value restore use this table.
  Accepted changes enter the shared draft automatically; Export controls which changes enter the CLI file.
  Unreplayed edits and stale results cannot enter Export.

  One **Filter checks** shows the recorded results before replay and the original judges' paired results afterward.
  Previously violated checks stay marked and appear first, including those cleared in replay. New issues and unavailable
  results remain explicit. A failed model validation cannot display a confirmed signal clearance; independently checked
  parameters can show **Parameter problem corrected**. Recorded physical vibration
  findings remain unchanged inputs. Failed results show the next action, excluded intervals and precise time ranges above
  the table. Missing replay coverage is distinct from disagreement with the recorded output. Detailed model validation
  and filter input coverage remain inside the checklist. Accepted results identify remaining problem checks beside the
  next action, distinguishing replay limits from the original flight checks. Checklist intervals use log seconds so short
  periods retain distinct endpoints. The separate recorded-flight checks table is removed.

  **Gyro signals** shows roll, pitch and yaw together. Each axis pairs a time plot with a frequency plot, stacking at narrow
  widths. One selector identifies the log, configuration, PID profile and full interval for both domains on all axes.
  Each trace includes its own spectrum, computed from exactly that scored window at the recorded sample rate with no
  display decimation. The time plot retains native-rate replay samples. Legacy results without interval spectra explicitly
  identify their spectra as averages over all evaluated windows. Raw data means recorded gyroRAW, Previous filter means
  recorded gyroADC, and New filter means the calculated output from the same flight input. Shared checkboxes control all
  six plots without replacing inputs or rerunning analysis; the selection persists across interval and result changes.
  Missing curves are unavailable. A recorded-only replay disables the new-filter curve. The redundant recorded-versus-model
  replay disclosure is removed. P+D previews are omitted because they represented only the modeled gyro
  contribution, not the full PID output or the helicopter response. Autotune still evaluates P+D noise and per-path delay.

  Results remain cached by file, flight source, recorded interval values, derived RPM and CLI input. Analysis derives
  its RPM threshold from the recorded governor data. Filter tuning reuses that threshold only for current inputs.
  Flight and abnormal-mode masks are computed on complete decoded segments before flight and configuration cuts.
  The masks are sliced with the samples, so profile changes cannot restart flight detection. Periods with no eligible
  flight samples remain outside the analysis. Eligible flight intervals with no complete filter window are excluded
  before reconstruction and checklist replay. Their coverage limits block a confirmed recommendation.

  **Export only this test** selects one control change group and its recorded configuration, preserving atomic groups.
  Other control and filter changes are deselected. Export explains when several independent trials are selected and
  labels restoration of an older configuration as **Recorded configuration values**. Prerequisite cards state when an upstream
  change is itself blocked, so the user can follow the required flight-test sequence.
  Gain extraction decodes only selected logs. Configuration provenance can still use headers from the complete file.
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
- 2026-10-17, release of the crash-flight round (IMP-01 to IMP-07, IMP-11, IMP-12), built from an rsync snapshot of the shared
  tree and installed with `make apps`:
  - Without real logs, every `test/*.test.cjs`: 1407 tests, 0 failures (35 skipped for missing real logs; the snapshot also skips
    the git test). `test/ste_text.test.cjs`: 49 of 49, also with `AUTOTUNE_GOV_LOG` set to the crash log.
  - With `AUTOTUNE_REAL_LOG` (Gaui X4 II 2026-10-04 11:37) and `AUTOTUNE_RESCUE_LOG` (Fireball 2026-10-05): `tuning_worker` 96 tests,
    1 failure from before this round ("round 2: Fireball 2026-10-05 in file scope" expects the governor item `blocked`, the
    hierarchy gives `possible` since commit 4af7fc9, G21 does not gate). `PARAM_EPOCHS_LOG` with the crash log and with the
    Fireball dump, `health_rescue`/`health_limits` with the Fireball dump, and `governorTune real` on the Fireball dump with its
    CLI dump of 2026-10-13 (partial), on the crash log (partial) and on the Gaui dump (Vbat 0): no failure.
  - Firmware: `git diff 118e912 58a4bd5cc` and `118e912 874f369d5` of the 25 manifest files changes only `flight/pid.[ch]`,
    `flight/mixer.c`, `flight/governor.[ch]` and `flight/rpm_filter.c`, with additions only (the journal hooks and the read-only
    fingerprints), and their sha256 agree with `firmware/equivalence.cjs`. 58a4bd5cc and 874f369d5 have the same manifest files.
  - Installed app (app.nw on the 0.62.2 SDK runtime over CDP): the Analysis view on `crash.bbl` completes in 35 s, with D10 "No
    receiver signal" 2.1 s (problem) and D11 "In-flight motor cut" under "Transmitter and rescue", and no page error.
