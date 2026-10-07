# Rotorflight Blackbox

NW.js desktop app for analysing Rotorflight (RC helicopter) blackbox flight logs.
Long-term goal for this checkout: add automatic controller tuning.

**Read `docs/DEVELOPMENT.md` before non-trivial work.** It covers the build, architecture,
data model, existing analysis code, a verified headless test harness, and the tuning roadmap.

## Commands

```sh
make init                 # install dependencies
make dev-server           # Vite on http://localhost:8080 (terminal 1)
make dev-client           # NW.js shell against the dev server (terminal 2)
node --test test/save_file.test.cjs test/video_export.test.cjs
make apps                 # production build into apps/

# tuning analysis (offline): logs -> segments.json -> report.md
node tools/autotune/extract.cjs <out dir> <log files...>
node tools/autotune/report.cjs <out dir>
node --test test/autotune.test.cjs

# oscillation and tail wag: logs -> bursts.json -> report.md
node --max-old-space-size=12000 tools/autotune/wag.cjs <out dir> <log files...>
node tools/autotune/wag_report.cjs <out dir>
node tools/autotune/spectra.cjs <out dir> <log file> [logs for spectrograms]   # then wag_report.cjs again
node tools/autotune/line.cjs <out dir> <log file>                              # one vibration line, then:
node tools/autotune/line_report.cjs <out dir>
python3 tools/autotune/spectra_plot.py <out dir>                               # figures; needs numpy, matplotlib

# health checks (TUNING_KNOWLEDGE.md section 10): logs -> health.json -> report.md
node --max-old-space-size=12000 tools/autotune/health.cjs <out dir> <log files...> [--cli <cli dump>]
node tools/autotune/health_report.cjs <out dir>
node --test test/health_gov.test.cjs test/health_loop.test.cjs test/health_setup.test.cjs
# rescue checks (G19, T15, D8) and control limits (L1-L7); with the Fireball dump of 2026-10-05 the real rescues too
AUTOTUNE_RESCUE_LOG=<fireball 2026-10-05 dump.bbl> node --max-old-space-size=8000 --test test/health_rescue.test.cjs test/health_limits.test.cjs

# Analysis and Tuning views (in the app; DEVELOPMENT.md section 13): checks, catalog, tuning order, evidence, advice, worker, plots, views, lens, verdict
node --test test/health_track.test.cjs test/health_more.test.cjs test/health_phase.test.cjs test/catalog.test.cjs test/hierarchy.test.cjs test/evidence.test.cjs test/advice.test.cjs
node --test test/tuning_plot.test.cjs test/tuning_snippet.test.cjs test/tuning_dialog.test.cjs test/log_lens.test.cjs test/analysis_view.test.cjs test/views.test.cjs
AUTOTUNE_REAL_LOG=<RTFL_BLACKBOX_LOG_20261004_113720.BBL> AUTOTUNE_RESCUE_LOG=<fireball 2026-10-05 dump.bbl> node --max-old-space-size=8000 --test test/tuning_worker.test.cjs   # parity with health.cjs + health_report.cjs, the Fireball tests; about 11 min; without them the real-log tests skip
PARAM_EPOCHS_LOG=<fireball 2026-10-05 dump.bbl> node --test test/param_epochs.test.cjs   # arms, re-arms and the parts of each log whose values are possibly not current
node --test test/datasets.test.cjs test/filter_tune.test.cjs   # configurations (datasets.cjs) and the filter search (filter_tune.cjs, worker command filterTune)
node tools/autotune/datasets.cjs <log file> [--cli <dump>]        # the configurations of a file; node tools/autotune/filter_tune.cjs <out dir> <log file> [--cli <dump>]: the filter search
node --test test/ste_text.test.cjs        # ASD-STE100 lint of every text that the app shows (docs/STE_GLOSSARY.md); about 30 s

# Gaui X4 II: every measurement of one dump in about 4 min (cache + toolkit + 12 area run.sh), no agents;
# then the saved workflow x4-new-dump interprets it against the previous dump
bash analysis/gaui-x4/run_all.sh <dump.BBL> <out dir> [groups.json]

# read the flash of a flight controller over USB, read-only (Configurator closed)
python3 tools/flash_read.py /dev/cu.usbmodemXXXX --out log.bbl [--resume]
```

