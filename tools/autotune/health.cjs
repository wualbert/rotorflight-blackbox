'use strict';

/**
 * Health checks of every log, start to end: governor/ESC/power (health_gov), cyclic and tail loops (health_loop),
 * data validity and filter setup (health_setup). Measurements only; health_report.cjs judges them.
 *
 *   node --max-old-space-size=12000 tools/autotune/health.cjs <out dir> <log files...> [--cli <cli dump>]
 *
 * Writes <out dir>/health.json. A flight found in an earlier file (the same flight in two flash dumps) is read once.
 * In flight = airborne with the rotor at or above RULE.flight.headspeed, in a log with at least RULE.flight.minS s of
 * that whose body rate there is at least RULE.flight.rate deg/s rms (wag.cjs). The loop and governor modules run only on
 * logs that were flown; the setup module runs on every log.
 *
 * With --cli, the dump is parsed once (health_setup.parseCli) and its per-profile gov_headspeed and gov_max_throttle and
 * its battery_cell_count reach the governor module (cliContext). CLI profile q is log profile q + 1 (the log's
 * PID-profile event value is 1-based, as health_setup D4 maps it).
 */

const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const lib = require('./lib.cjs');
const r = (v, d = 3) => (typeof v === 'number' && isFinite(v)) ? +v.toFixed(d) : null;
const MODULES = { setup: require('./health_setup.cjs'), gov: require('./health_gov.cjs'), loop: require('./health_loop.cjs') };

const RULE = { flight: { headspeed: lib.FLIGHT_RPM, rate: 10, minS: 5 } }; // as wag.cjs RULE.flight; comparisons are >=

// in-flight mask of a whole segment: airborne and headspeed >= RULE.flight.headspeed; all zero unless the log was flown
function flightMask(w, rate, rule = RULE.flight) {
    const n = w.n, flying = new Uint8Array(n); let up = 0, turn = 0;
    for (let i = 0; i < n; i++) if (w.airborneAt[i] && w.hs[i] >= rule.headspeed) { flying[i] = 1; up++; turn += w.gyro[0][i] ** 2 + w.gyro[1][i] ** 2 + w.gyro[2][i] ** 2; }
    const bodyRate = up ? Math.sqrt(turn / up) : 0, flown = up / rate >= rule.minS && bodyRate >= rule.rate;
    if (!flown) flying.fill(0);
    return { flying, up, bodyRate, flown };
}

// in-flight seconds per profile, summed unrounded and rounded once
function profileSeconds(flying, profile, rate) {
    const n = flying.length, count = {};
    for (let i = 0; i < n; i++) if (flying[i]) count[profile[i]] = (count[profile[i]] || 0) + 1;
    return Object.fromEntries(Object.entries(count).map(([p, c]) => [p, r(c / rate, 1)]));
}

// per-profile governor settings of a parsed CLI dump, keyed by log profile (CLI profile + 1)
function cliContext(cli) {
    const out = {}; if (!cli) return out;
    const gh = {}, mt = {};
    for (const [q, set] of Object.entries(cli.profiles || {})) { const p = +q + 1;
        if (typeof set.gov_headspeed === 'number' && set.gov_headspeed > 0) gh[p] = set.gov_headspeed;
        if (typeof set.gov_max_throttle === 'number' && set.gov_max_throttle > 0) mt[p] = set.gov_max_throttle; }
    if (Object.keys(gh).length) { out.govHeadspeed = gh; out.govHeadspeedSource = `CLI gov_headspeed (${cli.kind})`; }
    if (Object.keys(mt).length) { out.maxThrottle = mt; out.maxThrottleSource = `CLI gov_max_throttle (${cli.kind})`; }
    const c = cli.global && cli.global.battery_cell_count;
    if (typeof c === 'number' && c > 0) { out.cells = c; out.cellsSource = 'CLI battery_cell_count'; }
    return out;
}

// the context every module gets
function buildCtx(w, fl, { flying, profile, cli, cliParsed, app }) {
    return Object.assign({ flying, profile, govState: w.govStateAt || null, rate: fl.actualRate, header: fl.header, cli, app, flightRule: RULE.flight }, cliContext(cliParsed));
}

module.exports = { RULE, flightMask, profileSeconds, cliContext, buildCtx };
if (require.main !== module) return;

