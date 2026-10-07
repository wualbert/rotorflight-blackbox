'use strict';

/**
 * Tuning Lab engine: a Web Worker that runs the offline tuning toolkit (tools/autotune/*.cjs) unchanged, off the UI
 * thread, on one log or on every log of a file. An instance that the dialog keeps is the "derive" worker: it filters and
 * measures windows of raw log data for the Tuning view and the log lens, and never decodes a log.
 *
 * The decoder scripts load with importScripts, as lib.loadApp loads them; the toolkit's .cjs files are fetched as text
 * and evaluated by a small CommonJS shim: require over the fetched sources, node:fs an in-memory Map, node:path posix,
 * node:vm onto this global. FLIGHT_RPM is read once when lib.cjs loads, so every flight rpm gets its own set of
 * modules. Health records are built as health.cjs builds them (lines 76-92); health_report.cjs, extract.cjs and
 * report.cjs run as "virtual CLIs" over the in-memory fs, so their findings, decisions and reports are the CLI's.
 * Nothing here talks to a flight controller. The texts a pilot sees (progress, notes, errors) are ASD-STE100.
 *
 *   main -> worker  { cmd: 'analyseLog', id, bytes (ArrayBuffer of ONE log), logIndex, logCount, fileName, options }
 *                   { cmd: 'analyseFile', id, bytes (ArrayBuffer of the whole file), fileName, selectedLog, options }
 *                   { cmd: 'cancel', id }   (honoured between logs; terminating the worker always works)
 *                   { cmd: 'init', id }     (loads the toolkit and the derive modules now)
 *                   { cmd: 'derive', id, kind, rate, cols: { name: Float32Array }, params }   (DERIVE below)
 *                   { cmd: 'export', id, recs, picks: [recommendation ids] | null (advice defaults), meta }   (advice.exportScript)
 *                   { cmd: 'filterTune', id, bytes (the whole file), fileName, options: { cliText, cliName, flightRpm, logs, flights,
 *                     blockedBy (hierarchy node ids or STE texts), budgetMs, loo } }   (round 3 M2: filterTune below)
 *   options         { flightRpm: number | null (auto), cliText, cliName, excludeAbnormal: true, phases: true (health_phase.cjs:
 *                     bench runs left out, attitude checks on the flight phases), curves: true,
 *                     gains: false (file only: extract.cjs + report.cjs), keepMetrics: false (tests: full records),
 *                     flights: null | [{ log, flight }] (file only, SPEC3 D: the selected flights, flight 0-based in its log; only
 *                     those logs, a selected flight of a log with more flights with the time from the touchdown before it to the
 *                     liftoff after it; result.selection { flights, windows, text } in frame seconds, and the text in the notes
 *                     and the report), datasets: true (round 3 M1: the configurations of datasets.cjs; false: none, the PID
 *                     profile labels only), logGear: true (without a CLI dump, the orders of the tail rotor and main motor notch
 *                     filters from the log: gearPlan; false: none) }
 *                     With excludeAbnormal false and no flight phases (phases false, or no health_phase.cjs), the records,
 *                     findings and reports are the CLI's (health.cjs ...), with the toolkit's PID profile labels (lib.profilesOf:
 *                     the stretch before the first change gets the profile that flies its governor target later). Else the
 *                     modules get the raw label 0 there (labelsOf).
 *   worker -> main  { id, type: 'progress', stage, fraction, text } | { id, type: 'result', result } | { id, type: 'error', message, stack }
 *                   | { id, type: 'ready', result: { modules, notes } } | { id, type: 'derived', result } | { id, type: 'exported', result: CLI text }
 *                   | { id, type: 'filterTuned', result } (the filter search: filter_tune.cjs tune() with text, recommendations (each with stale:
 *                     filterStale), logs, blockedBy)
 *
 * result (TuningResult): { version: 1, scope, selection (null, or the flight selection of options.flights: { flights: [{ log, flight, t0, t1 }],
 *   windows: [{ log, t0, t1 }] the time analysed, logs, all: the logs with every flight, text }), fileName, logIndex, logs, flightRpm: { value, source: user | govTarget | headspeed | default, basis,
 *   profile, seconds, logs: [the logs the basis was pooled from] }, cli,
 *   timing: { decodeS, analyseS, judgeS, gainsS, totalS }, records, flights, benchRuns, profiles, header, headerLog, fields,
 *   findings, decisions, groups, advice: { recommendations, coverage, notes, script }, hierarchy, curves, datasets, issues, top, areas,
 *   noData, notchFit, epochs, freshness, cliStatus, reportMarkdown, notes }
 *   epochs      the parameter epochs of each analysed log (param_epochs.cjs, freshnessOf): [{ log, spans: [{ t0, t1, arm, armed, pidProfile,
 *               rateProfile, fresh, reasons, adjust, check, source: { pid, rate }, text }] }], null without param_epochs.cjs. adjust and the
 *               reason 'adjusted' keep only the adjustments that can change a value of the span (of its PID profile or rate profile, or
 *               global), and fresh follows the reasons left (spanInfo); freshness { caveat, reasons: { [reason]: STE text } } | null; f.stale,
 *               the stale of each period of L1-L7 (f.events[].stale), d.stale of the decisions, r.stale of the recommendations, issues[].stale
 *               and the stale of each A/B comparison and of its results (datasets.comparisons[].stale, .results[].stale), each with only
 *               the causes that can change a value that its check reads (READS; CLAUDE.md "Values that are possibly not current")
 *   cliStatus   null without a CLI dump, else { name, used, conflicts: [{ what, text, ... }] }: the log wins over a dump that disagrees
 *               with it (cliStatusOf, armingFinal)
 *   notchFit    the orders of the tail rotor and main motor notch filters that the log shows (filter_tune.cjs tailOrder, gearPlan):
 *               { used (true: the checks F5, F6, F8, F9, the notch markers of the curves and advice F5 have them, basis 'log
 *               notch'), logs, tail, motor: { passed, order, se, n, unit, axis, depthDb, sources, Q, reasons } | null, ms }; null
 *               when the fit did not run (a CLI dump, the CLI's view, options.logGear false)
 *   datasets    round 3 M1: datasets.cjs datasets() of every log of the file (configurations, labels cut to the analysed time, diff,
 *               pairs, info, notes, newest, newestByProfile, unknownNames), with analysed, analysedSeconds, analysedFlightSeconds and
 *               comparisons (advice.cjs); null with options.datasets false
 *   issues, top, areas  round 3 M3: catalog.cjs issues(): one item for each check and axis, the 3 most important, each card's status
 *   noData      round 3 M4: [{ log, reason }] of the logs with no data that the app can read (records[].noData, noDataReason)
 *   header, fields, headerLog   the log header and the field states of the log that advice reads (headerOf): the selected log,
 *               or in file scope the last flight log when the selected log is not a flight log; never a bench run (headerLog
 *               null: no flight log, and result.header is the selected log's, for the display only)
 *   findings[]  the toolkit's, with module and times (health_report.cjs), and for the app: fid (module|id|log|segment|profile|
 *               axis|k, unique in the result), summary (catalog.cjs summary: two paragraphs joined by '\n', the symptom and why
 *               it matters, then the number against its limit), node (hierarchy.cjs homeOf: a prerequisite or a tuning block id),
 *               tuner (true when node is a tuning block: a "poorly tuned parameters" item, K2), area (catalog.cjs areaOf: power,
 *               motor, governor, rpm, vibration, limits, tail, cyclic, radio or logging, K3), evidence
 *               (evidence.cjs forFinding: spans in frame seconds), phase ('flight' | 'all' | 'ground+flight' | a health_phase
 *               phase | null) and phases (the phase names the measurement used, PHASE_USE), pidProfile (1-6: the profile of
 *               the label, the label 0 the arming profile only when it is confirmed; null: unknown or not a PID profile),
 *               cliSection (D4: the CLI section compared and if its comparison can show a stale CLI dump), rateChanges (R1 in
 *               a log with rate profile changes), filterPass (F5 flags of every flight log), explained, and from catalog.cjs
 *               status (D9 key), noun, display { value, unit, scale, limit, bound, profile, phase } (texts for the UI: catalog.cjs
 *               display; value is the quantity that the rule compares, bound the limit in its unit, review V5, V6)
 *   records[]   the summary of each segment (SUMMARY), with timeMap: frame seconds of its samples (timeMapOf); logClass
 *               ('flight' | 'bench' | null: not known), phases [{ phase, t0, t1 }] and flights [{ t0, t1, seconds, method,
 *               confidence, liftoffBy, touchdownBy, atStart, atEnd }] in frame seconds, phaseSeconds { phase: s }, profiles
 *               { arming (armingFinal: D12), pid: [{ t0, t1, profile }] (0: unknown), rate: [{ t, profile }], adjustments: [{ t, func,
 *               name, value }] } in frame seconds. A bench run has no analysis: its metrics hold health_phase only (D7).
 *               profileSeconds and targetOf keep the label of the modules (0: the stretch before the first change); advice
 *               and the hierarchy get them with 0 as the confirmed arming profile (logsInput)
 *   flights     every flight of the result: [{ log, segment, t0, t1, seconds, method, confidence }] (frame seconds)
 *   benchRuns   the logs with no flight, which the app does not analyse: [{ log, start, durationS, phaseSeconds }]
 *   curves[]    of the selected log: { log, segment, fromS, seconds, track, more, phase } (the modules' curves)
 *   profiles    { pid: { [1-6 or 0 = unknown]: { seconds, logs } }, rateChanges: [{ log, t, profile }], arming: [{ log, profile,
 *               basis (event | cli | cliTarget | headspeed confirm; govTarget | fileTarget are estimates), confirmed, estimate,
 *               headspeed (the evidence of the headspeed step: armingCore comment, or null) }] }: the label 0 counts as the
 *               arming profile only when it is confirmed
 *   decisions[] report.cjs's, with fid (report|C7||||axis|bin) and evidence (evidence.cjs forDecision)
 *   hierarchy   hierarchy.cjs status(findings, recommendations, { logs, coverage }), byDataset { id: { pidProfile, nodes, startHere,
 *               prereqProblems } } (the diagram of each analysed configuration): nodes (the prerequisites: ok | problem | noData;
 *               the blocks: the block statuses), startHere (block ids), prereqProblems (prerequisite ids), with graph (hierarchy.cjs
 *               graph(): { prereq, blocks, edges, rules, nodes }, K1) | null
 *   cli         { kind, version, selectedProfile, selectedRateProfile (CLI indexes the dump selects at its end; null when the
 *               dump is possibly cut: selectionOf) } | null
 */

// The decoder as lib.loadApp runs it (lib.cjs:39-53): a jQuery stand-in (the decoder only toggles CSS classes and merges
// option objects), then the scripts in lib.cjs SCRIPTS order, relative to js/
self.window = self;
self.$ = (function () {
    const chain = new Proxy(function () {}, { get: () => () => chain });
    return Object.assign(() => chain, { extend: (deep, target, ...rest) => deep === true ? Object.assign(target, ...rest) : Object.assign(deep, target, ...rest) });
})();
importScripts('vendor/semver.js', 'complex.js', 'real.js', 'tools.js', 'cache.js', 'datastream.js', 'decoders.js',
    'flightlog_fielddefs.js', 'flightlog_fields_presenter.js', 'flightlog_parser.js', 'flightlog_index.js', 'flightlog.js');