## Rules that bite

- No module system. Files are classic scripts sharing globals; order in `index.html` is the
  dependency order.
- A new JS or CSS file needs **both** a tag in `index.html` and an entry in `distSources` in
  `gulpfile.js`. Miss the second and it works in dev but is absent from packaged builds.
- No transpiler. Code must run as written on Chromium 99.
- The app only runs inside NW.js, not a plain browser.
- Keep computation separate from DOM code so it can be tested in Node.
- Analysis and Tuning are full-screen views (`showView` in `js/main.js`), not modal dialogs. The log viewer stays laid out
  under them. A handler that is only for the log viewer must examine `activeView`. "Show in the log" keeps a copy of the
  pilot's graphs and puts them back: never call `newGraphConfig` for it, because that writes the saved workspace.
- For analysis use `getChunksInTimeRange`, never the smoothed variant. Time is in microseconds.
- Handle missing fields: what a log contains depends on the pilot's blackbox settings.
- CI builds installers only. It runs no tests and no lint, so run tests locally.
- Tuning work is quantitative. Every recommendation needs a number, its uncertainty and the rule it
  passed; thresholds live in `RULES` at the top of `tools/autotune/report.cjs`, `wag_report.cjs` and `health_report.cjs`
  (and in `DEFAULT_RULES` / `RULES` of `health_track.cjs`, `health_more.cjs`, `health_phase.cjs`, `health_rescue.cjs`, `health_limits.cjs`, `health_config.cjs`, `health_power.cjs`, `advice.cjs`,
  `datasets.cjs` and `filter_tune.cjs`; `DS_RULES` of `advice.cjs` for the A/B and the slopes; the D2 frame loss `D2_LOSS` and the issue sizes `ISSUE_RULES` of `catalog.cjs`). See sections 12 and 13 of the guide.
- The app loads `tools/autotune/*.cjs` as text through a CommonJS shim in `js/tuning_worker.js`. In those files, no Node
  API calls at module load, and keep `module.exports` then `if (require.main !== module) return`. A file the worker loads
  needs a `distSources` entry too.
- Viewer only: there is no connection to a flight controller. Tuning output is advice and
  CLI text for the pilot to review, never applied automatically.
- **Writing (ASD-STE100, Issue 9).** Write all text that the app shows in STE. This rule is also applicable to the text that
  `tools/autotune` writes for the app:
  - Use only approved words, and the technical nouns and technical verbs in `docs/STE_GLOSSARY.md`.
  - Use a maximum of 20 words in an instruction and 25 words in a description or a note.
  - Do not use semicolons.
  - Write one instruction in each sentence, in the imperative, with the condition first.
  - Put text that you cannot change in quotation marks or in code font. In HTML, use `<code>`, `<pre>` or `data-ste="quoted"`.
  - Before you commit, do the test `node --test test/ste_text.test.cjs` and make sure that it shows no errors. The test cannot
    find all errors. Thus, read the text again.
- **Gear ratios.** The gear ratios in the configuration are correct. Write this in each text about a vibration line or about
  the headspeed:
  - Do not tell the pilot that a gear ratio, a pulley or the number of teeth is incorrect. Do not tell the pilot to examine,
    measure or change them.
  - A line that is not a rotor harmonic is a resonance. Show it as a target for a notch filter (the dynamic notch filter, or
    a static notch filter at a constant frequency) and as a mechanical vibration to examine.
  - For check G12, write about `motor_poles` and the RPM sensor, not about the gear ratio.
  - The test `test/ste_text.test.cjs` finds most of these errors (check GEAR).
