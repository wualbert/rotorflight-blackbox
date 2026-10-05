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
- For analysis use `getChunksInTimeRange`, never the smoothed variant. Time is in microseconds.
- Handle missing fields: what a log contains depends on the pilot's blackbox settings.
- CI builds installers only. It runs no tests and no lint, so run tests locally.
- Tuning work is quantitative. Every recommendation needs a number, its uncertainty and the rule it
  passed; thresholds live in `RULES` at the top of `tools/autotune/report.cjs`, `wag_report.cjs` and `health_report.cjs`. See
  section 12 of the guide.
- Viewer only: there is no connection to a flight controller. Tuning output is advice and
  CLI text for the pilot to review, never applied automatically.
