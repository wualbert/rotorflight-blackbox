'use strict';

/**
 * Health report: <dir>/health.json (from health.cjs) -> <dir>/report.md and <dir>/results.json
 *
 *   node tools/autotune/health_report.cjs <dir>
 *
 * The modules measure (analyse), this script judges: every threshold is in RULES below, one entry per check of
 * docs/TUNING_KNOWLEDGE.md section 10, with its source (firmware | doc | community | pipeline, unvalidated).
 * RULES starts as a copy of the modules' DEFAULT_RULES; edit it here. A value that differs from a module's default
 * is announced on stderr, so a changed module default is not missed either.
 *
 * Two kinds of number decide findings without being in RULES, and the report lists both with their values: the in-flight
 * gate of health.cjs (applied when health.json was made; it decides whether the governor and loop checks run at all), and
 * the measurement parameters of the modules in MEASURED below (what counts as at the ceiling, as an output limit, ...).
 */

const fs = require('node:fs'), path = require('node:path');
const MODULES = { setup: require('./health_setup.cjs'), gov: require('./health_gov.cjs'), loop: require('./health_loop.cjs') };

const RULES = {
    sig: 2, // a value must pass its threshold by this many standard errors to be flagged (governor checks)
    // data validity (health_setup, D5 in health_gov)
    D1: { minHz: 1000, source: 'pipeline, unvalidated' },
    D2: { maxJumps: 0, maxGaps: 0, source: 'pipeline, unvalidated' },
    D3: { source: 'pipeline, unvalidated' },
    D4: { source: 'pipeline, unvalidated' },
    D5: { step: 1, minCell: 3, minS: 0.5, source: 'pipeline, unvalidated' },
    H: { source: 'log header' },
    // governor, ESC and power (health_gov)
    G0: { source: 'firmware' },
    G1: { fallback: 1, source: 'firmware' },
    G2: { median: 0.01, band: 0.02, minS: 10, source: 'pipeline, unvalidated' },
    G3: { minStep: 0.3, good: 0.03, flag: 0.05, minEvents: 3, saturatedShare: 0.5, source: 'pipeline, unvalidated', note: 'minStep in |collective| / one-sided travel (1 = full pitch)' },
    G4: { minStep: 0.3, flag: 0.03, minEvents: 3, source: 'pipeline, unvalidated', note: 'minStep in |collective| / one-sided travel (1 = full pitch)' },
    G5: { minStep: 0.3, flag: 0.5, minEvents: 3, source: 'pipeline, unvalidated', note: 'minStep in |collective| / one-sided travel (1 = full pitch)' },
    G6: { median: 85, runS: 0.1, deficit: 0.02, source: 'doc' },
    G7: { source: 'firmware' },
    G8: { unityShare: 0.99, bounds: [0.8, 1.2], minN: 1000, source: 'firmware' },
    G9: { prominence: 5, minAmplitude: 0.001, maxCollectiveCoherence: 0.5, minWindows: 4, source: 'pipeline, unvalidated' },
    G10: { implicated: 0.5, ruledOut: 0.1, flatRpm: 10, minWindows: 8, source: 'pipeline, unvalidated' },
    G11: { perPack: 5, minBlocks: 10, source: 'pipeline, unvalidated' },
    G12: { tolerance: 0.005, minProminence: 3, source: 'pipeline, unvalidated' },
    G13: { minCell: 3.3, source: 'pipeline, unvalidated' },
    // cyclic (health_loop)
    C1: { level: 0.95, minS: 0.2, source: 'firmware', note: 'limit from firmware (pid.c:1156-1166); 95 % and 0.2 s are pipeline, unvalidated' },
    C2: { minEpisodes: 1, source: 'firmware', note: 'limits enforced by the firmware; detected from the data (RULE.limitSamples, pipeline)' },
    C3: { iShare: 0.1, gyroRatio: [0.9, 1.1], minEvents: 3, source: 'pipeline, unvalidated', note: 'doc says only "I remains near 0" (TUNE)' },
    C4: { overshootPct: 10, settleS: 0.3, minEvents: 3, source: 'pipeline, unvalidated' },
    C6: { prominence: 5, minWindows: 8, source: 'pipeline, unvalidated', note: 'band from doc (TUNE 0.5-1, PROF 1-3 Hz)' },
    C8: { minWindows: 10, source: 'pipeline, unvalidated', note: 'report only, no threshold' },
    C9: { minBlocks: 10, source: 'pipeline, unvalidated', note: 'report only' },
    C10: { tau: [2, 3], airborneTauMin: 5, minSpans: 200, source: 'firmware', note: 'ground decay tau 2.5 s at error_decay_ground 25 (pid.c:1170-1181); window pipeline' },
    C11: { share: 0.5, minWindows: 10, source: 'pipeline, unvalidated' },
    // tail (health_loop)
    T2: { prominence: 5, minWindows: 8, source: 'pipeline, unvalidated', note: 'band from doc' },
    T4: { hzChange: 0.1, gainChange: 0.2, minBursts: 5, source: 'pipeline, unvalidated', note: 'rationale PROC45' },
    T5: { ratio: 1.5, minEvents: 3, source: 'pipeline, unvalidated', note: '+-10 deg/s blend is firmware (pid.c:1277)' },
    T6: { kick: 30, minEvents: 3, source: 'pipeline, unvalidated', note: 'sign rule PROF' },
    T7: { r: 0.5, minWindows: 5, source: 'pipeline, unvalidated', note: 'rationale [COM] RCG-55' },
    T8: { minEpisodes: 1, source: 'firmware' },
    T9: { iShare: 0.1, gyroRatio: [0.9, 1.1], minEvents: 3, source: 'pipeline, unvalidated' },
    // filters and vibration (health_setup)
    F1: { source: 'doc' },
    F2: { flagHz: 60, noteHz: 80, source: 'doc' },
    F3: { minQ: 2, source: 'doc' },
    F4: { targetHz: 20, toleranceHz: 5, source: 'doc' },
    F5: { minProminence: 5, maxDistance: 0.02, minWindows: 3, source: 'pipeline, unvalidated' },
    F6: { minDb: 10, minWindows: 3, minLineProminence: 5, source: 'pipeline, unvalidated' },
    F8: { minPidHz: 1000, source: 'firmware' },
    F9: { notchCeiling: 0.45, source: 'pipeline, unvalidated' },
};