var TuningWorker = (function () {
    const DIR = '../tools/autotune/';
    const REQUIRED = ['lib', 'health', 'health_setup', 'health_gov', 'health_loop', 'health_report'];
    const GAINS = ['extract', 'report'];                                   // needed for options.gains only
    const OPTIONAL = { track: 'health_track', more: 'health_more', phase: 'health_phase', rescue: 'health_rescue', limits: 'health_limits', config: 'health_config', power: 'health_power', advice: 'advice', catalog: 'catalog', hierarchy: 'hierarchy', evidence: 'evidence', datasets: 'datasets', epochs: 'param_epochs' };
    const LOST = { track: 'its checks', more: 'its checks', phase: 'the flight phases and the ground checks', rescue: 'the rescue checks', limits: 'the checks of the control limits', config: 'the rescue check of each PID profile (D9)',
        power: 'the battery checks at the load steps (P1, P2)', advice: 'recommendations', catalog: 'the STE summaries',
        hierarchy: 'the tuning sequence', evidence: 'the part of the log that gave each result', datasets: 'the configurations of the flights',
        epochs: 'the parts of the log in which the values are possibly not the values of the log header' }; // without that module
    const ON_DEMAND = ['filter_tune'];                                     // fetched with the others, loaded only by the filterTune command
    const CORE = ['setup', 'gov', 'loop'];                                 // health.cjs MODULES, in its order
    const JUDGED = ['track', 'more', 'phase', 'rescue', 'limits', 'config', 'power']; // the new modules, judged after health_report.cjs
    const ALL_PHASE = new Set(['rescue', 'limits', 'config', 'power']);    // modules that use all phases of a flight log, rescue included, with no guard time
    const SUMMARY = ['log', 'segment', 'start', 'durationS', 'fromS', 'seconds', 'flown', 'flyingS', 'rate', 'actualRate', 'bodyRate', // result.records[]
        'profileSeconds', 'targetOf', 'govStateLogged', 'excluded', 'normalS', 'skipped', 'errors', 'timeMap', // normalS: s that the attitude checks use (else null)
        'logClass', 'phases', 'flights', 'phaseSeconds', 'profiles', 'noData', 'noDataReason'];  // noData: a log with no data that the app can read (round 3 M4)
    const APP_RECORD = ['excluded', 'normalS', 'timeMap', 'logClass', 'phases', 'flights', 'phaseSeconds', 'profiles', 'noData', 'noDataReason']; // not in health.json
    const RANK = { error: 0, flag: 1, note: 2, ok: 3, skipped: 4 };      // health_report.cjs:99
    const r = (v, d = 3) => (typeof v === 'number' && isFinite(v)) ? +v.toFixed(d) : null; // health.cjs:21
    const toJson = (v) => JSON.stringify(v, (k, x) => ArrayBuffer.isView(x) ? Array.from(x) : x); // health.json (health.cjs:106-107)
    const pick = (o, keys) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]));
    const seconds = (ms) => r(ms / 1000, 2);
    const basename = (p) => String(p).split(/[\\/]/).pop();
    const message = (e) => String(e && e.message || e);
    const and = (list) => list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list.join('');
    // sorted log numbers as runs ("1 to 48", "50"), so that a list of many bench runs stays short (STE: 25 words)
    // runs of numbers as items for and(): "1 to 5", "7", "9", "10" (a pair is two items: "1 to 5, 7, 9 and 10")
    const spans = (ns) => ns.reduce((r, n) => { const l = r[r.length - 1]; if (l && n === l[1] + 1) l[1] = n; else r.push([n, n]); return r; }, []).flatMap(([a, b]) => a === b ? [String(a)] : b === a + 1 ? [String(a), String(b)] : [`${a} to ${b}`]);

    // ---------------------------------------------------------------------------------------------
    // Toolkit sources and the CommonJS shim
    // ---------------------------------------------------------------------------------------------

    // every .cjs file as text once per worker: { texts: { 'lib.cjs': text }, missing: { 'advice.cjs': why } }
    let fetched = null;
    function sources() {
        const get = (name) => fetch(`${DIR}${name}.cjs`, { cache: 'no-cache' })
            .then(res => res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`)))
            .then(text => typeof text === 'string' ? [name, text, null] : [name, null, 'no text'], e => [name, null, message(e)]);
        fetched = fetched || Promise.all(REQUIRED.concat(GAINS, Object.values(OPTIONAL), ON_DEMAND).map(get)).then(list => {
            const src = { texts: {}, missing: {} };
            for (const [name, text, why] of list) if (text === null) src.missing[`${name}.cjs`] = why; else src.texts[`${name}.cjs`] = text;
            const lost = REQUIRED.filter(n => !src.texts[`${n}.cjs`]);
            if (lost.length) { fetched = null; throw new Error(`These toolkit files are not available: ${lost.map(n => `"tools/autotune/${n}.cjs" (${src.missing[`${n}.cjs`]})`).join(', ')}.`); }
            return src;
        });
        return fetched;
    }

    const posix = {
        normalize(p) { const out = []; for (const s of String(p).split('/')) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); } return (String(p).charAt(0) === '/' ? '/' : '') + out.join('/'); },
        join: (...p) => posix.normalize(p.join('/')),
        resolve: (...p) => posix.normalize(p.reduce((a, s) => String(s).charAt(0) === '/' ? s : `${a}/${s}`, '/')),
        basename: (p, ext) => { const b = String(p).split('/').pop(); return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; },
        dirname: (p) => String(p).replace(/\/[^/]*$/, '') || '/',
    };

    // node:fs over a Map of path -> string or bytes; reading a decoder script gives '' (lib.loadApp: already loaded here)
    function memFs(files, calls) {
        const counted = (f) => (...a) => { calls.n++; return f(...a); };
        return {
            readFileSync: counted((p) => {
                if (/^\/js\/.+\.js$/.test(p)) return '';
                if (!files.has(p)) throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), { code: 'ENOENT' });
                return files.get(p);
            }),
            writeFileSync: counted((p, data) => { files.set(p, String(data)); }),
            mkdirSync: counted(() => undefined),
            existsSync: counted((p) => files.has(p)),
        };
    }

    // A module's text as a function of the CommonJS arguments, compiled apart from running it. The text starts on line 1 of
    // the script, so stack lines are the file's (Node's CJS wrapper does the same); a hashbang line is blanked, as Node does.
    // V8 gives a syntax error no location in the module, so its message names the file.
    function compile(key, text) {
        try { return (0, eval)(`(function (require, module, exports, process, __dirname, __filename, console) {${text.replace(/^#![^\n]*/, '')}\n})\n//# sourceURL=tools/autotune/${key}`); }
        catch (e) { throw Object.assign(new SyntaxError(`tools/autotune/${key}: ${message(e)}`), { cause: e }); }
    }

    // A CommonJS registry over the source texts (spike autotune_shim.js `load`). o: { rpm, files (Map), argv,
    // main: the entry of a virtual CLI (require.main === its module, as `node <entry>`), console (sink for its output) }.
    // Without o.main, require.main stays undefined and health.cjs returns after its exports, as when required in Node.
    function registry(texts, o) {
        const files = o.files || new Map(), calls = { n: 0 };
        const process = { env: o.rpm ? { AUTOTUNE_FLIGHT_RPM: String(o.rpm) } : {}, argv: o.argv || [], exit(code) { throw new Error(`process.exit(${code})`); } };
        const builtins = { 'node:fs': memFs(files, calls), 'node:path': posix, 'node:vm': { createContext: () => self, runInContext: (code) => (0, eval)(code) } };
        const cache = {}; let main;
        function require(name) {
            if (Object.prototype.hasOwnProperty.call(builtins, name)) return builtins[name];
            const key = String(name).replace(/^\.\//, '');
            if (cache[key]) return cache[key].exports;
            if (typeof texts[key] !== 'string') throw new Error(`Cannot find module '${name}'`);
            const module = { id: key, filename: `tools/autotune/${key}`, exports: {}, loaded: false };
            if (key === o.main) main = module;
            cache[key] = module;
            const req = (n) => require(n); req.main = main;
            try { compile(key, texts[key]).call(module.exports, req, module, module.exports, process, 'tools/autotune', module.filename, o.console || self.console); }
            catch (e) { delete cache[key]; throw e; }
            module.loaded = true;
            return module.exports;
        }
        return { require, files, calls, process };
    }

    // an entry script run as `node <entry> <args...>` over `files`; its stderr/stdout lines go to onLine
    function runCli(src, rpm, entry, args, files, onLine) {
        const line = (...a) => onLine && onLine(a.join(' '));
        registry(src.texts, { rpm, files, main: entry, argv: ['node', entry].concat(args), console: { log: line, info: line, warn: line, error: line, debug() {} } }).require(`./${entry}`);
    }

    // an optional module of `reg`, or a note that tells why the results lose what it gives
    function optional(reg, src, file, notes, lost) {
        const then = lost ? ` Thus, the results do not include ${lost}.` : '';
        if (!src.texts[file]) { notes.push(`The toolkit file "${file}" is not available (${src.missing[file]}).${then}`); return null; }
        try { return reg.require(`./${file}`); } catch (e) { notes.push(`The app cannot load the toolkit file "${file}". The error is "${message(e).replace(`tools/autotune/${file}: `, '')}".${then}`); return null; }
    }

    // The library modules for one flight rpm (null: the toolkit default), loaded once: lib, health and the three health
    // modules as health.cjs wires them, plus the new modules when they load
    const kits = new Map();
    function kit(src, rpm) {
        const key = rpm || 0;
        if (kits.has(key)) return kits.get(key);
        const reg = registry(src.texts, { rpm }), K = { rpm: rpm || null, files: reg.files, calls: reg.calls, notes: [], require: reg.require }; // require: a module on demand (filter_tune.cjs)
        K.lib = reg.require('./lib.cjs'); K.health = reg.require('./health.cjs');
        K.core = Object.fromEntries(CORE.map(m => [m, reg.require(`./health_${m}.cjs`)]));
        for (const [name, base] of Object.entries(OPTIONAL)) { const M = optional(reg, src, `${base}.cjs`, K.notes, LOST[name]); if (M) K[name] = M; }
        K.EXTRA = [...new Set(Object.values(K.core).flatMap(m => m.EXTRA).concat(['govTarget']))]; // health.cjs:70
        K.extraAll = [...new Set(K.EXTRA.concat(...[K.track, K.more, K.phase, K.rescue, K.limits, K.config, K.power].map(M => M && Array.isArray(M.EXTRA) ? M.EXTRA : [])))];
        if (K.phase && typeof K.phase.phases !== 'function') { K.notes.push('The toolkit file "health_phase.cjs" has no function "phases". Thus, the results do not include the flight phases and the ground checks.'); delete K.phase; }
        K.analysers = Object.assign({}, K.phase ? { phase: K.phase } : {}, K.core, K.track ? { track: K.track } : {}, K.more ? { more: K.more } : {},
            K.rescue ? { rescue: K.rescue } : {}, K.limits ? { limits: K.limits } : {}, K.config ? { config: K.config } : {}, K.power ? { power: K.power } : {}); // health_phase first; rescue and limits after health_loop (the T8 limits)
        kits.set(key, K);
        return K;
    }

    // ---------------------------------------------------------------------------------------------
    // Flight rpm (auto): from every flown log of the file, never from the one on screen
    // ---------------------------------------------------------------------------------------------

    // flight rpm = floor(share x basis / step) x step; basis = the lowest per-profile median governor target, else headspeed,
    // over the samples that show the rotor flying, pooled over the flown logs (rpmEvidence, autoRpm)
    const RPM = { share: 0.85, step: 100, minRpm: 500, targetS: 1, headspeedS: 5, profileFloor: 0.5, perSecond: 100,
        source: {
            share: 'pipeline, unvalidated: 85 % of the lowest flying target keeps the droop under load above the flight rpm',
            step: 'pipeline, unvalidated: rounded down to 100 rpm',
            minRpm: 'pipeline, unvalidated: a median under 500 rpm is a rotor idling or spooling up, not flying',
            targetS: 'pipeline, unvalidated: 1 s of samples; a governor target is a configured value, so 1 s on a profile names it',
            headspeedS: 'a measured headspeed needs the seconds health.cjs needs to call a log flown (RULE.flight.minS)',
            profileFloor: 'a profile whose median headspeed is under half the median of all is a spool-up flagged airborne, not a flight profile ' +
                '(Fireball 2026-09-20 #25: 5.4 s at 570 rpm, all 4199 rpm); the widest spread of flown profiles seen is 1.6x (same file #20: 2621 against 4232 rpm)',
            perSecond: 'samples read per second of log: enough for a median and its seconds',
        } };
    const median = (a) => Float64Array.from(a).sort()[a.length >> 1];

    // What one log shows of the rotor speed it was flown at, read at RPM.perSecond samples per second, rescue left out. In
    // the air: the flight phases of health_phase.cjs where the app has them (masks: one per segment of segs, null for a
    // segment with no flight phase: a bench run gives nothing); else airborne by AIRBORNE_STATE where the log has those
    // events; in a log without them, where lib.cjs marks every frame airborne (a bench run as much as a flight), the
    // governor ACTIVE; with neither event nothing marks flight. Per profile: the governor target in the air while ACTIVE
    // (any state without GOVSTATE events), and the headspeed in the air.
    function rpmEvidence(segs, li, masks) {
        const live = segs.filter(w => !w.skipped), add = (P, p, v, s) => { const x = P[p] || (P[p] = { values: [], seconds: 0 }); x.values.push(v); x.seconds += s; };
        const ev = { log: li, segments: live.length, airborneEvents: live.some(w => w.airborneAt.some(v => !v)), govLogged: live.some(w => !!w.govStateAt), active: false, airS: 0, bodyRate: 0, gt: {}, hs: {},
            phased: !!masks, flight: masks ? masks.some(m => !!m) : null };
        let n = 0, turn = 0;
        for (const w of live) {
            const step = Math.max(1, Math.round(w.rate / RPM.perSecond)), dt = step / (w.flight && w.flight.actualRate || w.rate), gt = w.extra.govTarget, gs = w.govStateAt;
            const fm = masks ? masks[segs.indexOf(w)] || null : undefined;
            if (fm === null) { if (gs) for (let i = 0; i < w.n && !ev.active; i += step) if (gs[i] === 4) ev.active = true; continue; }
            for (let i = 0; i < w.n; i += step) {
                const active = gs ? gs[i] === 4 : null;
                if (active) ev.active = true;
                if ((w.rescueAt && w.rescueAt[i]) || !(fm ? fm[i] : ev.airborneEvents ? w.airborneAt[i] : active)) continue;
                n++; ev.airS += dt; turn += w.gyro[0][i] ** 2 + w.gyro[1][i] ** 2 + w.gyro[2][i] ** 2;
                if (w.hs[i] > 0) add(ev.hs, w.profileAt[i], w.hs[i], dt);
                if (gt && gt[i] > 0 && active !== false) add(ev.gt, w.profileAt[i], gt[i], dt);
            }
        }
        ev.bodyRate = n ? Math.sqrt(turn / n) : 0;
        return ev;
    }

    // a log is flown with health.cjs's gate (rule = RULE.flight: minS s at rate deg/s rms) less its headspeed floor, which is
    // the value being chosen
    const flownBy = (rule) => (e) => e.airS >= rule.minS && e.bodyRate >= rule.rate;

    // The flight rpm from the evidence of the logs: per profile, the samples of every flown log pooled; the lowest median of
    // RPM.minRpm or more over the profiles with RPM.targetS s of governor target, else over the profiles with RPM.headspeedS s
    // of headspeed and a median of RPM.profileFloor x the median of all headspeed or more; else the toolkit default.
    // { value, source, basis, profile (as profileAt: 0 = the arming profile), seconds, logs }
    function autoRpm(evidence, fallback, rule) {
        const flown = evidence.filter(flownBy(rule)), below = (v) => Math.floor(RPM.share * v / RPM.step) * RPM.step;
        const lowest = (key, minS, relative) => {
            const pool = new Map(), all = [];
            for (const e of flown) for (const [p, x] of Object.entries(e[key])) {
                const q = pool.get(+p) || { values: [], seconds: 0, logs: [] }; pool.set(+p, q);
                for (const v of x.values) { q.values.push(v); if (relative) all.push(v); }
                q.seconds += x.seconds; q.logs.push(e.log);
            }
            const floor = Math.max(RPM.minRpm, relative && all.length ? relative * median(all) : 0);
            let best = null;
            for (const p of [...pool.keys()].sort((a, b) => a - b)) {
                const q = pool.get(p), m = q.seconds >= minS ? median(q.values) : null;
                if (m !== null && m >= floor && (!best || m < best.basis)) best = { basis: m, profile: p, seconds: r(q.seconds, 1), logs: q.logs };
            }
            return best;
        };
        const g = lowest('gt', RPM.targetS, 0); if (g) return Object.assign({ value: below(g.basis), source: 'govTarget' }, g);
        const h = lowest('hs', RPM.headspeedS, RPM.profileFloor); if (h) return Object.assign({ value: below(h.basis), source: 'headspeed' }, h);
        return { value: fallback, source: 'default', basis: null, profile: null, seconds: null, logs: [] };
    }

    // why the evidence gave no flight rpm: per log (log scope) or counted over the logs of the file
    function rpmWhy(evidence, rule, file) {
        const kind = (e) => !e.segments ? 'undecoded' : e.phased && !e.flight ? 'noFlight' : e.phased ? (!flownBy(rule)(e) ? 'notFlown' : 'noMedian')
            : !e.airborneEvents && !e.govLogged ? 'noEvents' : !e.airborneEvents && !e.active ? 'bench' : !flownBy(rule)(e) ? 'notFlown' : 'noMedian';
        const flight = `A flight is a minimum of ${rule.minS} s at ${rule.rate} deg/s rms (health.cjs RULE.flight).`;
        const medians = `no PID profile has a median governor target of ${RPM.minRpm} rpm or more for ${RPM.targetS} s, or a median headspeed of ${RPM.minRpm} rpm or more for ${RPM.headspeedS} s.`;
        if (!file) { const e = evidence[0] || { segments: 0 }, had = `The log has ${r(e.airS, 1)} s of flight at ${r(e.bodyRate, 1)} deg/s rms.`;
            return { undecoded: 'The log has no part that the app can read.', noEvents: 'The log does not record AIRBORNE_STATE or the governor condition. Thus, the app cannot find the flight.',
                noFlight: 'The flight phases of "health_phase.cjs" show no flight in the log. Thus, the log is a bench run.',
                bench: 'The log does not record AIRBORNE_STATE, and the governor is not ACTIVE in the log. Thus, the log is possibly a test on the ground.',
                notFlown: `${had} ${flight}${e.phased ? ' The flight time is the time in the flight phases of "health_phase.cjs".' : e.airborneEvents ? '' : ' The log does not record AIRBORNE_STATE. Thus, the flight time is the time with the governor in the ACTIVE mode.'}`,
                noMedian: `${had} But ${medians}` }[kind(e)]; }
        if (!evidence.length) return 'The file has no log.';
        const n = {}; for (const e of evidence) n[kind(e)] = (n[kind(e)] || 0) + 1;
        const parts = [[n.notFlown, `Logs with less than ${rule.minS} s of flight at ${rule.rate} deg/s rms`], [n.noFlight, 'Bench runs (no flight phase in "health_phase.cjs")'],
            [n.bench, 'Logs without AIRBORNE_STATE and with no ACTIVE governor (tests on the ground)'],
            [n.noEvents, 'Logs that do not record AIRBORNE_STATE or the governor condition'], [n.noMedian, `Logs with sufficient flight in which ${medians.replace(/\.$/, '')}`], [n.undecoded, 'Logs that the app cannot read']].filter(x => x[0]);
        const count = evidence.length === 1 ? '1 log' : `${evidence.length} logs`;
        return [`No log of the file gives a flight rpm (${count}).`].concat(parts.map(([c, t]) => `${t}: ${c}.`)).join(' ');
    }

    // ---------------------------------------------------------------------------------------------
    // One log: decode and records
    // ---------------------------------------------------------------------------------------------

    // lib.segments(whole) on the bytes of one log, relabelled as log li of the file; error: the parser's, as health.cjs:96-101.
    // events: the INFLIGHT_ADJUSTMENT events of the log [{ t (frame s from the log start), func, name, value }], copied from
    // the chunks that lib.cjs reads (it keeps only the PID profile changes, func 2): the FlightLog that lib.cjs makes in this
    // global is wrapped while it decodes, and nothing else changes
    // epochEvents: the events of param_epochs.cjs [{ event, t (frame s from the log start, the clock of frameOf), data }], in log
    // order: SYNC_BEEP, INFLIGHT_ADJUSTMENT, LOGGING_RESUME, DISARM, FLIGHT_MODE and LOG_END as js/flightlog_parser.js decodes them
    const ADJUSTMENT = 13; // FlightLogEvent.INFLIGHT_ADJUSTMENT (js/flightlog_fielddefs.js)
    const EPOCH_EVENTS = new Set([0, 13, 14, 15, 30, 255]); // FlightLogEvent SYNC_BEEP, INFLIGHT_ADJUSTMENT, LOGGING_RESUME, DISARM, FLIGHT_MODE, LOG_END
    function decode(K, bytes, fileName, li, extra = K.extraAll) {
        const file = `/v/${fileName}`, segs = [], events = [], epochEvents = [], Log = self.FlightLog;
        self.FlightLog = function (data) {
            const log = new Log(data), get = log.getChunksInTimeRange;
            log.getChunksInTimeRange = function () {
                const chunks = get.apply(this, arguments), t0 = this.getMinTime(), seen = new Set(events.map(e => e.key)), seenE = new Set(epochEvents.map(e => e.key));
                for (const c of chunks || []) for (const e of c.events || []) {
                    if (typeof e.time !== 'number') continue;
                    if (EPOCH_EVENTS.has(e.event)) { const key = `${e.event}|${e.time}|${JSON.stringify(e.data || null)}`;
                        if (!seenE.has(key)) { seenE.add(key); epochEvents.push({ key, event: e.event, t: (e.time - t0) / 1e6, data: Object.assign({}, e.data || {}) }); } }
                    if (e.event !== ADJUSTMENT || !e.data) continue;
                    const key = `${e.time}|${e.data.func}|${e.data.value}`; if (seen.has(key)) continue; seen.add(key);
                    events.push({ key, t: r((e.time - t0) / 1e6, 4), func: e.data.func, name: e.data.name || null, value: e.data.value }); }
                return chunks; };
            return log; };
        K.files.set(file, bytes);
        try { for (const w of K.lib.segments(self, file, { whole: true, extra })) { w.flight.log = li; segs.push(w); } }
        finally { self.FlightLog = Log; K.files.delete(file); delete self.__bytes; }
        let err = false;
        if (!segs.length) { const log = new FlightLog(bytes); err = log.getLogCount() ? log.getLogError(0) : 'no log in these bytes'; }
        return { segs, events: events.sort((a, b) => a.t - b.t).map(e => ({ t: e.t, func: e.func, name: e.name, value: e.value })),
            epochEvents: epochEvents.sort((a, b) => a.t - b.t).map(e => ({ event: e.event, t: e.t, data: e.data })), error: err ? `parser: ${err}` : null };
    }

    // Frame seconds (the viewer clock: frame time less the log start) of samples 0, every, 2 every, ... and of the last sample
    // of a segment (endS), and both sides of each frame-time jump, a loop stall or lost frames, as [i, frame s of sample i - 1,
    // frame s of sample i]. Module times are index times (fromS + i / actualRate): they drift from the frame clock by up to
    // 0.2 s in a flight (Gaui X4 #58: 196 ms at 320 s), and between two knots the frame clock is a straight line except at a
    // jump, where a map without the jump is off by half of it or more (12.8 ms at the 26 ms stall of #50, 83.574 s). With the
    // jumps, #50 is 4.7 ms or less (test/tuning_worker.test.cjs). Float32 seconds: 24 us at 400 s. evidence.cjs timeMap takes
    // its place when that module loads.
    const TIMEMAP = { every: 250, jumpUs: 1000, maxJumps: 500, source: 'pipeline, unvalidated: a frame interval 1 ms or more over the nominal one is a knot; the 500 largest jumps are kept' };
    function timeMapOf(w) {
        const t = w.extra && w.extra.time, n = w.n, rate = w.flight && w.flight.actualRate || w.rate;
        if (!t || n < 2) return null;
        const s = (i) => w.fromS + (t[i] - t[0]) / 1e6, E = TIMEMAP.every, frameS = new Float32Array(Math.ceil(n / E)), dt = 1e6 / rate;
        for (let k = 0; k < frameS.length; k++) frameS[k] = s(k * E);
        let jumps = []; for (let i = 1; i < n; i++) if (t[i] - t[i - 1] >= dt + TIMEMAP.jumpUs || t[i] <= t[i - 1]) jumps.push([i, r(s(i - 1), 6), r(s(i), 6), t[i] - t[i - 1]]);
        if (jumps.length > TIMEMAP.maxJumps) jumps = jumps.sort((a, b) => b[3] - a[3]).slice(0, TIMEMAP.maxJumps).sort((a, b) => a[0] - b[0]);
        return { fromS: w.fromS, every: E, actualRate: rate, n, frameS, endS: r(s(n - 1), 6), jumps: jumps.map(j => j.slice(0, 3)) };
    }
    function mapOf(K, w, J) {
        if (K.evidence && typeof K.evidence.timeMap === 'function') try { return K.evidence.timeMap(w); }
            catch (e) { J.notes.add(`The function "timeMap" of "evidence.cjs" stopped. The error is "${message(e)}". Thus, the app calculates the frame times with a different method.`, w.flight.log); }
        return timeMapOf(w);
    }

    // Frame seconds of sample i of a decoded segment w: the viewer clock, w.extra.time less the log start (lib.cjs fromS is
    // frame time); i = n is the end of the last sample. Without the time column, index time
    function frameOf(w) {
        const t = w.extra && w.extra.time, n = w.n, rate = w.flight && w.flight.actualRate || w.rate;
        if (!t) return (i) => r(w.fromS + i / rate, 4);
        return (i) => { const j = Math.max(0, Math.min(n - 1, Math.round(i))); return r(w.fromS + (t[j] - t[0]) / 1e6 + (i > n - 1 ? (i - n + 1) / rate : 0), 4); };
    }

    // health_phase.cjs on one segment (SPEC2 D13): { P: phases(w, ctx) (spans of index samples), mask: the flight phases
    // (flightMask(w, ctx), else the 'flight' spans), flight: P.flight }; null without the module or when it stops (a note).
    // Before the flight rpm is known (logEvidence), ctx.flightRule is the log's own provisional flight rpm and ctx.flying
    // the health.cjs mask at the toolkit default
    function phasesOf(K, w, ctx, J) {
        if (!K.phase) return null;
        try {
            const P = K.phase.phases(w, Object.assign({}, ctx));
            if (!P || !Array.isArray(P.spans)) throw new Error('the result has no spans');
            let mask = typeof K.phase.flightMask === 'function' ? K.phase.flightMask(w, Object.assign({}, ctx, { phases: P })) : null;
            if (!mask) { mask = new Uint8Array(w.n); for (const q of P.spans) if (q && q.phase === 'flight') mask.fill(1, Math.max(0, q.i0), Math.min(w.n, q.i1)); }
            if (mask.length !== w.n) throw new Error(`the flight mask has ${mask.length} samples, and the segment has ${w.n} samples`);
            return { P, mask, flight: !!P.flight };
        } catch (e) {
            J.notes.add(`The function "phases" of "health_phase.cjs" stopped. The error is "${message(e)}". Thus, the app does not find the flight phases of the log, and the checks use all of the airborne time.`, w.flight.log);
            return null;
        }
    }
    // the class of a log from its segments' phases: a flight log has one or more flights, a bench run has none; null when
    // the app does not know (no phases, or a segment whose phases stopped and no flight in the others)
    const classOf = (list) => !list.length || list.every(q => !q) ? null : list.some(q => q && q.flight) ? 'flight' : list.some(q => !q) ? null : 'bench';

    // D12. The PID profile labels of a segment for the modules (ctx.profile), its targetOf, and the toolkit's guess for the
    // stretch before the first logged change (null: a change at the first frame, so no stretch). The log does not name the
    // profile there: lib.profilesOf (health.cjs:83) labels it with a profile that flies the same governor target later in
    // the log, which is a guess (a profile can share its target, and the toolkit does not know the arming rules). With
    // toolkit labels (the CLI's view, for parity) the modules get that guess; else they get the raw label 0 (w.profileAt),
    // and targetOf['0'] is the target of the stretch. pidProfileOf and logsInput map 0 to the arming profile only when
    // armingFinal confirms it
    function labelsOf(K, w, target, toolkit, rpm) {
        const lp = K.lib.profilesOf(w, target, rpm || K.health.RULE.flight.headspeed), guess = w.profileAt[0] > 0 ? null : lp.p[0];
        if (toolkit) return { p: lp.p, targetOf: lp.targetOf, guess };
        const targetOf = Object.assign({}, lp.targetOf);
        if (guess > 0 && !('0' in targetOf) && isFinite(lp.targetOf[guess])) targetOf[0] = lp.targetOf[guess];
        return { p: Uint8Array.from(w.profileAt), targetOf, guess };
    }
    // the toolkit's labels only in the CLI's view: no flight phases (option phases false, or no health_phase.cjs) and
    // excludeAbnormal false (health.cjs parity)
    const toolkitView = (J) => !phasesOn(J, J.K) && J.o.excludeAbnormal === false;

    // The base of a segment's record as health.cjs:80-91 builds it (rec, the flight mask, ctx), with the labels of labelsOf
    // (o.toolkit: health.cjs's own), and its phases with o.airborneEvents (the log has AIRBORNE_STATE events: a segment after
    // a logging gap can have no change of the flag) and o.flightRule (the flight rpm of the phase detector, when it is not
    // the kit's), and o.labelRpm (the rpm of the governor targets of labelsOf, when it is not the kit's: the first pass)
    function prepare(K, w, o, J) {
        const fl = w.flight, H = K.health;
        const rec = { id: fl.id, file: fl.file, log: fl.log, segment: o.segment, start: fl.start, durationS: r(fl.durationS, 1), gaps: fl.gaps, rate: fl.rate, actualRate: r(fl.actualRate, 2), header: fl.header };
        if (w.skipped) { rec.skipped = w.skipped; return { w, rec, ctx: null, ph: null }; }
        const rate = fl.actualRate, target = w.extra.govTarget || w.hs, L = labelsOf(K, w, target, !!o.toolkit, o.labelRpm), profile = L.p, targetOf = L.targetOf;
        const { flying, up, bodyRate, flown } = H.flightMask(w, rate), profileSeconds = H.profileSeconds(flying, profile, rate);
        Object.assign(rec, { fromS: r(w.fromS, 3), seconds: r(w.seconds, 1), n: w.n, flown, flyingS: r(flown ? up / rate : 0, 1), bodyRate: r(bodyRate, 1), targetOf, profileSeconds, govStateLogged: !!w.govStateAt, metrics: {}, errors: {} });
        const ctx = H.buildCtx(w, fl, { flying, profile, cli: o.cli, cliParsed: o.cliParsed, app: self });
        const pctx = Object.assign({}, ctx, { airborneEvents: !!o.airborneEvents }, o.flightRule ? { flightRule: o.flightRule } : {});
        return { w, rec, ctx, flying, flown, guess: L.guess, ph: o.phases ? phasesOf(K, w, pctx, J) : null };
    }

    // The masks of health_gov in a flight log (SPEC2 D13 correction: the governor, motor, ESC and power checks use all
    // phases of a flight log, with a rule for each phase), from the phases of health_phase.cjs:
    //   - all: every sample in a phase (idle, spool-up, ground, flight, spool-down). The battery voltage, the main rotor line
    //     against the headspeed (motor_poles, the RPM sensor) and the time in each governor state (GOV_ALL) use it. FALLBACK
    //     entries are of the whole log in every mask (health_gov G1). Motor kicks and the handover from SPOOLUP to ACTIVE out
    //     of the flight are checks G16 and G17 of health_phase.cjs, which gets every phase;
    //   - rotor: the ground and flight phases, the rotor governed. The RPM glitch proxy of G1 (GOV_ROTOR) uses it: at IDLE a
    //     motor that starts has no headspeed yet ("hs = 0 with motor[0] > 100", Gaui X4 #50 at 4.18 s), which is no glitch;
    //   - tracking: the ground and flight phases at the flight rpm or more (health.cjs RULE.flight.headspeed, as the health.cjs
    //     mask has it), less rescue, level modes and failsafe with excludeAbnormal (health_more normalMask without ground
    //     contact and its widening: noGround). health_gov keeps only the samples with the governor ACTIVE for these checks
    //     when the log records GOVSTATE (its act mask): the headspeed error, the collective steps, the throttle headroom, the
    //     governor spectra and gains (G0, G2 to G11). The headspeed floor keeps out a rotor that the throttle cannot hold
    //     (Fireball 2026-09-29 #3, 376.3-377.2 s: 2446 rpm against 3500 at full throttle, a G6 run, which G2 would count as
    //     a steady error of -30 %).
    // { all, rotor, tracking, seconds: { all, rotor, tracking } }
    const GOV_ALL = ['D5', 'G13', 'G12', 'states'];   // health_gov metrics measured over all phases
    const GOV_ROTOR = ['G1'];                         // over the ground and flight phases, at any headspeed
    const TRACK_PHASES = ['ground', 'flight'];
    const PHASE_USE = { all: ['idle', 'spoolup', 'ground', 'flight', 'spooldown'], tracking: TRACK_PHASES, flight: ['flight'] };
    function govMasks(K, w, ctx, ph, o, J) {
        const n = w.n, all = new Uint8Array(n), rotor = new Uint8Array(n), tracking = new Uint8Array(n), rate = ctx.rate, floor = K.health.RULE.flight.headspeed;
        for (const q of ph.P.spans) if (q && isFinite(q.i0) && isFinite(q.i1)) { const a = Math.max(0, q.i0), b = Math.min(n, q.i1);
            all.fill(1, a, b); if (TRACK_PHASES.includes(q.phase)) { rotor.fill(1, a, b); for (let i = a; i < b; i++) tracking[i] = w.hs[i] >= floor ? 1 : 0; } }
        const keep = o.excludeAbnormal && K.more ? noGround(K, w, ctx, tracking, J) : null;
        if (keep) for (let i = 0; i < n; i++) tracking[i] &= keep[i];
        const sec = (m) => { let c = 0; for (let i = 0; i < n; i++) c += m[i]; return r(c / rate, 1); };
        return { all, rotor, tracking, seconds: { all: sec(all), rotor: sec(rotor), tracking: sec(tracking) } };
    }
    // health_more normalMask of rescue, level modes and failsafe only (A7: no ground contact, no widening of it): every sample
    // in its flight phase code (health_more FLIGHT_PHASE, health_phase PHASES.indexOf('flight')), so it finds no ground contact.
    // null when it stops (a note)
    const NO_GROUND = 3;
    function noGround(K, w, ctx, base, J) {
        try { return K.more.normalMask(w, Object.assign({}, ctx, { flying: base, phases: { code: new Uint8Array(w.n).fill(NO_GROUND) } })).mask; }
        catch (e) { J.notes.add(`The function "normalMask" of "health_more.cjs" stopped. The error is "${message(e)}". Thus, the governor checks include rescue, level modes and failsafe.`, w.flight.log); return null; }
    }
    // health_gov on the three masks of govMasks: the metrics of the tracking mask, GOV_ALL from the mask of all phases and
    // GOV_ROTOR from the rotor mask, and phaseMasks (the phases, seconds and checks of each mask). The cost: three analyses
    // (2 s each on a 382 s log at 1 kHz, Fireball 2026-09-29 #3)
    function govAllPhases(M, w, ctx, flying, G) {
        const run = (mask) => M.analyse(w, Object.assign({}, ctx, { flying: mask, flyingAll: flying }));
        const all = run(G.all), rotor = run(G.rotor), out = run(G.tracking);
        for (const k of GOV_ALL) if (k in all) out[k] = all[k];
        for (const k of GOV_ROTOR) if (k in rotor) out[k] = rotor[k];
        out.phaseMasks = { all: { phases: PHASE_USE.all, seconds: G.seconds.all, checks: GOV_ALL.filter(k => k !== 'states') },
            rotor: { phases: TRACK_PHASES, seconds: G.seconds.rotor, checks: GOV_ROTOR.slice() }, tracking: { phases: TRACK_PHASES, seconds: G.seconds.tracking, active: !!ctx.govState } };
        return out;
    }
    // The context of health_rescue and health_limits (CLAUDE.md "Control limits"): all phases of a flight log, rescue included,
    // with no guard time (the health.cjs context, its flying mask not used), the phases of the log when the app has them, and
    // the tail output limits of check T8 (health_loop runs first) as { lo, hi } in the units of w.u
    function allCtx(ctx, phaseCtx, rec) {
        const t8 = rec.metrics && rec.metrics.loop && rec.metrics.loop.T8 && rec.metrics.loop.T8.limits && rec.metrics.loop.T8.limits.yaw;
        const tail = t8 && (typeof t8.limitLow === 'number' || typeof t8.limitHigh === 'number') ? { tailLimits: { lo: t8.limitLow, hi: t8.limitHigh } } : {};
        return Object.assign({}, phaseCtx || Object.assign({}, ctx, { phases: false }), tail);
    }

    // runs of a mask in frame seconds [{ t0, t1 }]
    function runsOf(w, mask) {
        const at = frameOf(w), out = [];
        for (let i = 0; i < w.n;) { if (!mask[i]) { i++; continue; } let j = i; while (j < w.n && mask[j]) j++; out.push({ t0: at(i), t1: at(j) }); i = j; }
        return out;
    }

    // The record of one segment of a log that is not a bench run: the modules of health.cjs, then the new ones (track, more,
    // phase), each with its mask:
    //   - health_phase: the health.cjs mask (all phases), with ctx.phases and ctx.flightMask;
    //   - the attitude and filter checks (health_setup, health_loop, health_track, health_more): the health.cjs mask, ANDed
    //     with health_more.normalMask (excludeAbnormal: ctx.normal) and with the flight phases of a flight log (ctx.flightMask;
    //     ctx.flyingGov is the governor's tracking mask, ctx.flyingAll the health.cjs mask, ctx.phases the phases), so that
    //     the pad, spool-up, spool-down, the ground, rescue, level modes and failsafe are left out (SPEC2 D13);
    //   - the governor (health_gov): in a flight log, all phases (govMasks: a mask for each kind of check), also when health.cjs
    //     does not call the log flown; else the health.cjs mask less rescue, level modes and failsafe (noGround).
    // rec.excluded: seconds per reason of normalMask; rec.normalS: the seconds the attitude checks use; J.attitude: the runs of
    // the attitude mask in frame seconds (the extract.cjs segments: flightSegments). health.cjs runs the loop module only on a
    // flight (RULE.flight: minS s at rate deg/s rms); when the attitude time left fails that gate, the loop module does not
    // run and, without the flight phases, the governor module sees the whole flight, as health.cjs gives it (its FALLBACK and
    // Vbat checks are of the whole log, and the exclusions are for the rate loops: setpoint is logged before the rescue and
    // level overrides, pid.c:813-839). While w lives: rec.timeMap, and the spans evidence.cjs locate finds (rec.metrics.locate)
    // with the attitude ctx (ctx.flyingGov: the governor's mask when it differs)
    function analyseSegment(K, prep, o, J) {
        const { w, rec, ctx, flying, flown, ph } = prep, fl = w.flight, H = K.health, rate = fl.actualRate;
        if (!ctx) return { rec, ctx: null, phaseCtx: null };
        const fm = o.logClass === 'flight' && ph ? ph.mask : null, phaseArg = fm ? { phases: ph.P, flightMask: fm } : { phases: false }; // false: health_more does not find phases itself
        let excluded = null, normalS = null, thin = false, normal = null;
        if (o.excludeAbnormal && flown && K.more) {
            try {
                const N = K.more.normalMask(w, Object.assign({}, ctx, phaseArg));
                normal = N.mask; excluded = N.excluded;
                for (const t of N.notes || []) J.notes.add(t, fl.log);
            } catch (e) { rec.errors.more = `normalMask: ${e && e.stack || e}`; J.notes.add(`The function "normalMask" of "health_more.cjs" stopped. The error is "${message(e)}". Thus, the analysis includes rescue, level modes, failsafe and ground contact.`, fl.log); }
        }
        const att = normal || fm ? Uint8Array.from(flying, (v, i) => v & (normal ? normal[i] : 1) & (fm ? fm[i] : 1)) : flying;
        // the governor: all phases of a flight log; without them the health.cjs mask less rescue, level modes and failsafe
        const G = fm ? govMasks(K, w, ctx, ph, o, J) : null, keep = !fm && normal ? noGround(K, w, ctx, flying, J) : null;
        const govMask = G ? G.tracking : keep ? Uint8Array.from(flying, (v, i) => v & keep[i]) : flying;
        if (flown && (normal || fm)) {
            let left = 0, turn = 0; for (let i = 0; i < w.n; i++) if (att[i]) { left++; turn += w.gyro[0][i] ** 2 + w.gyro[1][i] ** 2 + w.gyro[2][i] ** 2; }
            const F = H.RULE.flight, leftRate = left ? Math.sqrt(turn / left) : 0;
            normalS = r(left / rate, 1); thin = !(left / rate >= F.minS && leftRate >= F.rate);
            const kept = fm ? `With only the flight phases${normal ? ' and no rescue, level mode or failsafe' : ''}` : 'After the app removes rescue, level modes, failsafe and ground contact';
            if (thin) J.notes.add(`${kept}, the log has ${normalS} s of usual flight at ${r(leftRate, 1)} deg/s rms. ` +
                `A flight is a minimum of ${F.minS} s at ${F.rate} deg/s rms (health.cjs RULE.flight). Thus, the app does not do the loop checks${fm ? '' : ', and the governor checks use all of the flight'}.`, fl.log);
            J.attitude.set(fl.log, (J.attitude.get(fl.log) || []).concat(runsOf(w, att)));
        }
        const gov = G ? G.tracking : thin ? flying : govMask, differs = gov !== att && gov.some((v, i) => v !== att[i]);
        const attCtx = normal || fm ? Object.assign({}, ctx, { flying: att, flyingAll: flying }, normal ? { normal } : {}, fm ? { phases: ph.P, flightMask: fm } : {}, fm || differs ? { flyingGov: gov } : {}) : ctx;
        const newCtx = Object.assign({}, attCtx, fm ? {} : { phases: false }); // health_track, health_more: no phases of their own when the app has none
        const govCtx = thin && !G ? Object.assign({}, ctx, { flyingAll: flying }) : keep ? Object.assign({}, ctx, { flying: govMask, normal, flyingAll: flying }) : ctx;
        const phaseCtx = ph ? Object.assign({}, ctx, { phases: ph.P, flightMask: ph.mask }) : null;
        for (const [name, M] of Object.entries(K.analysers)) {
            const run = name === 'phase' ? !!phaseCtx : ALL_PHASE.has(name) ? (fm ? true : !ph && flown) : name === 'setup' || (name === 'gov' && G) || (flown && !(thin && name === 'loop'));
            if (!run) { rec.metrics[name] = null; continue; }
            J.progress(`Log ${fl.log + 1}: the app does the checks of "${OPTIONAL[name] || `health_${name}`}.cjs".`);
            const c = Object.assign({}, name === 'phase' ? phaseCtx : ALL_PHASE.has(name) ? allCtx(ctx, phaseCtx, rec) : name === 'gov' ? govCtx : name === 'track' || name === 'more' ? newCtx : attCtx);
            if (name === 'setup' && c.pidLabels) c.profile = c.pidLabels; // D4 and the F5, F6 and F9 rows: the PID profile labels
            try { rec.metrics[name] = name === 'gov' && G ? govAllPhases(M, w, c, flying, G) : M.analyse(w, c); } catch (e) { rec.errors[name] = String(e && e.stack || e); }
        }
        rec.excluded = excluded; rec.normalS = normalS;
        rec.timeMap = mapOf(K, w, J);
        if (K.evidence && typeof K.evidence.locate === 'function') {
            try { rec.metrics.locate = K.evidence.locate(w, attCtx, rec.metrics); }
            catch (e) { J.notes.add(`The function "locate" of "evidence.cjs" stopped. The error is "${message(e)}". Thus, some results do not show their part of the log.`, fl.log); }
        }
        return { rec, ctx: newCtx, phaseCtx };
    }

    // The phases of a record in frame seconds (records[].phases, flights, phaseSeconds): each span's own fields kept but its
    // samples and index times; the flights from the result's flights (health_phase: liftoff to touchdown, with method,
    // confidence and how each end was found), else from the flight spans. J.flightAt: the frame seconds of each flight by
    // log, segment and samples, for the flight list of D7 (d7Frames)
    const FLIGHT_KEYS = ['method', 'confidence', 'liftoffBy', 'touchdownBy', 'atStart', 'atEnd'];
    const flightKey = (log, segment, i0, i1) => `${log}|${segment}|${i0}|${i1}`;
    function phaseRecord(rec, w, ph, J) {
        const at = frameOf(w), P = ph.P, ok = (q) => q && isFinite(q.i0) && isFinite(q.i1);
        const extra = (q) => Object.fromEntries(Object.entries(q).filter(([k, v]) => !['phase', 'i0', 'i1', 't0', 't1'].includes(k) && (v === null || typeof v !== 'object')));
        rec.phases = P.spans.filter(q => ok(q) && typeof q.phase === 'string').map(q => Object.assign({ phase: q.phase, t0: at(q.i0), t1: at(q.i1) }, extra(q)));
        const list = Array.isArray(P.flights) ? P.flights.filter(ok) : P.spans.filter(q => ok(q) && q.phase === 'flight');
        rec.flights = list.map(q => { const t0 = at(q.i0), t1 = at(q.i1), o = { t0, t1, seconds: r(t1 - t0, 2), method: q.method ?? null, confidence: q.confidence ?? null };
            for (const k of FLIGHT_KEYS.slice(2)) if (q[k] !== undefined) o[k] = q[k];
            if (J) J.flightAt.set(flightKey(rec.log, rec.segment, q.i0, q.i1), o);
            return o; });
        rec.phaseSeconds = {}; for (const q of rec.phases) rec.phaseSeconds[q.phase] = r((rec.phaseSeconds[q.phase] || 0) + q.t1 - q.t0, 1);
    }

    // a record as health.json has it: only the modules health.cjs runs (health_report.cjs judges these)
    function asHealthJson(rec) {
        const out = Object.assign({}, rec); for (const k of APP_RECORD) delete out[k];
        if (rec.metrics) out.metrics = pick(rec.metrics, CORE);
        if (rec.errors) out.errors = pick(rec.errors, CORE);
        return out;
    }

    // which fields the log has (health_setup D3: present | zero | absent), plus the main columns and the fields the new modules read
    function fieldsOf(K, w, rec) {
        const d3 = rec.metrics && rec.metrics.setup && rec.metrics.setup.D3;
        if (!d3) return null;
        const state = (v) => { if (!v) return 'absent'; for (let i = 0; i < v.length; i++) if (v[i] !== 0) return 'present'; return 'zero'; };
        const fields = Object.assign({}, d3.fields), main = { setpoint: w.sp, gyroADC: w.gyro, mixer: w.u, axisP: w.P, axisI: w.I, axisF: w.F };
        for (const [k, cols] of Object.entries(main)) cols.forEach((v, a) => { if (!(`${k}[${a}]` in fields)) fields[`${k}[${a}]`] = state(v); });
        for (const k of K.extraAll) if (!(k in fields) && k !== 'time' && k !== 'loopIteration') fields[k] = state(w.extra[k]);
        return fields;
    }

    // D12. The PID profile at the start of a log, whose values the header holds (lib.cjs profileAt is 0 there, extract.cjs
    // calls it 'arm', and lib.profilesOf labels it with the profile that flies the same governor target later in the log).
    // The header has no profile index, and it is written once at the log start. The evidence, in this order:
    //   - event: a PID profile change at the first frame;
    //   - the first logged change: rc_adjustments.c logs a change only, so the profile before it is another one;
    //   - cli: the header against each CLI section (health_setup D4 mismatchesByProfile, 0 = agrees; used when not every
    //     section agrees);
    //   - cliTarget: the governor target before the first change against the CLI gov_headspeed of each PID profile;
    //   - headspeed (user decision 2026-10-06; headspeedOf): govRequest before the first change against the headspeed of each
    //     PID profile at the logged PID profile changes of the file (hsInfo, hsMap). It needs no CLI dump. The log wins over a CLI
    //     dump (user rule "No access to the flight controller"): a gov_headspeed of the dump that the logged changes contradict is
    //     older than the log and is not used (staleHeadspeeds: also not by cliTarget), and a dump whose section of the profile does
    //     not agree with the header does not stop the step (the 'cli' basis goes, result.cliStatus records the conflict). Only a
    //     dump that agrees with the log can stop it: it gives this gov_headspeed to another candidate ('cliShared');
    //   - govTarget: the toolkit's label (a profile that flies the same target later in the log), when no other profile of
    //     the log has that target and the headspeed step found no profile;
    //   - fileTarget (fileArming, after every log): the profile that flies that target in the other logs of the file.
    // The govTarget step does not apply (A6) when the toolkit's label is the profile of the first change (the first-change
    // rule excludes it), or when the CLI gives the same gov_headspeed to another candidate (the target cannot tell them).
    // One rule for the PID profile of the stretch (M2): only a confirmed profile (event, cli, cliTarget or headspeed) is used.
    // An inference (govTarget, fileTarget) is only the estimate, and the stretch stays "PID profile unknown".
    // { profile: 1-6 confirmed | 0 (unknown), estimate: 1-6 inferred and not confirmed | null, basis, candidates, inferred
    //   (the toolkit's label: lib.profilesOf), target (rpm before the first change), firstChangeS (frame s), conflict (the CLI
    //   sections and the governor target disagree: an estimate only), confirmed (event, cli, cliTarget or headspeed), headspeed (the
    //   evidence of the headspeed step, null without it: { headspeed: govRequest at the start (rpm) | null, why: null (it found
    //   the profile) | 'noField' | 'zero' | 'changes' | 'none' | 'shared' | 'excluded' | 'cliShared',
    //   profile, profiles, values, observations: { switches, logs } of that headspeed, map: { [PID profile]: rpm | [rpm] },
    //   dumpSections (only when the header agrees with the CLI sections of other PID profiles than the one found: those) }) }
    const TARGET_STEP = 50; // rpm: lib.profilesOf rounds the governor target to 50 rpm
    const CONFIRMS = ['event', 'cli', 'cliTarget', 'headspeed']; // the bases that confirm a PID profile (advice.cjs, hierarchy.cjs CONFIRMED)
    // The D12 result is armingFinal(armingCore(preps, events), hs). armingCore: the steps that read the decoded log (preps), the
    // result without the headspeed step and the govTarget step, with what they need. Small (no samples): the worker keeps it for each log (J.armCore) and does the last steps again
    // when the map of the headspeeds has more logs (armingFinal)
    function armingCore(preps, events) {
        const first = preps.find(p => p.ctx);
        if (!first) return null;
        const pid = events.filter(e => e.func === 2 && isFinite(e.value)), t = first.rec.targetOf || {}, inf = first.guess > 0 ? first.guess : 0;
        const out = { profile: 0, estimate: null, basis: [], candidates: [], inferred: inf, target: t['0'] ?? (inf > 0 ? t[inf] ?? null : null), firstChangeS: pid.length ? pid[0].t : null, conflict: false, confirmed: false, headspeed: null };
        // the header against the CLI sections (D4): d4 { sections, agree } in PID profiles (result.cliStatus reads it), null without them
        const D = first.rec.metrics && first.rec.metrics.setup && first.rec.metrics.setup.D4, by = D && D.mismatchesByProfile, keys = by ? Object.keys(by) : [];
        const agree = keys.filter(k => by[k] === 0).map(k => +k + 1), d4 = keys.length ? { sections: keys.map(k => +k + 1), agree } : null;
        const gh = (first.ctxPid || first.ctx).govHeadspeed; // by PID profile (ctxPid: before relabel)
        const raw0 = first.w.profileAt[0]; if (raw0 > 0) return { out: Object.assign(out, { profile: raw0, basis: ['event'], candidates: [raw0], confirmed: true }), done: true, d4, gh: gh ? Object.assign({}, gh) : null };
        let cands = [1, 2, 3, 4, 5, 6].filter(p => !pid.length || p !== pid[0].value);
        if (agree.length && agree.length < keys.length) { cands = cands.filter(p => agree.includes(p)); out.basis.push('cli'); } // none left: unknown
        const excluded = pid.length > 0 && inf === pid[0].value, uniqueT = inf > 0 && !excluded && !Object.keys(t).some(k => +k > 0 && +k !== inf && t[k] === t[inf]);
        // cliCands: the candidates after the header against the CLI sections only (the headspeed step reads it); cliTarget and the
        // govTarget step are done in armingFinal, with the gov_headspeed values of the dump that the map does not contradict
        return { out, cands, cliCands: cands.slice(), gh: gh ? Object.assign({}, gh) : null, d4, uniqueT, inf, firstValue: pid.length ? pid[0].value : null, done: false };
    }
    // The PID profiles whose CLI gov_headspeed the logged PID profile changes contradict (the map has other values for them): that
    // part of the dump is older than the log, and the analysis does not use it (user rule "No access to the flight controller")
    const staleHeadspeeds = (gh, M) => gh && M ? Object.keys(gh).map(Number).filter(q => M.table[q] !== undefined && ![].concat(M.table[q]).includes(gh[q])) : [];
    // The last steps (cliTarget, headspeed, govTarget) on a copy of the core result. hs: { info (hsInfo of the log), map (hsMap of the
    // file) } or null (the log was not read for the map)
    function armingFinal(core, hs) {
        if (!core) return null;
        const out = Object.assign({}, core.out, { basis: core.out.basis.slice(), candidates: core.out.candidates.slice() });
        if (core.done) return out;
        let cands = core.cands.slice();
        // a CLI dump with no section that agrees with this log header (D4: result.cliStatus used false) does not describe the log: it
        // gives no evidence (no cliTarget, no cliShared). The log wins
        const dumpOk = !(core.d4 && !core.d4.agree.length);
        const stale = staleHeadspeeds(core.gh, hs && hs.map), gh = core.gh && dumpOk ? Object.fromEntries(Object.entries(core.gh).filter(([q]) => !stale.includes(+q))) : null;
        // govRequest before the first change (hsInfo): one value is the exact gov_headspeed of the arming profile; more values are a change
        // of the PID profile or of gov_headspeed that the log does not record, and then neither the dump nor the governor target can tell
        // the profile at arming (the governor target of the stretch is its most frequent value, not the value at arming)
        const info = hs && hs.info, start = info && info.field && info.start ? info.start.values : null, changes = !!start && start.length > 1, exact = start && start.length === 1 ? start[0] : null;
        const round = (v) => Math.round(v / TARGET_STEP) * TARGET_STEP, target = out.target;
        if (gh && Object.keys(gh).length && !changes && (exact !== null || target !== null)) { const hit = Object.keys(gh).filter(k => exact !== null ? gh[k] === exact : round(gh[k]) === target).map(Number);
            if (hit.length && hit.length < Object.keys(gh).length) { cands = cands.filter(p => hit.includes(p)); out.basis.push('cliTarget'); } }
        const H = headspeedOf(core, hs, gh, stale);
        out.headspeed = H.evidence;
        // the log wins: the headspeed is exact, and the governor target of cliTarget is a ramp (rounded to TARGET_STEP). When the CLI
        // sections or cliTarget left out the profile that the headspeed found, they are not evidence of the result
        if (H.profile) {
            if (!core.cliCands.includes(H.profile)) out.basis = out.basis.filter(b => b !== 'cli');
            if (!cands.includes(H.profile)) out.basis = out.basis.filter(b => b !== 'cliTarget');
            cands = [H.profile]; out.basis.push('headspeed');
        } else if (core.uniqueT && !changes && !(gh && target !== null && Object.keys(gh).some(k => +k !== core.inf && cands.includes(+k) && round(gh[k]) === target))) {
            if (cands.includes(core.inf)) { cands = [core.inf]; out.basis.push('govTarget'); } else out.conflict = true; // a CLI target shared by another candidate: no decision
        }
        out.candidates = cands;
        const one = out.basis.length && cands.length === 1 && !out.conflict ? cands[0] : 0;
        if (!one) out.basis = [];
        out.confirmed = out.basis.some(b => CONFIRMS.includes(b));
        if (out.confirmed) out.profile = one; else if (one) out.estimate = one;
        return out;
    }

    // The headspeed of each PID profile (user decision 2026-10-06). govRequest is the gov_headspeed of the active PID profile
    // (firmware 4.6.0 governor.c: a PID profile change moves govRequest to the gov_headspeed of the new profile; govTarget is the
    // slewed ramp to it, so it does not identify a profile). The logged PID profile changes (INFLIGHT_ADJUSTMENT func 2) of the
    // file give the headspeed of each PID profile: after a change to p, a stretch whose nonzero govRequest has one value h is an
    // observation (p, h); a stretch with more values is not used. A value h at the start of a log identifies p when every
    // observation of h in the file is p. Bench runs count: their changes are valid observations. A PID profile can have more values
    // in one file (the pilot changed gov_headspeed between logs: the Gaui X4 dump 2026-10-04 11:37 has PID profile 1 at 2100 rpm in
    // logs 8 to 27 and at 2300 rpm from log 28): each of its values identifies it while no other PID profile has that value.
    // Measured with the first frame after each change: the Fireball dump 2026-10-05 (3500, 4500 and 5000 rpm = PID profiles 1,
    // 2 and 3) and the Gaui X4 dumps of 2026-10-04 (2300, 2500 and 2700 rpm = 1, 2 and 3) have one value in every stretch
    const HS = { settleS: 0.05, listMax: 4, source: {
        settleS: 'health_rescue RULE.profile.targetS: govRequest is at the new gov_headspeed 0.05 s after a PID profile change. On the Fireball and Gaui X4 dumps of 2026-10-04/05 it is there at the first frame after the change',
        listMax: 'the values that one note gives; a stretch with more values is not used either way' } };
    // The observations of one decoded log (the whole-log segments of lib.cjs, before a flight selection cuts them), from the runs
    // of profileAt (exact at the change: lib.cjs sets it at the frame of the event): { field (the log records govRequest), obs:
    // [{ profile, h }] (one for each stretch after a change with one nonzero value, HS.settleS after the change left out),
    // dropped (stretches after a change with more values), start: { values: the nonzero values before the first change, in their
    // order, HS.listMax + 1 at most } | null (a change at the first frame) }
    function hsInfo(segs) {
        const live = segs.filter(w => !w.skipped && w.n > 0), out = { field: live.some(w => w.extra && w.extra.govRequest), obs: [], dropped: 0, start: null };
        if (!out.field) return out;
        const runs = []; let run = null;
        for (const w of live) {
            const gr = w.extra.govRequest, pa = w.profileAt, settle = Math.round(HS.settleS * (w.flight && w.flight.actualRate || w.rate));
            for (let i = 0; i < w.n; i++) {
                if (!run || pa[i] !== run.p) { run = { p: pa[i], values: [], k: 0 }; runs.push(run); }
                const k = run.k++, v = gr ? gr[i] : 0;
                if (!(v > 0) || (run.p > 0 && k < settle) || run.values.length > HS.listMax || run.values.includes(v)) continue;
                run.values.push(v);
            }
        }
        runs.forEach((q, k) => {
            if (q.p <= 0) { if (k === 0) out.start = { values: q.values, first: runs[1] && runs[1].p > 0 ? runs[1].p : null }; return; } // first: the PID profile of the first change
            if (q.values.length === 1) out.obs.push({ profile: q.p, h: q.values[0] }); else if (q.values.length > 1) out.dropped++;
        });
        return out;
    }
    // the observations of every log read so far (J.hsLogs: first pass, main pass): { table: { [PID profile]: rpm | [rpm, ...] },
    // switches, logs, identify(h) -> { profile, switches, logs, excludedBy } | { why: 'none' | 'shared' (profiles) }, nearest(p, li) ->
    // { logs, values }: the values of PID profile p in the logs with an observation of p that are nearest to log li in the file }.
    // excludedBy: the logs that start at h (one value) and whose first change goes to the PID profile that h identifies. A log records
    // only a change, so such a log starts in a different PID profile with the same headspeed (headspeedOf: 'ambiguous')
    function hsMap(J) {
        if (J.hsMapOut && J.hsMapOut.n === J.hsLogs.size) return J.hsMapOut;
        const byH = new Map(), byP = new Map(), logsOf = new Map(), sorted = (it) => [...it].sort((a, b) => a - b);
        let switches = 0; const used = new Set();
        for (const [li, x] of J.hsLogs) for (const o of x.obs) {
            const a = byH.get(o.h) || byH.set(o.h, new Map()).get(o.h); a.set(o.profile, (a.get(o.profile) || 0) + 1);
            const b = byP.get(o.profile) || byP.set(o.profile, new Set()).get(o.profile); b.add(o.h);
            (logsOf.get(o.h) || logsOf.set(o.h, new Set()).get(o.h)).add(li); switches++; used.add(li); }
        const table = {}; for (const p of sorted(byP.keys())) { const v = sorted(byP.get(p)); table[p] = v.length === 1 ? v[0] : v; }
        const named = (h) => { const m = byH.get(h); if (!m) return { why: 'none' };
            const ps = sorted(m.keys()); if (ps.length > 1) return { why: 'shared', profiles: ps };
            return { profile: ps[0], switches: m.get(ps[0]), logs: logsOf.get(h).size }; };
        const excluded = new Map(); // h -> logs that start at h and change first to the PID profile of h
        for (const [li, x] of J.hsLogs) { const s = x.start; if (!s || s.values.length !== 1 || !s.first) continue;
            const id = named(s.values[0]); if (id.profile === s.first) (excluded.get(s.values[0]) || excluded.set(s.values[0], []).get(s.values[0])).push(li); }
        const identify = (h) => { const id = named(h); return id.why ? id : Object.assign(id, { excludedBy: (excluded.get(h) || []).slice().sort((a, b) => a - b) }); };
        const nearest = (p, li) => {
            let best = Infinity, logs = [], values = [];
            for (const [l, x] of J.hsLogs) { const vs = x.obs.filter(o => o.profile === p).map(o => o.h); if (!vs.length) continue;
                const d = Math.abs(l - li); if (d < best) { best = d; logs = []; values = []; } if (d === best) { logs.push(l); for (const v of vs) if (!values.includes(v)) values.push(v); } }
            return { logs: logs.sort((a, b) => a - b), values: values.sort((a, b) => a - b) };
        };
        return (J.hsMapOut = { n: J.hsLogs.size, table, switches, logs: used.size, identify, nearest });
    }
    // the map and the observations of log li for armingFinal (null when the log was not read for the map)
    const hsFor = (J, li) => J.hsLogs && J.hsLogs.has(li) ? { info: J.hsLogs.get(li), map: hsMap(J), li } : null;
    // the decoded log li into the map (once: the first pass reads it with fewer columns, the main pass reads it again)
    function hsCollect(J, d, li) { if (J.hsLogs && !J.hsLogs.has(li) && !d.error) J.hsLogs.set(li, hsInfo(d.segs)); }
    // The headspeed step of armingFinal: { profile (1-6 when it identifies one), evidence (out.headspeed) }. gh: the CLI gov_headspeed
    // of each PID profile less those that the map contradicts (stale)
    function headspeedOf(core, hs, gh, stale) {
        const info = hs && hs.info, none = { profile: 0, evidence: null };
        if (!info) return none;
        if (!info.field) return Object.assign(none, { evidence: { headspeed: null, why: 'noField' } });
        const s = info.start; if (!s) return none; // a change at the first frame: armingCore has the event
        const ev = (h, why, more) => Object.assign({ headspeed: h, why }, more || {});
        if (!s.values.length) return Object.assign(none, { evidence: ev(null, 'zero') });
        if (s.values.length > 1) return Object.assign(none, { evidence: ev(null, 'changes', { values: s.values.slice(0, HS.listMax) }) });
        const h = s.values[0], M = hs.map, id = M.identify(h), map = Object.assign({}, M.table);
        if (id.why) return Object.assign(none, { evidence: ev(h, id.why, { profiles: id.profiles || null, map }) });
        const p = id.profile, seen = { observations: { switches: id.switches, logs: id.logs }, map };
        if (core.firstValue === p) return Object.assign(none, { evidence: ev(h, 'excluded', Object.assign({ profile: p }, seen)) });
        // the log itself, or the nearest logs with PID profile p when p has more values in the file (gov_headspeed changed between
        // logs), show p at another value: h is not the value of p at this time
        const mine = [...new Set(info.obs.filter(o => o.profile === p && o.h !== h).map(o => o.h))].sort((a, b) => a - b);
        const near = !mine.length && Array.isArray(M.table[p]) && typeof M.nearest === 'function' && hs.li !== undefined ? M.nearest(p, hs.li) : null;
        if (mine.length || (near && near.values.some(v => v !== h)))
            return Object.assign(none, { evidence: ev(h, 'contradicted', Object.assign({ profile: p, values: mine.length ? mine : near.values.filter(v => v !== h), logs: mine.length ? [hs.li] : near.logs, own: mine.length > 0 }, seen)) });
        // another log starts at h, and its first change goes to p: a different PID profile also has h
        const others = (id.excludedBy || []).filter(l => l !== hs.li);
        if (others.length) return Object.assign(none, { evidence: ev(h, 'ambiguous', Object.assign({ profile: p, logs: others }, seen)) });
        // a CLI dump (optional) that agrees with the log (no gov_headspeed that the map contradicts, and the header agrees with its
        // section of p, or with some section when the dump has none of p) can stop the step: it gives this gov_headspeed to another
        // candidate (a PID profile whose section agrees with the header, not the first change). A dump that disagrees with the log
        // cannot: the log wins
        const cc = core.cliCands, own = cc.includes(p), d4 = core.d4;
        const agrees = !(stale && stale.length) && own && (!d4 || (d4.sections.includes(p) ? d4.agree.includes(p) : d4.agree.length > 0));
        if (agrees && gh) {
            const others = Object.keys(gh).map(Number).filter(q => q !== p && cc.includes(q) && gh[q] === h);
            if (others.length) return Object.assign(none, { evidence: ev(h, 'cliShared', Object.assign({ profile: p, profiles: [p].concat(others).sort((a, b) => a - b) }, seen)) });
        }
        return { profile: p, evidence: ev(h, null, Object.assign({ profile: p }, seen, !own && core.d4 ? { dumpSections: core.d4.agree.slice() } : {})) };
    }

    // After every log of the file: a log that does not tell its start profile gets, as its estimate, the profile that flies its
    // governor target in the other logs of the file (an inference: the targets are the per-profile gov_headspeed), when only
    // one profile does and the candidates allow it. An estimate is not confirmed: the stretch stays "PID profile unknown"
    // (armingFinal). Then the notes (ASD-STE100): of the logs that the headspeed step confirms, of the logs that stay unknown
    // (why), and the PID profiles that fly in the analysis but start no flight log (armingNotes)
    function fileArming(J) {
        const flies = new Map(); // target -> Map(profile -> logs)
        for (const l of J.records) if (l.logClass !== 'bench' && l.targetOf) for (const [k, v] of Object.entries(l.targetOf)) if (+k > 0 && isFinite(v)) {
            const m = flies.get(v) || flies.set(v, new Map()).get(v); m.set(+k, (m.get(+k) || new Set()).add(l.log)); }
        for (const [log, a] of J.arming) {
            if (a.profile || a.estimate || a.conflict || a.target === null || !flies.has(a.target)) continue;
            const ps = [...flies.get(a.target)].filter(([, logs]) => [...logs].some(x => x !== log)).map(([p]) => p);
            if (ps.length !== 1 || !a.candidates.includes(ps[0])) continue;
            Object.assign(a, { estimate: ps[0], basis: ['fileTarget'], candidates: ps, confirmed: false });
        }
        armingNotes(J);
    }
    const rpmText = (vs) => `${and(vs.map(String))} rpm`;
    const profilesText = (ps) => `PID profile${ps.length > 1 ? 's' : ''} ${and(ps.map(String))}`;
    // the logs that the map has: "this file", or "this log" in log scope (the app reads one log)
    const mapScope = (J) => J.scope === 'log' ? 'this log' : 'this file';
    // why the PID profile at the start of a log stays unknown, from the headspeed step (a.headspeed.why), in STE sentences
    function unknownWhy(J, a) {
        const x = a.headspeed; if (!x || !x.why) return '';
        const at = `At the start of the log, "govRequest" is ${x.headspeed} rpm.`, before = a.firstChangeS === null ? 'In the log' : 'Before the first PID profile change';
        switch (x.why) {
            case 'noField': return 'The log does not record "govRequest", the headspeed of the PID profile.';
            case 'zero': return `${before}, "govRequest" is 0.`;
            case 'changes': return a.firstChangeS === null ? `The log records no PID profile change, but "govRequest" has more than one value (${rpmText(x.values)}).`
                : `Before the first PID profile change, "govRequest" has more than one value (${rpmText(x.values)}).`;
            case 'none': return `${at} No PID profile change in ${mapScope(J)} shows this value.`;
            case 'shared': return `${at} In the PID profile changes of ${mapScope(J)}, ${profilesText(x.profiles)} have this value.`;
            case 'excluded': return `${at} PID profile ${x.profile} has this value. But the log changes to PID profile ${x.profile} at ${numText(+a.firstChangeS.toFixed(1))} s, and a log records only a change of the PID profile.`;
            case 'cliShared': return `${at} In the CLI dump, ${profilesText(x.profiles)} have this value.`;
            case 'contradicted': return `${at} The PID profile changes of ${mapScope(J)} show this value for PID profile ${x.profile}. ` +
                `But ${x.own ? 'this log shows' : `${logWords(x.logs)} ${x.logs.length > 1 ? 'show' : 'shows'}`} ${rpmText(x.values)} for PID profile ${x.profile}.`;
            case 'ambiguous': return `${at} The PID profile changes of ${mapScope(J)} show this value for PID profile ${x.profile}. ` +
                `But ${logWords(x.logs)} ${x.logs.length > 1 ? 'start' : 'starts'} at this value, and the first PID profile change goes to PID profile ${x.profile}. ` +
                'Because a log records only a change of the PID profile, a different PID profile also has this value.';
            default: return '';
        }
    }
    // a log whose evidence disagrees: the governor target against the CLI sections that agree with the header (only a CLI dump can
    // show it; the governor target gives only an estimate, so the log does not confirm the profile)
    function conflictNote(J, log, a) {
        J.notes.add(`The governor target agrees with PID profile ${a.inferred}, but the log header does not agree with the CLI section \`profile ${a.inferred - 1}\`. Thus, the PID profile at the start of the log is unknown.`, log);
    }
    function armingNotes(J) {
        const known = new Map(); // the logs that the headspeed step confirms, by headspeed, PID profile and observations
        for (const [log, a] of J.arming) {
            const x = a.headspeed;
            if (a.confirmed && a.basis.includes('headspeed') && x) { const k = `${x.headspeed}|${a.profile}|${x.observations.switches}|${x.observations.logs}`; (known.get(k) || known.set(k, { x, p: a.profile, logs: [] }).get(k)).logs.push(log); continue; }
            if (a.conflict) { conflictNote(J, log, a); continue; }
            if (a.profile || !J.records.some(l => l.log === log && l.profileSeconds && l.profileSeconds['0'] > 0)) continue;
            const reason = unknownWhy(J, a), guess = a.estimate ? `The governor target at the start of the log agrees with PID profile ${a.estimate}. The governor target does not show the PID profile without other data. ` : '';
            J.notes.add(reason || guess ? `${reason ? `${reason} ` : ''}${guess}Thus, the app cannot find the PID profile at the start of the log. The results of that part show "PID profile unknown".`
                : 'The app cannot find the PID profile at the start of the log. Thus, the results of that part show "PID profile unknown".', log);
        }
        for (const { x, p, logs } of known.values()) {
            const one = logs.length === 1, list = one ? `log ${logs[0] + 1}` : `logs ${and(spans(logs.sort((a, b) => a - b).map(l => l + 1)))}`, o = x.observations;
            const seen = `${o.switches === 1 ? '1 change' : `${o.switches} changes`} in ${o.logs === 1 ? '1 log' : `${o.logs} logs`}`;
            J.notes.add(`At the start of ${list}, "govRequest" is ${x.headspeed} rpm. In the PID profile changes of ${mapScope(J)}, only PID profile ${p} has this value (${seen}). ` +
                `Thus, ${one ? 'this log starts' : 'these logs start'} in PID profile ${p}.`);
        }
        // a PID profile that flies in the analysis, which no flight log starts in: the log header has its values only when the pilot
        // arms the helicopter in it. True and useful only when the app can then identify it (a headspeed of the map that no other
        // PID profile has) and no CLI dump gives its section
        if (J.scope !== 'file' || !J.hsLogs || !J.hsLogs.size) return;
        const M = hsMap(J), starts = new Set([...J.arming.values()].filter(a => a.confirmed && a.profile > 0).map(a => a.profile)), cli = J.cliParsed && J.cliParsed.profiles || {};
        const flown = new Set(); for (const l of J.records) if (l.logClass !== 'bench' && !l.skipped) for (const [k, v] of Object.entries(l.profileSeconds || {})) if (+k > 0 && v >= 0.05) flown.add(+k);
        for (const p of [...flown].sort((a, b) => a - b)) {
            const h = M.table[p];
            if (starts.has(p) || [].concat(h).every(v => M.identify(v).profile !== p) || cli[p - 1]) continue; // one of its values identifies it
            J.notes.add(`No flight log in the analysis starts in PID profile ${p}. The log header records the values of the PID profile that is active when you arm the helicopter. ` +
                `Thus, the log header has the values of PID profile ${p} only when you arm the helicopter in PID profile ${p}.`);
        }
    }
    // After the main pass, before the judgement: without a first pass (a flight rpm of the user and no configurations), the map had
    // only the logs before each log. The arming of every log again with the map of all of them: the PID profile runs of its records
    // (the stretch before the first change) and the CLI section of its D4 follow
    function armingLate(J) {
        if (!J.hsLogs || !J.armCore) return;
        for (const [li, a] of J.arming) {
            const b = armingFinal(J.armCore.get(li), hsFor(J, li));
            if (!b || JSON.stringify(b) === JSON.stringify(a)) continue;
            for (const k of Object.keys(a)) delete a[k];
            Object.assign(a, b); // records[].profiles.arming is this object
            const end = a.firstChangeS === null ? Infinity : a.firstChangeS - 1e-4, known = a.confirmed && a.profile > 0 ? a.profile : null; // the runs before the first change (the change frame is at or after its event time)
            for (const rec of J.records) if (rec.log === li && rec.profiles) for (const q of rec.profiles.pid) if (q.t0 < end) q.profile = known || 0;
            for (const [rec, s] of J.cliSections) if (rec.log === li && s) Object.assign(s, { arming: known, usable: s.section !== null && s.chosenBy !== 'guess' && (known === null || s.section === known - 1) });
        }
    }
    // records[].profiles of one segment: the arming profile of its log, the PID profile runs (frame s; 0: unknown), and the
    // rate profile changes (func 1) and other in-flight adjustments in its time
    function profileRecord(rec, w, arming, events, next) {
        const at = frameOf(w), pa = w.profileAt, runs = [], inside = (e) => e.t >= (rec.segment ? rec.fromS : -Infinity) && (next === null || e.t < next);
        for (let i = 0; i < w.n;) { let j = i + 1; while (j < w.n && pa[j] === pa[i]) j++; runs.push({ t0: at(i), t1: at(j), profile: pa[i] > 0 ? pa[i] : arming.confirmed ? arming.profile : 0 }); i = j; }
        const mine = events.filter(inside);
        rec.profiles = { arming, pid: runs, rate: mine.filter(e => e.func === 1).map(e => ({ t: e.t, profile: e.value })),
            adjustments: mine.filter(e => e.func !== 1 && e.func !== 2).map(e => ({ t: e.t, func: e.func, name: e.name, value: e.value })) };
    }

    // ---------------------------------------------------------------------------------------------
    // Configurations (datasets.cjs, SPEC3 J, round 3 M1): one PID profile and one exact set of the values that change the flight
    // ---------------------------------------------------------------------------------------------

    // datasets.cjs finds the configurations of the file from one input for each log (dsInput): the log header, the PID profile
    // runs, the rate profile changes and the other in-flight adjustments, the flights ([] for a bench run) and the PID profile at
    // arming (only a confirmed one). The first pass (firstPass) collects the inputs of every log of the file. The main pass makes
    // the input of each log that it analyses again before the modules run (its flight phases use the flight rpm of the file), and
    // datasets() runs again (it takes milliseconds). Then each sample of the log gets the label of its configuration (relabel):
    // ctx.profile holds the label (1 to 255, the same for one configuration in every log, 0 out of every configuration), so that
    // every module pools by configuration and not only by PID profile. ctx.pidLabels keeps the PID profile labels for
    // health_setup (D4 compares the CLI section of the PID profile at the start), check D8 and the curves of the views;
    // ctx.pidProfileOf(label) gives the PID profile of a label (0: unknown). At the end (dsFinal) the labels map to the
    // configurations of the last datasets() run: by their values, else by the time of their stretches. dsOn: options.datasets is
    // not false and datasets.cjs loads; relabelOn: also not the CLI's view (toolkitView), which keeps the labels of the toolkit
    const dsOn = (J) => J.o.datasets !== false && !!J.DS;
    const relabelOn = (J) => dsOn(J) && !toolkitView(J);
    const DS_MODULES = new Set(['gov', 'loop', 'track', 'more', 'phase', 'rescue', 'limits']); // the modules that get the labels of the configurations
    const MAX_LABELS = 255; // the labels are a Uint8Array
    const SNAP_S = 0.0015;  // s: more than the 1 ms rounding of the stretch ends of datasets.cjs (labels t0, t1)
    // the values of a configuration as a key: its PID profile and its values that change the flight (datasets.cjs keys them so)
    const dsKey = (d) => `${d.pidProfile}|${JSON.stringify(Object.keys(d.values || {}).sort().map(n => [n, d.values[n]]))}`;
    // the frame seconds of every sample of a segment (the clock of datasets.cjs labels), else index time
    function frameTimes(w) {
        const t = w.extra && w.extra.time, n = w.n, out = new Float64Array(n), rate = w.flight && w.flight.actualRate || w.rate;
        for (let i = 0; i < n; i++) out[i] = t ? w.fromS + (t[i] - t[0]) / 1e6 : w.fromS + i / rate;
        return out;
    }
    // armingCore and armingFinal before the analysis: check D4 of health_setup gives the mismatches of the log header with each CLI section. The
    // same count comes from health_setup compareCli (the code of D4), so the result is the result of addLog after the analysis.
    // J, li: the core is kept (J.armCore) and the headspeed step uses the map of the logs read so far (hsFor)
    function armingLite(K, preps, events, cli, J, li) {
        if (J && J.armFixed && J.armFixed.has(li)) return armingFinal(J.armCore.get(li), hsFor(J, li)); // the core of the whole log (armWhole)
        const core = armingCoreLite(K, preps, events, cli);
        if (J && core) J.armCore.set(li, core);
        return armingFinal(core, J ? hsFor(J, li) : null);
    }
    // armingCore with the mismatches of the header against each CLI section (D4) when the preps have no D4 yet
    function armingCoreLite(K, preps, events, cli) {
        const live = preps.filter(p => p && p.ctx), first = live[0]; if (!first) return null;
        const m = first.rec.metrics || (first.rec.metrics = {}), had = Object.prototype.hasOwnProperty.call(m, 'setup'), saved = m.setup;
        if (cli && cli.profiles && !(saved && saved.D4)) {
            const h = first.w.flight.header || {}, by = {};
            for (const q of Object.keys(cli.profiles).map(Number)) by[q] = K.core.setup.compareCli(h, cli, q).filter(v => !v.match && v.where !== 'global').length;
            m.setup = { D4: { mismatchesByProfile: by } };
        }
        try { return armingCore(live, events); }
        finally { if (had) m.setup = saved; else delete m.setup; }
    }
    // D12 of a log that a flight selection cuts (analyseFile): the core of the whole log, before the cut. The PID profile at the
    // start of a window that starts after the first logged change is the profile of that change, not the profile whose values the
    // log header has, so the core of the cut segments is not used (J.armFixed: addLog and armingLite keep this core)
    function armWhole(J, segs, events, li) {
        const K = J.K, preps = segs.filter(w => !w.skipped && w.n > 0).map((w, k) => prepare(K, w, { segment: k, cli: J.cliText, cliParsed: J.cliParsed, phases: false, toolkit: toolkitView(J) }, J));
        const core = armingCoreLite(K, preps, events, J.cliParsed);
        if (core) { J.armCore.set(li, core); J.armFixed.add(li); }
    }
    // the input of one log for datasets(): preps of its segments (prepare), cls its class (classOf: 'flight', 'bench' or null)
    function dsInput(J, K, d, li, preps, cls) {
        const live = preps.filter(p => p && p.ctx), head = d.segs.find(w => w.flight && w.flight.header);
        const out = { log: li, header: head ? head.flight.header : null, armingProfile: 0, armingEstimate: 0, profileRuns: [], rateChanges: [], adjustments: [], flights: null, durationS: null };
        if (!live.length) return out; // no data that the app can read (round 3 M4): its header only, no stretch
        armingInput(out, armingLite(K, preps, d.events, J.cliParsed, J, li));
        for (const p of live) { const w = p.w, at = frameOf(w), pa = w.profileAt;
            for (let i = 0; i < w.n;) { let j = i + 1; while (j < w.n && pa[j] === pa[i]) j++; out.profileRuns.push({ t0: at(i), t1: at(j), profile: pa[i] }); i = j; } }
        out.rateChanges = d.events.filter(e => e.func === 1 && e.value > 0).map(e => ({ t: e.t, profile: e.value }));
        out.adjustments = d.events.filter(e => e.func !== 1 && e.func !== 2).map(e => ({ t: e.t, func: e.func, value: e.value }));
        out.flights = cls === 'bench' ? [] : cls === 'flight' ? [].concat(...live.map(p => { const at = frameOf(p.w), P = p.ph && p.ph.P;
            return (P && Array.isArray(P.flights) ? P.flights : []).filter(q => q && isFinite(q.i0) && isFinite(q.i1)).map(q => ({ t0: at(q.i0), t1: at(q.i1) })); })) : null;
        return out;
    }
    // the PID profile at arming of an input of datasets(): only a confirmed one (D12), else the estimate apart
    function armingInput(input, a) { input.armingProfile = a && a.confirmed && a.profile > 0 ? a.profile : 0; input.armingEstimate = a && !a.confirmed && a.estimate ? a.estimate : 0; }
    // After the first pass, the map of the headspeeds has every log that it read: the PID profile at arming of every input again
    function dsArming(J) {
        for (const [li, input] of J.dsInputs) { if (!J.armCore.has(li)) continue;
            const before = [input.armingProfile, input.armingEstimate]; armingInput(input, armingFinal(J.armCore.get(li), hsFor(J, li)));
            if (before[0] !== input.armingProfile || before[1] !== input.armingEstimate) J.dsDirty = true; }
    }
    // the datasets() of the inputs so far (null when datasets.cjs stops: a note, and no configurations)
    function dsNow(J) {
        if (!J.dsDirty) return J.ds;
        J.dsDirty = false;
        try { J.ds = J.DS.datasets([...J.dsInputs.values()].sort((a, b) => a.log - b.log), J.dsCli, { logBase: 1 }); }
        catch (e) { J.ds = null; J.DS = null; J.notes.add(`The function "datasets" of "datasets.cjs" stopped. The error is "${message(e)}". Thus, the results do not show the configurations.`); }
        return J.ds;
    }
    function dsSet(J, li, input) { J.dsInputs.set(li, input); J.dsDirty = true; }
    // the label of configuration k of ds (registered by its values: the same label in every log), null after MAX_LABELS
    function labelOf(J, ds, k) {
        const d = ds.datasets[k], key = dsKey(d), R = J.dsReg;
        if (R.byKey.has(key)) return R.byKey.get(key);
        if (R.info.size >= MAX_LABELS) return null;
        const L = R.info.size + 1; R.byKey.set(key, L); R.info.set(L, { key, pid: d.pidProfile > 0 ? d.pidProfile : 0 }); R.spans.set(L, []);
        return L;
    }
    // the labels of the configurations in the ctx of every segment of log li (before the modules run)
    function relabel(J, li, preps) {
        const ds = dsNow(J); if (!ds) return;
        const live = preps.filter(p => p && p.ctx); let over = false;
        for (const q of ds.labels) if (q.log === li) { const L = labelOf(J, ds, q.index); if (L === null) over = true; else J.dsReg.spans.get(L).push({ log: li, t0: q.t0, t1: q.t1 }); }
        const pidOf = (L) => { const x = J.dsReg.info.get(L); return x ? x.pid : 0; };
        const of = ds.datasets.map((d, k) => labelOf(J, ds, k)); // the label of each configuration index (one key each)
        for (const p of live) {
            const w = p.w, T = frameTimes(w), ix = J.DS.labelArray(ds, li, T), lab = new Uint8Array(w.n), pa = w.profileAt;
            // datasets.cjs rounds the ends of its stretches to 1 ms: a stretch of a PID profile starts and ends at the samples of
            // that PID profile (the 2 samples at 4 kHz next to a change get the configuration of their PID profile run)
            for (let i = 0; i < w.n;) { let j = i + 1; while (j < w.n && pa[j] === pa[i]) j++;
                let a = i; while (a < j && T[a] - T[i] < SNAP_S) a++; let b = j - 1; while (b >= i && T[j - 1] - T[b] < SNAP_S) b--;
                if (a < j) for (let k = i; k < a; k++) ix[k] = ix[a];
                if (b >= i) for (let k = b + 1; k < j; k++) ix[k] = ix[b];
                i = j; }
            for (let i = 0; i < w.n; i++) { const k = ix[i]; if (k < 0) continue; const L = of[k]; if (L === null) over = true; else lab[i] = L; }
            // per-profile CLI values (health.cjs cliContext: gov_headspeed, gov_max_throttle) for the labels of their PID profile
            const byLabel = (o) => { const out = {}; for (const [L, x] of J.dsReg.info) if (x.pid > 0 && o[x.pid] !== undefined) out[L] = o[x.pid]; return out; };
            p.ctxPid = p.ctx; // the ctx of the PID profiles (armingCore reads its gov_headspeed of each PID profile)
            p.ctx = Object.assign({}, p.ctx, { profile: lab, pidLabels: p.ctx.profile, pidProfileOf: pidOf },
                p.ctx.govHeadspeed ? { govHeadspeed: byLabel(p.ctx.govHeadspeed) } : {}, p.ctx.maxThrottle ? { maxThrottle: byLabel(p.ctx.maxThrottle) } : {});
        }
        if (over) J.notes.add(`The file has more than ${MAX_LABELS} configurations. Thus, the results of the other configurations show no configuration.`, li);
    }
    // the ctx with the PID profile labels (health_setup, the curves of the views)
    const pidCtx = (c) => c && c.pidLabels ? Object.assign({}, c, { profile: c.pidLabels }) : c;
    // After every log: datasets() of the last inputs, and the configuration of each label of the modules: the configuration with the
    // same values, else the one at the time of all its stretches (a PID profile at arming that the main pass confirmed changes a
    // configuration of a log that the analysis read before). J.dsMap: label -> configuration (or null)
    function dsFinal(J) {
        if (!dsOn(J)) return null;
        J.dsDirty = true; const ds = dsNow(J); if (!ds) return null;
        const byKey = new Map(ds.datasets.map(d => [dsKey(d), d])), lost = [];
        J.dsMap = new Map();
        for (const [L, x] of J.dsReg.info) {
            let d = byKey.get(x.key) || null;
            if (!d) { const ids = new Set(J.dsReg.spans.get(L).map(q => J.DS.datasetAt(ds, q.log, (q.t0 + q.t1) / 2)).filter(v => v !== null)); d = ids.size === 1 ? ds.datasets.find(y => y.id === [...ids][0]) || null : null; if (!d) lost.push(L); }
            J.dsMap.set(L, d);
        }
        if (lost.length) J.notes.add(`The configuration of ${lost.length === 1 ? '1 part' : `${lost.length} parts`} of the logs changed after the analysis of that part. Thus, the results of ${lost.length === 1 ? 'that part show' : 'those parts show'} no configuration.`);
        return ds;
    }
    // the configuration of a finding (round 3 M1): a module that pooled by configuration gives its label (f.profile); health_setup
    // and the others give a PID profile label of one log, which is one configuration when that PID profile has one configuration in
    // that log (datasets.cjs profileMap). Else null: a header or global check, or a PID profile with more configurations in the log
    function datasetOfFinding(J, f, ds) {
        if (!ds) return null;
        if (f.datasetLabel !== undefined) return f.datasetLabel > 0 ? J.dsMap.get(f.datasetLabel) || null : null;
        const logs = logsOf(f); if (logs.length !== 1 || ['D4', 'F4', 'H'].includes(f.id)) return null;
        const p = f.profile === 'arm' ? 0 : typeof f.profile === 'string' && /^\d+$/.test(f.profile) ? +f.profile : f.profile;
        if (!Number.isInteger(p) || p < 0) return null;
        const a = J.arming.get(logs[0]), key = p > 0 ? p : a && a.confirmed && a.profile > 0 ? a.profile : 0, ids = (J.DS.profileMap(ds, logs[0]) || {})[key] || [];
        return ids.length === 1 ? ds.datasets[ids[0]] || null : null;
    }
    // result.datasets: datasets() of every log of the file, its labels cut to the time of the analysis (the analysed logs, the
    // windows of a flight selection), and for each configuration the seconds of flight in that time (analysedFlightSeconds)
    function dsResult(J, ds) {
        if (!ds) return null;
        const wins = J.selection ? J.selection.windows : null, analysed = new Set(J.logs), labels = [];
        for (const q of ds.labels) { if (!analysed.has(q.log)) continue;
            const parts = wins ? wins.filter(w => w.log === q.log).map(w => [Math.max(q.t0, w.t0), Math.min(q.t1, w.t1)]).filter(([a, b]) => b > a) : [[q.t0, q.t1]];
            for (const [a, b] of parts) labels.push(Object.assign({}, q, { t0: r(a, 3), t1: r(b, 3), flightSeconds: a === q.t0 && b === q.t1 ? q.flightSeconds : r(flightIn(J, q.log, a, b), 3) })); }
        const fs = {}, sec = {}; for (const q of labels) { fs[q.dataset] = (fs[q.dataset] || 0) + (q.flightSeconds || 0); sec[q.dataset] = (sec[q.dataset] || 0) + q.t1 - q.t0; }
        return Object.assign({}, ds, { labels, datasets: ds.datasets.map(d => Object.assign({}, d, { analysed: fs[d.id] !== undefined, analysedSeconds: r(sec[d.id] || 0, 3), analysedFlightSeconds: r(fs[d.id] || 0, 3) })),
            analysed: ds.datasets.filter(d => fs[d.id] !== undefined).map(d => d.id) });
    }
    // the seconds of flight of a log from a to b (frame seconds), from its input
    function flightIn(J, log, a, b) { const x = J.dsInputs.get(log); return (x && x.flights || []).reduce((s, q) => s + Math.max(0, Math.min(b, q.t1) - Math.max(a, q.t0)), 0); }
    // a label of the modules as the PID profile label of the app (1-6, 0: unknown), and a text that names its configuration
    const pidLabelOf = (J, L) => { const d = J.dsMap && J.dsMap.get(L); return d && d.pidProfile > 0 ? d.pidProfile : 0; };
    const configText = (d) => `configuration ${d.id} (${d.pidProfile > 0 ? `PID profile ${d.pidProfile}` : 'PID profile unknown'})`;
    // the label fields of a finding of a module that pooled by configuration: profile (a label) -> the PID profile label, with the
    // configuration (dataset); in other (T4), events, the evidence and its spans and context; the toolkit text names the
    // configuration where it names the label ("profile 3", "PID profile 3")
    function asPidLabels(J, f) {
        const conv = (o) => { if (!o || typeof o !== 'object' || !Number.isInteger(o.profile) || o.profile < 0) return;
            const d = o.profile > 0 && J.dsMap ? J.dsMap.get(o.profile) || null : null; o.profile = pidLabelOf(J, o.profile); o.dataset = d ? d.id : null; };
        const L = f.datasetLabel;
        f.profile = L > 0 ? pidLabelOf(J, L) : L === 0 ? 0 : f.profile;
        if (f.other) conv(f.other);
        for (const e of Array.isArray(f.events) ? f.events : []) conv(e);
        if (f.evidence && typeof f.evidence === 'object') { const e = f.evidence; if (Number.isInteger(e.profile)) e.profile = f.profile; if (e.dataset === undefined) e.dataset = f.dataset;
            for (const q of [].concat(e.spans || [], e.context || [])) conv(q); }
        if (typeof f.text === 'string' && J.dsMap) f.text = f.text.replace(/(?<!\b(?:CLI|rate) )\b(PID )?profile (\d+)\b/g, (m, pid, n) => { const d = J.dsMap.get(+n); return d ? configText(d) : m; });
    }

    // records, curves, header and fields of one decoded log; parser errors are kept apart (health.cjs puts them last). With
    // phases (health_phase.cjs and options.phases), a log with no flight is a bench run: its records are kept, with no
    // analysis (SPEC2 D13 correction). J.heads: the header, the field states and the class of each log, for headerOf.
    // J.vib: the gyro filter pass of each flight log (vibOf), for the F5 flags of every flight log (filterPass)
    function addLog(J, d, li, selected) {
        if (d.error) { J.errorRecords.push({ id: `${J.fileName}|${li}|error`, file: J.fileName, log: li, segment: 0, skipped: d.error }); return; }
        const K = J.K, airborneEvents = d.segs.some(w => !w.skipped && w.airborneAt.some(v => !v)), usePhases = phasesOn(J, K), t = Date.now();
        const preps = d.segs.map(w => { const seg = J.segCount.get(w.flight.id) || 0; J.segCount.set(w.flight.id, seg + 1);
            return prepare(K, w, { segment: seg, cli: J.cliText, cliParsed: J.cliParsed, phases: usePhases, airborneEvents, toolkit: toolkitView(J) }, J); });
        const cls = usePhases ? classOf(preps.filter(p => p.ctx).map(p => p.ph)) : null, out = [];
        // the notch orders of the log (log scope: no first pass) before its checks, then the gear of the modules
        if (J.gearAcc && !J.tailFit) { gearAdd(J, preps, cls, li, K); gearFit(J); }
        gearInto(J, preps);
        // the configurations (round 3 M1): the input of this log at the flight rpm of the file, then the labels of the modules
        if (dsOn(J)) { dsSet(J, li, dsInput(J, K, d, li, preps, cls)); dsCliFilter(J, dsBench(J)); if (cls !== 'bench' && relabelOn(J)) relabel(J, li, preps); }
        for (const p of preps) {
            if (cls === 'bench' && p.ctx) { p.rec.logClass = 'bench'; phaseRecord(p.rec, p.w, p.ph, J); benchPhase(K, p, J); out.push({ p, rec: p.rec, ctx: null }); continue; }
            const a = analyseSegment(K, p, { excludeAbnormal: J.o.excludeAbnormal, logClass: cls }, J);
            if (p.ctx) { a.rec.logClass = cls; if (p.ph) phaseRecord(a.rec, p.w, p.ph, J); }
            out.push(Object.assign({ p }, a));
        }
        const core = cls === 'bench' ? null : J.armFixed.has(li) ? J.armCore.get(li) : armingCore(preps, d.events), arming = armingFinal(core, hsFor(J, li));
        if (core) J.armCore.set(li, core);
        if (arming) J.arming.set(li, arming);
        out.filter(o => o.ctx).forEach((o, k, live) => profileRecord(o.rec, o.p.w, arming, d.events, k + 1 < live.length ? live[k + 1].rec.fromS : null));
        for (const p of preps) if (p.ctx && cls !== 'bench') J.cliSections.set(p.rec, sectionOf(p, arming));
        J.ms.analyse += Date.now() - t;
        const head = { log: li, header: d.segs.length ? d.segs[0].flight.header : null, fields: null, bench: cls === 'bench', flight: cls === 'flight' || (cls === null && out.some(o => o.rec.flown)) };
        for (const { p, rec, ctx, phaseCtx } of out) {
            J.records.push(rec);
            if (cls === 'bench') continue;
            if (rec.flown && !airborneEvents) J.notes.add(`The log does not record AIRBORNE_STATE. Thus, the toolkit (lib.cjs) sets all frames as airborne, and the app finds the flight only from the headspeed (${J.rpm.value} rpm or more) and the gyro rate. The log can be a test on the ground.`, li);
            if (!head.fields && !p.w.skipped && rec.metrics) { head.header = p.w.flight.header; head.fields = fieldsOf(K, p.w, rec); }
            if (head.flight && ctx && rec.metrics && rec.metrics.more && !(selected && J.o.curves)) vibOf(J, p.w, ctx, rec);
            if (!selected) continue;
            if (J.o.curves) J.curves.push(curvesOf(J, p.w, ctx, rec, phaseCtx));
        }
        if (selected || head.flight) J.heads.set(li, Object.assign(head, { header: head.header ? JSON.parse(toJson(head.header)) : null }));
        if (cls === 'bench') return;
        const rate = d.events.filter(e => e.func === 1), other = d.events.filter(e => e.func !== 1 && e.func !== 2);
        if (rate.length) J.notes.add('The log records a change of the rate profile. Check R1 uses the rate values of the log header, which are the values of the rate profile at the start of the log.', li);
        if (other.length) J.notes.add('The log records in-flight adjustments of tuning values. The log header shows only the values at the start of the log.', li);
    }
    const phasesOn = (J, K) => J.o.phases !== false && !!K.phase;
    // a bench run gets only the log class of health_phase.cjs (its D7, which lists the run as not analysed: advice, hierarchy)
    function benchPhase(K, p, J) {
        if (typeof K.phase.analyse !== 'function') return;
        J.progress(`Log ${p.rec.log + 1}: the app does the checks of "health_phase.cjs".`);
        try { p.rec.metrics.phase = K.phase.analyse(p.w, Object.assign({}, p.ctx, { phases: p.ph.P, flightMask: p.ph.mask })); } catch (e) { p.rec.errors.phase = String(e && e.stack || e); }
    }

    const startProfile = (l) => l.metrics && l.metrics.setup ? l.metrics.setup.startProfile : null; // the label of the modules at the first sample (labelsOf)

    // D4 (health_setup) compares the log header with one CLI section: the section of the label at the first sample (an event
    // at the first frame, or with toolkit labels the guess of lib.profilesOf), else the section with the fewest mismatches.
    // The header holds the values of the arming profile, so a section that a guess chose (toolkit labels: lib.profilesOf), or
    // the section of another profile than the confirmed arming profile, does not show a stale CLI dump (review A2). { section
    // (CLI index | null), chosenBy: 'event' | 'guess' | 'fewest mismatches', arming (the confirmed arming profile | null),
    // usable: false for those two, else true (with arming null: the section that agrees best, the arming profile unknown) }
    // or null without D4. advice.cjs reads it from the D4 finding (cliSection) and from logs[].d4
    function sectionOf(prep, arming) {
        const d4 = prep.rec.metrics && prep.rec.metrics.setup && prep.rec.metrics.setup.D4;
        if (!d4 || d4.skipped) return null;
        const section = Number.isInteger(d4.profileCompared) ? d4.profileCompared : null, byLabel = d4.profileChosenBy !== 'fewest mismatches';
        // a window of a flight selection that starts after the first frame (w.cutAt): its first label is not the profile of the header
        const chosenBy = !byLabel ? 'fewest mismatches' : prep.w.profileAt[0] > 0 && !prep.w.cutAt ? 'event' : 'guess', known = arming && arming.confirmed && arming.profile > 0 ? arming.profile : null;
        return { section, chosenBy, arming: known, usable: section !== null && chosenBy !== 'guess' && (known === null || section === known - 1) };
    }

    // The gyro filter pass of a flight log that is not on screen (health_more curves vib, gyroRAW -> gyroADC): only the pass
    // of each axis, pooled and per profile, for filterPass. J.vib: [{ log, segment, vib }]. The cost is one health_more curves
    // call for each segment of each flight log (Gaui X4 #49 to #58, Fireball: see test/tuning_worker.test.cjs)
    function vibOf(J, w, ctx, rec) {
        const M = J.K.more; if (!M || typeof M.curves !== 'function') return;
        let c; try { c = M.curves(w, Object.assign({}, pidCtx(ctx)), rec.metrics.more); } catch (e) { J.notes.add(`The app cannot make the curves of "health_more.cjs". The error is "${message(e)}".`, rec.log); return; }
        const v = c && c.vib; if (!v) return;
        const axes = (S) => Object.fromEntries(['roll', 'pitch', 'yaw'].map(ax => [ax, S[ax] ? { f: S[ax].f, pass: S[ax].pass } : null]));
        J.vib.push({ log: rec.log, segment: rec.segment, vib: Object.assign({ filtOnly: !!v.filtOnly, windows: v.windows, byProfile: Object.fromEntries(Object.entries(v.byProfile || {}).map(([p, S]) => [p, Object.assign({ windows: S.windows }, axes(S))])) }, axes(v)) });
    }

    const CURVED = ['track', 'more', 'phase'];   // the modules whose curves the views draw (the rescue and limit periods are evidence spans), by PID profile
    function curvesOf(J, w, ctx, rec, phaseCtx) {
        const out = { log: rec.log, segment: rec.segment, fromS: r(w.fromS, 3), seconds: r(w.seconds, 1), track: null, more: null, phase: null };
        for (const name of CURVED) {
            const M = J.K[name];
            if (!M || typeof M.curves !== 'function' || !rec.metrics || !rec.metrics[name]) continue;
            try { out[name] = M.curves(w, Object.assign({}, pidCtx(name === 'phase' ? phaseCtx : ctx)), rec.metrics[name]); } catch (e) { J.notes.add(`The app cannot make the curves of "${OPTIONAL[name]}.cjs". The error is "${message(e)}".`, rec.log); }
        }
        return out;
    }

    // ---------------------------------------------------------------------------------------------
    // Judging, gains, advice
    // ---------------------------------------------------------------------------------------------

    const logsOf = (f) => Array.isArray(f.log) ? f.log : f.log === null || f.log === undefined ? [] : [f.log];
    const timesOf = (f) => { const t = new Set(); // health_report.cjs:123-126
        for (const e of f.events || []) if (typeof e.t === 'number') t.add(e.t);
        for (const m of String(f.text || '').matchAll(/\bat (\d+(?:\.\d+)?) s\b/g)) t.add(+m[1]);
        return [...t].sort((a, b) => a - b); };
    const bySeverity = (a, b) => (RANK[a.severity] ?? 5) - (RANK[b.severity] ?? 5) || String(a.id).localeCompare(String(b.id), 'en', { numeric: true })
        || String(logsOf(a)[0]).localeCompare(String(logsOf(b)[0]), 'en', { numeric: true }); // health_report.cjs:128

    // Finding texts name logs by index from 0 (health_loop T4 "(log 32 profile 2", health_gov G3 "at log 38 127.9 s",
    // health_setup H "since log 47"); the dialog and advice count from 1, as the viewer's log picker. "log 1000 Hz" (the SETUP
    // logging rate) is not a log number. The toolkit report (reportMarkdown) keeps its own numbering.
    const viewerText = (t) => String(t).replace(/\blog (\d+)\b(?!\.\d|\s*Hz)/g, (m, n) => `log ${+n + 1}`);

    // health_report.cjs over the records as health.json, then the new modules judged the same way (health_report.cjs:113-127)
    function judgeAll(J, src) {
        const K = J.K, all = J.records.concat(J.errorRecords), records = all.filter(l => l.logClass !== 'bench'), files = new Map(), lines = []; // bench runs: no health.cjs analysis
        files.set('/v/health.json', toJson({ files: [J.fileName], cli: J.cliText ? J.o.cliName || 'CLI dump' : null, rule: K.health.RULE, extra: K.EXTRA, logs: records.map(asHealthJson) }));
        runCli(src, K.rpm, 'health_report.cjs', ['/v'], files, (l) => lines.push(l));
        for (const l of lines) if (/^RULES/.test(l)) J.notes.add(`The file "health_report.cjs" shows this text: "${l}".`);
        const findings = JSON.parse(files.get('/v/results.json')).findings;
        for (const name of JUDGED) {
            const M = K[name], file = `${OPTIONAL[name]}.cjs`;
            if (!M || (name === 'phase' && !phasesOn(J, K))) continue;
            const flights = JSON.parse(toJson(all.filter(l => l.metrics && l.metrics[name]).map(l => ({ log: l.log, segment: l.segment, start: l.start, header: l.header, metrics: l.metrics[name] })))), add = []; // a bench run: health_phase only; segment: D7 lists the flights of each segment
            const extra = name === 'config' ? { cli: J.cliParsed || null, arming: Object.fromEntries([...J.arming].map(([l, a]) => [l, { profile: a.profile, confirmed: !!a.confirmed }])) } : undefined;
            try { for (const f of M.judge(flights, M.DEFAULT_RULES, extra)) add.push(Object.assign({ module: name }, f)); }
            catch (e) { add.push({ module: name, id: name.toUpperCase(), severity: 'error', log: null, text: `The app cannot compare the results of "${file}" with the limits. The error is "${message(e)}".` }); }
            for (const l of all) if (l.errors && l.errors[name]) add.push({ module: name, id: name.toUpperCase(), severity: 'error', log: l.log, text: `The analysis of "${file}" stopped. The error is "${l.errors[name].split('\n')[0]}".` });
            for (const f of add) { f.times = timesOf(f); findings.push(f); }
        }
        for (const f of findings) if (typeof f.text === 'string') f.text = viewerText(f.text);
        return { findings: findings.sort(bySeverity), markdown: files.get('/v/report.md') };
    }

    // extract.cjs then report.cjs on the whole file, as `node extract.cjs /v/out <file>` and `node report.cjs /v/out`
    function gains(J, src, bytes) {
        const lost = GAINS.filter(n => !src.texts[`${n}.cjs`]);
        if (lost.length) { J.notes.add(`The app did not calculate the gains, because ${and(lost.map(n => `"${n}.cjs" (${src.missing[`${n}.cjs`]})`))} ${lost.length > 1 ? 'are' : 'is'} not available.`); return null; }
        const files = new Map([[`/v/${J.fileName}`, bytes]]), count = J.logCount || 1, D = J.K.lib.DEFAULTS;
        try {
            let found = null; // extract.cjs ends with "<n> flights, <n> segments, <n> skipped -> <file>"
            runCli(src, J.K.rpm, 'extract.cjs', ['/v/out', `/v/${J.fileName}`], files, (l) => {
                const s = /^\d+ flights, (\d+) segments,/.exec(l); if (s) found = +s[1];
                const m = /#(\d+)/.exec(l); J.progress(`"extract.cjs": "${l}"`, 'gains', m ? 0.6 + 0.3 * Math.min(1, (+m[1] + 1) / count) : null); });
            delete self.__bytes; files.delete(`/v/${J.fileName}`);
            if (found === 0) { J.notes.add(`The app did not calculate the gains, because "extract.cjs" found no applicable segment. A segment is a minimum of ${D.minSegmentS} s of flight with one PID profile, no rescue and no missing data. ` +
                `Its median headspeed is ${r(D.minHeadspeed, 0)} rpm or more (5/6 of the flight rpm ${J.rpm.value}).`); return null; }
            if (!flightSegments(J, files)) return null;
            runCli(src, J.K.rpm, 'report.cjs', ['/v/out'], files);
        } catch (e) { J.notes.add(`The app did not calculate the gains. The error is "${message(e)}".`); return null; }
        finally { delete self.__bytes; }
        const res = JSON.parse(files.get('/v/out/results.json'), (k, v) => k === 'jack' ? undefined : v); // as report.cjs writes it
        return { decisions: res.decisions || [], groups: res.groups || [], markdown: files.get('/v/out/report.md'), segments: J.segments || [] };
    }

    // Between extract.cjs and report.cjs: J.segments, the extract.cjs segments in short (log, profile with 'arm' as the
    // confirmed PID profile at the start of that log or 0, fromS, seconds in frame time, headspeed median), for evidence.cjs
    // forDecision. report.cjs gets only the segments that the attitude checks could use (SPEC2 D13 correction, A3, D-H4):
    // SEGMENT.inAttitude of its time or more in the runs of the attitude mask (J.attitude: the flight phases less rescue,
    // level modes and failsafe), and in a flight log from a liftoff (- SEGMENT.liftoffS) to the touchdown of that flight +
    // SEGMENT.touchdownS. A
    // bench run gives none. The CLI's view (no phases, no exclusions) keeps every segment. false: no segment is left (a note)
    const SEGMENT = { inAttitude: 0.9, liftoffS: 0, touchdownS: 0.1, source: {
        liftoffS: 'review D-H4 (the user rule): a segment starts at or after the liftoff. On the Gaui X4 dump, the extract.cjs segments of #49 and #50 start 0.12 and 0.57 s before liftoff (the airborne flag sets before it)',
        inAttitude: 'pipeline, unvalidated: an extract.cjs segment is airborne and spooled up, so 90 % of it in the attitude mask keeps the segments of a flight and drops rescue, level modes and a bench run that the airborne flag marks',
        touchdownS: 'review D-H4: segments of Gaui X4 #49, #51 and #58 ran 0.95 to 2.16 s past touchdown, and the touchdown jolt (211-226 deg/s roll) then held 55-68 % of the 8-12 Hz roll energy; 0.1 s is the frame step of the touchdown detector plus margin' } };
    // the frame seconds of sample i of a record through its time map (knots every `every` samples, the last sample at endS)
    function frameAtSample(tm, i) {
        const F = tm.frameS, E = tm.every, last = Math.max(0, tm.n - 1), rate = tm.actualRate, endS = typeof tm.endS === 'number' ? tm.endS : F[F.length - 1];
        if (i <= 0) return F[0] + i / rate;
        if (i >= last) return endS + (i - last) / rate;
        const k = Math.min(F.length - 1, Math.floor(i / E)), a = k * E, b = k + 1 < F.length ? (k + 1) * E : last, sb = k + 1 < F.length ? F[k + 1] : endS;
        return b === a ? F[k] : F[k] + (i - a) / (b - a) * (sb - F[k]);
    }
    // the frame span [t0, t1] of an extract.cjs segment: its first frame (fromS, frame time) and the end of its seconds x rate
    // samples, through the time map of the record that holds it (the frame clock drifts from the sample count)
    function segmentSpan(recs, s) {
        const n = Math.round(s.seconds * (s.rate || 0)), rec = recs.find(l => l.timeMap && l.timeMap.frameS && s.fromS >= l.fromS - 1e-3 && s.fromS <= l.timeMap.endS + 1e-3);
        if (!rec || !(n > 0)) return { t0: s.fromS, t1: s.fromS + s.seconds };
        const tm = rec.timeMap, F = tm.frameS, E = tm.every, last = Math.max(0, tm.n - 1);
        let k = 0; while (k + 1 < F.length && F[k + 1] <= s.fromS) k++;
        const a = k * E, b = k + 1 < F.length ? (k + 1) * E : last, sb = k + 1 < F.length ? F[k + 1] : tm.endS, u = sb > F[k] ? a + (s.fromS - F[k]) / (sb - F[k]) * (b - a) : a;
        return { t0: s.fromS, t1: frameAtSample(tm, u + n) };
    }
    function flightSegments(J, files) {
        const file = '/v/out/segments.json', text = files.get(file);
        if (typeof text !== 'string') return true;
        const S = JSON.parse(text), list = Array.isArray(S.segments) ? S.segments : [], byLog = new Map();
        for (const l of J.records) if (typeof l.log === 'number') (byLog.get(l.log) || byLog.set(l.log, []).get(l.log)).push(l);
        const overlap = (runs, t0, t1) => runs.reduce((a, q) => a + Math.max(0, Math.min(q.t1, t1) - Math.max(q.t0, t0)), 0);
        const keepOf = (s) => { const recs = byLog.get(s.log) || [];
            if (J.selection && !recs.length) return false;   // SPEC3 D: a log that the selection does not have
            if (recs.some(l => l.logClass === 'bench')) return false;
            const flight = recs.some(l => l.logClass === 'flight'), masked = flight || recs.some(l => l.excluded);
            if (!masked) return true; // the CLI's view
            const { t0, t1 } = segmentSpan(recs, s), att = J.attitude.get(s.log) || [];
            if (!(t1 > t0) || overlap(att, t0, t1) < SEGMENT.inAttitude * (t1 - t0)) return false;
            return !flight || recs.some(l => (l.flights || []).some(q => t0 >= q.t0 - SEGMENT.liftoffS - 1e-3 && t1 <= q.t1 + SEGMENT.touchdownS)); };
        const keep = list.filter(s => s && typeof s.fromS === 'number' && typeof s.seconds === 'number' ? keepOf(s) : true);
        const arm = (s) => s.profile === 'arm' ? confirmedArming(J, s.log) || 0 : s.profile;
        J.segments = keep.map(s => ({ log: s.log, profile: arm(s), fromS: s.fromS, seconds: s.seconds, headspeed: { median: s.headspeed ? s.headspeed.median : null } }));
        if (keep.length === list.length) return true;
        J.notes.add(`${list.length - keep.length} of the ${list.length} segments of "extract.cjs" are not in a flight, or they have rescue, a level mode or failsafe. Thus, the app does not use them to calculate the gains.`);
        if (!keep.length) { J.notes.add('The app did not calculate the gains, because no segment of "extract.cjs" is in a flight without rescue, level modes and failsafe.'); return false; }
        files.set(file, JSON.stringify(Object.assign({}, S, { segments: keep })));
        return true;
    }
    // the confirmed PID profile (1-6) at the start of a log, else null (D12: an estimate is not used)
    const confirmedArming = (J, log) => { const a = J.arming.get(log); return a && a.confirmed && a.profile > 0 ? a.profile : null; };

    // logs[].start orders the tuning history (H staleness); a log without a clock date (0000-01-01, no RTC) gets none,
    // so advice treats every header change as possibly later. logBase 1: advice numbers logs as the viewer does.
    const dated = (s) => typeof s === 'string' && /^[1-9]\d{3}-/.test(s) ? s : null;
    // a per-label object of a record (profileSeconds, targetOf) with the label 0 as the confirmed arming profile (D12, A1):
    // the seconds add up, and a target of that profile in the rest of the log stays. Unknown (null): unchanged, 0 is "PID
    // profile unknown"
    function asArming(o, known, add) {
        const out = Object.assign({}, o || {});
        if (known === null || !('0' in out)) return out;
        const v = out['0']; delete out['0'];
        out[known] = add ? r((out[known] || 0) + v, 1) : known in out ? out[known] : v;
        return out;
    }
    // logClass: 'bench' for a bench run, which has no analysis but its D7 (SPEC2 D13); profileSeconds and targetOf with the
    // label 0 as the confirmed arming profile (asArming); startProfile: the label of the modules at the first sample;
    // armingProfile: the confirmed arming profile (armingFinal: 0 unknown, null without data), with its basis, armingEstimate
    // (an inference that is not confirmed), d4: the CLI section of its D4 (sectionOf)
    const logsInput = (J) => J.records.concat(J.errorRecords).map(l => { const a = J.arming.get(l.log), known = confirmedArming(J, l.log);
        return { log: l.log, segment: l.segment, start: dated(l.start), flown: !!l.flown, flyingS: l.flyingS || 0, profileSeconds: asArming(l.profileSeconds, known, true),
            targetOf: asArming(l.targetOf, known, false), excluded: l.excluded || null, skipped: l.skipped || null, startProfile: startProfile(l), armingProfile: a ? a.profile : null, armingBasis: a ? a.basis : [],
            armingConfirmed: !!(a && a.confirmed), armingEstimate: a ? a.estimate : null, logClass: l.logClass || null, d4: J.cliSections.get(l) || null }; });
    function adviseAll(J, findings, decisions) {
        const A = J.K.advice;
        if (!A) return { recommendations: [], coverage: [], notes: ['The toolkit file "advice.cjs" is not available. Thus, the results do not include recommendations.'], script: '' };
        const input = JSON.parse(toJson({ findings, decisions, header: J.adviceHeader, cli: J.cliParsed, cliName: J.cliParsed ? J.o.cliName || null : null, fields: J.fields, headerProfile: J.headerProfile, headerProfileInferred: !!J.headerProfileInferred, headerLog: J.headerLog, logBase: 1, logs: logsInput(J),
            datasets: J.dsOut || null, gear: J.gear || null })); // gear: the notch orders of the log (gearFit), when no CLI dump gives the gear ratios
        try { const a = JSON.parse(toJson(A.advise(input))), recommendations = a.recommendations || [];
            return { recommendations, coverage: a.coverage || [], notes: a.notes || [], script: scriptOf(J, A, recommendations, findings) }; }
        catch (e) { const t = `The app cannot make the recommendations of "advice.cjs". The error is "${message(e)}".`; J.notes.add(t); return { recommendations: [], coverage: [], notes: [t], script: '' }; }
    }
    // The CLI file of the saved report (TuningResult advice.script, SPEC2 C5): advice.exportScript with the default picks and
    // the meta of the export panel (js/tuning_dialog.js exportMeta); '' when no recommendation has CLI text. An advice.cjs
    // without exportScript: its script(recommendations)
    function scriptOf(J, A, recs, findings) {
        if (typeof A.exportScript !== 'function' || typeof A.defaultPicks !== 'function') return typeof A.script === 'function' ? A.script(recs) : '';
        return A.defaultPicks(recs).length ? A.exportScript(recs, null, scriptMeta(J, recs, findings)) : '';
    }
    // as js/tuning_dialog.js exportMeta: craft, file, logs (from 1), flights, firmware (of the analysed header), the PID profiles
    // 1-6 of the analysis, the local date, logBase 1, and the PID profile and rate profile that the CLI dump selects (C7)
    function scriptMeta(J, recs, findings) {
        const h = J.header || {}, d = new Date(), two = (n) => ('0' + n).slice(-2), sel = J.cliSel || { profile: null, rateProfile: null }, ps = new Set();
        for (const f of findings) if (Number.isInteger(f.pidProfile) && f.pidProfile > 0) ps.add(f.pidProfile);
        for (const x of recs) if (Number.isInteger(x.profile) && x.profile > 0 && x.profile <= 6) ps.add(x.profile);
        for (const [k, v] of Object.entries(profilesSummary(J).pid)) if (+k > 0 && v.seconds >= 0.05) ps.add(+k);
        return { craft: h['Craft name'] || null, file: J.fileName || null, logs: J.logs.map(l => String(l + 1)), flights: flightsLine(J), firmware: h['Firmware revision'] || null,
            profiles: [...ps].sort((a, b) => a - b), date: `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`, logBase: 1, activeProfile: sel.profile, activeRateProfile: sel.rateProfile };
    }
    // the flights of each log as js/tuning_dialog.js flightsLine writes them ("Log 50: 15.5 s to 74.2 s. Log 3: Bench run (no analysis)."),
    // null without phases
    const numText = (v) => Number.isInteger(v) || Math.abs(v) >= 1e4 ? String(Math.round(v)) : String(+v.toPrecision(4)); // tuning_dialog.js num
    function flightsLine(J) {
        const all = J.records.concat(J.errorRecords), logs = new Map();
        if (!all.some(l => l.logClass || (Array.isArray(l.phases) && l.phases.length) || (l.flights && l.flights.length) || l.phaseSeconds)) return null;
        for (const l of all) if (typeof l.log === 'number') { const L = logs.get(l.log) || logs.set(l.log, { bench: false, flights: [], data: false }).get(l.log);
            if (l.logClass === 'bench') L.bench = true; if (l.logClass === 'flight') for (const q of l.flights || []) L.flights.push(q); if (!l.skipped || l.logClass) L.data = true; }
        return [...logs].sort((a, b) => a[0] - b[0]).map(([log, L]) => `Log ${log + 1}: ${L.bench ? 'Bench run (no analysis).' : !L.data ? 'No data that the app can read.' : L.flights.length
            ? `${L.flights.slice().sort((a, b) => a.t0 - b.t0).map(q => `${numText(+q.t0.toFixed(1))} s to ${numText(+q.t1.toFixed(1))} s`).join(', ')}.` : 'no flight.'}`).join(' ') || null;
    }

    // The log whose header and field states advice reads (SPEC2 C1, D-H1): never a bench run. Log scope: that log (a bench run:
    // none). File scope: the selected log when it is a flight log, else the last flight log of the file (a note). result.header
    // is the header of that log, else of the selected log (for the display only: the craft name, the firmware). headerProfile:
    // its confirmed arming profile, else 0 (D12)
    function headerOf(J) {
        const sel = J.heads.get(J.logIndex) || null, flights = [...J.heads.values()].filter(h => h.flight && h.header);
        let use = sel && sel.header && !sel.bench && (J.scope === 'log' || sel.flight) ? sel : null;
        if (!use && J.scope === 'file') {
            use = flights.sort((a, b) => b.log - a.log)[0] || null;
            if (use) J.notes.add(`Log ${J.logIndex + 1} is ${sel && sel.bench ? 'a bench run' : 'not a flight log'}. Thus, the recommendations use the log header of log ${use.log + 1}. This is the last flight log in the file.`);
            else J.notes.add('The file has no flight log. Thus, the recommendations do not use a log header.');
        }
        const a = use ? J.arming.get(use.log) : null;
        J.headerLog = use ? use.log : null; J.adviceHeader = use ? use.header : null; J.fields = use ? use.fields : null;
        J.header = use ? use.header : sel ? sel.header : null;
        J.headerProfile = a && a.confirmed ? a.profile : 0; J.headerProfileInferred = !!(a && !a.confirmed && a.estimate);
    }

    // ---------------------------------------------------------------------------------------------
    // The app's fields of a finding: id, STE summary, tuning step, the part of the log that gave it
    // ---------------------------------------------------------------------------------------------

    // Before advice, while the records hold their metrics: fid on every finding first (SPEC2 D4: module|id|log|segment|
    // profile|axis|k, k counting the findings that agree in all the rest), then summary (catalog.cjs), node (hierarchy.cjs)
    // and evidence (evidence.cjs, ctx: the finding's record with metrics, locate and timeMap; the records of every log by log
    // (pooled checks, T4 other, H since); the curves of that record; all findings, for the context spans). The record of a
    // finding: the segment of its first log whose time range holds its first time. A log cut by a logging gap has more than
    // one: findings with no time that agree in all but their segment come in judge order (health_report.cjs sorts them
    // stably), so when they are as many as the segments with metrics of their module, the n-th is of the n-th segment;
    // else the longest segment with those metrics, else the first record of the log
    function annotate(J, findings, ds) {
        const K = J.K, byLog = {}, recs = new Array(findings.length), order = new Map(), count = new Map();
        for (const l of J.records.concat(J.errorRecords)) (byLog[l.log] = byLog[l.log] || []).push(l);
        // the configuration of each finding (round 3 M1): f.dataset ('A', ...) or null; f.datasetLabel, the label of a module that
        // pooled by configuration (f.profile until the evidence is found, then the PID profile label: asPidLabels)
        if (ds) for (const f of findings) {
            if (J.dsMap && relabelOn(J) && DS_MODULES.has(f.module) && Number.isInteger(f.profile) && f.profile >= 0) f.datasetLabel = f.profile;
            const d = datasetOfFinding(J, f, ds); f.dataset = d ? d.id : null;
        }
        findings.forEach((f, i) => {
            const list = byLog[logsOf(f)[0]] || [], t = Array.isArray(f.times) ? f.times[0] : undefined;
            const at = typeof t === 'number' && list.find(l => typeof l.fromS === 'number' && t >= l.fromS - 1e-3 && t <= l.fromS + l.seconds + 0.05);
            if (at) { recs[i] = at; return; }
            const cands = list.filter(l => l.metrics && l.metrics[f.module]);
            recs[i] = cands.slice().sort((a, b) => b.seconds - a.seconds)[0] || list[0] || null;
            if (cands.length < 2) return;
            const key = [f.module, f.id, logsOf(f).join('+'), f.profile ?? '', f.axis ?? '', f.severity].join('|');
            if (!order.has(key)) order.set(key, { cands, items: [] });
            order.get(key).items.push(i);
        });
        for (const { cands, items } of order.values()) if (items.length === cands.length) items.forEach((i, n) => { recs[i] = cands[n]; });
        // fid: module|id|log|segment|profile|axis|k, with the configuration before k when the result has configurations
        // (module|id|log|segment|profile|axis|dataset|k): profile is the PID profile label (0: unknown)
        findings.forEach((f, i) => {
            const shown = f.datasetLabel !== undefined ? (f.datasetLabel > 0 ? pidLabelOf(J, f.datasetLabel) : 0) : f.profile;
            const key = [f.module, f.id, logsOf(f).join('+'), recs[i] ? recs[i].segment : '', shown ?? '', f.axis ?? ''].concat(ds ? [f.dataset || ''] : []).join('|'), k = count.get(key) || 0;
            count.set(key, k + 1); f.fid = `${key}|${k}`; });
        const fail = (what, f, e) => J.notes.add(`The app cannot ${what} of check ${f.id}. The error is "${message(e)}".`);
        const curvesOf = (rec) => rec ? J.curves.find(c => c.log === rec.log && c.segment === rec.segment) || null : null;
        const withPhases = (l) => l.logClass === 'flight' || l.logClass === 'bench', phased = (log) => (byLog[log] || []).some(withPhases), anyPhased = J.records.some(withPhases);
        findings.forEach((f, i) => {
            const logs = logsOf(f);
            f.phase = !(logs.length ? logs.some(phased) : anyPhased) ? null : f.phase !== undefined ? f.phase : headerCheck(K, f.id) ? null
                : f.module === 'gov' ? (GOV_ALL_IDS.has(f.id) ? 'all' : 'ground+flight') : /^G/.test(f.id) || f.id === 'D2' ? 'all' : 'flight';
            f.phases = ALL_PHASE.has(f.module) && f.phase !== null && f.phase !== undefined ? PHASE_USE.all.slice() : ALL_PHASE.has(f.module) && (logs.length ? logs.some(phased) : anyPhased) && f.severity !== 'skipped' ? PHASE_USE.all.slice()
                : f.phase === null || f.phase === undefined ? null : f.phase === 'ground+flight' ? PHASE_USE.tracking.slice() : f.phase === 'all' ? PHASE_USE.all.slice() : [f.phase];
            f.pidProfile = pidProfileOf(J, f);
            if (f.id === 'D4') f.cliSection = recs[i] ? J.cliSections.get(recs[i]) || null : null;
            const rate = f.id === 'R1' ? logs.reduce((n, l) => n + (byLog[l] || []).reduce((m, rec) => m + (rec.profiles ? rec.profiles.rate.length : 0), 0), 0) : 0;
            if (rate) f.rateChanges = rate;
            if (K.hierarchy) try { f.node = K.hierarchy.homeOf(f.id, f.axis ?? null); f.tuner = !!(f.node && typeof K.hierarchy.isBlock === 'function' && K.hierarchy.isBlock(f.node)); } catch (e) { fail('find the tuning step', f, e); }
            if (K.catalog && typeof K.catalog.areaOf === 'function') try { f.area = K.catalog.areaOf(f); } catch (e) { fail('find the subsystem', f, e); }
            if (K.evidence) try { f.evidence = K.evidence.forFinding(f, { record: recs[i], others: byLog, curves: curvesOf(recs[i]), findings }) || null; } catch (e) { fail('find the part of the log', f, e); }
            if (f.datasetLabel !== undefined) asPidLabels(J, f); // after the evidence: it reads the metrics by the label of the module
            // the summary after the evidence: it reads the facts of the metrics (F5 notch axes and prominence, D5 kind, ...),
            // as evidence.summary does, so the two agree (review V5)
            if (K.catalog) try { f.summary = K.catalog.summary(f); } catch (e) { fail('make the summary', f, e); }
        });
    }

    // checks of the log header or of the whole configuration: no phase (catalog.cjs evidence source 'header', else this list)
    const HEADER = new Set(['D1', 'D3', 'D4', 'F1', 'F2', 'F3', 'F4', 'F8', 'F9', 'H', 'SETUP']);
    const headerCheck = (K, id) => { const c = K.catalog && K.catalog.CHECKS && K.catalog.CHECKS[id]; return c && c.evidence && c.evidence.source ? c.evidence.source === 'header' : HEADER.has(id); };
    // D12: the PID profile (1-6) of a finding from its profile label, or null (unknown, or a label that is not a PID profile).
    // The labels (advice.cjs "Profiles"): the log profile (1-based INFLIGHT_ADJUSTMENT value; 0 or 'arm' the profile at the
    // start of the log: the confirmed arming profile of its logs, the same in each of them, else unknown); the CLI index for
    // D4; 'start profile N' for H; an axis name for F4
    const GOV_ALL_IDS = new Set(['D5', 'G13', 'G12']); // the health_gov checks of GOV_ALL: all phases (annotate); the others ground and flight
    function pidProfileOf(J, f) {
        const p = f.profile, logs = logsOf(f), ok = (v) => Number.isInteger(v) && v >= 1 && v <= 6 ? v : null;
        if (f.datasetLabel !== undefined) return f.datasetLabel > 0 ? ok(pidLabelOf(J, f.datasetLabel)) : null; // the PID profile of its configuration
        const start = () => { const a = logs.map(l => confirmedArming(J, l)); return a.length && a.every(x => x !== null && x === a[0]) ? a[0] : null; };
        if (f.id === 'D4') { const a = start(); return a !== null && p === a - 1 ? a : null; } // the CLI section compared, when it is the confirmed profile at the start
        if (typeof p === 'string') { const m = /^start profile (\d+)$/.exec(p); return m ? (+m[1] > 0 ? ok(+m[1]) : start()) : p === 'arm' ? start() : null; }
        if (p === 0) return start();
        return ok(p);
    }

    // report.cjs decisions (C7) as findings for the app, before advice: fid (report|C7||||axis|bin) and evidence (forDecision
    // over the extract.cjs segments)
    function annotateDecisions(J, decisions, segments) {
        const seen = new Set(), E = J.K.evidence;
        for (const d of decisions || []) {
            let fid = `report|C7||||${d.axis ?? ''}|${d.bin ?? ''}`; for (let k = 1; seen.has(fid); k++) fid = `report|C7||||${d.axis ?? ''}|${d.bin ?? ''}.${k}`;
            seen.add(fid); d.fid = fid;
            if (E && typeof E.forDecision === 'function') try { d.evidence = E.forDecision(d, segments) || null; } catch (e) { J.notes.add(`The app cannot find the part of the log of check C7. The error is "${message(e)}".`); }
        }
    }

    // a flag that every recommendation citing it makes information (advice.cjs, for example an F5 line the filters already
    // remove) is explained: the dialog shows it as report-only, with that recommendation's title. An evidence row cites its
    // finding by fid; a row without one (an advice.cjs before fid) by module, id, log, profile and text
    function explain(findings, recs) {
        const text = (f) => `text|${f.module || null}|${f.id}|${JSON.stringify(f.log === undefined ? null : f.log)}|${f.profile === undefined ? null : f.profile}|${f.text}`, by = new Map();
        for (const r of recs) for (const e of r.evidence || []) { const k = e.fid ? `fid|${e.fid}` : text(e); if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
        for (const f of findings) { const rs = f.severity === 'flag' && (by.get(`fid|${f.fid}`) || by.get(text(f))); if (rs && rs.every(r => r.severity === 'info')) f.explained = rs[0].title; }
    }

    // A flag that every recommendation citing it gives as a watch with a cause (a K rule of hierarchy.cjs, for example K22: a
    // FALLBACK at an overload of check G19) is a possible result: f.resultOf = [{ rule, ids }] of those causes, which the catalog
    // summary names and its status shows as "Monitor" (rows cite a finding by fid)
    const RESULT_RULES = /^K2[2-7]$/; // the K rules of the rescue checks and the control limits (hierarchy.cjs K22-K27); the older rules keep their status
    function resultOf(findings, recs) {
        const by = new Map();
        for (const r of recs) for (const e of r.evidence || []) if (e && e.fid) { if (!by.has(e.fid)) by.set(e.fid, []); by.get(e.fid).push(r); }
        for (const f of findings) { const rs = f.severity === 'flag' && f.fid ? by.get(f.fid) : null;
            if (rs && rs.every(r => r.severity === 'watch' && Array.isArray(r.causes) && r.causes.some(c => RESULT_RULES.test(c.rule)))) f.resultOf = rs.flatMap(r => r.causes.filter(c => RESULT_RULES.test(c.rule)).map(c => ({ rule: c.rule, ids: c.ids }))); }
    }

    // What the UI shows of a finding, from catalog.cjs (the classic scripts cannot load it), after explain (status reads
    // explained): status (D9 status key), noun (the STE noun of the check), display { value: the quantity that the rule
    // compares, with its SE, unit and meaning (never a bare count), unit, scale, limit: the STE limit sentence, bound: the
    // limit in the unit of value (review V5, V6: the views show it, never the toolkit threshold), profile: "PID profile N"
    // or "PID profile unknown", phase }. An explained flag gets its summary again (it says why it is information only), on
    // the finding, its evidence and the evidence rows of the recommendations (recs)
    function present(J, findings, recs) {
        const C = J.K.catalog;
        if (!C) return;
        const rows = new Map(); for (const r of recs || []) for (const e of r.evidence || []) if (e && e.fid) { if (!rows.has(e.fid)) rows.set(e.fid, []); rows.get(e.fid).push(e); }
        for (const f of findings) {
            try { if (typeof C.status === 'function') f.status = C.status(f); } catch (e) { J.notes.add(`The app cannot find the condition of the result of check ${f.id}. The error is "${message(e)}".`); }
            const c = C.CHECKS && C.CHECKS[f.id];
            f.noun = c && typeof c.noun === 'string' ? c.noun : null;
            if ((f.explained || f.resultOf) && typeof C.summary === 'function') try { f.summary = C.summary(f); if (f.evidence) f.evidence.summary = f.summary; for (const e of rows.get(f.fid) || []) e.summary = f.summary; } catch (e) { /* the summary of annotate stays */ }
            if (typeof C.display === 'function') {
                try { const d = C.display(f); f.display = { value: d.value ?? null, unit: d.unit ?? null, scale: d.scale ?? null, limit: d.limit ?? null, bound: d.bound ?? null, profile: d.profile ?? null, phase: d.phase ?? null }; }
                catch (e) { J.notes.add(`The app cannot write the values of check ${f.id}. The error is "${message(e)}".`); }
                for (const e of rows.get(f.fid) || []) if (f.display) e.display = { value: f.display.value, bound: f.display.bound, limit: f.display.limit };
                continue;
            }
            if (typeof C.format !== 'function') continue;
            let v = null, limit = null;
            try { v = C.format(f); } catch (e) { J.notes.add(`The app cannot write the values of check ${f.id}. The error is "${message(e)}".`); continue; }
            try { limit = c && typeof c.limit === 'function' && typeof C.rulesOf === 'function' ? c.limit(f, v, C.rulesOf(f, c), (f.evidence && f.evidence.facts) || {}) : null; } // as catalog.summary calls it
            catch (e) { J.notes.add(`The app cannot write the limit of check ${f.id}. The error is "${message(e)}".`); }
            f.display = { value: v.value ?? null, unit: v.unit ?? null, scale: v.scale ?? null, limit: typeof limit === 'string' ? limit : null, profile: v.profile ?? null, phase: v.phase ?? null };
        }
    }

    // round 3 M3: the issues of the Analysis overview (catalog.cjs issues): one for each check and axis over the logs, the PID
    // profiles and the configurations, ranked by status and size; top: the 3 most important; areas: the status of each card
    function issuesOf(J, findings) {
        const C = J.K.catalog, none = { issues: [], top: [], areas: {} };
        if (!C || typeof C.issues !== 'function') return none;
        try { const x = C.issues(findings); return { issues: JSON.parse(toJson(x.issues)), top: x.top.slice(), areas: JSON.parse(toJson(x.areas)) }; }
        catch (e) { J.notes.add(`The app cannot make the list of items for the overview. The error is "${message(e)}".`); return none; }
    }

    // the tuning sequence of the result: a status for each node (hierarchy.cjs), after advice
    function hierarchyOf(J, findings, advice) {
        if (!J.K.hierarchy) return null;
        try { const H = J.K.hierarchy, logs = logsInput(J), out = JSON.parse(toJson(H.status(findings, advice.recommendations, { logs, coverage: advice.coverage })));
            if (out && typeof out === 'object') out.graph = JSON.parse(toJson(typeof H.graph === 'function' ? H.graph() : { nodes: H.NODES || [], edges: H.EDGES || [], rules: H.RULES || [] })); // the diagram (K1: prereq, blocks, edges, rules)
            // round 3: the diagram of each analysed configuration: its findings and those of no configuration (header and global
            // checks), the recommendations that start from it or that it supports, in its PID profile
            if (out && J.dsOut) { out.byDataset = {};
                for (const d of J.dsOut.datasets.filter(x => x.analysed)) {
                    const F = findings.filter(f => !f.dataset || f.dataset === d.id), R = advice.recommendations.filter(r => r.dataset === d.id || (r.supportedBy || []).includes(d.id) || (!r.dataset && !(r.supportedBy || []).length));
                    const st = JSON.parse(toJson(H.status(F, R, { logs, coverage: advice.coverage, profile: d.pidProfile > 0 ? d.pidProfile : 0 })));
                    out.byDataset[d.id] = { pidProfile: d.pidProfile, nodes: st.nodes, startHere: st.startHere, prereqProblems: st.prereqProblems }; } }
            return out; }
        catch (e) { J.notes.add(`The app cannot calculate the tuning sequence. The error is "${message(e)}".`); return null; }
    }

    // ---------------------------------------------------------------------------------------------
    // Values that are possibly not current (CLAUDE.md): the parameter epochs of each log (param_epochs.cjs) and the CLI dump status
    // ---------------------------------------------------------------------------------------------

    // Rotorflight 4.6.0 writes the log header once, when the blackbox starts at the first arm of the log, with the values of the PID
    // profile and the rate profile active then. param_epochs.cjs cuts each analysed log into spans and gives why the header values can
    // be wrong in each one (reasons, in this order: grace, rearm, switched, unlogged, adjusted, resume). The worker keeps the events
    // and the governor request of each analysed log while it decodes it (epochCollect: before a flight selection cuts it), and after
    // every log, when the PID profile at the start of each log is final and advice has run, it makes (freshnessOf):
    //   - result.epochs [{ log, spans: [{ ...span (t0, t1 in frame s, 0.1 ms), source: { pid, rate }, text }] }]: source 'header' (the
    //     header of this log), 'cli' (a CLI dump that agrees with the log: result.cliStatus), 'log N' (the header of log N, 0-based as
    //     records[].log and datasets.cjs sources), 'recovered' (no value, and advice used the gains that report.cjs recovered for that
    //     PID profile), 'adjustment' (the values of the log header, and an in-flight adjustment of a value of that scope) or 'none'
    //     (unknown); text: '' when the span is fresh, else one STE sentence for each reason and the sentences of the source (6 or
    //     less). The worker keeps of span.adjust only the adjustments that can change a value of the span (CLAUDE.md: an adjustment
    //     applies to its parameter): an adjustment of a PID profile value made in another PID profile, or of a rate made in another
    //     rate profile, is left out, and a span with no adjustment left has no reason 'adjusted' (fresh when it has no other reason);
    //   - result.freshness { caveat, reasons: { [reason]: STE text } };
    //   - f.stale of each finding (staleOfFinding), the stale of each period of the limits checks (L1-L7 events): { reasons, text, source,
    //     spans }; r.stale of each recommendation and issues[].stale (staleUnion): { reasons, text, source, findings }; the stale of each
    //     A/B comparison and of each of its results (comparisonStale); r.stale of the recommendations of the filter search (filterTune).
    //     source: the STE sentences of the source of the values (CLAUDE.md: each flag gives the source, or "unknown"), also at the end
    //     of text. Only the causes that can change a value that the check reads count (READS, reasonsFor): a PID profile change for the
    //     values of a PID profile, a rate profile change for the rates, a change of "govRequest" for the values of a PID profile, an
    //     adjustment for its parameter; a later arm, the time after a disarm and a logging pause for all values. The time of a finding
    //     (placesIn, measuredIn): its events (periods, entries: frame seconds tS, t1S, else the module times through the time map of
    //     its record), the spans of its evidence (frame seconds), and the time that it measured: the phases that it used (f.phases,
    //     records[].phases; the record when it has none of them) while armed, cut to the stretches of its configuration (f.dataset),
    //     else in the stretches of its PID profile. The events and the evidence of a result of a label (configuration, PID profile) count
    //     in the stretches of that label only. A disarmed span (grace) counts only for the events and the evidence of a finding.
    // A span with no reason (fresh) is not proven: an MSP write while armed (the Lua script of the transmitter, the Configurator) leaves
    // no record in firmware 4.6.0, and freshness.caveat says so
    const REASONS = ['grace', 'rearm', 'switched', 'unlogged', 'adjusted', 'resume'];
    const FRESH = {
        caveat: 'The log does not record a change that the transmitter or the Configurator makes after the pilot arms the helicopter.',
        reasons: {
            grace: 'After the pilot disarms the helicopter, the log continues for some seconds. The log does not record a change at this time.',
            rearm: 'The pilot armed the helicopter again in the same log. The log header has the values of the first arm only. A change between the arms is not in the log.',
            switched: 'This part of the log uses a PID profile or a rate profile that is not the one at the start of the log. The log header has only the values at the start of the log.',
            unlogged: '"govRequest" changes, and the log records no PID profile change at that time. Thus, the pilot possibly changed a value, and the log does not show the change.',
            adjusted: 'An in-flight adjustment changed a value. The log header has the value before the change.',
            resume: 'The log has a period with no data. The log does not record a change in that period.' },
        // the causes as nouns ("The causes are ... and ..."): f.stale, r.stale, issues[].stale
        cause: { grace: 'the time after a disarm', rearm: 'a second arm in the same log', switched: 'a different PID profile or rate profile',
            unlogged: 'a change of "govRequest"', adjusted: 'an in-flight adjustment', resume: 'a period with no data' },
    };
    // the causes in sentences of 3 causes or less (Rule 6.3: 25 words)
    const causeText = (reasons) => { const c = reasons.map(k => FRESH.cause[k]), a = c.slice(0, 3), b = c.slice(3);
        return `The ${a.length === 1 ? 'cause is' : 'causes are'} ${and(a)}.${b.length ? ` ${b.length === 1 ? 'One more cause is' : 'Other causes are'} ${and(b)}.` : ''}`; };
    const sec1 = (t) => numText(+(+t).toFixed(1)); // a time in a text, s
    // a name in quotation marks in a text: its own double quotes as single quotes (a function, so that no quote is in a template expression)
    const unquote = (v) => String(v).replace(/"/g, "'");
    const logWords = (list) => list.length === 1 ? `log ${list[0] + 1}` : `logs ${and(spans(list.slice().sort((a, b) => a - b).map(l => l + 1)))}`;

    // What each check reads (CLAUDE.md "Values that are possibly not current": use only the causes that can change the value): the
    // parameters (datasets.cjs names, whose scope datasets.cjs scopeOf gives: profile, rate or global; {ax} the axis of the result, the
    // three axes without one; '@global', '@profile', '@rate': a value of that scope that has no name here, as the limits of the mixer).
    // [] : a check of the log itself, which reads no configured value (the log rate, the frame time errors, the recorded fields, the
    // time not used, the flight phases, the header changes between logs, the log header against a CLI dump): no flag. A check that is
    // not here (a module error, a new check) gets every cause. From the checks of the modules: the filter checks read the gyro filters
    // and the RPM notch filters (global), the governor checks gov_* (of a PID profile) and gov_mode, the battery checks the cell
    // voltages, the loop checks the gains of their axis, and the setpoint checks the rates of their axis
    const AX_GAINS = ['{ax}_p_gain', '{ax}_i_gain', '{ax}_d_gain', '{ax}_f_gain', '{ax}_b_gain', '{ax}_o_gain'];
    const YAW_GAINS = AX_GAINS.map(n => n.replace('{ax}', 'yaw'));
    const FILTERS = ['gyro_lpf1_static_hz', 'gyro_lpf2_static_hz', 'gyro_notch1_hz', 'gyro_notch2_hz', 'gyro_rpm_notch_preset', 'gyro_rpm_notch_min_hz', 'dyn_notch_count', 'dyn_notch_min_hz', 'dyn_notch_max_hz', 'dyn_notch_q'];
    const GOV_READS = ['gov_mode', 'gov_headspeed', 'gov_gain', 'gov_p_gain', 'gov_i_gain', 'gov_d_gain', 'gov_f_gain', 'gov_tta_gain', 'gov_max_throttle', 'gov_min_throttle',
        'gov_cyclic_ff_weight', 'gov_collective_ff_weight', 'gov_yaw_ff_weight', 'gov_use_voltage_comp'];
    const SETPOINT = ['{ax}_response', '{ax}_accel_limit', 'setpoint_boost_gain'];
    const VBAT = ['vbat_min_cell_voltage', 'vbat_warning_cell_voltage'];
    const READS = {
        D1: [], D2: [], D3: [], D4: [], D6: [], D7: [], H: [],
        F1: FILTERS, F2: FILTERS, F3: FILTERS, F5: FILTERS, F6: FILTERS, F7: FILTERS, F8: FILTERS, F9: FILTERS, F11: FILTERS, C15: FILTERS,
        F4: ['{ax}_d_cutoff'], F10: AX_GAINS.concat(['{ax}_d_cutoff'], FILTERS), C11: AX_GAINS.concat(['{ax}_d_cutoff'], FILTERS),
        D5: VBAT, G13: VBAT, P1: VBAT, P2: VBAT,
        G0: ['gov_mode'], G1: ['gov_mode', 'motor_poles'], G12: ['motor_poles'], G14: ['gov_mode', 'gov_autorotation_timeout'], G15: ['gov_mode', 'gov_spoolup_time'],
        G16: ['gov_mode', 'gov_handover_throttle'], G17: ['gov_mode', 'gov_spoolup_time'], G18: ['gov_mode', 'gov_idle_throttle'],
        G2: GOV_READS, G3: GOV_READS, G4: GOV_READS, G5: GOV_READS, G6: GOV_READS, G7: GOV_READS, G8: GOV_READS, G9: GOV_READS, G10: GOV_READS.concat(YAW_GAINS), G11: GOV_READS,
        G19: GOV_READS.concat(['rescue_mode', 'rescue_climb_collective', 'rescue_hover_collective']), G20: GOV_READS.concat(['motor_poles']),
        C1: ['{ax}_i_gain', 'error_limit'], L6: ['{ax}_i_gain', 'error_limit', 'offset_limit'], C2: ['@global', 'cyclic_ring'], L3: ['@global', 'cyclic_ring'],
        C3: ['{ax}_f_gain', '{ax}_srate', '{ax}_rc_rate', '{ax}_response'], T9: ['yaw_f_gain', 'yaw_srate', 'yaw_rc_rate', 'yaw_response'],
        C4: AX_GAINS.concat(['{ax}_accel_limit', '{ax}_response']), T5: YAW_GAINS.concat(['yaw_cw_stop_gain', 'yaw_ccw_stop_gain', 'yaw_accel_limit', 'yaw_response']),
        C5: AX_GAINS, C6: AX_GAINS, T1: YAW_GAINS, T2: YAW_GAINS, T4: YAW_GAINS,
        C8: ['cyclic_cross_coupling_gain', 'cyclic_cross_coupling_ratio', 'cyclic_cross_coupling_cutoff'], C9: ['pitch_i_gain', 'pitch_o_gain', 'offset_limit'],
        C10: ['error_decay_time_ground', 'error_decay_time_cyclic', 'error_decay_time_yaw', 'error_decay_limit_cyclic', 'error_decay_limit_yaw'],
        C12: AX_GAINS.concat(SETPOINT), C13: AX_GAINS.concat(SETPOINT), T11: AX_GAINS.concat(SETPOINT), T12: AX_GAINS.concat(SETPOINT), C14: ['pitch_collective_ff_gain'],
        T6: YAW_GAINS.concat(['yaw_collective_ff_gain']), T7: ['yaw_i_gain', 'yaw_collective_ff_gain', 'yaw_precomp_cutoff', 'yaw_inertia_precomp_gain'],
        T8: ['@global'], T13: YAW_GAINS.concat(['@global']), T14: ['yaw_inertia_precomp_gain', 'yaw_inertia_precomp_cutoff'], T15: YAW_GAINS.concat(['rescue_mode']),
        R1: ['@global'].concat(SETPOINT), D8: ['rescue_mode'], D9: ['rescue_mode'],
        L1: ['@global', 'gov_max_throttle', 'gov_min_throttle'], L2: ['@global'], L4: ['@global'], L5: ['@global'], L7: ['collective_rc_rate', 'collective_srate', 'collective_expo'],
        C7: AX_GAINS, 'F:filters': FILTERS, 'F:filters:profile': ['{ax}_gyro_cutoff', '{ax}_d_cutoff'], // C7: report.cjs; F:filters: the filter search (filterStale)
    };
    const AXIS_NAMES = ['roll', 'pitch', 'yaw'];
    const baseName = (n) => String(n).replace(/\[\d+\]$/, '');
    // the scope of a parameter name (datasets.cjs scopeOf), null without datasets.cjs
    const scopeOfName = (J, n) => { const D = J.K && J.K.datasets || J.DS; return D && typeof D.scopeOf === 'function' ? D.scopeOf(n) : null; };
    // { none } | { scopes: Set, names: Set (base names), generic: Set (the scopes of '@' items) } of check id on axis, null: every cause
    function readsOf(J, id, axis) {
        const list = READS[id]; if (!list) return null;
        if (!list.length) return { none: true };
        const axes = AXIS_NAMES.includes(axis) ? [axis] : AXIS_NAMES, scopes = new Set(), names = new Set(), generic = new Set();
        for (const p of list) {
            if (p.charAt(0) === '@') { scopes.add(p.slice(1)); generic.add(p.slice(1)); continue; }
            for (const n of p.includes('{ax}') ? axes.map(ax => p.replace('{ax}', ax)) : [p]) { const s = scopeOfName(J, n); if (s === null) return null; names.add(baseName(n)); scopes.add(s); }
        }
        return { none: false, scopes, names, generic };
    }
    // the reasons of a span (its meta: spanInfo) that can change a value that R reads (readsOf; null: every reason)
    function reasonsFor(meta, R) {
        const s = meta.span;
        if (!R) return s.reasons.slice();
        if (R.none) return [];
        return s.reasons.filter(k => k === 'switched' ? (R.scopes.has('profile') && meta.pidSw) || (R.scopes.has('rate') && meta.rateSw)
            : k === 'unlogged' ? R.scopes.has('profile') // govRequest: the gov_headspeed of the active PID profile
                : k === 'adjusted' ? meta.adj.some(a => a.param ? R.names.has(a.param) || R.generic.has(a.scope) : R.scopes.has(a.scope))
                    : true); // grace, rearm, resume: every value
    }

    // The input of paramEpochs for decoded log li: its epoch events, and the frame seconds and govRequest of its samples, cut to the
    // first and last sample of each run of one govRequest value (requestSteps then gives the same steps, with a few values per run)
    function epochCollect(J, d, li) {
        if (!J.epochIn || J.epochIn.has(li) || d.error) return;
        const live = d.segs.filter(w => !w.skipped && w.n > 0); if (!live.length) return;
        const has = live.some(w => w.extra && w.extra.govRequest), t = [], g = [];
        for (const w of live) { const T = frameTimes(w), G = has && w.extra ? w.extra.govRequest : null, n = w.n;
            for (let i = 0; i < n; i++) if (i === 0 || i === n - 1 || (G && (G[i] !== G[i - 1] || G[i] !== G[i + 1]))) { t.push(T[i]); if (has) g.push(G ? G[i] : 0); } }
        J.epochIn.set(li, { events: d.epochEvents || [], frameS: Float64Array.from(t), govRequest: has ? Float64Array.from(g) : null });
    }

    // what spanInfo needs of one log: the disarms, the logging resumes, the arm starts, the govRequest steps that no adjustment explains
    // (as paramEpochs finds them), the rate profile changes, the configurations of datasets.cjs, the PID profiles of recovered gains, and
    // for each in-flight adjustment its parameter, its scope and the PID profile and the rate profile in which the pilot made it (adjAt)
    function epochCtx(J, li, x, spansOf, PE, recovered, p0) {
        const ev = x.events, t0 = x.frameS[0], adj = ev.filter(e => e.event === PE.EV.INFLIGHT_ADJUSTMENT && e.data), R = PE.RULES;
        const steps = x.govRequest && typeof PE.requestSteps === 'function' ? PE.requestSteps(x.govRequest, x.frameS, R)
            .filter(s => !adj.some(e => e.data.func !== 1 && e.t >= s.t0 - R.blipS && e.t <= s.t1 + R.blipS)) : [];
        const rate = adj.filter(e => e.data.func === 1), r0 = rate.find(e => e.t <= t0), armAt = new Map();
        for (const s of spansOf) if (s.armed && !armAt.has(s.arm)) armAt.set(s.arm, s.t0);
        const DS = J.K && J.K.datasets || J.DS, scope = (func) => DS && DS.ADJUST && typeof DS.scopeOf === 'function' ? (DS.ADJUST[func] ? DS.scopeOf(DS.ADJUST[func][0]) : 'profile') : func >= 5 && func <= 13 ? 'rate' : 'profile';
        const param = (func) => DS && DS.ADJUST && DS.ADJUST[func] ? baseName(DS.ADJUST[func][0]) : null;
        // the PID profile and the rate profile at each adjustment, in the order of the log (0: unknown); a profile event at the first frame
        // gives the profile at the start (param_epochs.cjs atStart)
        // (0: unknown). An unknown PID profile at the start is not the PID profile of the first logged change (a log records only a change):
        // notPid, so an adjustment made before that change does not count for the stretches of that PID profile
        let pid = p0 > 0 ? p0 : 0, rp = 0; const at = new Map(), first = adj.find(e => e.data.func === 2 && e.t > t0), notPid = !(p0 > 0) && first ? first.data.value : 0;
        for (const e of adj) if (e.t <= t0) { if (e.data.func === 2 && !(p0 > 0)) pid = e.data.value; if (e.data.func === 1) rp = e.data.value; }
        for (const e of adj) { const f = e.data.func;
            if (f === 2) { if (e.t > t0) pid = e.data.value; } else if (f === 1) { if (e.t > t0) rp = e.data.value; } else if (f > 2) at.set(`${e.t}|${f}|${e.data.value}`, { pid, rate: rp, notPid: pid ? 0 : notPid }); }
        const adjInfo = (a) => Object.assign({ scope: scope(a.func), param: param(a.func), pid: 0, rate: 0, notPid: 0 }, at.get(`${a.t}|${a.func}|${a.value}`) || {});
        const cli = J.cliParsed && J.cliStatus && J.cliStatus.used ? J.cliParsed : null, st = J.cliStatus;
        // a CLI dump that the log contradicts for PID profile p (its gov_headspeed), or for every log (no section agrees with a header)
        const cliOld = (p) => !!st && (!st.used || st.conflicts.some(x => x.what === 'gov_headspeed' && x.profile === p));
        return { li, steps, armAt, scope, adjInfo, recovered, cliOld, rate0: r0 ? r0.data.value : 0, rateEvents: rate.filter(e => e.t > t0).map(e => ({ t: e.t, value: e.data.value })),
            disarms: ev.filter(e => e.event === PE.EV.DISARM).map(e => e.t), resumes: ev.filter(e => e.event === PE.EV.LOGGING_RESUME).map(e => e.t),
            labels: J.dsFull ? J.dsFull.labels.filter(q => q.log === li) : null,
            cliPid: (p) => !!(cli && cli.profiles && cli.profiles[String(p - 1)]) && !cliOld(p), cliRate: (q) => !!(cli && cli.rateprofiles && cli.rateprofiles[String(q - 1)]) };
    }
    const lastAt = (list, t) => { let v = null; for (const x of list) if (x <= t + 1e-6) v = x; return v; };
    // the source of a datasets.cjs label (labels[].source.profile, .rate) as a span source
    const labelSource = (v) => v === 'header' ? 'header' : v === 'cli' ? 'cli' : typeof v === 'string' && /^log \d+/.test(v) ? /^log \d+/.exec(v)[0] : 'none';
    // The worker's fields of a span of paramEpochs (c: epochCtx, p0: the PID profile at the start of the log, 0: unknown): { reasons,
    // fresh, adjust (the adjustments that can change a value of the span), source, text, meta (for f.stale: reasonsFor, sourceFor) }.
    // The source of a switched PID profile stays when an adjustment also changed one of its values: the adjustment is one more sentence
    function spanInfo(s, c, p0) {
        const startPid = p0 > 0 ? s.pidProfile === p0 : s.pidProfile === 0;
        const rateNow = c.rateEvents.filter(e => e.t <= s.t0 + 1e-6).pop(), rateSwitched = !!rateNow && !(c.rate0 > 0 && rateNow.value === c.rate0);
        // an adjustment changes a value of the PID profile or the rate profile that is active then (or a global value): a span of another
        // profile keeps the values that the adjustment did not change (an unknown profile at the adjustment or in the span: kept)
        const adj = s.adjust.map(a => Object.assign({}, a, c.adjInfo(a))).filter(a => a.scope === 'rate' ? !a.rate || !s.rateProfile || a.rate === s.rateProfile
            : a.scope === 'profile' ? (!a.pid ? !(a.notPid && s.pidProfile === a.notPid) : !s.pidProfile || a.pid === s.pidProfile) : true);
        const reasons = s.reasons.filter(k => k !== 'adjusted' || adj.length), fresh = !reasons.length;
        let lab = null, best = 0; for (const q of c.labels || []) { const ov = Math.min(q.t1, s.t1) - Math.max(q.t0, s.t0); if (ov > best) { best = ov; lab = q; } }
        let pid = 'header', rate = 'header';
        // a label source 'cli' of a CLI dump that the log contradicts (result.cliStatus: not used, or another gov_headspeed): unknown
        if (!startPid) { pid = lab ? labelSource(lab.source && lab.source.profile) : c.cliPid(s.pidProfile) ? 'cli' : 'none'; if (pid === 'cli' && c.cliOld(s.pidProfile)) pid = 'none'; }
        if (pid === 'none' && c.recovered.has(s.pidProfile)) pid = 'recovered';
        if (rateSwitched) { rate = lab ? labelSource(lab.source && lab.source.rate) : c.cliRate(s.rateProfile) ? 'cli' : 'none'; if (rate === 'cli' && c.cliOld(0)) rate = 'none'; }
        if (pid === 'header' && adj.some(a => a.scope === 'profile')) pid = 'adjustment';
        if (rate === 'header' && adj.some(a => a.scope === 'rate')) rate = 'adjustment';
        const source = { pid, rate }, adjust = adj.map(a => ({ t: a.t, func: a.func, name: a.name, value: a.value }));
        const span = Object.assign({}, s, { reasons, fresh, adjust });
        const meta = { c, span, p0, src: source, pidSw: !startPid, rateSw: rateSwitched, adj };
        return { reasons, fresh, adjust, source, text: fresh ? '' : spanText(span, c, source, startPid, rateSwitched).join(' '), meta };
    }
    // the sentences of a span that is not fresh: one for each reason, then the sentences of its source (6 or less: Rule 6.6)
    function spanText(s, c, src, startPid, rateSwitched) {
        const out = [], N = s.pidProfile, Rp = s.rateProfile, p0 = c.p0;
        for (const k of s.reasons) {
            if (k === 'grace') { const d = lastAt(c.disarms, s.t0); out.push(`The pilot disarmed the helicopter at ${sec1(d === null ? s.t0 : d)} s, and the log does not record a change in this part.`); }
            else if (k === 'rearm') out.push(`The pilot armed the helicopter again at ${sec1(c.armAt.has(s.arm) ? c.armAt.get(s.arm) : s.t0)} s, and the log header has the values of the first arm only.`);
            else if (k === 'switched') out.push(!startPid && rateSwitched ? `This part flies PID profile ${N} and rate profile ${Rp}, and the log header has the values at the start of the log.`
                : !startPid ? `This part flies PID profile ${N}, and the log header has the values of ${p0 > 0 ? `PID profile ${p0}` : 'the PID profile at the start of the log'}.`
                : rateSwitched ? `This part uses rate profile ${Rp}, and the log header has the values of the rate profile at the start of the log.` : FRESH.reasons.switched.split('. ')[0] + '.');
            else if (k === 'unlogged') { const st = c.steps.filter(q => q.t1 <= s.t0 + 1e-6).pop();
                out.push(st ? `At ${sec1(st.t1)} s, "govRequest" changes from ${numText(st.from)} rpm to ${numText(st.to)} rpm with no PID profile change in the log.` : FRESH.reasons.unlogged.split('. ')[0] + '.'); }
            else if (k === 'adjusted') { const a = s.adjust, item = (q) => `"${unquote(q.name || `adjustment ${q.func}`)}" to ${numText(q.value)}`;
                out.push(a.length === 1 ? `An in-flight adjustment changed ${item(a[0])} at ${sec1(a[0].t)} s, and the log header has the value before this change.`
                    : a.length === 2 ? `In-flight adjustments changed ${item(a[0])} and ${item(a[1])} from ${sec1(a[0].t)} s, and the log header has the values before these changes.`
                    : `In-flight adjustments changed ${a.length} values from ${sec1(a[0].t)} s, and the log header has the values before these changes.`); }
            else if (k === 'resume') { const t = lastAt(c.resumes, s.t0); out.push(`The log has no data for a period before ${sec1(t === null ? s.t0 : t)} s, and the log does not record a change in that period.`); }
        }
        return out.concat(sourceSentences(c, s, src, s.reasons.includes('adjusted'), Math.max(1, 6 - out.length)));
    }
    // The source of the values of a span (CLAUDE.md: each flag gives the source of the values that the app uses for that part, or
    // "unknown"): the switched PID profile and rate profile, the values that an adjustment changed, then the other values (the header of
    // this log). room: the sentences, 1 or more
    function sourceSentences(c, s, src, adjusted, room) {
        const N = s.pidProfile, Rp = s.rateProfile;
        const phrase = (v, what, p) => v === 'cli' ? `for ${what}, the app uses the values of ${c.cliOld(p) ? 'a CLI dump that does not agree with the log' : 'the CLI dump'}`
            : /^log \d+$/.test(v) ? `for ${what}, the app uses the values of the log header of log ${+v.slice(4) + 1}`
                : v === 'recovered' ? `for ${what}, the app uses the gains that it calculated from the flights` : v === 'none' ? `the values of ${what} are unknown` : null;
        const a = phrase(src.pid, N > 0 ? `PID profile ${N}` : 'the PID profile', N), b = phrase(src.rate, Rp > 0 ? `rate profile ${Rp}` : 'the rate profile', 0);
        const parts = [a, b].filter(Boolean), cap = (t) => t.charAt(0).toUpperCase() + t.slice(1), out = [];
        if (parts.length) out.push(parts.length === 2 ? `${cap(parts[0])}, and ${parts[1]}.` : `${cap(parts[0])}.`);
        if (adjusted) out.push('For the values that an in-flight adjustment changed, the app uses the values of the log.');
        out.push(out.length ? `For the other values, the app uses the log header of log ${c.li + 1}.` : `The app uses the values of the log header of log ${c.li + 1}.`);
        return out.slice(0, Math.max(1, room));
    }
    // the source sentences of a span for a result that reads R (readsOf): the PID profile or the rate profile that it does not read has
    // the values of the header for it, and the adjustment sentence only when an adjustment counts (eff: reasonsFor)
    function sourceFor(meta, R, eff) {
        const src = { pid: R && !R.none && !R.scopes.has('profile') ? 'header' : meta.src.pid, rate: R && !R.none && !R.scopes.has('rate') ? 'header' : meta.src.rate };
        return sourceSentences(meta.c, meta.span, src, eff.includes('adjusted'), 3).join(' ');
    }

    // The frame seconds of a module time t of log li (index time, fromS + i / actualRate), through the time map of its record
    const finite = (v) => typeof v === 'number' && isFinite(v);
    function frameOfIndex(J, li, t) {
        const rec = J.records.find(l => l.log === li && l.timeMap && l.timeMap.frameS && finite(l.fromS) && t >= l.fromS - 1e-3 && t <= l.fromS + (l.seconds || 0) + 0.05);
        if (!rec) return t;
        const E = J.K.evidence;
        if (E && typeof E.toFrame === 'function') try { const v = E.toFrame(rec.timeMap, t); if (finite(v)) return v; } catch (e) { /* the worker's map below */ }
        return frameAtSample(rec.timeMap, (t - rec.timeMap.fromS) * rec.timeMap.actualRate);
    }
    // [[t0, t1]] in frame seconds of a finding in log li: its events (frame seconds tS, t1S; else the module times t0 or t and t1, or t +
    // seconds, through the time map) and the spans of its evidence (evidence.cjs: frame seconds). single: the finding has only this log
    // (an event or a span without a log is of it)
    function placesIn(J, f, li, single) {
        const out = [], mine = (x) => x.log === undefined || x.log === null ? single : x.log === li;
        for (const e of Array.isArray(f.events) ? f.events : []) {
            if (!e || typeof e !== 'object' || !mine(e)) continue;
            const ia = finite(e.t0) ? e.t0 : finite(e.t) ? e.t : null, a = finite(e.tS) ? e.tS : ia !== null ? frameOfIndex(J, li, ia) : null; if (a === null) continue;
            const b = finite(e.t1S) ? e.t1S : finite(e.t1) ? frameOfIndex(J, li, e.t1) : finite(e.seconds) && e.seconds > 0 ? a + e.seconds : a; out.push([a, Math.max(a, b)]); }
        const ev = f.evidence && typeof f.evidence === 'object' ? f.evidence : null;
        for (const q of ev && Array.isArray(ev.spans) ? ev.spans : []) if (q && finite(q.t0) && finite(q.t1) && mine(q)) out.push([q.t0, Math.max(q.t0, q.t1)]);
        return out;
    }
    // the time that a finding measured in log li: the phases of f.phases of its records (the whole record when it has none of them, or
    // no phases), cut to the stretches of its configuration in this log (f.dataset: the labels of datasets.cjs) when it has one
    function measuredIn(J, f, li) {
        const recs = J.records.filter(l => l.log === li && !l.skipped && finite(l.fromS)), out = [], use = Array.isArray(f.phases) && f.phases.length ? new Set(f.phases) : null;
        for (const l of recs) {
            const ph = use && Array.isArray(l.phases) ? l.phases.filter(q => use.has(q.phase) && finite(q.t0) && finite(q.t1)).map(q => [q.t0, q.t1]) : [];
            if (ph.length) out.push(...ph); else out.push([l.fromS, l.timeMap && finite(l.timeMap.endS) ? l.timeMap.endS : l.fromS + (l.seconds || 0)]);
        }
        return cutTo(out, stretchesOf(J, f, li));
    }
    // the stretches of the configuration of a finding in log li ([[t0, t1]] of the labels of datasets.cjs), null without one (or when the
    // configuration has no stretch in this log)
    function stretchesOf(J, f, li) {
        const st = f.dataset && J.dsFull ? J.dsFull.labels.filter(q => q.log === li && q.dataset === f.dataset && finite(q.t0) && finite(q.t1)).map(q => [q.t0, q.t1]) : [];
        return st.length ? st : null;
    }
    // ranges (a time: [t, t]) cut to the stretches st (null: unchanged)
    function cutTo(ranges, st) {
        if (!st) return ranges;
        const out = [];
        for (const [a, b] of ranges) for (const [p, q] of st) { if (b > a) { const x = Math.max(a, p), y = Math.min(b, q); if (y > x) out.push([x, y]); } else if (a >= p && a < q) out.push([a, a]); }
        return out;
    }
    // the spans of E (a log of J.epochs) that are not fresh and that the ranges touch: [{ log, span, ov (s of overlap) }]; keep: a
    // filter of the spans (null: all)
    function touched(E, li, ranges, keep) {
        const out = [], last = E.spans[E.spans.length - 1];
        for (const s of E.spans) {
            if (s.fresh || (keep && !keep(s))) continue;
            let ov = 0, hit = false;
            for (const [a, b] of ranges) { if (b > a) { const o = Math.min(b, s.t1) - Math.max(a, s.t0); if (o > 0) { ov += o; hit = true; } } else if (a >= s.t0 && (a < s.t1 || s === last)) hit = true; } // a time: [t0, t1)
            if (hit) out.push({ log: li, span: s, ov });
        }
        return out;
    }
    // hits of the same span as one (the overlaps added)
    function mergeHits(list) {
        const by = new Map(); for (const h of list) { const x = by.get(h.span); if (x) x.ov += h.ov; else by.set(h.span, Object.assign({}, h)); }
        return [...by.values()];
    }
    // the source sentences of a list of parts, the largest first (CLAUDE.md: each flag gives the source of the values, or "unknown"): the
    // first source, and "Other parts have other sources." when they are not the same
    const sourceOf = (list, other) => { const u = [...new Set(list.filter(Boolean))]; return u.length ? u[0] + (u.length > 1 ? ` ${other}` : '') : ''; };
    const STALE_LEAD = { result: 'This result uses a part of the log in which the values are possibly not the values of the log header.',
        period: 'This period is in a part of the log in which the values are possibly not the values of the log header.',
        recommendation: 'This recommendation uses a part of the log in which the values are possibly not the values of the log header.' };
    // { reasons, text, source, spans: [{ log, t0, t1 }] (3 or less, the largest overlap first) } of the touched spans, or null. what:
    // 'result' (a finding), 'period' (a period of a limits check) or 'recommendation' (the filter search). R: what the check reads
    // (readsOf; null: every cause): a span counts with the reasons that can change a value that it reads
    function staleFrom(J, hits, what, R) {
        const items = mergeHits(hits).map(h => { const meta = J.spanMeta.get(h.span); return { h, meta, eff: meta ? reasonsFor(meta, R) : h.span.reasons.slice() }; }).filter(x => x.eff.length);
        if (!items.length) return null;
        const reasons = REASONS.filter(k => items.some(x => x.eff.includes(k))), byOv = items.sort((a, b) => b.h.ov - a.h.ov);
        const source = sourceOf(byOv.map(x => x.meta ? sourceFor(x.meta, R, x.eff) : ''), 'Other parts have other sources.');
        const text = [STALE_LEAD[what] || STALE_LEAD.result, causeText(reasons)].concat(source ? [source] : []).join(' ');
        return { reasons, text, source, spans: byOv.slice(0, 3).map(x => ({ log: x.h.log, t0: x.h.span.t0, t1: x.h.span.t1 })) };
    }
    // f.stale: the spans that the finding's time touches in each of its logs (its events and evidence, and the time that it measured in
    // the stretches of its configuration, else of its PID profile, while armed), with the reasons that can change a value that its check
    // reads. A check of the log itself (READS []) uses no configured value that can change in a log: null
    function staleOfFinding(J, f) {
        const R = readsOf(J, f.id, f.axis);
        if (R && R.none) return null;
        const all = logsOf(f), logs = all.filter(l => J.epochs.has(l)), single = all.length === 1, hits = [], cfg = !!(f.dataset && J.dsFull);
        for (const li of logs) {
            const E = J.epochs.get(li);
            const p = Number.isInteger(f.pidProfile) && f.pidProfile > 0 ? f.pidProfile : f.profile === 0 || f.profile === 'arm' ? (E.p0 || 0) : null; // the stretches of its PID profile
            // a module that pools by a label (configuration, PID profile) uses only the samples of that label: its events and evidence spans
            // (a block or a window that starts or ends in another stretch) count in its stretches only. A result of no label: all of them
            const mine = (s) => cfg || p === null || s.pidProfile === p;
            hits.push(...touched(E, li, cutTo(placesIn(J, f, li, single), cfg ? stretchesOf(J, f, li) : null), mine));
            hits.push(...touched(E, li, measuredIn(J, f, li), (s) => s.armed && mine(s)));
        }
        return staleFrom(J, hits, 'result', R);
    }
    // the stale of each period of a limits check (L1-L7: f.events, frame seconds tS, t1S)
    function staleEvents(J, f) {
        if (f.module !== 'limits' || !Array.isArray(f.events)) return;
        const li = Array.isArray(f.log) ? f.log[0] : f.log, E = J.epochs ? J.epochs.get(li) : null, R = readsOf(J, f.id, f.axis);
        for (const e of f.events) if (e && typeof e === 'object') { const a = finite(e.tS) ? e.tS : finite(e.t) ? frameOfIndex(J, li, e.t) : null, b = finite(e.t1S) ? e.t1S : finite(e.t1) ? frameOfIndex(J, li, e.t1) : a;
            e.stale = E && finite(a) && !(R && R.none) ? staleFrom(J, touched(E, li, [[a, Math.max(a, b)]], null), 'period', R) : null; }
    }
    // a report.cjs decision (C7): the spans of its evidence (the extract.cjs segments), with the gains of its axis
    function staleOfDecision(J, d) {
        const sp = d.evidence && Array.isArray(d.evidence.spans) ? d.evidence.spans : [], hits = [];
        for (const q of sp) { const E = q && J.epochs.get(q.log); if (E && finite(q.t0) && finite(q.t1)) hits.push(...touched(E, q.log, [[q.t0, q.t1]], (s) => s.armed)); }
        return staleFrom(J, hits, 'result', readsOf(J, 'C7', d.axis));
    }
    // r.stale, issues[].stale: { reasons, text, findings (how many of its results have stale) } over the results it cites, or null
    function staleUnion(list, what) {
        const hit = list.filter(x => x && x.stale), n = hit.length; if (!n) return null;
        const reasons = REASONS.filter(k => hit.some(x => x.stale.reasons.includes(k))), source = sourceOf(hit.map(x => x.stale.source), 'Other results have other sources.');
        return { reasons, findings: n, source, text: `${n === 1 ? '1 result' : `${n} results`} of this ${what} ${n === 1 ? 'uses' : 'use'} a part of the log in which the values are possibly not the values of the log header. ` +
            causeText(reasons) + (source ? ` ${source}` : '') };
    }
    // The A/B comparisons of the configurations (advice.cjs comparisons, result.datasets.comparisons): the stale of each result (the union
    // over the findings of its check and axis in the two configurations) and of each comparison (over all its results)
    function comparisonStale(J, findings) {
        const list = J.dsOut && Array.isArray(J.dsOut.comparisons) ? J.dsOut.comparisons : [];
        for (const c of list) {
            const all = [];
            for (const x of Array.isArray(c.results) ? c.results : []) {
                const fs = findings.filter(f => f.id === x.check && (f.dataset === c.a || f.dataset === c.b) && (x.axis === null || x.axis === undefined || f.axis === x.axis));
                x.stale = J.epochs.size ? staleUnion(fs, 'pair') : null; // 'pair' (of configurations): STE has no noun "comparison"
                for (const f of fs) if (!all.includes(f)) all.push(f);
            }
            c.stale = J.epochs.size ? staleUnion(all, 'pair') : null;
        }
    }

    // The spans of one log for the stale (J.epochs, J.spanMeta): paramEpochs with the PID profile at the start (p0), then the worker's fields
    // of each span (spanInfo). null when paramEpochs stops (a note)
    function epochsOfLog(J, PE, li, p0, recovered) {
        const x = J.epochIn.get(li);
        let list;
        try { list = PE.paramEpochs({ events: x.events, frameS: x.frameS, govRequest: x.govRequest, profileAtStart: p0 }); }
        catch (e) { J.notes.add(`The function "paramEpochs" of "param_epochs.cjs" stopped. The error is "${message(e)}". Thus, the app does not show the parts of the log in which the values are possibly not the values of the log header.`, li); return null; }
        const c = Object.assign(epochCtx(J, li, x, list, PE, recovered, p0), { p0 });
        const spans = list.map(s => { const info = spanInfo(s, c, p0), meta = info.meta;
            const o = Object.assign({}, s, { t0: r(s.t0, 4), t1: r(s.t1, 4), reasons: info.reasons, fresh: info.fresh, adjust: info.adjust.map(a => Object.assign({}, a, { t: r(a.t, 4) })), source: info.source, text: info.text });
            J.spanMeta.set(o, meta); return o; });
        J.epochs.set(li, { p0, spans });
        return spans;
    }
    // result.epochs and result.freshness; f.stale, the stale of the limits periods, d.stale of the decisions and r.stale. Without
    // param_epochs.cjs (a note of kit) or without the events: epochs and freshness null, every stale null
    function freshnessOf(J, findings, decisions, recs) {
        const PE = J.K.epochs, out = [];
        J.epochs = new Map(); J.spanMeta = new Map(); // span -> what its stale needs (spanInfo meta)
        if (PE && typeof PE.paramEpochs === 'function' && J.epochIn) {
            const recovered = new Set(recs.filter(x => x.base && x.base.approx && Number.isInteger(x.profile)).map(x => x.profile));
            for (const li of [...J.epochIn.keys()].sort((a, b) => a - b)) { const spans = epochsOfLog(J, PE, li, confirmedArming(J, li) || 0, recovered); if (spans) out.push({ log: li, spans }); }
        }
        const on = J.epochs.size > 0;
        for (const f of findings) { f.stale = on ? staleOfFinding(J, f) : null; if (on) staleEvents(J, f); else if (f.module === 'limits' && Array.isArray(f.events)) for (const e of f.events) if (e && typeof e === 'object') e.stale = null; }
        for (const d of decisions || []) d.stale = on ? staleOfDecision(J, d) : null;
        const byFid = new Map(findings.concat(decisions || []).filter(f => f.fid).map(f => [f.fid, f]));
        for (const x of recs) x.stale = on ? staleUnion((x.evidence || []).map(e => e && e.fid ? byFid.get(e.fid) : null), 'recommendation') : null;
        J.byFid = byFid;
        comparisonStale(J, findings);
        return on ? { epochs: out, freshness: { caveat: FRESH.caveat, reasons: Object.assign({}, FRESH.reasons) } } : { epochs: null, freshness: null };
    }

    // result.cliStatus: null without a CLI dump, else { name, used (the header of an analysed flight log agrees with a section of the
    // dump; false when the app cannot read it), conflicts: [{ what: 'gov_headspeed' | 'header' | 'profile', text (STE), ... }] }. The log
    // wins (user rule "No access to the flight controller"): a gov_headspeed that the logged PID profile changes contradict is not used,
    // and a dump that disagrees with the log header never makes a PID profile that the log confirms unknown (armingFinal)
    // the D12 cores of the analysed logs that are not bench runs (bench: a Set of logs), in log order
    const coresOf = (J, bench) => [...(J.armCore || new Map())].filter(([li, c]) => c && J.logs.includes(li) && !bench.has(li)).sort((a, b) => a[0] - b[0]);
    // what the log says of a CLI dump: { M (hsMap), gh (its gov_headspeed of each PID profile), stale (the PID profiles whose gov_headspeed
    // the logged changes contradict), used (the header of an analysed flight log agrees with a section of the dump) }
    function cliCheck(J, cores) {
        const M = J.hsLogs && J.hsLogs.size ? hsMap(J) : null, any = cores.find(([, c]) => c.gh), gh = any ? any[1].gh : null, stale = staleHeadspeeds(gh, M);
        const used = !!J.cliParsed && (cores.some(([, c]) => c.d4 && c.d4.agree.length) || (!cores.some(([, c]) => c.d4) && !stale.length));
        return { M, gh, stale, used };
    }
    // The CLI dump that datasets.cjs gets (J.dsCli, from J.dsCliFull): the log wins, so the dump gives no section that the log contradicts.
    // A dump that no analysed log header agrees with (result.cliStatus used false) gives no section of a PID profile or of a rate profile,
    // and a gov_headspeed conflict removes the section of that PID profile. Then datasets() runs again (J.dsDirty). bench: the bench runs
    function dsCliFilter(J, bench) {
        if (!J.dsCliFull || !J.cliText) return;
        const { stale, used } = cliCheck(J, coresOf(J, bench)), key = `${used}|${stale.join(',')}`;
        if (J.dsCliKey === key) return;
        J.dsCliKey = key;
        const F = J.dsCliFull, c = Object.assign({}, F, { profiles: used ? Object.assign({}, F.profiles) : {}, rateprofiles: used ? Object.assign({}, F.rateprofiles) : {} });
        for (const q of stale) delete c.profiles[String(q - 1)];
        J.dsCli = c; J.dsDirty = true;
    }
    // the bench runs of the inputs of datasets.cjs (flights [] : no flight), before the records have their class
    const dsBench = (J) => new Set([...(J.dsInputs || new Map())].filter(([, x]) => x && Array.isArray(x.flights) && !x.flights.length).map(([li]) => li));
    function cliStatusOf(J) {
        if (!J.cliText) return null;
        const name = J.o.cliName || null, conflicts = [];
        const bench = new Set(J.records.filter(l => l.logClass === 'bench').map(l => l.log)); // a bench run: not analysed
        const cores = coresOf(J, bench), { M, gh, stale, used } = cliCheck(J, cores);
        for (const q of stale) conflicts.push({ what: 'gov_headspeed', profile: q, cli: gh[q], log: [].concat(M.table[q]),
            text: `In the CLI dump, \`gov_headspeed\` of \`profile ${q - 1}\` is ${gh[q]}. The PID profile changes in ${mapScope(J)} show ${rpmText([].concat(M.table[q]))} for PID profile ${q}. The app uses the values of the log.` });
        const none = [], other = new Map();
        for (const [li, c] of cores) { if (!c.d4) continue; const a = J.arming.get(li);
            if (!c.d4.agree.length) none.push(li);
            else if (!c.done && a && a.confirmed && a.basis.includes('headspeed') && !c.cliCands.includes(a.profile)) {
                const k = `${a.profile}|${c.d4.agree.join(',')}`; (other.get(k) || other.set(k, { p: a.profile, agree: c.d4.agree, logs: [] }).get(k)).logs.push(li); } }
        if (none.length) conflicts.push({ what: 'header', logs: none, text: `No section of the CLI dump agrees with the log header of ${logWords(none)}.` });
        for (const { p, agree, logs } of other.values()) conflicts.push({ what: 'profile', profile: p, sections: agree.slice(), logs,
            text: `The log header of ${logWords(logs)} agrees with the CLI ${agree.length > 1 ? 'sections' : 'section'} ${and(agree.map(q => `\`profile ${q - 1}\``))}. But "govRequest" at the start of the log shows PID profile ${p}. The app uses PID profile ${p}.` });
        if (conflicts.length) J.notes.add(`The CLI dump${name ? ` "${unquote(name)}"` : ''} does not agree with the log. The app uses the values of the log.`);
        return { name, used, conflicts };
    }

    // ---------------------------------------------------------------------------------------------
    // Jobs
    // ---------------------------------------------------------------------------------------------

    function notesList() { // a note per text, with the logs it applies to, numbered from 1 as the viewer shows them
        const m = new Map();
        return { add(text, log) { if (!m.has(text)) m.set(text, []); if (typeof log === 'number' && !m.get(text).includes(log)) m.get(text).push(log); },
            list: () => [...m].map(([t, logs]) => logs.length ? `${t.replace(/\.$/, '')} (log${logs.length > 1 ? 's' : ''} ${and(logs.map(l => String(l + 1)))}).` : t) };
    }

    const CANCELED = 'You canceled the analysis.';
    const cancelled = new Set();
    const checkpoint = (id) => new Promise(resolve => setTimeout(resolve, 0)).then(() => { if (cancelled.has(id)) throw new Error(CANCELED); });

    async function begin(msg, post, scope) {
        const o = Object.assign({ flightRpm: null, cliText: null, cliName: null, excludeAbnormal: true, phases: true, curves: true, gains: false, keepMetrics: false }, msg.options || {});
        if (!(typeof o.flightRpm === 'number' && o.flightRpm > 0 && isFinite(o.flightRpm))) o.flightRpm = null;
        if (!msg.bytes) throw new Error('The command has no log data.');
        const J = { id: msg.id, o, scope, fileName: basename(msg.fileName || 'log.bbl'), t0: Date.now(), ms: { decode: 0, analyse: 0, judge: 0, gains: 0 }, fraction: 0,
            notes: notesList(), records: [], errorRecords: [], curves: [], segCount: new Map(), header: null, fields: null, headerProfile: null, cliText: o.cliText || null, cliParsed: null,
            arming: new Map(), segments: null, heads: new Map(), headerLog: null, adviceHeader: null, cliSel: { profile: null, rateProfile: null },
            vib: [], flightAt: new Map(), cliSections: new Map(), attitude: new Map(), hsLogs: new Map(), hsMapOut: null, armCore: new Map(), armFixed: new Set(), // hsLogs, armCore, armFixed: D12 (hsInfo, armingCore, armWhole)
            epochIn: new Map(), epochs: new Map(), cliStatus: null, dsFull: null }; // epochIn: the input of paramEpochs of each analysed log (epochCollect)
        J.progress = (text, stage = 'analyse', fraction = null) => { if (fraction !== null) J.fraction = fraction; post({ id: J.id, type: 'progress', stage, fraction: r(J.fraction, 3), text }); };
        J.progress('The app loads the toolkit.', 'load', 0.01);
        J.src = await sources();
        J.bytes = ArrayBuffer.isView(msg.bytes) ? new Uint8Array(msg.bytes.buffer, msg.bytes.byteOffset, msg.bytes.byteLength) : new Uint8Array(msg.bytes);
        // the configurations (round 3 M1): datasets.cjs, and the CLI dump read early (the first pass needs its PID profile sections)
        const K0 = kit(J.src, null);
        J.DS = K0.datasets || null; J.dsInputs = new Map(); J.dsDirty = true; J.ds = null; J.dsMap = null; J.dsReg = { byKey: new Map(), info: new Map(), spans: new Map() };
        if (J.cliText) { try { J.cliParsed = K0.core.setup.parseCli(J.cliText); } catch (e) { J.cliParsed = null; } // settle notes an error
            try { J.dsCli = J.DS ? J.DS.parseCli(J.cliText) : null; } catch (e) { J.dsCli = null; }
            J.dsCliFull = J.dsCli; J.dsCliKey = null; } // dsCliFilter: the sections that the log does not contradict
        return J;
    }

    // the flight rpm (user, or auto from the evidence) and its modules; parses the CLI dump with them. why: the reason of a
    // default (rpmWhy)
    function settle(J, rpm, why) {
        J.rpm = rpm; J.K = kit(J.src, rpm.source === 'default' ? null : rpm.value);
        for (const t of J.K.notes) J.notes.add(t);
        if (J.o.excludeAbnormal && !J.K.more) J.notes.add('The analysis includes the periods of rescue, level modes, failsafe and ground contact, because "health_more.cjs" is missing.' +
            (J.K.track ? ' The checks of "health_track.cjs" do not use the rescue periods that RESCUE_STATE shows. The configuration, governor and loop checks use them.' : ''));
        if (rpm.source === 'default') J.notes.add(`The flight rpm is ${rpm.value}. This is the value that the toolkit uses when it cannot calculate the flight rpm. ${why} ` +
            'The app finds the flight time from AIRBORNE_STATE. If the log does not record AIRBORNE_STATE, the app uses the time with the governor in the ACTIVE mode. ' +
            'If the rotor turns more slowly in flight, you can set a flight rpm that is less than the lowest governor target.');
        if (J.cliText) try { J.cliParsed = J.K.core.setup.parseCli(J.cliText); J.cliSel = selectionOf(J.cliText, J.cliParsed); } catch (e) { J.notes.add(`The app cannot read the CLI dump. The error is "${message(e)}".`); }
    }

    const userRpm = (J) => J.o.flightRpm ? { value: J.o.flightRpm, source: 'user', basis: null, profile: null, seconds: null, logs: [] } : null;
    const basisKind = { govTarget: 'governor target', headspeed: 'headspeed' };

    // file scope, auto: the evidence of every log (decoded with only govTarget as an extra column), so the flight rpm is the
    // file's, whichever log is on screen
    // The flight rpm evidence of one decoded log (K: the toolkit default rpm), from the flight phases where health_phase.cjs
    // gives them (phased: a bench run gives none), and from the airborne time (plain, rpmEvidence without masks). The phase
    // detector needs a flight rpm (health_phase: the flight headspeed share of a flight), and the file's is not known yet:
    // it gets the log's own, from its airborne time (autoRpm of plain alone; the toolkit default without one). With want (the
    // configurations, round 3 M1) also the segments prepared (preps: the governor targets at that rpm, the CLI context, the phases
    // when the app has them) and the class of the log (cls), for dsInput
    function logEvidence(J, K, segs, li, want) {
        const plain = rpmEvidence(segs, li), usePh = phasesOn(J, K);
        if (!usePh && !want) return { plain, phased: null };
        const rule = K.health.RULE.flight, own = autoRpm([plain], K.lib.FLIGHT_RPM, rule), airborneEvents = segs.some(w => !w.skipped && w.airborneAt.some(v => !v));
        const preps = segs.map(w => w.skipped ? null : prepare(K, w, { segment: 0, cli: J.cliText, cliParsed: J.cliParsed, phases: usePh, airborneEvents, flightRule: Object.assign({}, rule, { headspeed: own.value }), labelRpm: own.value }, J));
        const live = preps.filter(Boolean), cls = usePh ? classOf(live.map(p => p.ph)) : null;
        if (!usePh || cls === null) return { plain, phased: null, preps: live, cls };
        return { plain, phased: rpmEvidence(segs, li, segs.map((w, k) => preps[k] && preps[k].ph && preps[k].ph.flight ? preps[k].ph.mask : null)), preps: live, cls };
    }
    // the auto flight rpm of the evidence: from the flight phases; when they show no flight but the airborne time gives a
    // flight rpm (a detector that needs the flight rpm sees no flight at the toolkit default), from the airborne time, and a note
    function chooseRpm(J, list, fallback, rule) {
        const ev = list.map(x => x.phased || x.plain), rpm = autoRpm(ev, fallback, rule);
        if (rpm.source !== 'default' || !list.some(x => x.phased)) return { rpm, evidence: ev };
        const plain = list.map(x => x.plain), alt = autoRpm(plain, fallback, rule);
        if (alt.source === 'default') return { rpm, evidence: ev };
        J.notes.add('At the default flight rpm, the flight phases of "health_phase.cjs" show no flight. Thus, the app calculates the flight rpm from the airborne time.');
        return { rpm: alt, evidence: plain };
    }
    const rpmExtra = (J, K) => ['govTarget', 'govRequest'].concat(phasesOn(J, K) && Array.isArray(K.phase.EXTRA) ? K.phase.EXTRA.filter(k => k !== 'govTarget' && k !== 'govRequest') : [], // govRequest: the headspeed of each PID profile (hsInfo)
        J.gearAcc ? GEAR_EXTRA.concat(GEAR_MASK_EXTRA) : []); // gyroRAW: the notch orders (gearAdd), with the columns of its mask (health_more normalMask)

    // ---------------------------------------------------------------------------------------------
    // The orders of the RPM notch filters that follow a gear ratio, from the log (no CLI dump)
    // ---------------------------------------------------------------------------------------------

    // The log header has no gear ratio (blackbox.c writes none). Without one, the frequency of the tail rotor notch filters
    // (sources 21-28, at h x T x the rotor frequency) and of the main motor notch filter (source 10, at M x the rotor frequency) is
    // unknown to health_setup (F5 coverage, F6 attenuation, F8, F9: rpmBanks through gearOf(ctx)), to health_more (the notch
    // markers of the vibration curves, which the Tuning view and the log lens draw) and to advice.cjs (F5: is a line a tail rotor
    // harmonic). filter_tune.cjs tailOrder finds T and M from the dip that each of these firmware notches leaves in
    // |gyroADC / gyroRAW|: the configured values that the firmware uses, not the mechanics (CLAUDE.md "Gear ratios"). The worker
    // runs it (gearPlan) when no CLI dump is loaded (a dump gives the gear ratios, a diff its absent keys as the default 1,1:
    // health_setup gearOf), not in the CLI's view (health.cjs has no fit: parity) and not with options.logGear false:
    //   - file scope: in the first pass (analyseFile runs one for it), on each flight log that the pass reads, one log at a time
    //     (tailOrderAdd keeps the sums of the spectra, not the samples), then tailOrderFit before the main pass;
    //   - log scope: on the log, in addLog before its checks.
    // The mask: the flight phases of the log less rescue, level modes and failsafe (health_more normalMask, as the filter search), else the
    // health.cjs flight mask.
    // A fit that passes (J.gear: tailOrder().gear, basis 'log notch', motorisedTail null when the tail fit did not pass) is
    // ctx.gear of every segment and the gear of advice. A fit that does not pass changes nothing, and a note gives its cause from
    // the log. result.notchFit: the fit (notchFitOut), null when it did not run
    const GEAR_EXTRA = ['gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]'], GEAR_MASK_EXTRA = ['flightModeFlags', 'failsafePhase'];
    function gearPlan(J) {
        J.gearAcc = null; J.tailFit = null; J.gear = null; J.gearLogs = [];
        const K0 = kit(J.src, null);
        if (J.o.logGear === false || J.cliParsed || J.cliText || (!phasesOn(J, K0) && J.o.excludeAbnormal === false)) return;
        let FT = null;
        try { FT = K0.require('./filter_tune.cjs'); } catch (e) { J.notes.add(`The app cannot load the toolkit file "filter_tune.cjs". The error is "${message(e)}". Thus, the app does not find the frequency of the tail rotor notch filters in the log.`); return; }
        if (typeof FT.tailOrderStart !== 'function' || typeof FT.tailOrderAdd !== 'function' || typeof FT.tailOrderFit !== 'function') return;
        J.gearAcc = { FT, acc: FT.tailOrderStart() };
    }
    // the flight logs of one decode (the preps of its segments, cls: its class, K: the kit of the preps) into the fit. The mask: the flight
    // phases less rescue, level modes and failsafe (health_more normalMask, as the filter search: filterTune), the filter checks of
    // CLAUDE.md; without health_more (or when it stops: a note) the flight phases less rescue
    function gearAdd(J, preps, cls, li, K) {
        if (!J.gearAcc || J.tailFit || cls === 'bench') return;
        const items = [], more = K && K.more;
        for (const p of preps) {
            if (!p || !p.ctx || p.w.skipped || !GEAR_EXTRA.every(k => p.w.extra && p.w.extra[k])) continue;
            const base = p.ph ? (p.ph.flight ? p.ph.mask : null) : p.flown ? p.flying : null; if (!base) continue;
            let mask = null;
            if (more) try { mask = more.normalMask(p.w, Object.assign({}, p.ctx, { flying: base }, p.ph ? { phases: p.ph.P, flightMask: base } : { phases: false })).mask; }
                catch (e) { J.notes.add(`The function "normalMask" of "health_more.cjs" stopped. The error is "${message(e)}". Thus, the frequency of the tail rotor notch filters comes from all of the flight phase.`, li); }
            if (!mask) { mask = Uint8Array.from(base); const rs = p.w.rescueAt; if (rs) for (let i = 0; i < mask.length; i++) if (rs[i]) mask[i] = 0; }
            items.push({ w: p.w, mask, flight: true });
        }
        if (!items.length) return;
        try { if (J.gearAcc.FT.tailOrderAdd(J.gearAcc.acc, items, {})) J.gearLogs.push(li); }
        catch (e) { J.notes.add(`The function "tailOrderAdd" of "filter_tune.cjs" stopped. The error is "${message(e)}". Thus, the app does not find the frequency of the tail rotor notch filters in the log.`); J.gearAcc = null; }
    }
    // the fit of the logs added, once; J.gear when a group passed
    function gearFit(J) {
        if (!J.gearAcc || J.tailFit) return;
        const { FT, acc } = J.gearAcc; J.gearAcc = null;
        try { J.tailFit = FT.tailOrderFit(acc); }
        catch (e) { J.notes.add(`The function "tailOrderFit" of "filter_tune.cjs" stopped. The error is "${message(e)}". Thus, the app does not find the frequency of the tail rotor notch filters in the log.`); return; }
        const g = J.tailFit.gear; J.tailFit.cause = (G, name) => typeof FT.fitCauseText === 'function' ? FT.fitCauseText(G, name) : '';
        J.gear = g ? Object.assign({}, g, { motorisedTail: J.tailFit.passed ? false : null }) : null; // no tail fit: a motorised tail is possible (source 20)
    }
    // the gear of the modules, for the segments of one log
    const gearInto = (J, preps) => { if (J.gear) for (const p of preps) if (p && p.ctx) p.ctx.gear = Object.assign({}, J.gear); };
    // The notes of the fit (STE, from the log only; no text about a gear ratio): for the tail rotor and for the main motor notch
    // filters when the header has them, the order that the checks use with its SE, else the cause from the log
    const GEAR_UNIT = { flight: ['flight log', 'flight logs'], block: ['period of 30 s of flight', 'periods of 30 s of flight'] };
    function gearNotes(J) {
        const F = J.tailFit; if (!F) return;
        for (const [name, G] of [['tail rotor', F.reasons && F.reasons.some(x => x.code === 'no tail rotor notch') ? null : F], ['motor', F.motor]]) { // "motor notch filter" (STE: main only in "main rotor")
            if (!G) continue;
            if (G.passed) { const u = (GEAR_UNIT[G.unit] || ['unit', 'units'])[G.n === 1 ? 0 : 1];
                const depth = typeof G.depthDb === 'number' ? `At this frequency, the filters decrease the gyro signal by ${Math.round(-G.depthDb)} dB.` : '';
                J.notes.add([`In the log, the ${name} notch filter is at ${G.order} ± ${G.se} x the rotor frequency (${G.axis} axis, ${G.n} ${u}).`, depth,
                    'The checks of the notch filters and the vibration plots use this value.'].filter(Boolean).join(' '));
                continue; }
            J.notes.add([`The data in the log is not sufficient to find the ${name} notch filter.`, F.cause(G, name), `Thus, the frequency of the ${name} notch filters is unknown.`].filter(Boolean).join(' '));
        }
    }
    // result.notchFit: { used (the checks have the orders of the log), logs (the flight logs of the fit), tail, motor: { passed, order,
    // se (with the time base: filter_tune RULES.notchFit.timeBase), seUnits (the scatter of the units only), overlap (the fit is on a bank
    // next to a main rotor bank), n, unit, axis, depthDb, sources, Q, reasons } | null, ms } | null (the fit did not run: a CLI dump, the
    // CLI's view, logGear false)
    function notchFitOut(J) {
        const F = J.tailFit; if (!F) return null;
        const part = (G) => G ? JSON.parse(toJson({ passed: !!G.passed, order: G.order, se: G.se, seUnits: G.seUnits ?? null, overlap: !!G.overlap, n: G.n, unit: G.unit, axis: G.axis, depthDb: G.depthDb, sources: G.sources || [], Q: G.Q ?? null, reasons: G.reasons || [] })) : null;
        return { used: !!J.gear, logs: J.gearLogs.slice(), tail: F.reasons && F.reasons.some(x => x.code === 'no tail rotor notch') ? null : part(F), motor: part(F.motor), ms: F.ms ?? null };
    }

    // The first pass over the logs of the file: the flight rpm evidence (auto: of the selected logs, SPEC3 D, else of every log) and,
    // with the configurations (round 3 M1), the input of every log of the file for datasets(). One decode of each log, with only
    // the columns of the governor target and the flight phases
    async function firstPass(J, count, slice, from, to, logs, auto) {
        const K = kit(J.src, null), rule = K.health.RULE.flight, list = [], ds = dsOn(J), use = ds || !logs ? [...Array(count).keys()] : logs;
        for (const [k, li] of use.entries()) {
            await checkpoint(J.id);
            const forRpm = auto && (!logs || logs.includes(li));
            J.progress(forRpm ? `The app calculates the flight rpm from log ${li + 1} of ${count}.` : `The app reads the configuration of log ${li + 1} of ${count}.`, 'decode', from + (to - from) * k / use.length);
            const d = timedDecode(J, K, slice(li), li, rpmExtra(J, K)), ev = logEvidence(J, K, d.segs, li, ds || !!J.gearAcc);
            hsCollect(J, d, li); // D12: the headspeed of each PID profile at the changes of every log read, bench runs too
            if (forRpm) list.push(ev);
            if (ds) dsSet(J, li, dsInput(J, K, d, li, ev.preps || [], ev.cls === undefined ? null : ev.cls));
            gearAdd(J, ev.preps || [], ev.cls, li, K); // the notch orders: the spectra of this log
        }
        if (ds) { dsArming(J); dsCliFilter(J, dsBench(J)); } // the CLI dump that the log does not contradict
        gearFit(J);
        if (auto) chosenRpm(J, list, K, rule);
    }
    function chosenRpm(J, list, K, rule) {
        const { rpm, evidence } = chooseRpm(J, list, K.lib.FLIGHT_RPM, rule);
        settle(J, rpm, rpmWhy(evidence, rule, true));
        if (rpm.source !== 'default') J.notes.add(`The flight rpm is ${rpm.value} (\`floor(${RPM.share} x ${rpm.basis} / ${RPM.step}) x ${RPM.step}\`). ` +
            `${rpm.basis} rpm is the lowest median ${basisKind[rpm.source]} in flight of a PID profile (${rpm.profile ? `PID profile ${rpm.profile}` : 'the PID profile at the start of the log'}). ` +
            `The app calculated it from ${rpm.seconds} s of flight in log${rpm.logs.length > 1 ? 's' : ''} ${and(rpm.logs.map(l => String(l + 1)))}. ` +
            `${evidence.filter(flownBy(rule)).length} of the ${list.length} logs have a minimum of ${rule.minS} s of flight at ${rule.rate} deg/s rms.`);
    }
    function timedDecode(J, K, bytes, li, extra) { const t = Date.now(); try { return decode(K, bytes, J.fileName, li, extra); } finally { J.ms.decode += Date.now() - t; } }

    // F5 flags of every flight log: what the gyro filters pass of each line, measured (health_more curves vib.pass, gyroRAW ->
    // gyroADC, the flag's profile when it has its own spectrum; the curves of the log on screen, else J.vib): the largest over
    // the line's bin and its neighbours, per axis. advice.cjs reads it before proposing a notch (SPEC2 D-H2)
    function filterPass(J, findings) {
        const vibs = J.curves.filter(c => c.more && c.more.vib).map(c => ({ log: c.log, segment: c.segment, vib: c.more.vib })).concat(J.vib);
        for (const f of findings) {
            if (f.id !== 'F5' || f.severity !== 'flag') continue;
            const c = vibs.filter(c => c.log === f.log && !c.vib.filtOnly).sort((a, b) => b.vib.windows - a.vib.windows)[0];
            if (!c) continue;
            const v = c.vib, S = (v.byProfile && v.byProfile[f.profile]) || v;
            f.filterPass = [...String(f.text).matchAll(/line at [\d.]+ x rotor \(([\d.]+) Hz/g)].map(m => {
                const hz = +m[1], o = { hz };
                for (const ax of ['roll', 'pitch', 'yaw']) {
                    const s = S[ax], k = s && s.pass ? Math.round(hz / (s.f[1] - s.f[0])) : -1; let best = null;
                    for (let j = k - 1; j <= k + 1; j++) if (j >= 0 && s && s.pass && j < s.pass.length && isFinite(s.pass[j])) best = Math.max(best === null ? 0 : best, s.pass[j]);
                    o[ax] = best === null ? null : r(best, 4);
                }
                return o;
            });
        }
    }

    // the logs with no flight (SPEC2 D13): [{ log, start, durationS, phaseSeconds }] of their segments together
    // the logs whose records are all skipped and have no log class (a log with no data, as "parser: Log truncated, no data",
    // or a log that the decoder cannot read): [{ log, why }]. They are not bench runs and not flight logs
    function emptyLogsOf(J) {
        const by = new Map();
        for (const l of J.records.concat(J.errorRecords)) { const x = by.get(l.log) || by.set(l.log, { log: l.log, all: true, why: null }).get(l.log);
            if (!l.skipped || l.logClass) x.all = false; else if (!x.why) x.why = String(l.skipped); }
        return [...by.values()].filter(x => x.all).sort((a, b) => a.log - b.log).map(({ log, why }) => ({ log, why }));
    }
    function benchRunsOf(J) {
        const by = new Map();
        for (const l of J.records) if (l.logClass === 'bench') {
            const b = by.get(l.log) || by.set(l.log, { log: l.log, start: dated(l.start), durationS: l.durationS, phaseSeconds: {} }).get(l.log);
            for (const [k, v] of Object.entries(l.phaseSeconds || {})) b.phaseSeconds[k] = r((b.phaseSeconds[k] || 0) + v, 1);
        }
        return [...by.values()];
    }
    // result.profiles (D12): the in-flight seconds of each PID profile (records' profileSeconds, the label 0 as the confirmed
    // PID profile at the start of that log, 0 when it is not confirmed) with their logs, the rate profile changes, and the PID
    // profile at the start of each analysed log with its basis
    function profilesSummary(J) {
        const pid = {}, rateChanges = [], arming = [];
        for (const l of J.records) {
            if (l.logClass === 'bench' || l.skipped) continue;
            const a = J.arming.get(l.log);
            for (const [k, v] of Object.entries(l.profileSeconds || {})) { const p = +k === 0 && a && a.confirmed && a.profile > 0 ? a.profile : +k, x = pid[p] || (pid[p] = { seconds: 0, logs: [] });
                x.seconds = r(x.seconds + v, 1); if (!x.logs.includes(l.log)) x.logs.push(l.log); }
            if (l.profiles) for (const q of l.profiles.rate) rateChanges.push({ log: l.log, t: q.t, profile: q.profile });
        }
        for (const [log, a] of J.arming) arming.push({ log, profile: a.profile, basis: a.basis.slice(), confirmed: !!a.confirmed, estimate: a.estimate ?? null, headspeed: a.headspeed ? JSON.parse(JSON.stringify(a.headspeed)) : null });
        return { pid, rateChanges, arming: arming.sort((x, y) => x.log - y.log) };
    }

    // D7 (health_phase) lists the flights of a log in index time (w.fromS + i / rate), as every module gives its times. The
    // app gives them in frame seconds (SPEC2 D1, A8): each flight of the list from its record (J.flightAt, by segment and
    // samples), and the sentence of the text for each flight ("Flight k is from a s to b s (c s).", health_phase judge)
    function d7Frames(J, findings) {
        const fmt = (v) => typeof v === 'number' && isFinite(v) ? v.toFixed(1) : 'unknown', say = (k, q) => `Flight ${k + 1} is from ${fmt(q.t0)} s to ${fmt(q.t1)} s (${fmt(q.seconds)} s).`;
        for (const f of findings) {
            if (f.id !== 'D7' || f.module !== 'phase' || !Array.isArray(f.flights)) continue;
            f.flights = f.flights.map((q, k) => {
                const at = q && J.flightAt.get(flightKey(f.log, q.segment ?? 0, q.i0, q.i1));
                if (!at) return q;
                const o = Object.assign({}, q, { t0: at.t0, t1: at.t1, seconds: at.seconds });
                if (typeof f.text === 'string') f.text = f.text.replace(say(k, q), say(k, o));
                return o;
            });
        }
    }

    function finish(J, judged, gained) {
        J.progress('The app makes the recommendations.', 'advice', 0.97);
        d7Frames(J, judged.findings);
        filterPass(J, judged.findings);
        fileArming(J);
        headerOf(J);
        gearNotes(J);
        J.cliStatus = cliStatusOf(J); // before the epochs (a span source 'cli' needs a CLI dump that the app uses) and the configurations
        if (dsOn(J)) dsCliFilter(J, new Set(J.records.filter(l => l.logClass === 'bench').map(l => l.log))); // datasets.cjs: no section that the log contradicts
        const ds = dsFinal(J);
        J.dsFull = ds; J.dsOut = dsResult(J, ds);
        annotate(J, judged.findings, ds);
        if (gained) annotateDecisions(J, gained.decisions, gained.segments);
        const advice = adviseAll(J, judged.findings, gained ? gained.decisions : null);
        // the A/B comparisons of the configurations that are different in a few parameters (advice.cjs comparisons, round 3 M1)
        if (J.dsOut) { J.dsOut.comparisons = [];
            if (J.K.advice && typeof J.K.advice.comparisons === 'function') try { J.dsOut.comparisons = JSON.parse(toJson(J.K.advice.comparisons(judged.findings, J.dsOut))); }
                catch (e) { J.notes.add(`The app cannot compare the configurations. The error is "${message(e)}".`); } }
        // values that are possibly not current (CLAUDE.md): the epochs of each log, f.stale, the stale of the limits periods, r.stale
        const fresh = freshnessOf(J, judged.findings, gained ? gained.decisions : null, advice.recommendations);
        // the CLI file of the saved report again, with the flag of each change that has r.stale (CLAUDE.md: a comment line before its command)
        if (J.K.advice && advice.recommendations.some(x => x && x.stale)) try { advice.script = scriptOf(J, J.K.advice, advice.recommendations, judged.findings); }
            catch (e) { J.notes.add(`The app cannot make the CLI file of the report. The error is "${message(e)}".`); }
        explain(judged.findings, advice.recommendations);
        resultOf(judged.findings, advice.recommendations);
        present(J, judged.findings, advice.recommendations);
        const hierarchy = hierarchyOf(J, judged.findings, advice);
        const iss = issuesOf(J, judged.findings);
        for (const x of iss.issues) x.stale = fresh.epochs ? staleUnion((x.fids || []).map(fid => J.byFid.get(fid)), 'item') : null;
        const bench = benchRunsOf(J), empty = emptyLogsOf(J);
        // the logs with no data (all their segments skipped, no log class): not bench runs and not flight logs. Round 3 M4: each of
        // their records has noData (true) and noDataReason (the reason of the decoder), and the views write "No data that the app can read"
        const emptyLogs = new Set(empty.map(e => e.log));
        for (const l of J.records.concat(J.errorRecords)) if (emptyLogs.has(l.log)) { l.noData = true; l.noDataReason = l.skipped ? String(l.skipped) : null; }
        for (const why of [...new Set(empty.map(e => e.why))]) {
            const list = empty.filter(e => e.why === why), one = list.length === 1, said = why ? ` (${JSON.stringify(String(why))})` : '';
            const which = one ? `Log ${list[0].log + 1} has` : `Logs ${and(spans(list.map(e => e.log + 1)))} have`;
            J.notes.add(`${which} no data that the app can read${said}. The app does not use ${one ? 'this log' : 'these logs'}.`); }
        if (bench.length) J.notes.add(bench.length === 1 ? `Log ${bench[0].log + 1} is a bench run (no flight). The app does not do the analysis of a bench run.`
            : `${bench.length} of the ${J.logs.length} logs are bench runs (no flight). The app does not do the analysis of these logs: ${and(spans(bench.map(b => b.log + 1)))}.`);
        const records = J.records.concat(J.errorRecords).map(l => J.o.keepMetrics ? l : pick(l, SUMMARY));
        // the flights of a whole log of the selection: from its records (the order of the log: 0-based index)
        if (J.selection) for (const li of J.selection.all) J.records.filter(l => l.log === li && l.logClass === 'flight').flatMap(l => l.flights || []).sort((a, b) => a.t0 - b.t0)
            .forEach((q, k) => J.selection.flights.push({ log: li, flight: k, t0: q.t0, t1: q.t1 }));
        if (J.selection) J.selection.flights.sort((a, b) => a.log - b.log || a.flight - b.flight);
        const selection = J.selection ? { flights: J.selection.flights.slice(), windows: J.selection.windows.slice(), logs: J.logs.slice(), all: [...J.selection.all].sort((a, b) => a - b), text: selectionText(J.selection) } : null;
        if (selection) { J.notes.add(selection.text); if (J.selection.cut) J.notes.add('In a log with more flights, the app uses the time from the landing before a selected flight to the liftoff after it.'); }
        return { version: 1, scope: J.scope, selection, fileName: J.fileName, logIndex: J.logIndex, logs: J.logs, flightRpm: J.rpm,
            cli: J.cliParsed ? { kind: J.cliParsed.kind, version: J.cliParsed.version, selectedProfile: J.cliSel.profile, selectedRateProfile: J.cliSel.rateProfile } : null,
            timing: { decodeS: seconds(J.ms.decode), analyseS: seconds(J.ms.analyse), judgeS: seconds(J.ms.judge), gainsS: seconds(J.ms.gains), totalS: seconds(Date.now() - J.t0) },
            records, flights: J.records.flatMap(l => (l.logClass === 'flight' && l.flights || []).map(q => Object.assign({ log: l.log, segment: l.segment }, q))), benchRuns: bench, noData: empty.map(e => ({ log: e.log, reason: e.why })), profiles: profilesSummary(J),
            header: J.header, headerLog: J.headerLog, fields: J.fields, findings: judged.findings, decisions: gained ? gained.decisions : null, groups: gained ? gained.groups : null,
            advice, hierarchy, curves: J.o.curves ? J.curves : null, datasets: J.dsOut || null, issues: iss.issues, top: iss.top, areas: iss.areas, notchFit: notchFitOut(J),
            epochs: fresh.epochs, freshness: fresh.freshness, cliStatus: J.cliStatus,
            reportMarkdown: (selection ? `${selection.text}\n\n` : '') + judged.markdown + labelLine(J) + (gained ? `\n\n${gained.markdown}` : ''), notes: J.notes.list() };
    }

    // the profile numbers of the toolkit report are the labels of the configurations when the modules pooled by configuration
    function labelLine(J) {
        if (!J.dsMap || !relabelOn(J) || !J.dsMap.size) return '';
        const items = [...J.dsMap].filter(([, d]) => d).map(([L, d]) => `- ${L}: ${configText(d)}`);
        return items.length ? `\n\n## Configurations\n\nIn the toolkit tables, the column "profile" of the checks of seven modules gives the number of a configuration. These modules are "health_gov", "health_loop", "health_track", "health_more", "health_phase", "health_rescue" and "health_limits". The numbers are:\n\n${items.join('\n')}` : '';
    }

    function judgeTimed(J) { const t = Date.now(); J.progress('The app compares the results with the limits.', 'judge', J.o.gains && J.scope === 'file' ? 0.57 : 0.9); try { return judgeAll(J, J.src); } finally { J.ms.judge += Date.now() - t; } }

    async function analyseLog(msg, post) {
        const J = await begin(msg, post, 'log'), li = +msg.logIndex || 0;
        J.logIndex = li; J.logs = [li]; J.logCount = msg.logCount || null;
        gearPlan(J); // the notch orders of this log: addLog
        J.progress(`The app loads log ${li + 1}${J.logCount ? ` of ${J.logCount}` : ''}.`, 'decode', 0.05);
        const rpm = userRpm(J), d = timedDecode(J, kit(J.src, rpm && rpm.value), J.bytes, li);
        hsCollect(J, d, li); // D12: the map of the headspeeds has this log only
        epochCollect(J, d, li); // the parameter epochs of the log (freshnessOf)
        if (rpm) settle(J, rpm);
        else { const K0 = kit(J.src, null), rule = K0.health.RULE.flight, { rpm: auto, evidence } = chooseRpm(J, [logEvidence(J, K0, d.segs, li)], K0.lib.FLIGHT_RPM, rule);
            settle(J, auto, rpmWhy(evidence, rule, false)); }
        J.progress(`The app does the checks on log ${li + 1} at a flight rpm of ${J.rpm.value}.`, 'analyse', 0.15);
        addLog(J, d, li, true);
        d.segs.length = 0;
        await checkpoint(J.id);
        return finish(J, judgeTimed(J), null);
    }

    // ---------------------------------------------------------------------------------------------
    // Flight selection (SPEC3 D): options.flights = [{ log, flight }], flight the 0-based index of a flight in its log (the
    // flights of health_phase.cjs in the order of the log: result.flights). Only those logs are analysed. A log with one flight
    // is the whole log. In a log with more flights, a selected flight keeps the time from the touchdown of the flight before it
    // to the liftoff of the flight after it (the start or the end of its segment when there is none): its ground phases, its
    // spool-up and its spool-down stay with it. J.selection: { flights: [{ log, flight, t0, t1 }], windows: [{ log, t0, t1 }] } in
    // frame seconds, for result.selection, the notes and the report text
    // ---------------------------------------------------------------------------------------------

    // Map(log -> Set(flight)) of the valid entries of options.flights, or null when there is no selection
    function flightsWanted(J, count) {
        const list = Array.isArray(J.o.flights) ? J.o.flights : null;
        if (!list || !list.length) return null;
        const m = new Map(), bad = [];
        // flight null (or no flight): every flight of that log, the whole log
        for (const q of list) { const l = q && Number.isInteger(q.log) ? q.log : NaN, all = !!q && (q.flight === null || q.flight === undefined), f = all ? ALL : q && Number.isInteger(q.flight) ? q.flight : NaN;
            if (!(l >= 0 && l < count) || !(all || f >= 0)) { bad.push(q); continue; } if (!m.has(l)) m.set(l, new Set()); m.get(l).add(f); }
        if (bad.length) J.notes.add(`The app does not use ${bad.length === 1 ? '1 entry' : `${bad.length} entries`} of the flight selection, because the log or the flight is not in the file.`);
        J.selection = { flights: [], windows: [], all: new Set() };
        return m.size ? m : null;
    }
    // the segments of log li that the selected flights keep (want: Set of flight indices), cut by sample
    const ALL = 'all';
    function selectFlights(J, d, li, want) {
        const K = J.K, live = d.segs.filter(w => !w.skipped);
        if (want.has(ALL)) { J.selection.all.add(li); for (const w of live) { const at = frameOf(w); J.selection.windows.push({ log: li, t0: at(0), t1: at(w.n) }); } return d.segs; } // the flights: from the records (finish)
        if (!phasesOn(J, K)) { J.notes.add('The flight selection uses the flight phases of "health_phase.cjs", and they are not available. Thus, the app uses all of the selected logs.', li); return d.segs; }
        const airborneEvents = live.some(w => w.airborneAt.some(v => !v)), found = [];
        live.forEach((w, k) => { const p = prepare(K, w, { segment: k, cli: null, cliParsed: null, phases: true, airborneEvents }, J), P = p.ph && p.ph.P;
            for (const q of (P && Array.isArray(P.flights) ? P.flights : [])) found.push({ w, k, i0: q.i0, i1: q.i1 }); });
        found.sort((a, b) => a.k - b.k || a.i0 - b.i0);
        const idx = [...want].sort((a, b) => a - b), ok = idx.filter(f => f < found.length), lost = idx.filter(f => f >= found.length);
        if (lost.length) J.notes.add(`Log ${li + 1} has ${found.length === 1 ? '1 flight' : `${found.length} flights`}. Thus, the app does not use the selected flight${lost.length > 1 ? 's' : ''} ${and(lost.map(f => String(f + 1)))}.`, li);
        for (const f of ok) { const q = found[f], at = frameOf(q.w); J.selection.flights.push({ log: li, flight: f, t0: at(q.i0), t1: at(q.i1) }); }
        const whole = found.length <= 1 || ok.length === found.length;
        if (whole || !ok.length) { if (whole) for (const w of live) { const at = frameOf(w); J.selection.windows.push({ log: li, t0: at(0), t1: at(w.n) }); } return whole ? d.segs : []; }
        const cuts = new Map(); // segment -> [[a, b]]
        for (const f of ok) { const q = found[f], prev = found[f - 1], next = found[f + 1];
            const a = prev && prev.w === q.w ? prev.i1 : 0, b = next && next.w === q.w ? next.i0 : q.w.n;
            const list = cuts.get(q.w) || cuts.set(q.w, []).get(q.w), last = list[list.length - 1];
            if (last && a <= last[1]) last[1] = Math.max(last[1], b); else list.push([a, b]); }
        const out = []; J.selection.cut = true;
        for (const w of live) for (const [a, b] of cuts.get(w) || []) { const c = sliceSegment(w, a, b), at = frameOf(c); out.push(c); J.selection.windows.push({ log: li, t0: at(0), t1: at(c.n) }); }
        return out;
    }
    // samples [a, b) of a decoded whole-log segment as a segment of its own (lib.segments fields; fromS the frame second of a)
    function sliceSegment(w, a, b) {
        const cut = (v) => v ? v.subarray(a, b) : v, three = (x) => Array.isArray(x) ? x.map(cut) : x, T = w.extra && w.extra.time, rate = w.flight && w.flight.actualRate || w.rate;
        return Object.assign({}, w, { n: b - a, cutAt: (w.cutAt || 0) + a, fromS: T ? w.fromS + (T[a] - T[0]) / 1e6 : w.fromS + a / rate, seconds: (b - a) / w.rate,
            sp: three(w.sp), gyro: three(w.gyro), u: three(w.u), P: three(w.P), I: three(w.I), D: three(w.D), F: three(w.F), B: three(w.B), hs: cut(w.hs), coll: cut(w.coll),
            profileAt: cut(w.profileAt), airborneAt: cut(w.airborneAt), govStateAt: cut(w.govStateAt), rescueAt: cut(w.rescueAt),
            extra: Object.fromEntries(Object.entries(w.extra || {}).map(([k, v]) => [k, cut(v)])) });
    }
    // the selection in words (STE: no semicolon): "Flights in the analysis: log 1 (all flights), log 2 flight 2 (50.0 s to 83.0 s)."
    function selectionText(S) {
        const f1 = (v) => typeof v === 'number' && isFinite(v) ? v.toFixed(1) : 'unknown', logs = [...new Set(S.flights.map(q => q.log).concat([...S.all]))].sort((a, b) => a - b);
        const items = logs.flatMap(l => S.all.has(l) ? [`log ${l + 1} (all flights)`] : S.flights.filter(q => q.log === l).map(q => `log ${l + 1} flight ${q.flight + 1} (${f1(q.t0)} s to ${f1(q.t1)} s)`));
        return items.length ? `Flights in the analysis: ${items.join(', ')}.` : 'Flights in the analysis: none.';
    }

    async function analyseFile(msg, post) {
        const J = await begin(msg, post, 'file'), idx = new FlightLogIndex(J.bytes), count = idx.getLogCount();
        const sel = Math.min(Math.max(0, +msg.selectedLog || 0), Math.max(0, count - 1)), slice = (i) => J.bytes.subarray(idx.getLogBeginOffset(i), idx.getLogBeginOffset(i + 1));
        J.logIndex = sel; J.logs = [...Array(count).keys()]; J.logCount = count;
        const want = flightsWanted(J, count); // SPEC3 D: options.flights, the selected flights (null: every log)
        if (want) J.logs = [...want.keys()].sort((a, b) => a - b);
        gearPlan(J); // the notch orders of the log: in the first pass
        const rpm = userRpm(J), end = J.o.gains ? 0.55 : 0.85, pass = !rpm || dsOn(J) || !!J.gearAcc, start = !pass ? 0.03 : 0.03 + 0.3 * (end - 0.03); // a first pass: auto rpm (the selected logs), the configurations (every log), the notch orders
        if (rpm) settle(J, rpm);
        if (pass) await firstPass(J, count, slice, 0.03, start, want ? J.logs : null, !rpm);
        for (const [k, li] of J.logs.entries()) {
            await checkpoint(J.id);
            J.progress(`The app loads log ${li + 1} of ${count}.`, 'decode', start + (end - start) * k / J.logs.length);
            const d = timedDecode(J, J.K, slice(li), li);
            hsCollect(J, d, li); // a log that the first pass did not read (no first pass, or a flight selection): before the selection cuts it
            epochCollect(J, d, li); // the parameter epochs of the whole log (freshnessOf), before the selection cuts it
            if (want) { const whole = d.segs, cut = selectFlights(J, d, li, want.get(li));
                if (cut !== whole && cut.length) armWhole(J, whole, d.events, li); // D12: the PID profile at the start of the whole log
                d.segs = cut; }
            addLog(J, d, li, li === sel);
        }
        armingLate(J);
        await checkpoint(J.id);
        const judged = judgeTimed(J);
        let gained = null;
        if (J.o.gains) { await checkpoint(J.id); const t = Date.now(); J.progress('The app calculates the gains of the file with "extract.cjs" and "report.cjs".', 'gains', 0.6); gained = gains(J, J.src, J.bytes); J.ms.gains += Date.now() - t; }
        return finish(J, judged, gained);
    }

    // ---------------------------------------------------------------------------------------------
    // filterTune (round 3 M2): the filter search of filter_tune.cjs on the flight logs of a file, on demand
    // ---------------------------------------------------------------------------------------------

    // msg: { cmd: 'filterTune', id, bytes (the whole file), fileName, options: { cliText, cliName, flightRpm (the flight rpm of the
    // analysis, else auto as analyseFile), logs: [log indices] (the flight logs of the analysis, else every log of the file; a bench
    // run is left out), flights (SPEC3 D: the selected flights), blockedBy: [STE texts] (the gates of the filters block), budgetMs,
    // loo (false: no leave-one-out) } } -> { id, type: 'filterTuned', result }: tune() of filter_tune.cjs (parity, the noise at
    // this time, the search, recommended: { status, reasons, params, cli, rows, predicted, delay, validation }, curves of the raw,
    // logged, model and candidate spectra and of the PID output) with text (filter_tune.cjs texts: status, summary, parity,
    // recommendation, delay, validation, why, rows, in STE), recommendations (advice.cjs filterRecommendations: an action only when
    // tune() recommends the set and the model agrees with every flight log), logs, flightRpm, notes and timing. The masks: the flight
    // phases less rescue, level modes and failsafe (health_more normalMask over the flight phase), as the CLI of filter_tune.cjs
    async function filterTune(msg, post) {
        const J = await begin(Object.assign({}, msg, { options: Object.assign({}, msg.options || {}, { datasets: false, curves: false }) }), post, 'file'); // no gearPlan: tune() fits the notch orders itself
        const idx = new FlightLogIndex(J.bytes), count = idx.getLogCount(), slice = (i) => J.bytes.subarray(idx.getLogBeginOffset(i), idx.getLogBeginOffset(i + 1));
        const sel = flightsWanted(J, count), list = Array.isArray(J.o.logs) && J.o.logs.length ? J.o.logs.filter(l => Number.isInteger(l) && l >= 0 && l < count) : [...Array(count).keys()];
        J.logs = sel ? [...sel.keys()].filter(l => list.includes(l)).sort((a, b) => a - b) : list; J.logCount = count; J.logIndex = J.logs[0] || 0;
        const rpm = userRpm(J); if (rpm) settle(J, rpm); else await firstPass(J, count, slice, 0.02, 0.2, J.logs, true);
        const K = J.K; let FT = null;
        try { FT = K.require('./filter_tune.cjs'); } catch (e) { throw new Error(`The app cannot load the toolkit file "filter_tune.cjs". The error is "${message(e)}".`); }
        if (!K.phase) throw new Error('For the analysis of the filter values, the flight phases of "health_phase.cjs" are necessary, and that file is not available.');
        const extra = [...new Set(FT.EXTRA.concat(K.phase.EXTRA || [], K.more && K.more.EXTRA || [], ['time', 'govRequest']))], items = [], used = [], t0 = Date.now(), runs = new Map(); // govRequest: the stale (filterStale)
        for (const [k, li] of J.logs.entries()) {
            await checkpoint(J.id);
            J.progress(`The app loads log ${li + 1} of ${count} for the analysis of the filter values.`, 'decode', 0.2 + 0.3 * k / Math.max(1, J.logs.length));
            const d = timedDecode(J, K, slice(li), li, extra); if (d.error) continue;
            hsCollect(J, d, li); epochCollect(J, d, li); armWhole(J, d.segs, d.events, li); // the stale of the recommendations (filterStale): the whole log
            if (sel) d.segs = selectFlights(J, d, li, sel.get(li));
            const live = d.segs.filter(w => !w.skipped), airborneEvents = live.some(w => w.airborneAt.some(v => !v));
            const preps = live.map((w, s) => prepare(K, w, { segment: s, cli: J.cliText, cliParsed: J.cliParsed, phases: true, airborneEvents }, J));
            if (classOf(preps.map(p => p.ph)) !== 'flight') continue; // a bench run, or no flight phases
            for (const p of preps) { if (!p.ph || !p.ctx) continue; let mask = p.ph.mask;
                if (K.more) try { mask = K.more.normalMask(p.w, Object.assign({}, p.ctx, { flying: p.ph.mask, phases: p.ph.P, flightMask: p.ph.mask })).mask; }
                    catch (e) { J.notes.add(`The function "normalMask" of "health_more.cjs" stopped. The error is "${message(e)}". Thus, the analysis of the filter values uses all of the flight phase.`, li); }
                items.push({ w: p.w, mask, flight: true }); runs.set(li, (runs.get(li) || []).concat(runsOf(p.w, mask))); }
            if (!used.includes(li)) used.push(li);
        }
        const tSearch = Date.now();
        J.progress(`The app calculates the vibration for filter values on ${used.length === 1 ? '1 flight log' : `${used.length} flight logs`}.`, 'filter', 0.55);
        const opts = { cli: J.cliText || null, loo: J.o.loo !== false };
        // options.blockedBy: the ids of the steps that hold the filters (hierarchy nodes filters.blockedBy, for example 'rpm') or texts
        const G = K.hierarchy && typeof K.hierarchy.graph === 'function' ? (() => { try { return K.hierarchy.graph(); } catch (e) { return null; } })() : null;
        const titles = new Map(G ? [].concat((G.prereq || []).map(n => [n.id, { title: n.title, prereq: true }]), (G.blocks || []).map(n => [n.id, { title: n.title, prereq: false }])) : []);
        const blockedBy = (Array.isArray(J.o.blockedBy) ? J.o.blockedBy : []).map(b => titles.has(b) ? `The ${titles.get(b).prereq ? 'prerequisite' : 'step'} "${titles.get(b).title}" has a problem.` : typeof b === 'string' && /\s/.test(b) ? b : null).filter(Boolean);
        if (num0(J.o.budgetMs) > 0) opts.budgetMs = +J.o.budgetMs;
        const res = FT.tune(items, opts);
        res.text = typeof FT.texts === 'function' ? FT.texts(res, { logBase: 1, cli: !!J.cliText }) : null;
        res.recommendations = K.advice && typeof K.advice.filterRecommendations === 'function'
            ? JSON.parse(toJson(K.advice.filterRecommendations(res, { texts: res.text || {}, cli: !!J.cliText, cliName: J.o.cliName || null, blockedBy }))) : [];
        filterStale(J, res.recommendations, used, runs);
        Object.assign(res, { fileName: J.fileName, logs: used, flightRpm: J.rpm, blockedBy, selection: J.selection ? { flights: J.selection.flights.slice(), windows: J.selection.windows.slice(), text: selectionText(J.selection) } : null,
            notes: J.notes.list(), timing: { decodeS: seconds(J.ms.decode), searchS: seconds(Date.now() - tSearch), totalS: seconds(Date.now() - J.t0) } });
        return res;
    }
    const num0 = (v) => typeof v === 'number' && isFinite(v) ? v : +v || 0;
    // r.stale of the recommendations of the filter search (CLAUDE.md "Values that are possibly not current"): the spans of each log that
    // the search used (paramEpochs, with the PID profile at the start of the whole log: armWhole, hsCollect) that the time of its masks
    // touches (runs: frame seconds), with the reasons that can change the values of the recommendation: the gyro filters (global) for the
    // global one, the PID cutoffs of its PID profile (only the spans of that PID profile) for the others. { reasons, text, source, spans }
    // or null; without param_epochs.cjs every stale is null
    function filterStale(J, recs, used, runs) {
        const PE = J.K.epochs; J.epochs = new Map(); J.spanMeta = new Map();
        if (!PE || typeof PE.paramEpochs !== 'function') { for (const x of recs) x.stale = null; return; }
        for (const li of used) if (J.epochIn.has(li)) { const a = armingFinal(J.armCore.get(li), hsFor(J, li)); epochsOfLog(J, PE, li, a && a.confirmed && a.profile > 0 ? a.profile : 0, new Set()); }
        const cutoffs = readsOf(J, 'F:filters:profile', null), filters = readsOf(J, 'F:filters', null);
        for (const x of recs) {
            const profile = x.scope === 'profile' && Number.isInteger(x.profile) ? x.profile : null, R = profile ? cutoffs : filters, hits = [];
            for (const li of used) { const E = J.epochs.get(li); if (E) hits.push(...touched(E, li, (runs.get(li) || []).map(q => [q.t0, q.t1]), (s) => s.armed && (profile === null || s.pidProfile === profile))); }
            x.stale = staleFrom(J, hits, 'recommendation', R);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // derive: filters, spectra and window statistics of raw log data for the Tuning view and the log lens. No decode: the
    // main thread reads the frames (js/tuning_snippet.js) and sends the columns, raw logged values as the viewer's FlightLog
    // gives them (setpoint and gyro in deg/s, mixer and axis terms in permille, headspeed and govTarget in rpm).
    // ---------------------------------------------------------------------------------------------

    // lib, health_track (lowpass, bandGain, RULE, DEFAULT_RULES), health_more (RULE, DEFAULT_RULES), health_gov (pt2) and
    // catalog (check nouns), loaded once in a worker; a missing or failing one is a note, and the kinds that use it stop
    let derived = null;
    function deriveKit() {
        derived = derived || sources().then(src => {
            const reg = registry(src.texts, {}), D = { lib: reg.require('./lib.cjs'), calls: reg.calls, notes: [] };
            for (const [name, base] of [['track', 'health_track'], ['more', 'health_more'], ['gov', 'health_gov'], ['catalog', 'catalog']]) D[name] = optional(reg, src, `${base}.cjs`, D.notes, null);
            return D;
        }).catch(e => { derived = null; throw e; });
        return derived;
    }
    const uses = (D, name, file, kind) => { if (!D[name]) throw new Error(`The function "${kind}" cannot operate without "${file}".`); return D[name]; };
    const num = (v, name) => { const x = +v; if (v === null || v === undefined || v === '' || !isFinite(x)) throw new Error(`The parameter "${name}" is not a number.`); return x; };
    const column = (X, name, what) => { if (!X[name]) throw new Error(`The data has no column "${name}" (${what}).`); return X[name]; };
    const namesOf = (X, p) => { const list = Array.isArray(p.fields) ? p.fields : Object.keys(X); for (const k of list) column(X, k, 'fields'); return list; };
    const each = (X, p, fn) => Object.fromEntries(namesOf(X, p).map(k => [k, Float32Array.from(fn(X[k]))]));
    const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : null;

    // x(t + d samples), linear between samples, NaN outside the column
    function shifted(x, d) {
        const n = x.length, y = new Float64Array(n);
        for (let i = 0; i < n; i++) { const u = i + d, j = Math.floor(u), f = u - j; y[i] = j >= 0 && j < n - 1 ? x[j] + f * (x[j + 1] - x[j]) : j === n - 1 && f === 0 ? x[j] : NaN; }
        return y;
    }

    // Welch sums over Hann windows of N samples from i0 to i1, hop N / 2, each window's mean removed (health_more welch): the
    // power of each column and conj(X) Y of each pair. A window with a sample that is not finite is left out.
    function welch(D, xs, pairs, N, i0, i1) {
        const { fft, win } = D.lib.fftFor(self, N), K = N / 2 + 1, buf = new Float64Array(N), X = xs.map(() => new Float64Array(2 * N)), mean = new Float64Array(xs.length);
        const pw = xs.map(() => new Float64Array(K)), re = pairs.map(() => new Float64Array(K)), im = pairs.map(() => new Float64Array(K));
        let windows = 0;
        for (let s = i0; s + N <= i1; s += N >> 1) {
            let finite = true;
            for (let c = 0; c < xs.length && finite; c++) { let m = 0; for (let i = 0; i < N; i++) m += xs[c][s + i]; mean[c] = m / N; finite = isFinite(m); }
            if (!finite) continue;
            for (let c = 0; c < xs.length; c++) { const x = xs[c], Y = X[c], Q = pw[c];
                for (let i = 0; i < N; i++) buf[i] = (x[s + i] - mean[c]) * win[i];
                fft.simple(Y, buf, 'real');
                for (let k = 0; k < K; k++) Q[k] += Y[2 * k] ** 2 + Y[2 * k + 1] ** 2; }
            pairs.forEach(([a, b], j) => { const A = X[a], B = X[b];
                for (let k = 0; k < K; k++) { re[j][k] += A[2 * k] * B[2 * k] + A[2 * k + 1] * B[2 * k + 1]; im[j][k] += A[2 * k] * B[2 * k + 1] - A[2 * k + 1] * B[2 * k]; } });
            windows++;
        }
        return { N, K, windows, pw, re, im };
    }
    // the window length: params.N (else about 1 s) as a power of two, halved until the data holds one window
    function sizeOf(p, rate, len) {
        let N = 2 ** Math.max(4, Math.round(Math.log2(p.N > 0 ? p.N : rate)));
        while (N > len && N > 16) N /= 2;
        if (N > len) throw new Error(`The data has ${len} samples. A minimum of 16 samples is necessary for a spectrum.`);
        return N;
    }

    function spectrum(D, X, rate, p) {
        const names = namesOf(X, p), len = Math.min(...names.map(k => X[k].length)), N = sizeOf(p, rate, len), W = welch(D, names.map(k => X[k]), [], N, 0, len);
        const norm = 2 / (rate * D.lib.fftFor(self, N).power), f = Float32Array.from({ length: W.K }, (_, k) => k * rate / N), psd = {}, amplitude = {};
        names.forEach((k, c) => { psd[k] = Float32Array.from(W.pw[c], v => W.windows ? v * norm / W.windows : NaN); amplitude[k] = Float32Array.from(W.pw[c], v => W.windows ? Math.sqrt(v / W.windows) / (N / 4) : NaN); });
        return { f, psd, amplitude, windows: W.windows, N };
    }

    function transmission(D, X, rate, p) {
        const a = column(X, p.from, 'from'), b = column(X, p.to, 'to'), len = Math.min(a.length, b.length), N = sizeOf(p, rate, len), W = welch(D, [a, b], [[0, 1]], N, 0, len), K = W.K;
        const band = Array.isArray(p.band) ? p.band.map(Number) : D.more ? D.more.RULE.delay.band : [8, 16];
        const f = Float32Array.from({ length: K }, (_, k) => k * rate / N), gain = new Float32Array(K), phaseDeg = new Float32Array(K), coherence = new Float32Array(K);
        let s = 0, c = 0;
        for (let k = 0; k < K; k++) {
            const x = W.re[0][k], y = W.im[0][k], aa = W.pw[0][k], bb = W.pw[1][k], ph = Math.atan2(y, x), coh = aa > 0 && bb > 0 ? (x * x + y * y) / (aa * bb) : NaN;
            gain[k] = aa > 0 ? Math.hypot(x, y) / aa : NaN; phaseDeg[k] = ph * 180 / Math.PI; coherence[k] = coh;
            if (k > 0 && f[k] >= band[0] && f[k] <= band[1] && isFinite(coh)) { s += coh * -ph / (2 * Math.PI * k * rate / N); c += coh; }
        }
        return { f, gain, phaseDeg, coherence, band, delayMs: c ? r(1000 * s / c, 3) : null, windows: W.windows, N };
    }

    // Window statistics of the log lens (SPEC2 3.8), each with the check that judges the same quantity over the whole log
    // and that check's limits. One window has no standard error: an item more than a limit is "monitor", not a problem.
    // The window has no flight mask: the gates (stick, spooled rotor) of each item say when the data is not sufficient.
    const WINDOW = { minTrackS: 1, lineHz: 5, lineProminence: 3, lines: 3, minLineN: 128, spool: 0.5,
        source: { minTrackS: 'pipeline, unvalidated: 1 s of setpoint more than minAbsSetpoint for a window tracking error',
            lineProminence: 'pipeline, unvalidated: a local maximum of 3 x the median amplitude of the band (F5 flags at 5 over the whole log)',
            spool: 'pipeline, unvalidated: samples with the headspeed at half of the reference or less are spool-up, not governed flight' } };
    function windowStats(D, X, rate, p) {
        const L = D.lib, T = D.track, M = D.more, AX = L.AXES, items = [], notes = [];
        const n = Math.min(...Object.values(X).map(v => v.length)), pad = Math.max(0, Math.min(Math.floor((n - 2) / 2), Math.round((+p.padS || 0) * rate))), i0 = pad, i1 = n - pad, len = i1 - i0;
        const t0 = isFinite(+p.t0) ? +p.t0 : 0, at = (i) => r(t0 + i / rate, 3), fmt = (v, d = 1) => (+v).toFixed(d), pct = (v, d = 1) => fmt(100 * v, d);
        const nounOf = (id) => D.catalog && D.catalog.CHECKS && D.catalog.CHECKS[id] ? D.catalog.CHECKS[id].noun : null;
        const add = (o) => { const lim = o.limits || [], over = typeof o.over === 'number' ? o.over : typeof o.value === 'number' ? lim.filter(q => o.value > q.value).length : 0;
            items.push(Object.assign({ axis: null, value: null, unit: null, limits: lim, over, status: o.status || (over ? 'monitor' : 'satisfactory'), n: 0, detail: {}, checkNoun: nounOf(o.check) }, o, { over, limits: lim })); };
        const absent = (name, what, o) => add(Object.assign({ status: 'notMeasured', text: `The log does not record "${name}". Thus, the app cannot calculate ${what} (check ${o.check}).` }, o));
        const amp = (x, a, b) => { let s = 0; for (let i = a; i < b; i++) s += x[i] * x[i]; return Math.sqrt(2 * s / Math.max(1, b - a)); }; // sqrt(2) rms: the amplitude of a sinusoid (health_track amp)

        // tracking error (C12, T11): health_track tracking on the window, the delay given or fitted
        AX.forEach((axis, a) => {
            const check = axis === 'yaw' ? 'T11' : 'C12', key = `track.${axis}`, s = X[`setpoint[${a}]`], g = X[`gyroADC[${a}]`];
            if (!T) return add({ key, check, axis, status: 'notMeasured', text: `The app cannot calculate the tracking error without "health_track.cjs" (check ${check}).` });
            if (!s || !g) return absent(!s ? `setpoint[${a}]` : `gyroADC[${a}]`, `the ${axis} tracking error`, { key, check, axis });
            const R = T.RULE.track, lim = T.DEFAULT_RULES[check], lpHz = Math.min(R.lpHz, 0.45 * rate), sl = T.lowpass(s, lpHz, rate), gl = T.lowpass(g, lpHz, rate), maxK = Math.round(R.maxS * rate);
            const given = p.tauMs && isFinite(+p.tauMs[axis]) && p.tauMs[axis] !== null ? Math.max(0, Math.min(maxK, Math.round(+p.tauMs[axis] * rate / 1000))) : null;
            const ks = given === null ? Array.from({ length: maxK + 1 }, (_, k) => k) : [given], end = i1 - (given === null ? maxK : given), E = new Float64Array(ks.length);
            let S2 = 0, used = 0, all = 0;
            for (let i = i0; i < i1; i++) all += s[i] * s[i];
            for (let i = i0; i < end; i++) { if (Math.abs(s[i]) <= R.minAbsSetpoint) continue; used++; S2 += s[i] * s[i]; const v = sl[i]; for (let q = 0; q < ks.length; q++) { const d = gl[i + ks[q]] - v; E[q] += d * d; } }
            let q0 = 0; for (let q = 1; q < ks.length; q++) if (E[q] < E[q0]) q0 = q;
            const k = ks[q0], rms = Math.sqrt(all / Math.max(1, len)), minRms = R.minSetpointRms[axis], tauMs = r(k / rate * 1000, 1), value = S2 > 0 ? r(Math.sqrt(E[q0] / S2), 4) : null;
            const o = { key, check, axis, unit: 'fraction', n: used, limits: [{ value: lim.note, level: 'note' }, { value: lim.flag, level: 'flag' }], value,
                detail: { tauMs, tauSource: given === null ? 'fitted' : 'given', setpointRms: r(rms, 2), minSetpointRms: minRms, lpHz: r(lpHz, 1), seconds: r(used / rate, 2) } };
            if (used < WINDOW.minTrackS * rate) return add(Object.assign(o, { status: 'insufficient', text: `The window has ${fmt(used / rate, 2)} s with a ${axis} setpoint of more than ${R.minAbsSetpoint} deg/s. A minimum of ${WINDOW.minTrackS} s is necessary for the tracking error (check ${check}).` }));
            if (rms < minRms) return add(Object.assign(o, { status: 'insufficient', text: `The ${axis} setpoint is ${fmt(rms)} deg/s rms. The tracking error is not accurate at less than ${minRms} deg/s rms (check ${check}).` }));
            add(Object.assign(o, { text: `The ${axis} tracking error is ${pct(value)} % of the setpoint, with a time delay of ${fmt(tauMs)} ms. The limits are ${pct(lim.note, 0)} % and ${pct(lim.flag, 0)} % (check ${check}).` }));
        });

        // oscillation in the wag band (C5, T1): the largest stick-free amplitude of the band-passed error in 0.5 s windows
        AX.forEach((axis, a) => {
            const check = axis === 'yaw' ? 'T1' : 'C5', key = `osc.${axis}`, s = X[`setpoint[${a}]`], g = X[`gyroADC[${a}]`];
            if (!T) return add({ key, check, axis, status: 'notMeasured', text: `The app cannot calculate the oscillation without "health_track.cjs" (check ${check}).` });
            if (!s || !g) return absent(!s ? `setpoint[${a}]` : `gyroADC[${a}]`, `the ${axis} oscillation`, { key, check, axis });
            const O = T.RULE.osc, band = O.bands[axis], level = T.DEFAULT_RULES[check].level, o = { key, check, axis, unit: 'deg/s', limits: [{ value: level, level: 'note' }], detail: { band } };
            if (band[1] >= 0.45 * rate) return add(Object.assign(o, { status: 'insufficient', text: `The log rate of ${fmt(rate, 0)} Hz is too low for the ${band[0]}-${band[1]} Hz band (check ${check}).` }));
            const e = Float64Array.from(g, (v, i) => v - s[i]), be = L.bandpass(e, band[0], band[1], rate), bs = L.bandpass(s, band[0], band[1], rate), W = Math.round(O.windowS * rate);
            let free = 0, at20 = 0, best = null;
            for (let w0 = i0; w0 + W <= i1; w0 += W) { const A = amp(be, w0, w0 + W), As = amp(bs, w0, w0 + W);
                if (A >= O.thresholds[0] && As > O.stickDriven * A) continue; // stick-driven (health_track oscillation)
                free++; if (A >= level) at20++; if (!best || A > best.A) best = { A, w0 }; }
            if (!best) return add(Object.assign(o, { status: 'insufficient', n: 0, text: `The stick moves the ${axis} rate in all of the window. Thus, the app cannot measure the ${axis} oscillation (check ${check}).` }));
            let cross = 0; for (let i = best.w0 + 1; i < best.w0 + W; i++) if ((be[i - 1] < 0) !== (be[i] < 0)) cross++;
            const hz = r(cross / 2 / (W / rate), 1);
            add(Object.assign(o, { value: r(best.A, 1), n: free, detail: { band, windowS: O.windowS, stickFree: free, shareAtLimit: r(at20 / free, 3), hz, worst: { t0: at(best.w0), t1: at(best.w0 + W) } },
                text: `The largest ${axis} oscillation in the ${band[0]}-${band[1]} Hz band is ${fmt(best.A)} deg/s at ${fmt(hz)} Hz. The limit is ${level} deg/s (check ${check}).` }));
        });

        // headspeed error (G2): against govTarget, else against the window's median headspeed (then only the spread counts)
        {
            const key = 'gov.error', check = 'G2', hs = X.headspeed, tg = X.govTarget;
            const lim = [{ value: 0.01, level: 'flag', what: 'median' }, { value: 0.02, level: 'flag', what: 'p5..p95' }]; // health_report.cjs RULES.G2 median, band
            if (!hs) absent('headspeed', 'the headspeed error', { key, check });
            else {
                const ok = [], cut = (v) => v > 0, hasT = !!tg && Array.prototype.some.call(tg, cut), ref = hasT ? null : quantile(Float64Array.from(hs.subarray(i0, i1)).sort(), 0.5);
                for (let i = i0; i < i1; i++) { const q = hasT ? tg[i] : ref; if (q > 0 && hs[i] > WINDOW.spool * q) ok.push((hs[i] - q) / q); }
                ok.sort((x, y) => x - y);
                const m = quantile(ok, 0.5), p5 = quantile(ok, 0.05), p95 = quantile(ok, 0.95), worst = ok.length ? Math.max(Math.abs(m), Math.abs(p5), Math.abs(p95)) : null;
                const o = { key, check, unit: 'fraction', n: ok.length, limits: lim, detail: { reference: hasT ? 'govTarget' : 'median headspeed', median: r(m, 5), p5: r(p5, 5), p95: r(p95, 5), seconds: r(ok.length / rate, 2) } };
                if (!hasT) notes.push('The log does not record "govTarget". Thus, the reference of the headspeed error is the median headspeed of the window.');
                if (!ok.length) add(Object.assign(o, { status: 'insufficient', text: `The headspeed is less than half of the ${hasT ? 'governor target' : 'median headspeed'} in all of the window (check ${check}).` }));
                else add(Object.assign(o, { value: r(Math.abs(m), 5), over: (Math.abs(m) > lim[0].value ? 1 : 0) + (Math.max(-p5, p95) > lim[1].value ? 1 : 0),
                    detail: Object.assign(o.detail, { largest: r(worst, 5) }),
                    text: `The median headspeed error is ${pct(m, 2)} % of the ${hasT ? 'governor target' : 'median headspeed'}. For 90 % of the time, it is ${pct(p5, 2)} % to ${pct(p95, 2)} %. The limits are 1 % and 2 % (check ${check}).` }));
            }
        }

        // the tail output at its limit (T8): mixer[2] at the given limits, else at a pile-up in the window (health_loop limitOf)
        {
            const key = 'tail.limit', check = 'T8', u = X['mixer[2]'];
            if (!u) absent('mixer[2]', 'the time at the tail output limit', { key, check });
            else {
                const tol = 1.5, band = 20, minN = 20; // permille: health_loop RULE.limitTol 0.0015, limitBand 0.02, limitSamples 20
                let lim = p.tailLimits && (isFinite(+p.tailLimits.lo) || isFinite(+p.tailLimits.hi)) ? { lo: isFinite(+p.tailLimits.lo) && p.tailLimits.lo !== null ? +p.tailLimits.lo : null, hi: isFinite(+p.tailLimits.hi) && p.tailLimits.hi !== null ? +p.tailLimits.hi : null, source: 'given' } : null;
                if (!lim) { let lo = Infinity, hi = -Infinity; for (let i = i0; i < i1; i++) { if (u[i] < lo) lo = u[i]; if (u[i] > hi) hi = u[i]; }
                    let aL = 0, nL = 0, aH = 0, nH = 0; for (let i = i0; i < i1; i++) { const x = u[i]; if (x <= lo + tol) aL++; else if (x <= lo + band) nL++; if (x >= hi - tol) aH++; else if (x >= hi - band) nH++; }
                    lim = { lo: aL >= minN && aL >= nL ? lo : null, hi: aH >= minN && aH >= nH ? hi : null, source: 'window' }; }
                const o = { key, check, unit: 's', limits: [{ value: 0, level: 'flag' }], detail: { lo: lim.lo, hi: lim.hi, limitSource: lim.source } };
                if (lim.lo === null && lim.hi === null) add(Object.assign(o, { status: 'insufficient', text: `The app cannot find the tail output limit in the window (check ${check}).` }));
                else {
                    let atN = 0, runs = 0, prev = false;
                    for (let i = i0; i < i1; i++) { const on = (lim.lo !== null && u[i] <= lim.lo + tol) || (lim.hi !== null && u[i] >= lim.hi - tol); if (on) { atN++; if (!prev) runs++; } prev = on; }
                    add(Object.assign(o, { value: r(atN / rate, 3), n: runs, detail: Object.assign(o.detail, { periods: runs, share: r(atN / Math.max(1, len), 4) }),
                        text: atN ? `The tail output is at its limit for ${fmt(atN / rate, 2)} s in ${runs} period${runs === 1 ? '' : 's'}. Check ${check} shows a problem for 1 period or more.`
                            : `The tail output is not at its limit in the window (check ${check}).` }));
                }
            }
        }

        // D-term power at more than 30 Hz (C11 roll and pitch, F10 yaw): share of axisD power in 1 s windows (health_more F10)
        AX.forEach((axis, a) => {
            const check = axis === 'yaw' ? 'F10' : 'C11', key = `dterm.${axis}`, d = X[`axisD[${a}]`];
            if (!M) return add({ key, check, axis, status: 'notMeasured', text: `The app cannot calculate the D-term power without "health_more.cjs" (check ${check}).` });
            const hz = M.RULE.noise.hz, share = M.DEFAULT_RULES.F10.share, o = { key, check, axis, unit: 'fraction', limits: [{ value: share, level: 'flag' }], detail: { hz } };
            if (!d || !Array.prototype.some.call(d, v => v !== 0)) return absent(`axisD[${a}]`, `the ${axis} D-term power`, Object.assign(o, { limits: [] }));
            if (hz >= 0.45 * rate) return add(Object.assign(o, { status: 'insufficient', text: `The log rate of ${fmt(rate, 0)} Hz is too low for ${hz} Hz (check ${check}).` }));
            const hp = L.bandpass(d, hz, 0.45 * rate, rate), N = Math.min(len, Math.round(M.RULE.noise.windowS * rate));
            let tot = 0, hi = 0, windows = 0;
            for (let w0 = i0; w0 + N <= i1; w0 += N) { let m = 0; for (let i = w0; i < w0 + N; i++) m += d[i]; m /= N;
                for (let i = w0; i < w0 + N; i++) { tot += (d[i] - m) ** 2; hi += hp[i] ** 2; } windows++; }
            const v = tot > 0 ? r(hi / tot, 4) : null;
            add(Object.assign(o, { value: v, n: windows, detail: { hz, windowS: r(N / rate, 3), windows },
                text: v === null ? `The ${axis} D-term is constant in the window (check ${check}).` : `Of the ${axis} D-term power, ${pct(v)} % is at more than ${hz} Hz. The limit is ${pct(share, 0)} % (check ${check}).` }));
        });

        // the strongest gyro lines (F5): local maxima of the amplitude spectrum with their rotor orders
        {
            const hs = X.headspeed, rotorHz = hs ? quantile(Float64Array.from(hs.subarray(i0, i1)).sort(), 0.5) / 60 : null, count = Math.max(1, Math.round(+p.lines || WINDOW.lines));
            AX.forEach((axis, a) => {
                const key = `lines.${axis}`, check = 'F5', raw = X[`gyroRAW[${a}]`], x = raw || X[`gyroADC[${a}]`], field = raw ? `gyroRAW[${a}]` : `gyroADC[${a}]`;
                if (!x) return absent(`gyroRAW[${a}]`, `the ${axis} gyro lines`, { key, check, axis });
                if (!raw) notes.push(`The log does not record "gyroRAW[${a}]". Thus, the ${axis} gyro lines come from "gyroADC[${a}]", after the gyro filters.`);
                const o = { key, check, axis, unit: 'deg/s', status: 'information', detail: { field, rotorHz: r(rotorHz, 2) } };
                if (len < WINDOW.minLineN) return add(Object.assign(o, { status: 'insufficient', text: `The window has ${len} samples. A minimum of ${WINDOW.minLineN} samples is necessary for the gyro spectrum (check ${check}).` }));
                const N = sizeOf({}, rate, len), Wl = welch(D, [x], [], N, i0, i1), df = rate / N, A = Float64Array.from(Wl.pw[0], v => Wl.windows ? Math.sqrt(v / Wl.windows) / (N / 4) : 0);
                const k0 = Math.max(2, Math.ceil(WINDOW.lineHz / df)), k1 = Math.min(Wl.K - 3, Math.floor(0.45 * rate / df)), base = quantile(Float64Array.from(A.subarray(k0, k1 + 1)).sort(), 0.5) || 0, peaks = [];
                for (let k = k0; k <= k1; k++) if (A[k] > A[k - 1] && A[k] >= A[k + 1] && A[k] >= A[k - 2] && A[k] >= A[k + 2] && base > 0 && A[k] >= WINDOW.lineProminence * base) peaks.push(k);
                const notch = p.notchHz && Array.isArray(p.notchHz[axis]) ? p.notchHz[axis].map(Number).filter(isFinite) : null;
                const said = [], lines = peaks.sort((u, v) => A[v] - A[u]).slice(0, count).map(k => { const hz = L.spectralPeak(A, k, k).bin * df, q = { hz: r(hz, 2), amplitude: r(A[k], 3), prominence: r(A[k] / base, 1), order: rotorHz > 0 ? r(hz / rotorHz, 3) : null };
                    if (notch && notch.length) { const near = notch.reduce((b, v) => Math.abs(v - hz) < Math.abs(b - hz) ? v : b, notch[0]); q.notch = { hz: near, distance: r(Math.abs(near - hz) / hz, 4) }; }
                    said.push(`${fmt(hz)} Hz${rotorHz > 0 ? ` (${fmt(hz / rotorHz, 2)} × the rotor frequency)` : ''}`); // from the values before rounding
                    return q; });
                const list = and(said);
                add(Object.assign(o, { value: lines.length ? lines[0].amplitude : null, n: Wl.windows, detail: Object.assign(o.detail, { lines, N, df: r(df, 3), windows: Wl.windows, median: r(base, 4) }),
                    text: lines.length ? `The strongest ${axis} gyro line${lines.length > 1 ? 's are' : ' is'} at ${list}. Check ${check} uses these lines.`
                        : `The ${axis} gyro spectrum has no line of ${WINDOW.lineProminence} × its median amplitude or more (check ${check}).` }));
            });
        }
        return { t0: at(i0), t1: at(i1), seconds: r(len / rate, 3), padS: r(pad / rate, 3), items, notes: [...new Set(notes)] };
    }

    // kind -> (D, columns as Float64Array, rate, params) -> result
    const DERIVE = {
        bandpass: (D, X, rate, p) => ({ cols: each(X, p, (x) => D.lib.bandpass(x, num(p.lo, 'lo'), num(p.hi, 'hi'), rate)) }),     // lib.bandpass: zero phase, params { lo, hi, fields? }
        lowpass: (D, X, rate, p) => ({ cols: each(X, p, (x) => uses(D, 'track', 'health_track.cjs', 'lowpass').lowpass(x, num(p.hz, 'hz'), rate)) }), // health_track lowpass: zero phase, params { hz, fields? }
        pt2: (D, X, rate, p) => ({ cols: each(X, p, (x) => uses(D, 'gov', 'health_gov.cjs', 'pt2').pt2(x, num(p.hz, 'hz'), rate)) }),   // firmware pt2Filter (health_gov pt2), params { hz, fields? }
        shift: (D, X, rate, p) => { const d = num(p.ms, 'ms') * rate / 1000; return { cols: each(X, p, (x) => shifted(x, d)) }; },     // x(t + ms), params { ms, fields? }
        spectrum,      // Welch, Hann, params { N, fields? } -> { f, psd (unit^2/Hz), amplitude (of a sinusoid), windows, N }
        transmission,  // params { from, to, N, band } -> { f, gain |S_xy| / S_xx, phaseDeg, coherence, band, delayMs (health_more F11), windows, N }
        window: windowStats, // params { t0, padS, tauMs, tailLimits, notchHz, lines } -> { t0, t1, seconds, padS, items, notes }
    };

    async function derive(msg) {
        const D = await deriveKit(), fn = Object.prototype.hasOwnProperty.call(DERIVE, msg.kind) ? DERIVE[msg.kind] : null, rate = +msg.rate;
        if (!fn) throw new Error(`The function "${msg.kind}" is unknown.`);
        if (!(rate > 0 && isFinite(rate))) throw new Error('The command has no sample rate.');
        const X = {}; for (const [k, v] of Object.entries(msg.cols || {})) X[k] = v instanceof Float64Array ? v : Float64Array.from(v);
        if (!Object.keys(X).length) throw new Error('The command has no data.');
        return Object.assign({ kind: msg.kind, rate, n: Math.min(...Object.values(X).map(v => v.length)) }, fn(D, X, rate, msg.params || {}));
    }
    // export (SPEC2 D11): advice.exportScript(recs, picks, meta), the CLI file of the export panel. Text only: nothing is sent
    async function exportCli(msg) {
        const K = kit(await sources(), null);
        if (!K.advice || typeof K.advice.exportScript !== 'function') throw new Error('The toolkit file "advice.cjs" is not available, or it has no function "exportScript".');
        return K.advice.exportScript(Array.isArray(msg.recs) ? msg.recs : [], msg.picks === undefined ? null : msg.picks, msg.meta || {});
    }
    // the rate profile that a CLI dump selects at its end (`rateprofile N`, the CLI index), as health_setup parseCli gives selectedProfile
    const lastRateProfile = (text) => { const all = [...String(text || '').matchAll(/^\s*rateprofile (\d+)/gm)]; return all.length ? +all[all.length - 1][1] : null; };
    // The PID profile and the rate profile that a CLI dump selects at its end (CLI indexes), as the export puts them back. A
    // capture that is cut can end in a section, so its last `profile N` is a section, not the selection: a dump of N sections
    // has N + 1 `profile` lines (the selection last), or 1 line (one section and no other). Else null (SPEC2 C7). The same for
    // `rateprofile`
    function selectionOf(text, cli) {
        const lines = String(text || '').split(/\r?\n/).map(l => l.trim()), count = (re) => lines.filter(l => re.test(l)).length;
        const pick = (n, sections, v) => n === 1 || n === sections + 1 ? v : null;
        return { profile: pick(count(/^profile \d+/), Object.keys(cli.profiles || {}).length, cli.selectedProfile ?? null),
            rateProfile: pick(count(/^rateprofile \d+/), Object.keys(cli.rateprofiles || {}).length, lastRateProfile(text)) };
    }

    async function init() { const D = await deriveKit(); return { modules: Object.fromEntries(['track', 'more', 'gov', 'catalog'].map(k => [k, !!D[k]])), notes: D.notes.slice() }; }

    let queue = Promise.resolve();
    function onmessage(ev) {
        const msg = ev.data || {}, id = msg.id, post = (m) => self.postMessage(m);
        if (msg.cmd === 'cancel') { cancelled.add(id); return; }
        const job = { analyseLog, analyseFile, init, derive, export: exportCli, filterTune }[msg.cmd], type = { init: 'ready', derive: 'derived', export: 'exported', filterTune: 'filterTuned' }[msg.cmd] || 'result';
        queue = queue.then(() => job ? job(msg, post) : Promise.reject(new Error(`The command "${msg.cmd}" is unknown.`)))
            .then(result => post({ id, type, result }))
            .catch(e => post({ id, type: 'error', message: message(e), stack: String(e && e.stack || '') }))
            .then(() => { cancelled.delete(id); delete self.__bytes; });
    }

    return { onmessage, sources, kit, deriveKit, rpmEvidence, autoRpm, rpmWhy, viewerText, timeMapOf, hsInfo, hsMap, RPM, TIMEMAP, WINDOW, HS, READS, fresh: { readsOf, reasonsFor, measuredIn, placesIn, cutTo }, CANCELED }; // all but onmessage for tests
})();

self.onmessage = TuningWorker.onmessage;
