'use strict';

/**
 * Tuning Lab engine: a Web Worker that runs the offline tuning toolkit (tools/autotune/*.cjs) unchanged, off the UI
 * thread, on one log or on every log of a file.
 *
 * The decoder scripts load with importScripts, as lib.loadApp loads them; the toolkit's .cjs files are fetched as text
 * and evaluated by a small CommonJS shim: require over the fetched sources, node:fs an in-memory Map, node:path posix,
 * node:vm onto this global. FLIGHT_RPM is read once when lib.cjs loads, so every flight rpm gets its own set of
 * modules. Health records are built as health.cjs builds them (lines 76-92); health_report.cjs, extract.cjs and
 * report.cjs run as "virtual CLIs" over the in-memory fs, so their findings, decisions and reports are the CLI's.
 * Nothing here talks to a flight controller.
 *
 *   main -> worker  { cmd: 'analyseLog', id, bytes (ArrayBuffer of ONE log), logIndex, logCount, fileName, options }
 *                   { cmd: 'analyseFile', id, bytes (ArrayBuffer of the whole file), fileName, selectedLog, options }
 *                   { cmd: 'cancel', id }   (honoured between logs; terminating the worker always works)
 *   options         { flightRpm: number | null (auto), cliText, cliName, excludeAbnormal: true, curves: true,
 *                     gains: false (file only: extract.cjs + report.cjs), keepMetrics: false (tests: full records) }
 *   worker -> main  { id, type: 'progress', stage, fraction, text } | { id, type: 'result', result } | { id, type: 'error', message, stack }
 *
 * result (TuningResult): { version: 1, scope, fileName, logIndex, logs, flightRpm: { value, source: user | govTarget | headspeed | default, basis,
 *   profile, seconds, logs: [the logs the basis was pooled from] }, cli: { kind, version } | null,
 *   timing: { decodeS, analyseS, judgeS, gainsS, totalS }, records, header, fields, findings, decisions, groups,
 *   advice: { recommendations, coverage, notes, script }, curves, reportMarkdown, notes }
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
    const OPTIONAL = { track: 'health_track', more: 'health_more', advice: 'advice' };
    const CORE = ['setup', 'gov', 'loop'];                                 // health.cjs MODULES, in its order
    const SUMMARY = ['log', 'segment', 'start', 'durationS', 'fromS', 'seconds', 'flown', 'flyingS', 'rate', 'actualRate', 'bodyRate', // result.records[]
        'profileSeconds', 'targetOf', 'govStateLogged', 'excluded', 'normalS', 'skipped', 'errors'];          // normalS: s left by excludeAbnormal (else null)
    const RANK = { error: 0, flag: 1, note: 2, ok: 3, skipped: 4 };      // health_report.cjs:99
    const r = (v, d = 3) => (typeof v === 'number' && isFinite(v)) ? +v.toFixed(d) : null; // health.cjs:21
    const toJson = (v) => JSON.stringify(v, (k, x) => ArrayBuffer.isView(x) ? Array.from(x) : x); // health.json (health.cjs:106-107)
    const pick = (o, keys) => Object.fromEntries(keys.filter(k => k in o).map(k => [k, o[k]]));
    const seconds = (ms) => r(ms / 1000, 2);
    const basename = (p) => String(p).split(/[\\/]/).pop();
    const message = (e) => String(e && e.message || e);

    // ---------------------------------------------------------------------------------------------
    // Toolkit sources and the CommonJS shim
    // ---------------------------------------------------------------------------------------------

    // every .cjs file as text once per worker: { texts: { 'lib.cjs': text }, missing: { 'advice.cjs': why } }
    let fetched = null;
    function sources() {
        const get = (name) => fetch(`${DIR}${name}.cjs`, { cache: 'no-cache' })
            .then(res => res.ok ? res.text() : Promise.reject(new Error(`HTTP ${res.status}`)))
            .then(text => [name, text, null], e => [name, null, message(e)]);
        fetched = fetched || Promise.all(REQUIRED.concat(GAINS, Object.values(OPTIONAL)).map(get)).then(list => {
            const src = { texts: {}, missing: {} };
            for (const [name, text, why] of list) if (text === null) src.missing[`${name}.cjs`] = why; else src.texts[`${name}.cjs`] = text;
            const lost = REQUIRED.filter(n => !src.texts[`${n}.cjs`]);
            if (lost.length) { fetched = null; throw new Error(`toolkit not available: ${lost.map(n => `tools/autotune/${n}.cjs (${src.missing[`${n}.cjs`]})`).join(', ')}`); }
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

    // The library modules for one flight rpm (null: the toolkit default), loaded once: lib, health and the three health
    // modules as health.cjs wires them, plus the new modules when they load
    const kits = new Map();
    function kit(src, rpm) {
        const key = rpm || 0;
        if (kits.has(key)) return kits.get(key);
        const reg = registry(src.texts, { rpm }), K = { rpm: rpm || null, files: reg.files, calls: reg.calls, notes: [] };
        K.lib = reg.require('./lib.cjs'); K.health = reg.require('./health.cjs');
        K.core = Object.fromEntries(CORE.map(m => [m, reg.require(`./health_${m}.cjs`)]));
        for (const [name, base] of Object.entries(OPTIONAL)) {
            const file = `${base}.cjs`;
            if (!src.texts[file]) { K.notes.push(`${file} not available (${src.missing[file]}): its checks${name === 'advice' ? ' and recommendations' : ''} are missing`); continue; }
            try { K[name] = reg.require(`./${file}`); } catch (e) { K.notes.push(`${file} failed to load: ${message(e).replace(`tools/autotune/${file}: `, '')}`); }
        }
        K.EXTRA = [...new Set(Object.values(K.core).flatMap(m => m.EXTRA).concat(['govTarget']))]; // health.cjs:70
        K.extraAll = [...new Set(K.EXTRA.concat(...[K.track, K.more].map(M => M && Array.isArray(M.EXTRA) ? M.EXTRA : [])))];
        K.analysers = Object.assign({}, K.core, K.track ? { track: K.track } : {}, K.more ? { more: K.more } : {});
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
    // the air: airborne by AIRBORNE_STATE where the log has those events; in a log without them, where lib.cjs marks every
    // frame airborne (a bench run as much as a flight), the governor ACTIVE; with neither event nothing marks flight. Per
    // profile: the governor target in the air while ACTIVE (any state without GOVSTATE events), and the headspeed in the air.
    function rpmEvidence(segs, li) {
        const live = segs.filter(w => !w.skipped), add = (P, p, v, s) => { const x = P[p] || (P[p] = { values: [], seconds: 0 }); x.values.push(v); x.seconds += s; };
        const ev = { log: li, segments: live.length, airborneEvents: live.some(w => w.airborneAt.some(v => !v)), govLogged: live.some(w => !!w.govStateAt), active: false, airS: 0, bodyRate: 0, gt: {}, hs: {} };
        let n = 0, turn = 0;
        for (const w of live) {
            const step = Math.max(1, Math.round(w.rate / RPM.perSecond)), dt = step / (w.flight && w.flight.actualRate || w.rate), gt = w.extra.govTarget, gs = w.govStateAt;
            for (let i = 0; i < w.n; i += step) {
                const active = gs ? gs[i] === 4 : null;
                if (active) ev.active = true;
                if ((w.rescueAt && w.rescueAt[i]) || !(ev.airborneEvents ? w.airborneAt[i] : active)) continue;
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
        const kind = (e) => !e.segments ? 'undecoded' : !e.airborneEvents && !e.govLogged ? 'noEvents' : !e.airborneEvents && !e.active ? 'bench'
            : !flownBy(rule)(e) ? 'notFlown' : 'noMedian';
        const medians = `no profile median of ${RPM.minRpm} rpm or more held ${RPM.targetS} s (governor target) or ${RPM.headspeedS} s (headspeed)`;
        if (!file) { const e = evidence[0] || { segments: 0 };
            return { undecoded: 'the log has no decoded segment', noEvents: 'the log has neither AIRBORNE_STATE nor governor-state events, so nothing in it marks flight',
                bench: 'the log has no AIRBORNE_STATE events and its governor never reached ACTIVE: a bench run',
                notFlown: `${r(e.airS, 1)} s in the air at ${r(e.bodyRate, 1)} deg/s rms, under the ${rule.minS} s at ${rule.rate} deg/s of a flight (health.cjs RULE.flight)${e.airborneEvents ? '' : '; in the air = governor ACTIVE, as the log has no AIRBORNE_STATE events'}`,
                noMedian: `the log had ${r(e.airS, 1)} s in the air at ${r(e.bodyRate, 1)} deg/s rms, but ${medians}` }[kind(e)]; }
        if (!evidence.length) return 'the file has no log';
        const n = {}; for (const e of evidence) n[kind(e)] = (n[kind(e)] || 0) + 1;
        const parts = [[n.notFlown, `in the air under ${rule.minS} s at ${rule.rate} deg/s rms`], [n.bench, 'without AIRBORNE_STATE events and with the governor never ACTIVE (bench runs)'],
            [n.noEvents, 'with neither AIRBORNE_STATE nor governor-state events'], [n.noMedian, `in the air long enough, with ${medians}`], [n.undecoded, 'not decoded']].filter(x => x[0]);
        return `no log of the file gives one (of ${evidence.length} log${evidence.length === 1 ? '' : 's'}: ${parts.map(([c, t]) => `${c} ${t}`).join('; ')})`;
    }

    // ---------------------------------------------------------------------------------------------
    // One log: decode and records
    // ---------------------------------------------------------------------------------------------

    // lib.segments(whole) on the bytes of one log, relabelled as log li of the file; error: the parser's, as health.cjs:96-101
    function decode(K, bytes, fileName, li, extra = K.extraAll) {
        const file = `/v/${fileName}`, segs = [];
        K.files.set(file, bytes);
        try { for (const w of K.lib.segments(self, file, { whole: true, extra })) { w.flight.log = li; segs.push(w); } }
        finally { K.files.delete(file); delete self.__bytes; }
        let err = false;
        if (!segs.length) { const log = new FlightLog(bytes); err = log.getLogCount() ? log.getLogError(0) : 'no log in these bytes'; }
        return { segs, error: err ? `parser: ${err}` : null };
    }

    // The record of one segment exactly as health.cjs:80-91 builds it, plus the new modules (track, more) and, with
    // excludeAbnormal, ctx.flying ANDed with more.normalMask for every module (ctx.normal the mask, ctx.flyingAll the flying
    // before it; rec.excluded: seconds per reason; rec.normalS: the seconds left). health.cjs runs the loop and governor modules only on a flight (RULE.flight: minS s at rate deg/s
    // rms); when the normal flight left fails that gate, the loop module does not run and the governor module sees the whole
    // flight, as health.cjs gives it (its FALLBACK and Vbat checks are of the whole log, and the exclusions are for the rate
    // loops: setpoint is logged before the rescue and level overrides, pid.c:813-839)
    function analyseSegment(K, w, o, J) {
        const fl = w.flight, H = K.health;
        const rec = { id: fl.id, file: fl.file, log: fl.log, segment: o.segment, start: fl.start, durationS: r(fl.durationS, 1), gaps: fl.gaps, rate: fl.rate, actualRate: r(fl.actualRate, 2), header: fl.header };
        if (w.skipped) { rec.skipped = w.skipped; return { rec, ctx: null }; }
        const rate = fl.actualRate, target = w.extra.govTarget || w.hs, { p: profile, targetOf } = K.lib.profilesOf(w, target, H.RULE.flight.headspeed);
        const { flying, up, bodyRate, flown } = H.flightMask(w, rate), profileSeconds = H.profileSeconds(flying, profile, rate);
        Object.assign(rec, { fromS: r(w.fromS, 3), seconds: r(w.seconds, 1), n: w.n, flown, flyingS: r(flown ? up / rate : 0, 1), bodyRate: r(bodyRate, 1), targetOf, profileSeconds, govStateLogged: !!w.govStateAt, metrics: {}, errors: {} });
        const ctx = H.buildCtx(w, fl, { flying, profile, cli: o.cli, cliParsed: o.cliParsed, app: self });
        let excluded = null, normalS = null, thin = false;
        if (o.excludeAbnormal && flown && K.more) {
            try {
                const N = K.more.normalMask(w, Object.assign({}, ctx)), masked = Uint8Array.from(flying, (v, i) => v & N.mask[i]);
                let left = 0, turn = 0; for (let i = 0; i < w.n; i++) if (masked[i]) { left++; turn += w.gyro[0][i] ** 2 + w.gyro[1][i] ** 2 + w.gyro[2][i] ** 2; }
                ctx.normal = N.mask; ctx.flying = masked; ctx.flyingAll = flying; excluded = N.excluded; normalS = r(left / rate, 1); // flyingAll: the health.cjs mask, for health_more D6
                for (const t of N.notes || []) J.notes.add(t, fl.log);
                const F = H.RULE.flight, leftRate = left ? Math.sqrt(turn / left) : 0;
                thin = !(left / rate >= F.minS && leftRate >= F.rate);
                if (thin) J.notes.add(`${normalS} s of normal flight at ${r(leftRate, 1)} deg/s rms after excluding rescue, level modes, failsafe and ground contact, under the ${F.minS} s at ${F.rate} deg/s of a flight (health.cjs RULE.flight): loop checks not run, governor checks over the whole flight`, fl.log);
            } catch (e) { rec.errors.more = `normalMask: ${e && e.stack || e}`; J.notes.add(`health_more.cjs normalMask failed, analysed without exclusions: ${message(e)}`, fl.log); }
        }
        for (const [name, M] of Object.entries(K.analysers)) {
            if ((name !== 'setup' && !flown) || (thin && name === 'loop')) { rec.metrics[name] = null; continue; }
            J.progress(`log ${fl.log + 1}: ${name}`);
            const c = Object.assign({}, ctx); if (thin && name === 'gov') { c.flying = flying; delete c.normal; }
            try { rec.metrics[name] = M.analyse(w, c); } catch (e) { rec.errors[name] = String(e && e.stack || e); }
        }
        rec.excluded = excluded; rec.normalS = normalS;
        return { rec, ctx };
    }

    // a record as health.json has it: only the modules health.cjs runs (health_report.cjs judges these)
    function asHealthJson(rec) {
        const out = Object.assign({}, rec); delete out.excluded; delete out.normalS;
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

    // records, curves, header and fields of one decoded log; parser errors are kept apart (health.cjs puts them last)
    function addLog(J, d, li, selected) {
        if (d.error) { J.errorRecords.push({ id: `${J.fileName}|${li}|error`, file: J.fileName, log: li, segment: 0, skipped: d.error }); return; }
        const airborneEvents = d.segs.some(w => !w.skipped && w.airborneAt.some(v => !v));
        for (const w of d.segs) {
            const seg = J.segCount.get(w.flight.id) || 0; J.segCount.set(w.flight.id, seg + 1);
            const t = Date.now(), { rec, ctx } = analyseSegment(J.K, w, { segment: seg, cli: J.cliText, cliParsed: J.cliParsed, excludeAbnormal: J.o.excludeAbnormal }, J);
            J.ms.analyse += Date.now() - t;
            J.records.push(rec);
            if (rec.flown && !airborneEvents) J.notes.add(`no AIRBORNE_STATE events: lib.cjs counts every frame as airborne, so this log is a flight by headspeed (${J.rpm.value} rpm or more) and body rate alone, and may be a ground run`, li);
            if (!selected) continue;
            if (!J.header) J.header = JSON.parse(toJson(w.flight.header));
            if (!J.fields && !w.skipped) { J.fields = fieldsOf(J.K, w, rec); J.headerProfile = startProfile(rec); }
            if (J.o.curves) J.curves.push(curvesOf(J, w, ctx, rec));
        }
    }

    const startProfile = (l) => l.metrics && l.metrics.setup ? l.metrics.setup.startProfile : null; // the arming profile, whose gains the header holds

    function curvesOf(J, w, ctx, rec) {
        const out = { log: rec.log, segment: rec.segment, fromS: r(w.fromS, 3), seconds: r(w.seconds, 1), track: null, more: null };
        for (const name of ['track', 'more']) {
            const M = J.K[name];
            if (!M || !rec.metrics || !rec.metrics[name]) continue;
            try { out[name] = M.curves(w, Object.assign({}, ctx), rec.metrics[name]); } catch (e) { J.notes.add(`${OPTIONAL[name]}.cjs curves failed: ${message(e)}`, rec.log); }
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
        const K = J.K, records = J.records.concat(J.errorRecords), files = new Map(), lines = [];
        files.set('/v/health.json', toJson({ files: [J.fileName], cli: J.cliText ? J.o.cliName || 'CLI dump' : null, rule: K.health.RULE, extra: K.EXTRA, logs: records.map(asHealthJson) }));
        runCli(src, K.rpm, 'health_report.cjs', ['/v'], files, (l) => lines.push(l));
        for (const l of lines) if (/^RULES/.test(l)) J.notes.add(`health_report.cjs: ${l}`);
        const findings = JSON.parse(files.get('/v/results.json')).findings;
        for (const name of ['track', 'more']) {
            const M = K[name];
            if (!M) continue;
            const flights = JSON.parse(toJson(records.filter(l => l.metrics && l.metrics[name]).map(l => ({ log: l.log, start: l.start, header: l.header, metrics: l.metrics[name] })))), add = [];
            try { for (const f of M.judge(flights, M.DEFAULT_RULES)) add.push(Object.assign({ module: name }, f)); }
            catch (e) { add.push({ module: name, id: name.toUpperCase(), severity: 'error', log: null, text: `judge failed: ${message(e)}` }); }
            for (const l of records) if (l.errors && l.errors[name]) add.push({ module: name, id: name.toUpperCase(), severity: 'error', log: l.log, text: `analyse failed: ${l.errors[name].split('\n')[0]}` });
            for (const f of add) { f.times = timesOf(f); findings.push(f); }
        }
        for (const f of findings) if (typeof f.text === 'string') f.text = viewerText(f.text);
        return { findings: findings.sort(bySeverity), markdown: files.get('/v/report.md') };
    }

    // extract.cjs then report.cjs on the whole file, as `node extract.cjs /v/out <file>` and `node report.cjs /v/out`
    function gains(J, src, bytes) {
        const lost = GAINS.filter(n => !src.texts[`${n}.cjs`]);
        if (lost.length) { J.notes.add(`gains not analysed: ${lost.map(n => `${n}.cjs (${src.missing[`${n}.cjs`]})`).join(', ')} not available`); return null; }
        const files = new Map([[`/v/${J.fileName}`, bytes]]), count = J.logCount || 1, D = J.K.lib.DEFAULTS;
        try {
            let found = null; // extract.cjs ends with "<n> flights, <n> segments, <n> skipped -> <file>"
            runCli(src, J.K.rpm, 'extract.cjs', ['/v/out', `/v/${J.fileName}`], files, (l) => {
                const s = /^\d+ flights, (\d+) segments,/.exec(l); if (s) found = +s[1];
                const m = /#(\d+)/.exec(l); J.progress(`extract.cjs: ${l}`, 'gains', m ? 0.6 + 0.3 * Math.min(1, (+m[1] + 1) / count) : null); });
            delete self.__bytes; files.delete(`/v/${J.fileName}`);
            if (found === 0) { J.notes.add(`gains not analysed: extract.cjs found no segment (airborne outside rescue, one PID profile, no logging gap, ${D.minSegmentS} s or more at a median headspeed of ${r(D.minHeadspeed, 0)} rpm or more: 5/6 of the flight rpm ${J.rpm.value})`); return null; }
            runCli(src, J.K.rpm, 'report.cjs', ['/v/out'], files);
        } catch (e) { J.notes.add(`gains not analysed: ${message(e)}`); return null; }
        finally { delete self.__bytes; }
        const res = JSON.parse(files.get('/v/out/results.json'), (k, v) => k === 'jack' ? undefined : v); // as report.cjs writes it
        return { decisions: res.decisions || [], groups: res.groups || [], markdown: files.get('/v/out/report.md') };
    }

    // logs[].start orders the tuning history (H staleness); a log without a clock date (0000-01-01, no RTC) gets none,
    // so advice treats every header change as possibly later. logBase 1: advice numbers logs as the viewer does.
    const dated = (s) => typeof s === 'string' && /^[1-9]\d{3}-/.test(s) ? s : null;
    function adviseAll(J, findings, decisions) {
        const A = J.K.advice;
        if (!A) return { recommendations: [], coverage: [], notes: ['advice.cjs is not available: no recommendations'], script: '' };
        const input = JSON.parse(toJson({ findings, decisions, header: J.header, cli: J.cliParsed, fields: J.fields, headerProfile: J.headerProfile, headerLog: J.logIndex, logBase: 1,
            logs: J.records.concat(J.errorRecords).map(l => ({ log: l.log, segment: l.segment, start: dated(l.start), flown: !!l.flown, flyingS: l.flyingS || 0, profileSeconds: l.profileSeconds || {},
                targetOf: l.targetOf || {}, excluded: l.excluded || null, skipped: l.skipped || null, startProfile: startProfile(l) })) }));
        try { const a = JSON.parse(toJson(A.advise(input))), recommendations = a.recommendations || [];
            return { recommendations, coverage: a.coverage || [], notes: a.notes || [], script: typeof A.script === 'function' ? A.script(recommendations) : '' }; }
        catch (e) { J.notes.add(`advice failed: ${message(e)}`); return { recommendations: [], coverage: [], notes: [`advice failed: ${message(e)}`], script: '' }; }
    }

    // ---------------------------------------------------------------------------------------------
    // Jobs
    // ---------------------------------------------------------------------------------------------

    function notesList() { // a note per text, with the logs it applies to, numbered from 1 as the viewer shows them
        const m = new Map();
        return { add(text, log) { if (!m.has(text)) m.set(text, []); if (typeof log === 'number' && !m.get(text).includes(log)) m.get(text).push(log); },
            list: () => [...m].map(([t, logs]) => logs.length ? `${t} (log ${logs.map(l => l + 1).join(', ')})` : t) };
    }

    const cancelled = new Set();
    const checkpoint = (id) => new Promise(resolve => setTimeout(resolve, 0)).then(() => { if (cancelled.has(id)) throw new Error('cancelled'); });

    async function begin(msg, post, scope) {
        const o = Object.assign({ flightRpm: null, cliText: null, cliName: null, excludeAbnormal: true, curves: true, gains: false, keepMetrics: false }, msg.options || {});
        if (!(typeof o.flightRpm === 'number' && o.flightRpm > 0 && isFinite(o.flightRpm))) o.flightRpm = null;
        if (!msg.bytes) throw new Error('no log bytes in the message');
        const J = { id: msg.id, o, scope, fileName: basename(msg.fileName || 'log.bbl'), t0: Date.now(), ms: { decode: 0, analyse: 0, judge: 0, gains: 0 }, fraction: 0,
            notes: notesList(), records: [], errorRecords: [], curves: [], segCount: new Map(), header: null, fields: null, headerProfile: null, cliText: o.cliText || null, cliParsed: null };
        J.progress = (text, stage = 'analyse', fraction = null) => { if (fraction !== null) J.fraction = fraction; post({ id: J.id, type: 'progress', stage, fraction: r(J.fraction, 3), text }); };
        J.progress('loading the toolkit', 'load', 0.01);
        J.src = await sources();
        J.bytes = ArrayBuffer.isView(msg.bytes) ? new Uint8Array(msg.bytes.buffer, msg.bytes.byteOffset, msg.bytes.byteLength) : new Uint8Array(msg.bytes);
        return J;
    }

    // the flight rpm (user, or auto from the evidence) and its modules; parses the CLI dump with them. why: the reason of a
    // default (rpmWhy)
    function settle(J, rpm, why) {
        J.rpm = rpm; J.K = kit(J.src, rpm.source === 'default' ? null : rpm.value);
        for (const t of J.K.notes) J.notes.add(t);
        if (J.o.excludeAbnormal && !J.K.more) J.notes.add('rescue, level-mode, failsafe and ground-contact spans are not excluded: health_more.cjs is missing' +
            (J.K.track ? ' (health_track still leaves rescue out, from RESCUE_STATE events; the setup, governor and loop checks do not)' : ''));
        if (rpm.source === 'default') J.notes.add(`flight rpm ${rpm.value} is the toolkit default: ${why}. In the air = airborne by AIRBORNE_STATE, or the governor ACTIVE in a log without those events; set the flight rpm below the lowest governor target if this rotor flies slower`);
        if (J.cliText) try { J.cliParsed = J.K.core.setup.parseCli(J.cliText); } catch (e) { J.notes.add(`CLI dump not read: ${message(e)}`); }
    }

    const userRpm = (J) => J.o.flightRpm ? { value: J.o.flightRpm, source: 'user', basis: null, profile: null, seconds: null, logs: [] } : null;
    const basisKind = { govTarget: 'governor target', headspeed: 'headspeed' };

    // file scope, auto: the evidence of every log (decoded with only govTarget as an extra column), so the flight rpm is the
    // file's, whichever log is on screen
    async function fileRpm(J, count, slice, from, to) {
        const K = kit(J.src, null), rule = K.health.RULE.flight, evidence = [];
        for (let li = 0; li < count; li++) {
            await checkpoint(J.id);
            J.progress(`flight rpm: log ${li + 1} of ${count}`, 'decode', from + (to - from) * li / count);
            evidence.push(rpmEvidence(timedDecode(J, K, slice(li), li, ['govTarget']).segs, li));
        }
        const rpm = autoRpm(evidence, K.lib.FLIGHT_RPM, rule);
        settle(J, rpm, rpmWhy(evidence, rule, true));
        if (rpm.source !== 'default') J.notes.add(`flight rpm ${rpm.value} = floor(${RPM.share} x ${rpm.basis} / ${RPM.step}) x ${RPM.step}: the lowest per-profile median ${basisKind[rpm.source]} in flight (${rpm.profile ? `profile ${rpm.profile}` : 'the arming profile'}), ` +
            `${rpm.seconds} s in the air pooled from log${rpm.logs.length > 1 ? 's' : ''} ${rpm.logs.map(l => l + 1).join(', ')}; ${evidence.filter(flownBy(rule)).length} of ${count} logs had ${rule.minS} s in the air at ${rule.rate} deg/s rms`);
    }
    function timedDecode(J, K, bytes, li, extra) { const t = Date.now(); try { return decode(K, bytes, J.fileName, li, extra); } finally { J.ms.decode += Date.now() - t; } }

    // F5 flags of a log with curves: what the gyro filters pass of each line, measured (health_more curves vib.pass,
    // gyroRAW -> gyroADC, the flag's profile when it has its own spectrum): the largest over the line's bin and its
    // neighbours, per axis. advice.cjs reads it before proposing a notch
    function filterPass(J, findings) {
        for (const f of findings) {
            if (f.id !== 'F5' || f.severity !== 'flag') continue;
            const c = J.curves.filter(c => c.log === f.log && c.more && c.more.vib && !c.more.vib.filtOnly).sort((a, b) => b.more.vib.windows - a.more.vib.windows)[0];
            if (!c) continue;
            const v = c.more.vib, S = (v.byProfile && v.byProfile[f.profile]) || v;
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

    // a flag that every recommendation citing it makes information (advice.cjs, e.g. an F5 line the filters already
    // remove) is explained: the dialog shows it as report-only, with that recommendation's title
    function explain(findings, recs) {
        const key = (f) => `${f.module || null}|${f.id}|${JSON.stringify(f.log === undefined ? null : f.log)}|${f.profile === undefined ? null : f.profile}|${f.text}`, by = new Map();
        for (const r of recs) for (const e of r.evidence || []) { const k = key(e); if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
        for (const f of findings) { const rs = f.severity === 'flag' && by.get(key(f)); if (rs && rs.every(r => r.severity === 'info')) f.explained = rs[0].title; }
    }

    function finish(J, judged, gained) {
        J.progress('recommendations', 'advice', 0.97);
        if (J.o.curves) filterPass(J, judged.findings);
        const advice = adviseAll(J, judged.findings, gained ? gained.decisions : null);
        explain(judged.findings, advice.recommendations);
        const records = J.records.concat(J.errorRecords).map(l => J.o.keepMetrics ? l : pick(l, SUMMARY));
        return { version: 1, scope: J.scope, fileName: J.fileName, logIndex: J.logIndex, logs: J.logs, flightRpm: J.rpm,
            cli: J.cliParsed ? { kind: J.cliParsed.kind, version: J.cliParsed.version } : null,
            timing: { decodeS: seconds(J.ms.decode), analyseS: seconds(J.ms.analyse), judgeS: seconds(J.ms.judge), gainsS: seconds(J.ms.gains), totalS: seconds(Date.now() - J.t0) },
            records, header: J.header, fields: J.fields, findings: judged.findings, decisions: gained ? gained.decisions : null, groups: gained ? gained.groups : null,
            advice, curves: J.o.curves ? J.curves : null, reportMarkdown: judged.markdown + (gained ? `\n\n${gained.markdown}` : ''), notes: J.notes.list() };
    }

    function judgeTimed(J) { const t = Date.now(); J.progress('judging', 'judge', J.o.gains && J.scope === 'file' ? 0.57 : 0.9); try { return judgeAll(J, J.src); } finally { J.ms.judge += Date.now() - t; } }

    async function analyseLog(msg, post) {
        const J = await begin(msg, post, 'log'), li = +msg.logIndex || 0;
        J.logIndex = li; J.logs = [li]; J.logCount = msg.logCount || null;
        J.progress(`decoding log ${li + 1}${J.logCount ? ` of ${J.logCount}` : ''}`, 'decode', 0.05);
        const rpm = userRpm(J), d = timedDecode(J, kit(J.src, rpm && rpm.value), J.bytes, li);
        if (rpm) settle(J, rpm);
        else { const K0 = kit(J.src, null), rule = K0.health.RULE.flight, evidence = [rpmEvidence(d.segs, li)];
            settle(J, autoRpm(evidence, K0.lib.FLIGHT_RPM, rule), rpmWhy(evidence, rule, false)); }
        J.progress(`analysing log ${li + 1} at flight rpm ${J.rpm.value}`, 'analyse', 0.15);
        addLog(J, d, li, true);
        d.segs.length = 0;
        await checkpoint(J.id);
        return finish(J, judgeTimed(J), null);
    }

    async function analyseFile(msg, post) {
        const J = await begin(msg, post, 'file'), idx = new FlightLogIndex(J.bytes), count = idx.getLogCount();
        const sel = Math.min(Math.max(0, +msg.selectedLog || 0), Math.max(0, count - 1)), slice = (i) => J.bytes.subarray(idx.getLogBeginOffset(i), idx.getLogBeginOffset(i + 1));
        J.logIndex = sel; J.logs = [...Array(count).keys()]; J.logCount = count;
        const rpm = userRpm(J), end = J.o.gains ? 0.55 : 0.85, start = rpm ? 0.03 : 0.03 + 0.3 * (end - 0.03); // auto: a first pass over every log
        if (rpm) settle(J, rpm); else await fileRpm(J, count, slice, 0.03, start);
        for (let li = 0; li < count; li++) {
            await checkpoint(J.id);
            J.progress(`log ${li + 1} of ${count}: decoding`, 'decode', start + (end - start) * li / count);
            const d = timedDecode(J, J.K, slice(li), li);
            addLog(J, d, li, li === sel);
        }
        await checkpoint(J.id);
        const judged = judgeTimed(J);
        let gained = null;
        if (J.o.gains) { await checkpoint(J.id); const t = Date.now(); J.progress('gains: extract.cjs over the file', 'gains', 0.6); gained = gains(J, J.src, J.bytes); J.ms.gains += Date.now() - t; }
        return finish(J, judged, gained);
    }

    let queue = Promise.resolve();
    function onmessage(ev) {
        const msg = ev.data || {}, id = msg.id, post = (m) => self.postMessage(m);
        if (msg.cmd === 'cancel') { cancelled.add(id); return; }
        const job = { analyseLog, analyseFile }[msg.cmd];
        queue = queue.then(() => job ? job(msg, post) : Promise.reject(new Error(`unknown command ${msg.cmd}`)))
            .then(result => post({ id, type: 'result', result }))
            .catch(e => post({ id, type: 'error', message: message(e), stack: String(e && e.stack || '') }))
            .then(() => { cancelled.delete(id); delete self.__bytes; });
    }

    return { onmessage, sources, kit, rpmEvidence, autoRpm, rpmWhy, viewerText, RPM }; // all but onmessage for tests
})();

self.onmessage = TuningWorker.onmessage;