// Measurement parameters that decide what a finding sees (module RULE, applied in analyse, so fixed in health.json)
const MEASURED = [
    ['health', 'flight', 'in-flight gate: airborne, headspeed >= headspeed rpm, and a log is flown if >= minS s of that at >= rate deg/s rms body rate; gov and loop checks run only on flown logs', null],
    ['gov', 'ceiling.fraction', 'motor[0] >= this x the ceiling counts as at the ceiling (G3 saturated, G6, G7)', (M) => M.gov.RULE.ceiling.fraction],
    ['gov', 'ceiling', 'ceiling guessed from a motor[0] pile-up when the CLI gives no gov_max_throttle (G6, G7)', (M) => M.gov.RULE.ceiling],
    ['gov', 'cliCheck', 'a CLI value the log contradicts is not used (request above gov_headspeed x request; motor[0] above gov_max_throttle by counts)', (M) => M.gov.RULE.cliCheck],
    ['gov', 'step', 'collective events: |collective| / one-sided travel, min step and bins (G3, G4, G5)', (M) => M.gov.RULE.step],
    ['gov', 'unsat.vcompOffShare', 'G7 takes voltage compensation as off when this share of unsaturated motor[0]/govSum is 1', (M) => M.gov.RULE.unsat.vcompOffShare],
    ['gov', 'vbat.startCell', 'cell count inferred from the resting voltage when the CLI gives none; ambiguous = no per-cell verdict (D5, G13)', (M) => M.gov.RULE.vbat.startCell],
    ['loop', 'limitSamples', 'an extreme reached this often is an output limit (C2, T8)', (M) => M.loop.RULE.limitSamples],
    ['loop', 'dNoise.hz', 'C11 measures the share of axisD power above this frequency', (M) => M.loop.RULE.dNoise.hz],
    ['loop', 'flight', 'C10 landed-while-moving windows: fallback when health.json has no gate (health.cjs passes its own)', (M) => M.loop.RULE.flight],
];

// Checks done elsewhere in the pipeline, listed so the check list is complete
const ELSEWHERE = { C5: 'wag.cjs / wag_report.cjs', C7: 'report.cjs', T1: 'wag.cjs / wag_report.cjs', T3: 'wag.cjs / wag_report.cjs', T10: 'wag_report.cjs', F7: 'spectra.cjs / wag_report.cjs' };

const SECTIONS = [
    ['Data validity', /^D[1235]$/],
    ['Setup and tuning history', /^(D4|H|SETUP)$/],
    ['Governor, ESC and power', /^G\d+$/],
    ['Cyclic', /^C\d+$/],
    ['Tail', /^T\d+$/],
    ['Filters and vibration', /^F\d+$/],
];
const RANK = { error: 0, flag: 1, note: 2, ok: 3, skipped: 4 };

const DIR = process.argv[2];
if (!DIR) { console.error('usage: node health_report.cjs <dir>'); process.exit(2); }
const H = JSON.parse(fs.readFileSync(path.join(DIR, 'health.json'), 'utf8'));