const args = process.argv.slice(2), ci = args.indexOf('--cli');
const cliFile = ci >= 0 ? args.splice(ci, 2)[1] : null;
const [OUT, ...FILES] = args;
if (!OUT || !FILES.length) { console.error('usage: node health.cjs <out dir> <log files...> [--cli <cli dump>]'); process.exit(2); }

const app = lib.loadApp(), cli = cliFile ? fs.readFileSync(cliFile, 'utf8') : null, cliParsed = cli ? MODULES.setup.parseCli(cli) : null;
const EXTRA = [...new Set(Object.values(MODULES).flatMap(m => m.EXTRA).concat(['govTarget']))];
const seen = new Map(), logs = [], t0 = Date.now();

FILES.forEach((file, fi) => {
    const segCount = new Map();
    for (const w of lib.segments(app, file, { whole: true, extra: EXTRA })) {
        const fl = w.flight, label = FILES.length > 1 ? `${fi + 1}:${fl.log}` : fl.log;
        if (seen.has(fl.id) && seen.get(fl.id) !== file) continue;
        seen.set(fl.id, file);
        const seg = segCount.get(fl.id) || 0; segCount.set(fl.id, seg + 1);
        const rec = { id: fl.id, file: fl.file, log: label, segment: seg, start: fl.start, durationS: r(fl.durationS, 1), gaps: fl.gaps, rate: fl.rate, actualRate: r(fl.actualRate, 2), header: fl.header };
        if (w.skipped) { rec.skipped = w.skipped; logs.push(rec); console.error(`${fl.file.slice(-19)} #${fl.log}: skipped, ${w.skipped}`); continue; }
        const t1 = Date.now(), n = w.n, rate = fl.actualRate, x = w.extra;
        const target = x.govTarget || w.hs, { p: profile, targetOf } = lib.profilesOf(w, target, RULE.flight.headspeed);
        const { flying, up, bodyRate, flown } = flightMask(w, rate), seconds = profileSeconds(flying, profile, rate);
        Object.assign(rec, { fromS: r(w.fromS, 3), seconds: r(w.seconds, 1), n, flown, flyingS: r(flown ? up / rate : 0, 1), bodyRate: r(bodyRate, 1), targetOf, profileSeconds: seconds, govStateLogged: !!w.govStateAt, metrics: {}, errors: {} });
        const ctx = buildCtx(w, fl, { flying, profile, cli, cliParsed, app });
        for (const [name, M] of Object.entries(MODULES)) {
            if (name !== 'setup' && !flown) { rec.metrics[name] = null; continue; }
            try { rec.metrics[name] = M.analyse(w, Object.assign({}, ctx)); }
            catch (e) { rec.errors[name] = String(e && e.stack || e); console.error(`  ${name} failed: ${e && e.message}`); }
        }
        logs.push(rec);
        console.error(`${fl.file.slice(-19)} #${fl.log}${seg ? ` segment ${seg}` : ''}: ${(n / rate).toFixed(0)} s, ${flown ? `${rec.flyingS} s in flight` : 'not a flight'}, ${(Date.now() - t1) / 1000} s`);
    }
    // logs that lib.segments passes over without a word: the ones the parser cannot open
    app.__bytes = new Uint8Array(fs.readFileSync(file));
    const all = vm.runInContext('new FlightLog(__bytes)', app);
    for (let li = 0; li < all.getLogCount(); li++) {
        const err = all.getLogError(li); if (!err) continue;
        logs.push({ id: `${path.basename(file)}|${li}|error`, file: path.basename(file), log: FILES.length > 1 ? `${fi + 1}:${li}` : li, segment: 0, skipped: `parser: ${err}` });
        console.error(`${path.basename(file).slice(-19)} #${li}: skipped, parser: ${err}`);
    }
});

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'health.json'), JSON.stringify({ files: FILES.map(f => path.basename(f)), cli: cliFile ? path.basename(cliFile) : null, rule: RULE, extra: EXTRA, logs },
    (k, v) => ArrayBuffer.isView(v) ? Array.from(v) : v));
console.error(`${logs.length} logs, ${logs.filter(l => l.flown).length} flown, ${logs.filter(l => Object.keys(l.errors || {}).length).length} with errors, ${(Date.now() - t0) / 1000} s -> ${path.join(OUT, 'health.json')}`);