- **PID profiles.** Each result, period, recommendation and export line has its PID profile, and the log lens shows it:
  - The diagram of the tuning sequence shows the condition of each step for each PID profile, and "All PID profiles" shows
    them together.
  - A "from" value comes only from one of three sources. These are the CLI section of that PID profile, the gains that the
    analysis calculates for it, and the log header. Use the log header only if its PID profile was active when the log
    started. The header has the values at the start of the log. If the pilot arms the helicopter again during
    `blackbox_grace_period`, the same log continues.
  - The header does not show the number of the PID profile. Three sources show the PID profile at the start of the log.
    These are a log event of a PID profile change at the first frame, the CLI dump and the governor headspeed (`govRequest`).
  - The governor headspeed gives PID profile N if two conditions are correct. In the same file, PID profile N has that
    headspeed at each recorded PID profile change. No other PID profile has that headspeed. Show this source in the texts.
  - If the app cannot find this PID profile, show "PID profile unknown". Then give no CLI text and no export.
  - In the app, write "PID profile 1" to "PID profile 6", as the Configurator shows them. In CLI text, write `profile 0` to
    `profile 5`.
- **No access to the flight controller.** The log is the only necessary input. A CLI dump is optional:
  - Do not tell the pilot to load a dump or to connect the flight controller before the analysis.
  - Tell the pilot which values the log does not record. If a flight can record a value, tell the pilot how to do it.
  - The export does not change. The pilot uses it after the analysis.
- **Values that are possibly not current.** Show a flag on each result, period, recommendation and log lens window that
  uses such values (user, 2026-10-06):
  - A later arm in the same log. The header has the values of the first arm only.
  - A PID profile or a rate profile that is not the profile at the start of the log.
  - A change of the governor headspeed without a logged event, or a part of the log after a logging pause.
  - For each flag, give the source of the values that the app uses for that part, or "unknown".
  - Use only the causes that can change the value. A PID profile change applies to the values of a PID profile, a rate
    profile change to the rates, and an adjustment to its parameter. A later arm and a logging pause apply to all values.
  - In the CLI file, a flagged change stays selected. A comment line before its command gives the flag (user, 2026-10-06).
- **Flights, phases and bench runs.** A log with one or more flights is a flight log. A log with no flight is a bench run:
  - The analysis does not use bench runs, and the app shows them as "Bench run (no analysis)".
  - `health_phase.cjs` divides a flight log into the flight phases idle, spool-up, ground, flight and spool-down, in frame
    seconds. Each result has its flight phase.
  - The attitude-loop checks, the filter checks, the vibration checks and the gains of `report.cjs` use only the flight
    phase, without rescue, level modes and failsafe.
  - The governor, motor, ESC and power checks use all flight phases of a flight log, with a rule for each phase.
- **Control limits.** Examine each control output that is at its limit. This rule is applicable to the throttle, the collective, the
  cyclic, the tail, the servos, the I-term and the PID sum:
  - Find each period at the limit in all flight phases, also in rescue. Do not use a guard time that removes these periods.
  - Show each period with its time, its duration, the other outputs at their limits at the same time and the errors during the period.
  - If a log has one or more periods at a limit, do not show "Satisfactory" for that output.
- **Export.** The "CLI file" panel of the Tuning view writes a CLI script for the pilot. It writes a file or the clipboard
  only, and it does not send data to the flight controller:
  - The pilot selects the recommendations. By default, the panel selects the changes that have CLI text. It does not select
    the checks or the items to monitor.
  - The script starts with this step: save the output of `diff all`. Then it gives the `profile` lines, the `rateprofile`
    lines, the other `set` lines and `save`.
  - The comment lines (`#`) give the craft name, the log, the firmware, the PID profiles and the date. For each change, they
    give the previous value, the new value, the result and the rule.
  - Make sure that each value is in its range (`RANGE` in `advice.cjs` and the firmware). Do not write a parameter name that
    the firmware does not know. Write a `feature` line only with a feature name of firmware 4.6 (`FEATURE_NAMES` in `advice.cjs`).