// RULES against the module defaults
for (const [name, M] of Object.entries(MODULES)) for (const [k, v] of Object.entries(M.DEFAULT_RULES)) {
    if (!(k in RULES)) console.error(`RULES lacks ${k} (${name}); the module default is used`);
    else if (JSON.stringify(RULES[k]) !== JSON.stringify(v)) console.error(`RULES.${k} differs from the ${name} default ${JSON.stringify(v)}`);
}
const rulesFor = (M) => Object.fromEntries(Object.keys(M.DEFAULT_RULES).map(k => [k, k in RULES ? RULES[k] : M.DEFAULT_RULES[k]]));

// judge
const findings = [];
for (const [name, M] of Object.entries(MODULES)) {
    const flights = H.logs.filter(l => l.metrics && l.metrics[name]).map(l => ({ log: l.log, start: l.start, header: l.header, metrics: l.metrics[name] }));
    try { for (const f of M.judge(flights, rulesFor(M))) findings.push(Object.assign({ module: name }, f)); }
    catch (e) { findings.push({ module: name, id: name.toUpperCase(), severity: 'error', log: null, text: `judge failed: ${e.message}` }); }
    for (const l of H.logs) if (l.errors && l.errors[name]) findings.push({ module: name, id: name.toUpperCase(), severity: 'error', log: l.log, text: `analyse failed: ${l.errors[name].split('\n')[0]}` });
}
for (const l of H.logs) if (l.skipped) findings.push({ module: 'health', id: 'D2', severity: 'flag', log: l.log, text: `log not analysed: ${l.skipped}`, source: 'parser' });

const logsOf = (f) => Array.isArray(f.log) ? f.log : f.log === null || f.log === undefined ? [] : [f.log];
const timesOf = (f) => { const t = new Set();
    for (const e of f.events || []) if (typeof e.t === 'number') t.add(e.t);
    for (const m of String(f.text || '').matchAll(/\bat (\d+(?:\.\d+)?) s\b/g)) t.add(+m[1]);
    return [...t].sort((a, b) => a - b); };
for (const f of findings) f.times = timesOf(f);
findings.sort((a, b) => (RANK[a.severity] ?? 5) - (RANK[b.severity] ?? 5) || String(a.id).localeCompare(String(b.id), 'en', { numeric: true }) || String(logsOf(a)[0]).localeCompare(String(logsOf(b)[0]), 'en', { numeric: true }));

// report
const esc = (s) => String(s === null || s === undefined ? '' : s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
const fmtNum = (v) => typeof v === 'number' ? (Math.abs(v) >= 100 ? v.toFixed(0) : +v.toPrecision(3)) : v === null || v === undefined ? '' : esc(JSON.stringify(v));
const thr = (t) => t === null || t === undefined ? '' : typeof t === 'object' ? esc(JSON.stringify(Object.fromEntries(Object.entries(t).filter(([k]) => k !== 'source' && k !== 'note')))) : esc(t);
const logList = (f) => logsOf(f).join(', ');
const timeList = (f) => f.times.length ? f.times.slice(0, 6).map(t => t + ' s').join(', ') + (f.times.length > 6 ? ', ...' : '') : '';
const count = (list) => { const c = {}; for (const f of list) c[f.severity] = (c[f.severity] || 0) + 1; return c; };
const countText = (c) => ['error', 'flag', 'note', 'ok', 'skipped'].filter(k => c[k]).map(k => `${c[k]} ${k}`).join(', ');

const L = [];
L.push('# Health report', '');
L.push(`Logs: ${H.files.join(', ')}${H.cli ? `; CLI dump ${H.cli}` : '; no CLI dump (D4 skipped)'}. Generated by \`tools/autotune/health_report.cjs\` from \`health.json\`.`, '');
L.push('Measurements from `health_gov.cjs`, `health_loop.cjs` and `health_setup.cjs`; every threshold is in `RULES` at the top of `health_report.cjs`, with its source. '
    + 'Checks C5, C7, T1, T3, T10 and F7 are done by `wag_report.cjs` and `report.cjs`. Measurements are not facts about the hardware; a flag says where to look.', '');
const FL = H.rule.flight;
L.push(`In flight: airborne and headspeed >= ${FL.headspeed} rpm; a log is flown if it has >= ${FL.minS} s of that with body rate >= ${FL.rate} deg/s rms (health.cjs RULE.flight, applied when health.json was made). Totals: ${countText(count(findings))}.`, '');
L.push('## Logs', '', '| Log | Start | Length s | In flight s | Seconds per profile | GOVSTATE | Status |', '|---|---|---|---|---|---|---|');
for (const l of H.logs) L.push(`| ${l.log}${l.segment ? `.${l.segment}` : ''} | ${esc(l.start)} | ${l.seconds ?? l.durationS ?? ''} | ${l.flyingS ?? ''} | ${l.profileSeconds ? esc(Object.entries(l.profileSeconds).map(([p, s]) => `${p}: ${s}`).join(', ')) : ''} | ${l.govStateLogged ? 'yes' : l.skipped ? '' : 'no'} | ${esc(l.skipped || (Object.keys(l.errors || {}).length ? 'error in ' + Object.keys(l.errors).join(', ') : l.flown ? 'flown' : 'not a flight'))} |`);
L.push('');

for (const [title, re] of SECTIONS) {
    const sel = findings.filter(f => re.test(f.id) || (f.severity === 'error' && title === 'Data validity' && !SECTIONS.some(([, r]) => r.test(f.id))));
    L.push(`## ${title}`, '', `${countText(count(sel)) || 'no findings'}.`, '');
    const shown = sel.filter(f => f.severity === 'error' || f.severity === 'flag');
    if (shown.length) { L.push('| Check | Severity | Log | Profile | Axis | Value | SE | n | Times | Finding |', '|---|---|---|---|---|---|---|---|---|---|');
        for (const f of shown) L.push(`| ${f.id} | ${f.severity} | ${logList(f)} | ${f.profile ?? ''} | ${f.axis || ''} | ${fmtNum(f.value)} | ${fmtNum(f.se)} | ${f.n ?? ''} | ${timeList(f)} | ${esc(f.text)} |`);
        L.push(''); }
    const notes = sel.filter(f => f.severity === 'note');
    if (notes.length) L.push(`Notes (${notes.length}) are in the findings table below.`, '');
}

// every check
L.push('## Checks', '', 'Every check, its threshold and source, and what came of it. Skipped: the reasons as given, with the number of logs.', '',
    '| Check | Threshold | Source | Outcome | Skipped because |', '|---|---|---|---|---|');
const ids = [...new Set([...Object.keys(RULES).filter(k => k !== 'sig'), ...findings.map(f => f.id)])].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
for (const id of ids) {
    const sel = findings.filter(f => f.id === id), R = RULES[id] || {};
    const why = new Map(); for (const f of sel.filter(f => f.severity === 'skipped')) { const k = String(f.text).slice(0, 160); why.set(k, (why.get(k) || 0) + 1); }
    L.push(`| ${id} | ${thr(R)}${R.note ? ` (${esc(R.note)})` : ''}${id.startsWith('G') && id !== 'G0' ? `; flag needs ${RULES.sig} SE past the threshold where an SE exists` : ''} | ${esc(R.source || (sel[0] && sel[0].source) || '')} | ${countText(count(sel)) || 'no result'} | ${esc([...why].map(([k, c]) => `${k} (${c})`).join('; '))} |`);
}
for (const [id, where] of Object.entries(ELSEWHERE)) L.push(`| ${id} | see ${where} | | done elsewhere | |`);
L.push('');
L.push('## Measurement parameters', '', 'Not thresholds of a check, but they decide what the checks see. Set in the modules (`RULE`) and `health.cjs`; changing them needs a new `health.json`.', '',
    '| Module | Parameter | Value | What it decides |', '|---|---|---|---|');
for (const [mod, key, what, get] of MEASURED) L.push(`| ${mod} | ${key} | ${esc(JSON.stringify(get ? get(MODULES) : FL))} | ${esc(what)} |`);
L.push('');

// findings table
const table = findings.filter(f => f.severity !== 'ok' && f.severity !== 'skipped');
L.push('## Findings', '', `Errors, flags and notes, most severe first (${table.length}). Every finding including ok and skipped is in \`results.json\`. Times are seconds from log start.`, '',
    '| Severity | Check | Log | Profile | Axis | Value | SE | n | Threshold | Times | Finding |', '|---|---|---|---|---|---|---|---|---|---|---|');
for (const f of table) L.push(`| ${f.severity} | ${f.id} | ${logList(f)} | ${f.profile ?? ''} | ${f.axis || ''} | ${fmtNum(f.value)} | ${fmtNum(f.se)} | ${f.n ?? ''} | ${thr(f.threshold)} | ${timeList(f)} | ${esc(f.text)} |`);
L.push('');

fs.writeFileSync(path.join(DIR, 'report.md'), L.join('\n'));
fs.writeFileSync(path.join(DIR, 'results.json'), JSON.stringify({ files: H.files, cli: H.cli, rules: RULES, flightRule: FL, measured: MEASURED.map(([mod, key, what, get]) => ({ module: mod, key, value: get ? get(MODULES) : FL, what })), logs: H.logs.map(l => ({ log: l.log, segment: l.segment, start: l.start, seconds: l.seconds, flyingS: l.flyingS, flown: l.flown, profileSeconds: l.profileSeconds, skipped: l.skipped, errors: l.errors })), findings }, null, 1));
console.error(`${findings.length} findings (${countText(count(findings))}) -> ${path.join(DIR, 'report.md')}, results.json`);
