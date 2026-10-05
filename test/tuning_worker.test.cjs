// Tests of js/tuning_worker.js, the Tuning Lab engine. The worker script runs in a vm realm that stands in for a Web
// Worker global (importScripts, fetch and postMessage over the repo files, messages structured-cloned as postMessage
// does); the reference is the toolkit's own CLI (tools/autotune/health.cjs, health_report.cjs, extract.cjs, report.cjs)
// run as child processes on the same synthetic .bbl (test/helpers/bbl_encode.cjs).
//
//   node --test test/tuning_worker.test.cjs
//   AUTOTUNE_REAL_LOG=<Gaui dump .BBL> node --test test/tuning_worker.test.cjs     # also Gaui X4 #50 against the CLI at 2000 rpm, and the
//                                                                     # auto flight rpm of #0, #50, #51 with #0 on screen
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const bbl = require('./helpers/bbl_encode.cjs');

const REPO = path.resolve(__dirname, '..'), JS = path.join(REPO, 'js'), TK = path.join(REPO, 'tools/autotune'), WORKER = path.join(JS, 'tuning_worker.js');
const MARKER = Buffer.from('H Product:Blackbox flight data recorder by Nicholas Sherlock\n');
const J = (v) => JSON.stringify(v, (k, x) => ArrayBuffer.isView(x) ? Array.from(x) : x); // health.json text
const within = (got, want, tol, what) => assert.ok(Math.abs(got - want) <= tol, `${what}: got ${got}, want ${want} +- ${tol}`);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tuning-worker-'));
process.on('exit', () => fs.rmSync(tmp, { recursive: true, force: true }));

// Builtins that Chromium 99 (NW.js 0.62.2, the worker's runtime) lacks, deleted from the worker realm so that every test
// runs the worker and the toolkit files it fetches against Chromium 99's builtins, not Node's (first Chrome version)
const POST_CHROMIUM_99 = `(function () {
    const del = (o, keys) => { if (o) for (const k of keys) delete o[k]; };
    del(Array.prototype, ['toSorted', 'toReversed', 'toSpliced', 'with']);                                    // 110
    del(Object.getPrototypeOf(Int8Array.prototype), ['toSorted', 'toReversed', 'with']);                    // 110
    del(Object, ['groupBy']); del(Map, ['groupBy']);                                                         // 117
    del(Promise, ['withResolvers', 'try']); del(Array, ['fromAsync']); del(JSON, ['rawJSON', 'isRawJSON']); // 119, 128, 121, 114
    del(Set.prototype, ['union', 'intersection', 'difference', 'symmetricDifference', 'isSubsetOf', 'isSupersetOf', 'isDisjointFrom']); // 122
    del(String.prototype, ['isWellFormed', 'toWellFormed']); del(ArrayBuffer.prototype, ['transfer', 'transferToFixedLength', 'resize']); // 111, 114
    del(Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())), ['map', 'filter', 'take', 'drop', 'flatMap', 'reduce', 'toArray', 'forEach', 'some', 'every', 'find']); // 122
    del(RegExp, ['escape']); delete globalThis.Iterator;                                                    // 136, 122
})();`;

// A worker global: a DONT_CONTEXTIFY realm (a contextified one makes every global lookup ~100x slower) without the
// builtins newer than Chromium 99. `override` replaces fetched toolkit files by name (null: 404).
function worker(override = {}) {
    const ctx = vm.constants && vm.constants.DONT_CONTEXTIFY ? vm.createContext(vm.constants.DONT_CONTEXTIFY) : vm.createContext({});
    const run = (code, filename) => vm.runInContext(code, ctx, { filename }), pending = new Map(), progress = [];
    run(POST_CHROMIUM_99, 'chromium-99-builtins.js');
    Object.assign(ctx, {
        console: { log() {}, info() {}, warn() {}, debug() {}, error() {} }, setTimeout,
        importScripts: (...urls) => { for (const u of urls) { const f = path.resolve(JS, u); run(fs.readFileSync(f, 'utf8'), f); } },
        fetch: async (url) => {
            const f = path.resolve(JS, url), name = path.basename(f), has = Object.prototype.hasOwnProperty.call(override, name);
            const text = has ? override[name] : fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
            return text === null ? { ok: false, status: 404, text: async () => 'not found' } : { ok: true, status: 200, text: async () => text };
        },
        postMessage: (m) => { const c = structuredClone(m); if (c.type === 'progress') progress.push(c); else { const done = pending.get(c.id); pending.delete(c.id); done(c); } },
    });
    run('var self = globalThis;', 'worker-global.js');
    run(fs.readFileSync(WORKER, 'utf8'), WORKER);
    let next = 1;
    return { ctx, progress,
        send(data, bytes) { // bytes are copied into a buffer of the realm, as a transferred ArrayBuffer arrives
            const id = next++, ab = run(`new ArrayBuffer(${bytes.length})`); new Uint8Array(ab).set(bytes);
            return new Promise(resolve => { pending.set(id, resolve); ctx.onmessage({ data: Object.assign({ id, bytes: ab }, data) }); });
        },
        async result(data, bytes) { const m = await this.send(data, bytes); assert.equal(m.type, 'result', `worker error: ${m.message}\n${m.stack}`); return m.result; } };
}

// The synthetic file: a bench run, a flight with three profile switches, a rescue span and a logging gap, a log the
// parser cannot read, two more flights (one with other yaw gains), all at known governor targets, then a flight that
// logs only the fields the decoder requires (no governor, gyroRAW, servo, battery, rc or slow fields) and a log
// without headspeed
const TRUTH = { rpm: 2100, cliName: 'sim_cli.txt' }; // auto flight rpm: floor(0.85 x 2500 / 100) x 100
const CLI = `# diff all
# Rotorflight / STM32F7X2 (S7X2) 4.6.0 Jun 30 2026 / 07:20:47 (118e912) MSP API: 12.08
feature RPM_FILTER
mixer input SC -1250 1250 1070
set tail_rotor_gear_ratio = 19,77
set battery_cell_count = 6
profile 0
set gov_headspeed = 2500
profile 1
set gov_headspeed = 2700
profile 0
`;
const sim = (() => { let v = null; return () => v || (v = (() => {
    const flightA = bbl.simulateFlight({ seconds: 70, seed: 3, airborne: [6, 64], rescue: [40, 44], gapAt: 56, start: '2026-10-04T12:10:00.000+00:00',
        profiles: [{ from: 0, profile: 1, target: 2500 }, { from: 28, profile: 2, target: 2700 }, { from: 49, profile: 1, target: 2500 }] });
    const logs = [bbl.simulateFlight({ seconds: 8, seed: 2, airborne: null, start: '2026-10-04T12:00:00.000+00:00' }), flightA, { broken: true },
        bbl.simulateFlight({ seconds: 50, seed: 5, airborne: [6, 44], header: { yawPID: [80, 120, 10, 0, 0] }, start: '2026-10-04T12:20:00.000+00:00' }),
        bbl.simulateFlight({ seconds: 40, seed: 7, airborne: [6, 34], start: '2026-10-04T12:30:00.000+00:00' }),
        Object.assign(bbl.simulateFlight({ seconds: 30, seed: 9, airborne: [6, 26], start: '2026-10-04T12:40:00.000+00:00' }), { slow: null }),
        bbl.simulateFlight({ seconds: 10, seed: 11, airborne: [6, 9], start: '2026-10-04T12:50:00.000+00:00' })];
    logs[5].w.extra = {}; logs[6].w.hs = null;
    const bytes = bbl.encode(logs).bytes, file = path.join(tmp, 'sim.bbl'), cliFile = path.join(tmp, TRUTH.cliName);
    fs.writeFileSync(file, bytes); fs.writeFileSync(cliFile, CLI);
    const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length), at = []; for (let i = buf.indexOf(MARKER); i >= 0; i = buf.indexOf(MARKER, i + 1)) at.push(i);
    const slice = (li) => bytes.subarray(at[li], li + 1 < at.length ? at[li + 1] : bytes.length);
    return { bytes, file, cliFile, slice, count: at.length, flightA };
})()); })();

// the CLI, as a pilot runs it: health.cjs + health_report.cjs (and extract.cjs + report.cjs) at the flight rpm
const node = (script, args, rpm) => execFileSync(process.execPath, ['--max-old-space-size=8000', path.join(TK, script), ...args],
    { env: Object.assign({}, process.env, { AUTOTUNE_FLIGHT_RPM: String(rpm) }), stdio: ['ignore', 'ignore', 'pipe'] });
const cliHealth = (() => { let v = null; return () => v || (v = (() => {
    const S = sim(), out = path.join(tmp, 'cli');
    node('health.cjs', [out, S.file, '--cli', S.cliFile], TRUTH.rpm); node('health_report.cjs', [out], TRUTH.rpm);
    const read = (f) => fs.readFileSync(path.join(out, f), 'utf8');
    return { health: JSON.parse(read('health.json')), results: JSON.parse(read('results.json')), report: read('report.md'), out };
})()); })();
// health_report.cjs on the CLI's records of one log only
function cliReportOf(li) {
    const C = cliHealth(), dir = path.join(tmp, `cli-log${li}`); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'health.json'), J(Object.assign({}, C.health, { logs: C.health.logs.filter(l => l.log === li) })));
    node('health_report.cjs', [dir], TRUTH.rpm);
    return { results: JSON.parse(fs.readFileSync(path.join(dir, 'results.json'), 'utf8')), report: fs.readFileSync(path.join(dir, 'report.md'), 'utf8') };
}

// the part of a worker record that health.json has (health.cjs runs setup, gov, loop)
function healthPart(rec) {
    const o = Object.assign({}, rec); delete o.excluded; delete o.normalS;
    for (const k of ['metrics', 'errors']) if (o[k]) { o[k] = Object.assign({}, o[k]); delete o[k].track; delete o[k].more; }
    return o;
}
// the toolkit's findings, without what the worker adds for the app (filterPass on F5: the measured filter transmission;
// explained: a flag that every recommendation on it makes information)
const coreFindings = (F) => F.filter(f => ['setup', 'gov', 'loop', 'health'].includes(f.module)).map(f => { const o = Object.assign({}, f); delete o.filterPass; delete o.explained; return o; });
// CLI findings with their log numbers in finding texts counted from 1, as the worker gives them (TuningWorker.viewerText)
const viewerFindings = (F, TW) => F.map(f => typeof f.text === 'string' ? Object.assign({}, f, { text: TW.viewerText(f.text) }) : f);
const sameJson = (got, want, what) => assert.equal(J(got), J(want), what); // results of realm functions: compare as JSON
const logsOf = (f) => Array.isArray(f.log) ? f.log : f.log === null || f.log === undefined ? [] : [f.log];

// test modules standing in for health_track / health_more: every module sees ctx.flying, ctx.normal recorded
const STUB_TRACK = `'use strict';
const sum = (m) => { let s = 0; for (let i = 0; m && i < m.length; i++) s += m[i]; return s; };
module.exports = { EXTRA: ['rcCommand[0]'], RULE: {}, DEFAULT_RULES: {},
    analyse: (w, ctx) => ({ flyingN: sum(ctx.flying), normal: !!ctx.normal, rc: !!w.extra['rcCommand[0]'] }),
    judge: (flights) => flights.map(f => ({ id: 'C12', severity: 'note', log: f.log, profile: null, value: f.metrics.flyingN, se: null, n: 1, threshold: null, source: 'test', unit: 'samples', text: 'stub at 12.5 s', events: [{ t: 3.25, value: 1 }] })),
    curves: (w, ctx) => ({ roll: { time: { t: Float32Array.of(0, 0.1), usable: Uint8Array.of(1, 0) } } }) };`;
const STUB_MORE = `'use strict';
const sum = (m) => { let s = 0; for (let i = 0; m && i < m.length; i++) s += m[i]; return s; };
module.exports = { EXTRA: ['flightModeFlags'], RULE: {}, DEFAULT_RULES: {},
    normalMask(w, ctx) { const f = w.extra.flightModeFlags, mask = Uint8Array.from(ctx.flying, (v, i) => v && !(f && f[i] & 32) ? 1 : 0);
        return { mask, excluded: { rescueS: (sum(ctx.flying) - sum(mask)) / ctx.rate, levelModeS: 0, failsafeS: 0, groundS: 0, guardS: 0 }, notes: f ? [] : ['flightModeFlags not logged'] }; },
    analyse: (w, ctx) => ({ flyingN: sum(ctx.flying), normal: !!ctx.normal, normalN: sum(ctx.normal), flyingAllN: ctx.flyingAll ? sum(ctx.flyingAll) : null }),
    judge: () => [],
    curves: () => ({ gov: { t: Float32Array.of(0, 0.1, 0.2) } }) };`;

// ---------------------------------------------------------------------------------------------
// T0: loading
// ---------------------------------------------------------------------------------------------

test('T0: the toolkit loads through the shim with no fs call and no CLI run, and every flight rpm gets its own modules', async () => {
    const hostRpm = process.env.AUTOTUNE_FLIGHT_RPM; // a developer may have it exported (the Gaui needs 2000): kept, and a sentinel meanwhile
    process.env.AUTOTUNE_FLIGHT_RPM = 'host-sentinel';
    try {
        const W = worker(), TW = W.ctx.TuningWorker, src = await TW.sources();
        const K2000 = TW.kit(src, 2000), K3000 = TW.kit(src, 3000), K0 = TW.kit(src, null);
        for (const K of [K2000, K3000, K0]) assert.equal(K.calls.n, 0, 'fs calls while loading');
        const native = { lib: require('../tools/autotune/lib.cjs'), health: require('../tools/autotune/health.cjs'), setup: require('../tools/autotune/health_setup.cjs'),
            gov: require('../tools/autotune/health_gov.cjs'), loop: require('../tools/autotune/health_loop.cjs') };
        for (const [k, M] of Object.entries(native)) assert.deepEqual(Object.keys(k === 'lib' || k === 'health' ? K2000[k] : K2000.core[k]), Object.keys(M), `${k} exports`);
        for (const [K, rpm] of [[K2000, 2000], [K3000, 3000], [K0, 3000]]) {
            assert.equal(K.lib.FLIGHT_RPM, rpm); within(K.lib.DEFAULTS.minHeadspeed, rpm * 5 / 6, 1e-9, 'segment headspeed floor');
            assert.equal(K.health.RULE.flight.headspeed, rpm); assert.equal(K.core.gov.RULE.g12.headspeed, rpm); assert.equal(K.core.loop.RULE.flight.headspeed, rpm);
        }
        assert.equal(TW.kit(src, 2000), K2000, 'one set of modules per flight rpm');
        assert.equal(process.env.AUTOTUNE_FLIGHT_RPM, 'host-sentinel', 'the host environment is untouched');
        for (const g of ['require', 'module', 'exports', 'process']) assert.equal(vm.runInContext(`typeof ${g}`, W.ctx), 'undefined', `${g} leaked into the worker global`);
        assert.equal(vm.runInContext('typeof [].toSorted + typeof Object.groupBy + typeof new Set().union + typeof globalThis.Iterator', W.ctx), 'undefined'.repeat(4), 'the realm has Chromium 99 builtins');
        assert.equal(typeof [].toSorted, 'function', 'the test realm keeps its own');
    } finally { if (hostRpm === undefined) delete process.env.AUTOTUNE_FLIGHT_RPM; else process.env.AUTOTUNE_FLIGHT_RPM = hostRpm; }
});

// the toolkit files the worker fetches, from its REQUIRED, GAINS and OPTIONAL lists
function fetchedToolkit() {
    const src = fs.readFileSync(WORKER, 'utf8'), quoted = (s) => [...s.matchAll(/'([^']+)'/g)].map(m => m[1]);
    const dir = /const DIR = '([^']+)'/.exec(src)[1], names = ['REQUIRED', 'GAINS'].flatMap(k => quoted(new RegExp(`const ${k} = \\[([^\\]]*)\\]`).exec(src)[1]))
        .concat(quoted(/const OPTIONAL = \{([^}]*)\}/.exec(src)[1].replace(/\w+: /g, '')));
    return { src, dir, names };
}
// API calls newer than Chromium 99 (first Chrome version): copying sorts (110), groupBy (117), withResolvers (119), fromAsync
// (121), Set methods and iterator helpers (122), well-formed strings (111), RegExp.escape (136)
const POST_99_API = /\.(toSorted|toReversed|toSpliced|with)\(|\b(Object|Map)\.groupBy\b|Promise\.(withResolvers|try)\b|Array\.fromAsync|\.(union|intersection|difference|symmetricDifference|isSubsetOf|isSupersetOf|isDisjointFrom)\(|\bIterator\.|\.(isWellFormed|toWellFormed)\(|RegExp\.escape/;

test('T0: the worker is Chromium 99 syntax as written (esbuild chrome99 output equals esnext) and uses no newer API', (t) => {
    const src = fs.readFileSync(WORKER, 'utf8');
    assert.doesNotMatch(src, /\.(toSorted|toReversed|findLast|findLastIndex|at)\(|Object\.(hasOwn|groupBy)\(|structuredClone|^(const|let|class)\s/m, 'post-99 API or top-level lexical declaration');
    assert.doesNotMatch(src, POST_99_API, 'post-99 API');
    let esbuild; try { esbuild = require(path.join(REPO, 'node_modules/esbuild')); } catch (e) { t.skip('esbuild not installed'); return; }
    assert.equal(esbuild.transformSync(src, { target: 'chrome99' }).code, esbuild.transformSync(src, { target: 'esnext' }).code);
});

test('T0: the toolkit files the worker runs in Chromium 99 are Chromium 99 syntax and use no newer API', (t) => {
    const { dir, names } = fetchedToolkit();
    assert.equal(names.length, 11);
    let esbuild = null; try { esbuild = require(path.join(REPO, 'node_modules/esbuild')); } catch (e) { /* the API check still runs */ }
    for (const n of names) {
        const file = path.join(JS, `${dir}${n}.cjs`), text = fs.readFileSync(file, 'utf8');
        assert.doesNotMatch(text, POST_99_API, `${n}.cjs: post-99 API`);
        if (!esbuild) continue;
        const wrapped = `(function (require, module, exports, process, __dirname, __filename, console) {\n${text.replace(/^#![^\n]*/, '')}\n})`; // as the shim runs it
        assert.equal(esbuild.transformSync(wrapped, { target: 'chrome99' }).code, esbuild.transformSync(wrapped, { target: 'esnext' }).code, `${n}.cjs: syntax newer than Chromium 99`);
    }
    if (!esbuild) t.skip('esbuild not installed: API names checked, syntax not');
});

test('T0: every file the worker loads is a relative URL to a file that exists and is packaged (gulpfile distSources)', () => {
    const { src, dir, names } = fetchedToolkit(), gulp = fs.readFileSync(path.join(REPO, 'gulpfile.js'), 'utf8');
    const list = /(?:var distSources|APP_ASSET_SOURCES) = \[([\s\S]*?)\];/.exec(gulp)[1], quoted = (s) => [...s.matchAll(/'([^']+)'/g)].map(m => m[1]);
    const scripts = quoted(/importScripts\(([^)]*)\)/.exec(src)[1]).map(u => path.posix.join('js', u));
    const toolkit = names.map(n => path.posix.normalize(path.posix.join('js', `${dir}${n}.cjs`)));
    assert.equal(scripts.length, 12); assert.equal(names.length, 11);
    for (const f of scripts.concat(toolkit)) {
        assert.ok(!/^\/|^[a-z]+:/i.test(f) && !f.startsWith('..'), `${f} relative to the app root`);
        assert.ok(fs.existsSync(path.join(REPO, f)), `${f} exists`);
        assert.equal(list.split(`'./${f}'`).length - 1, 1, `${f} once in distSources`);
    }
});

// ---------------------------------------------------------------------------------------------
// T1: parity with the CLI
// ---------------------------------------------------------------------------------------------

// the auto flight rpm of the whole sim file: profile 0 (the arming profile, 2500 rpm) of logs 1, 3 and 4 (log 5 logs no
// govTarget), airborne 22 + 38 + 28 s with the governor ACTIVE
const FILE_RPM = { value: TRUTH.rpm, source: 'govTarget', basis: 2500, profile: 0, logs: [1, 3, 4], seconds: 88 };
const rpmOf = (fr) => Object.assign({}, fr, { seconds: Math.round(fr.seconds) });

test('T1: whole file, excludeAbnormal off: records equal health.cjs, findings and report.md equal health_report.cjs', async () => {
    const S = sim(), C = cliHealth(), W = worker(), TW = W.ctx.TuningWorker;
    const R = await W.result({ cmd: 'analyseFile', fileName: 'sim.bbl', selectedLog: 1,
        options: { flightRpm: null, cliText: CLI, cliName: TRUTH.cliName, excludeAbnormal: false, keepMetrics: true, gains: false } }, S.bytes);
    assert.deepEqual(rpmOf(R.flightRpm), FILE_RPM, 'auto flight rpm from the lowest governor target, pooled over the flown logs');
    assert.deepEqual(Object.keys(R.flightRpm), ['value', 'source', 'basis', 'profile', 'seconds', 'logs']);
    assert.ok(R.notes.some(n => n === `flight rpm 2100 = floor(0.85 x 2500 / 100) x 100: the lowest per-profile median governor target in flight (the arming profile), ${R.flightRpm.seconds} s in the air pooled from logs 2, 4, 5; 4 of 7 logs had 5 s in the air at 10 deg/s rms`), R.notes.join('\n'));
    assert.deepEqual(R.cli, { kind: 'diff', version: '4.6.0' });
    assert.equal(R.records.length, C.health.logs.length);
    R.records.forEach((rec, i) => assert.equal(J(healthPart(rec)), J(C.health.logs[i]), `record ${i} (log ${rec.log}.${rec.segment})`));
    assert.equal(J(coreFindings(R.findings)), J(viewerFindings(C.results.findings, TW)), 'findings (log numbers in texts from 1)');
    assert.equal(R.reportMarkdown, C.report, 'report.md');
    assert.ok(C.results.findings.length > 150 && C.results.findings.some(f => f.severity === 'flag'), `the CLI judged something: ${C.results.findings.length} findings`);
    assert.ok(C.health.logs.some(l => l.skipped && /^parser: /.test(l.skipped)) && C.health.logs.filter(l => l.log === 1).length === 2, 'parser error and gap are in the fixture');
    assert.ok(C.health.logs.find(l => l.log === 5).flown && /lacks .*headspeed/.test(C.health.logs.find(l => l.log === 6).skipped), 'a flight with the required fields only, a log without headspeed');
    // log numbers in finding texts count from 1 as the viewer does; "log 1000 Hz" is a logging rate
    const H = R.findings.filter(f => f.id === 'H' && f.log === 3), cliH = C.results.findings.filter(f => f.id === 'H' && f.log === 3);
    assert.ok(cliH.length && cliH.length === H.length && cliH.every((f, i) => /\(since log \d+, /.test(f.text) && H[i].text === f.text.replace(/since log (\d+)/, (m, n) => `since log ${+n + 1}`)),
        `H texts: ${J(H.map(f => f.text))} against the CLI's ${J(cliH.map(f => f.text))}`);
    assert.ok(R.findings.some(f => f.id === 'SETUP' && /; log 1000 Hz \(PID /.test(f.text)), 'SETUP logging rate unchanged');

    // the log on screen does not change what is analysed: the bench run (log 0) on screen gives the same rpm, records and findings
    const B = await W.result({ cmd: 'analyseFile', fileName: 'sim.bbl', selectedLog: 0,
        options: { flightRpm: null, cliText: CLI, cliName: TRUTH.cliName, excludeAbnormal: false, keepMetrics: true, gains: false, curves: false } }, S.bytes);
    assert.equal(B.logIndex, 0);
    sameJson(B.flightRpm, R.flightRpm, 'flight rpm with log 0 on screen');
    sameJson(B.records, R.records, 'records with log 0 on screen');
    sameJson(B.findings, R.findings, 'findings with log 0 on screen');
});

test('T1: one log at a time: records equal health.cjs, findings equal health_report.cjs over that log', async () => {
    const S = sim(), C = cliHealth(), W = worker(), TW = W.ctx.TuningWorker;
    for (let li = 0; li < S.count; li++) {
        const R = await W.result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: li, logCount: S.count,
            options: { flightRpm: TRUTH.rpm, cliText: CLI, cliName: TRUTH.cliName, excludeAbnormal: false, keepMetrics: true, curves: false } }, S.slice(li));
        assert.equal(J(R.records.map(healthPart)), J(C.health.logs.filter(l => l.log === li)), `log ${li} records`);
        const ref = cliReportOf(li);
        assert.equal(J(coreFindings(R.findings)), J(viewerFindings(ref.results.findings, TW)), `log ${li} findings`);
        assert.equal(R.reportMarkdown, ref.report, `log ${li} report.md`);
        assert.deepEqual(R.flightRpm, { value: TRUTH.rpm, source: 'user', basis: null, profile: null, seconds: null, logs: [] });
    }
});

test('T1: RESCUE_STATE events of the fixture reach lib.cjs rescueAt; the rescue switch reaches flightModeFlags', async () => {
    const S = sim(), W = worker(), TW = W.ctx.TuningWorker, K = TW.kit(await TW.sources(), TRUTH.rpm), T = S.flightA.truth;
    K.files.set('/v/a.bbl', S.slice(1));
    const segs = [...K.lib.segments(W.ctx, '/v/a.bbl', { whole: true, extra: ['flightModeFlags'] })];
    K.files.delete('/v/a.bbl');
    const sum = (v, f = (x) => x) => { let s = 0; for (let i = 0; i < v.length; i++) s += f(v[i]); return s; };
    assert.deepEqual(segs.map(w => sum(w.rescueAt)), [T.rescueStateFrames, 0], 'rescueAt: PULLUP to the end of EXIT, before the gap');
    assert.deepEqual(segs.map(w => sum(w.extra.flightModeFlags, (x) => x & 32 ? 1 : 0)), [T.rescueFrames, 0], 'RESCUE switch frames');
    assert.equal(T.rescueStateFrames - T.rescueFrames, 500, 'the state outlasts the switch by rescue_exit_time 0.5 s');
});

test('T1: gains: extract.cjs + report.cjs in the worker give the CLI decisions, groups and report', async () => {
    const S = sim(), W = worker(), out = path.join(tmp, 'cli-gains');
    node('extract.cjs', [out, S.file], TRUTH.rpm); node('report.cjs', [out], TRUTH.rpm);
    const ref = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')), md = fs.readFileSync(path.join(out, 'report.md'), 'utf8');
    const R = await W.result({ cmd: 'analyseFile', fileName: 'sim.bbl', selectedLog: 4, options: { flightRpm: TRUTH.rpm, excludeAbnormal: false, gains: true, curves: false } }, S.bytes);
    assert.ok(ref.groups.length >= 3, `report.cjs formed groups: ${ref.groups.length}`);
    assert.equal(J(R.decisions), J(ref.decisions), 'decisions');
    assert.equal(J(R.groups), J(ref.groups), 'groups');
    assert.ok(R.reportMarkdown.endsWith(`\n\n${md}`), 'report.cjs report.md follows the health report');
    assert.ok(R.timing.gainsS > 0);
    const f = W.progress.filter(p => p.id === 1).map(p => p.fraction);
    assert.ok(f.every((v, i) => v >= 0 && v <= 1 && (!i || v >= f[i - 1])), `progress fractions rise from 0 to 1: ${f.join(' ')}`);
    assert.ok(W.progress.some(p => p.stage === 'gains' && /extract\.cjs: sim\.bbl #4/.test(p.text)), 'extract.cjs progress lines reach the dialog');
});

test('T1: auto flight rpm: lowest per-profile governor target, else airborne headspeed, else the toolkit default', async () => {
    const S = sim(), W = worker(), TW = W.ctx.TuningWorker, rule = TW.kit(await TW.sources(), null).health.RULE.flight;
    const auto = async (li) => (await W.result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: li, options: { excludeAbnormal: false, curves: false } }, S.slice(li)));
    const none = { value: 3000, source: 'default', basis: null, profile: null, seconds: null, logs: [] };
    const bench = await auto(0);
    assert.deepEqual(bench.flightRpm, none);
    assert.ok(bench.notes.some(n => /^flight rpm 3000 is the toolkit default: the log has neither AIRBORNE_STATE nor governor-state events, so nothing in it marks flight\. /.test(n)), bench.notes.join('\n'));
    assert.deepEqual(rpmOf((await auto(3)).flightRpm), { value: 2100, source: 'govTarget', basis: 2500, profile: 0, seconds: 38, logs: [3] });
    const bare = (await auto(5)).flightRpm; // no govTarget logged: 0.85 x the median airborne headspeed (2500 rpm less the collective droop)
    assert.ok(bare.source === 'headspeed' && bare.value === 2100 && bare.basis > 2400 && bare.basis < 2550 && J(bare.logs) === '[5]', J(bare));
    const skipped = await auto(6);
    assert.deepEqual(skipped.flightRpm, none, 'a log the toolkit skips gives no rpm');
    assert.ok(skipped.notes.some(n => /toolkit default: the log has no decoded segment\./.test(n)), skipped.notes.join('\n'));

    // the rule on hand-made logs (12 s at 1 kHz unless n says otherwise): in the air = airborne by AIRBORNE_STATE (an airborneAt 0 somewhere),
    // else the governor ACTIVE; 5 s in the air at 10 deg/s rms (health.cjs RULE.flight less its rpm floor); per profile pooled
    const seg = (o) => { const n = o.n || 12000, f = (v) => new Float64Array(n).fill(v), air = new Uint8Array(n).fill(1);
        if (o.events !== false) air.fill(0, 0, 1000); // on the ground for the first second: the log has AIRBORNE_STATE events
        const w = { n, rate: 1000, airborneAt: air, hs: f(o.hs), profileAt: new Uint8Array(n).fill(o.profile || 0), gyro: [f(o.gyro ?? 20), f(0), f(0)],
            govStateAt: o.gov === undefined ? null : new Uint8Array(n).fill(o.gov), rescueAt: null, extra: { govTarget: o.target ? f(o.target) : null } };
        if (o.rescue) { w.rescueAt = new Uint8Array(n); w.rescueAt.fill(1, n - o.rescue.n); w.hs.fill(o.rescue.hs, n - o.rescue.n); }
        return w; };
    const rpm = (logs) => TW.autoRpm(logs.map((segs, li) => TW.rpmEvidence(segs, li)), 3000, rule);
    const at = (value, source, basis, profile, seconds, logs) => ({ value, source, basis, profile, seconds, logs });
    sameJson(rpm([[seg({ hs: 2450 })]]), at(2000, 'headspeed', 2450, 0, 11, [0]), 'airborne headspeed, rounded down to 100 rpm');
    // governor targets pooled per profile over two logs; a 0.3 s blip on a third profile is under the 1 s a target needs
    sameJson(rpm([[seg({ hs: 4000, target: 4000, gov: 4, profile: 1 })], [seg({ hs: 3500, target: 3500, gov: 4, profile: 2 }), seg({ n: 1300, hs: 1500, target: 1500, gov: 4, profile: 3 })]]),
        at(2900, 'govTarget', 3500, 2, 11, [1]), 'lowest per-profile target');
    sameJson(rpm([[seg({ hs: 4000, target: 4000, gov: 4, profile: 1 })], [seg({ n: 4500, hs: 2300, target: 2300, gov: 4, profile: 2 })]]),
        at(3400, 'govTarget', 4000, 1, 11, [0]), 'a log with 3.5 s in the air is not a flight: its target does not count');
    // a bench spool-up: no AIRBORNE_STATE events (lib marks it airborne throughout), the governor never ACTIVE
    const spool = TW.rpmEvidence([seg({ hs: 900, gov: 2, events: false, gyro: 30 })], 0);
    sameJson(TW.autoRpm([spool], 3000, rule), none, 'bench spool-up');
    assert.equal(TW.rpmWhy([spool], rule, false), 'the log has no AIRBORNE_STATE events and its governor never reached ACTIVE: a bench run');
    assert.equal(TW.rpmWhy([spool, TW.rpmEvidence([seg({ hs: 2300, events: false })], 1), TW.rpmEvidence([seg({ n: 3000, hs: 2300 })], 2)], rule, true),
        'no log of the file gives one (of 3 logs: 1 in the air under 5 s at 10 deg/s rms; 1 without AIRBORNE_STATE events and with the governor never ACTIVE (bench runs); 1 with neither AIRBORNE_STATE nor governor-state events)');
    // no AIRBORNE_STATE events but the governor ACTIVE (a log of firmware without the event): ACTIVE counts as in the air
    sameJson(rpm([[seg({ hs: 2300, target: 2300, gov: 4, events: false })]]), at(1900, 'govTarget', 2300, 0, 12, [0]), 'ACTIVE in a log without AIRBORNE_STATE');
    sameJson(rpm([[seg({ hs: 2300, target: 2300, gov: 4, events: false, gyro: 3 })]]), none, '... at 3 deg/s rms: a governor test on the bench');
    sameJson(rpm([[seg({ hs: 2300, events: false })]]), none, 'neither AIRBORNE_STATE nor governor-state events: nothing marks flight');
    // rescue is left out: 7 s of it at 1200 rpm would make the median 1200
    sameJson(rpm([[seg({ n: 14000, hs: 2450, rescue: { n: 7000, hs: 1200 } })]]), at(2000, 'headspeed', 2450, 0, 6, [0]), 'rescue left out');
    // a profile flagged airborne while spooling (5.4 s at 570 rpm, Fireball 2026-09-20 #25) is under half the median of all: no flight profile
    sameJson(rpm([[seg({ n: 6400, hs: 570, profile: 0 }), seg({ n: 60000, hs: 4200, profile: 2 })]]), at(3500, 'headspeed', 4200, 2, 59, [0]), 'spool-up profile left out');
    sameJson(rpm([[seg({ hs: 0 })]]), none, 'no headspeed');
});

// ---------------------------------------------------------------------------------------------
// T2: result schema
// ---------------------------------------------------------------------------------------------

test('T2: TuningResult schema, both scopes', async () => {
    const S = sim(), W = worker({ 'health_track.cjs': STUB_TRACK, 'health_more.cjs': STUB_MORE, 'advice.cjs': null });
    const L = await W.result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, logCount: S.count, options: {} }, S.slice(1));
    const F = await W.result({ cmd: 'analyseFile', fileName: 'sim.bbl', selectedLog: 4, options: { flightRpm: TRUTH.rpm } }, S.bytes);
    const KEYS = ['version', 'scope', 'fileName', 'logIndex', 'logs', 'flightRpm', 'cli', 'timing', 'records', 'header', 'fields', 'findings', 'decisions', 'groups', 'advice', 'curves', 'reportMarkdown', 'notes'];
    const SUMMARY = ['log', 'segment', 'start', 'durationS', 'fromS', 'seconds', 'flown', 'flyingS', 'rate', 'actualRate', 'bodyRate', 'profileSeconds', 'targetOf', 'govStateLogged', 'excluded', 'normalS', 'skipped', 'errors'];
    const RANK = { error: 0, flag: 1, note: 2, ok: 3, skipped: 4 };
    for (const [R, scope, li] of [[L, 'log', 1], [F, 'file', 4]]) {
        assert.deepEqual(Object.keys(R), KEYS, `${scope}: keys`);
        assert.equal(R.version, 1); assert.equal(R.scope, scope); assert.equal(R.fileName, 'sim.bbl'); assert.equal(R.logIndex, li);
        assert.deepEqual(R.logs, scope === 'log' ? [1] : [0, 1, 2, 3, 4, 5, 6]);
        assert.equal(R.cli, null);
        for (const k of ['decodeS', 'analyseS', 'judgeS', 'gainsS', 'totalS']) assert.ok(typeof R.timing[k] === 'number' && R.timing[k] >= 0, `timing.${k}`);
        for (const rec of R.records) assert.ok(Object.keys(rec).every(k => SUMMARY.includes(k)), `${scope}: record keys ${Object.keys(rec)}`);
        assert.equal(R.records.filter(r => r.log === 1).length, 2, 'log 1 has two segments (the gap)');
        assert.equal(R.header['Firmware revision'], 'Rotorflight 4.6.0 (sim) STM32F7X2'); assert.deepEqual(R.header.rollPID, [50, 100, 0, 100, 0]);
        for (const [k, v] of [['headspeed', 'present'], ['gyroRAW[0]', 'present'], ['mixer[2]', 'present'], ['flightModeFlags', 'present'], ['rcCommand[0]', 'present'], ['axisB[0]', 'absent'], ['EscRPM', 'absent']]) assert.equal(R.fields[k], v, `fields[${k}]`);
        R.findings.forEach((f, i) => {
            assert.ok(typeof f.module === 'string' && typeof f.id === 'string' && f.severity in RANK && Array.isArray(f.times), `finding ${i} ${J(f).slice(0, 120)}`);
            if (i) { const p = R.findings[i - 1]; assert.ok(RANK[p.severity] < RANK[f.severity] || (RANK[p.severity] === RANK[f.severity] && p.id.localeCompare(f.id, 'en', { numeric: true }) <= 0), `sorted at ${i}: ${p.severity} ${p.id}, ${f.severity} ${f.id}`); }
        });
        const stub = R.findings.filter(f => f.module === 'track');
        assert.ok(stub.length && stub.every(f => J(f.times) === J([3.25, 12.5])), 'new-module findings carry module and times (events and "at N s")');
        assert.equal(R.decisions, null); assert.equal(R.groups, null);
        assert.deepEqual(R.advice.recommendations, []); assert.deepEqual(R.advice.coverage, []); assert.match(R.advice.notes[0], /advice\.cjs is not available/);
        assert.ok(R.notes.some(n => /advice\.cjs not available \(HTTP 404\)/.test(n)), R.notes.join('\n'));
        assert.ok(R.curves.length && R.curves.every(c => c.log === li && J(Object.keys(c)) === J(['log', 'segment', 'fromS', 'seconds', 'track', 'more'])), `${scope}: curves of the selected log only`);
        assert.ok(R.curves[0].track.roll.time.t instanceof Float32Array && R.curves[0].more.gov.t.length === 3, 'curves keep their typed arrays');
        assert.ok(typeof R.reportMarkdown === 'string' && R.reportMarkdown.startsWith('# Health report'));
    }
    const stages = new Set(W.progress.map(p => p.stage));
    assert.ok([...stages].every(s => ['load', 'decode', 'analyse', 'judge', 'gains', 'advice'].includes(s)), [...stages].join());
});

// ---------------------------------------------------------------------------------------------
// The normal-flight mask (ground truth: the simulated rescue span)
// ---------------------------------------------------------------------------------------------

test('excludeAbnormal ANDs health_more.normalMask into ctx.flying for every module; rec.excluded has the seconds', async () => {
    const S = sim(), W = worker({ 'health_track.cjs': STUB_TRACK, 'health_more.cjs': STUB_MORE });
    const run = (excludeAbnormal) => W.result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, options: { flightRpm: TRUTH.rpm, cliText: CLI, excludeAbnormal, keepMetrics: true } }, S.slice(1));
    const off = await run(false), on = await run(true), rate = on.records[0].actualRate;
    const rescueS = S.flightA.truth.rescueFrames / rate; // every rescue frame of the simulation is in flight, before the gap
    within(on.records[0].excluded.rescueS, rescueS, 1e-9, 'excluded rescue seconds');
    assert.equal(on.records[1].excluded.rescueS, 0, 'no rescue after the gap');
    assert.equal(off.records[0].excluded, null);
    const m = on.records[0].metrics, m0 = off.records[0].metrics;
    assert.equal(m.more.flyingN, m0.more.flyingN - S.flightA.truth.rescueFrames, 'health_more sees the masked flying');
    assert.deepEqual([m.more.flyingAllN, m0.more.flyingAllN], [m0.more.flyingN, null], 'ctx.flyingAll: the flying before the mask (health_more D6), only with the mask');
    assert.equal(m.track.flyingN, m.more.flyingN, 'health_track sees the same mask');
    assert.ok(m.track.normal && m.more.normal && !m0.track.normal && m.more.normalN === m.more.flyingN && m.track.rc, 'ctx.normal is passed; EXTRA columns of the new modules are decoded');
    within(m.setup.flyingS, m0.setup.flyingS - rescueS, 0.051, 'health_setup flying seconds');
    assert.notEqual(J(m.loop), J(m0.loop), 'health_loop analysed the masked flight');
    assert.equal(J(off.records.map(healthPart)), J(cliHealth().health.logs.filter(l => l.log === 1)), 'with excludeAbnormal off the records stay the CLI\'s');
    within(on.records[0].normalS, m.more.flyingN / rate, 0.051, 'rec.normalS: the normal flight left'); assert.equal(off.records[0].normalS, null);
});

// health.cjs runs the loop and governor modules only on a flight (RULE.flight: 5 s at 10 deg/s rms). With too little normal
// flight left after the exclusions, the loop module does not run and the governor module sees the whole flight (the CLI's view)
test('excludeAbnormal: with under 5 s of normal flight left, loop checks do not run and governor checks see the whole flight', async () => {
    const S = sim(), none = STUB_MORE.replace('v && !(f && f[i] & 32) ? 1 : 0', '0'); // excludes every sample
    assert.notEqual(none, STUB_MORE);
    const W = worker({ 'health_track.cjs': STUB_TRACK, 'health_more.cjs': none });
    const run = (excludeAbnormal) => W.result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, options: { flightRpm: TRUTH.rpm, cliText: CLI, excludeAbnormal, keepMetrics: true } }, S.slice(1));
    const off = await run(false), on = await run(true);
    on.records.forEach((rec, i) => {
        assert.ok(rec.flown && rec.normalS === 0, `segment ${i}: flown, ${rec.normalS} s normal`);
        assert.equal(rec.metrics.loop, null, 'no loop metrics');
        assert.equal(J(rec.metrics.gov), J(off.records[i].metrics.gov), 'governor metrics over the whole flight, as health.cjs computes them');
        assert.equal(rec.metrics.track.flyingN, 0, 'the other modules keep the masked flight');
    });
    const of = (R, module) => R.findings.filter(f => f.module === module);
    assert.equal(of(on, 'loop').filter(f => logsOf(f).includes(1)).length, 0, 'no loop findings of the log');
    assert.ok(of(on, 'loop').every(f => f.log === null && /^no finding: /.test(f.text)), J(of(on, 'loop'))); // health_loop judging no flight (T4)
    assert.equal(J(of(on, 'gov')), J(of(off, 'gov')), 'the governor findings of the whole flight');
    assert.ok(of(on, 'gov').some(f => f.id === 'G0' && /PID governor running \(govSum non-zero in [1-9]\d* of /.test(f.text)), 'G0 counts in-flight samples');
    assert.ok(on.notes.includes('0 s of normal flight at 0 deg/s rms after excluding rescue, level modes, failsafe and ground contact, under the 5 s at 10 deg/s of a flight (health.cjs RULE.flight): loop checks not run, governor checks over the whole flight (log 2)'), on.notes.join('\n'));

    // the repo's health_more on a flight flown in ANGLE mode throughout: every in-flight sample is excluded
    const level = bbl.simulateFlight({ seconds: 20, seed: 13, airborne: [6, 18], level: [0, 20], start: '2026-10-04T13:00:00.000+00:00' });
    const L = await worker().result({ cmd: 'analyseLog', fileName: 'level.bbl', logIndex: 0, options: { flightRpm: TRUTH.rpm, keepMetrics: true, curves: false } }, bbl.encode([level]).bytes);
    const rec = L.records[0];
    assert.ok(level.truth.levelFrames === 20000 && rec.flown && rec.flyingS > 10 && rec.normalS === 0 && rec.excluded.levelModeS > 10, J(rec));
    assert.equal(rec.metrics.loop, null);
    assert.ok(L.findings.filter(f => f.id === 'G0').every(f => !/ in 0 of 0 /.test(f.text)), J(L.findings.filter(f => f.id === 'G0')));
    assert.ok(L.notes.some(n => /^0 s of normal flight .* loop checks not run, governor checks over the whole flight \(log 1\)$/.test(n)), L.notes.join('\n'));
});

// ---------------------------------------------------------------------------------------------
// T4: failures are findings or notes, not crashes
// ---------------------------------------------------------------------------------------------

test('T4: a module that throws becomes an error finding; one that does not load or is missing becomes a note', async () => {
    const S = sim(), loop = fs.readFileSync(path.join(TK, 'health_loop.cjs'), 'utf8') + '\nmodule.exports.analyse = () => { throw new Error("loop boom"); };\n';
    const track = STUB_TRACK.replace(/analyse: \(w, ctx\) => \(/, 'analyse: (w, ctx) => { throw new Error("track boom"); }, unused: (w, ctx) => (');
    const more = STUB_MORE.replace('judge: () => [],', 'judge: () => { throw new Error("more judge boom"); },').replace('curves: () =>', 'curves: () => { throw new Error("curves boom"); }, unused: () =>');
    const W = worker({ 'health_loop.cjs': loop, 'health_track.cjs': track, 'health_more.cjs': more, 'advice.cjs': 'module.exports = { advise() { throw new Error("advice boom"); } };' });
    const R = await W.result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, options: { flightRpm: TRUTH.rpm } }, S.slice(1));
    const err = (module, re) => R.findings.filter(f => f.module === module && f.severity === 'error' && re.test(f.text));
    assert.equal(err('loop', /^analyse failed: Error: loop boom/).length, 2, 'health_report error finding per segment');
    assert.equal(err('track', /^analyse failed: Error: track boom/).length, 2, 'track analyse error per segment');
    assert.equal(err('more', /^judge failed: more judge boom/).length, 1, 'more judge error');
    assert.ok(R.findings.some(f => f.module === 'gov' && f.severity !== 'error') && R.findings.some(f => f.module === 'setup'), 'the other modules still report');
    assert.match(R.advice.notes.join('\n'), /advice failed: advice boom/);
    assert.ok(R.notes.some(n => /health_more\.cjs curves failed: curves boom \(log 2\)/.test(n)), R.notes.join('\n'));

    const B = worker({ 'health_track.cjs': 'this is not javascript', 'health_more.cjs': null, 'advice.cjs': null });
    const R2 = await B.result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, options: { flightRpm: TRUTH.rpm } }, S.slice(1));
    for (const re of [/health_track\.cjs failed to load: /, /health_more\.cjs not available \(HTTP 404\)/, /advice\.cjs not available/, /spans are not excluded: health_more\.cjs is missing/])
        assert.ok(R2.notes.some(n => re.test(n)), `${re}: ${R2.notes.join('\n')}`);
    assert.ok(!R2.notes.some(n => /health_track still leaves rescue out/.test(n)), 'health_track did not load: no claim about it');
    const R3 = await worker({ 'health_more.cjs': null }).result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, options: { flightRpm: TRUTH.rpm, curves: false } }, S.slice(1));
    assert.ok(R3.notes.some(n => /spans are not excluded: health_more\.cjs is missing \(health_track still leaves rescue out, from RESCUE_STATE events/.test(n)), R3.notes.join('\n'));
    assert.ok(R2.curves.every(c => c.track === null && c.more === null) && R2.findings.length > 50);

    const E = worker({ 'health_gov.cjs': null });
    const m = await E.send({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, options: {} }, S.slice(1));
    assert.equal(m.type, 'error'); assert.match(m.message, /toolkit not available: tools\/autotune\/health_gov\.cjs \(HTTP 404\)/);
    const cancel = worker(), done = cancel.send({ cmd: 'analyseFile', fileName: 'sim.bbl', selectedLog: 1, options: { flightRpm: TRUTH.rpm } }, S.bytes);
    cancel.ctx.onmessage({ data: { cmd: 'cancel', id: 1 } });
    assert.equal((await done).message, 'cancelled');
});

test('T4: a toolkit file that does not parse is named; stack lines are the file\'s; a hashbang line is accepted', async () => {
    const S = sim(), log = { cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, options: { flightRpm: TRUTH.rpm, curves: false } };
    // V8 gives a syntax error no location in the module: the message names it
    const m = await worker({ 'health_loop.cjs': 'const x = ;' }).send(log, S.slice(1));
    assert.equal(m.type, 'error'); assert.match(m.message, /^tools\/autotune\/health_loop\.cjs: Unexpected token/);
    const R = await worker({ 'health_track.cjs': 'const x = ;' }).result(log, S.slice(1));
    assert.ok(R.notes.some(n => /^health_track\.cjs failed to load: Unexpected token/.test(n)), R.notes.join('\n'));
    // an error thrown while a module loads: the stack names its file and line, as Node's CommonJS loader numbers them
    const t = await worker({ 'health_loop.cjs': "'use strict';\n// line 2\nthrow new Error('boom at line 3');\n" }).send(log, S.slice(1));
    assert.equal(t.type, 'error'); assert.match(t.stack, /tools\/autotune\/health_loop\.cjs:3:\d+/);
    // a hashbang first line (fine for `node tools/autotune/x.cjs`, a syntax error inside a function body) is blanked
    const H = await worker({ 'health_track.cjs': '#!/usr/bin/env node\n' + STUB_TRACK }).result(log, S.slice(1));
    assert.ok(H.findings.some(f => f.module === 'track' && f.id === 'C12') && !H.notes.some(n => /health_track/.test(n)), H.notes.join('\n'));
    // gains: report.cjs that does not parse is named in the note
    const G = await worker({ 'report.cjs': 'const x = ;' }).result({ cmd: 'analyseFile', fileName: 'one.bbl', selectedLog: 0, options: { flightRpm: TRUTH.rpm, gains: true, curves: false } }, S.slice(4));
    assert.ok(G.decisions === null && G.notes.some(n => /^gains not analysed: tools\/autotune\/report\.cjs: Unexpected token/.test(n)), G.notes.join('\n'));
});

test('a file with no flight: the toolkit default rpm, why, and gains not analysed for want of a segment (not a TypeError)', async () => {
    const S = sim(), R = await worker().result({ cmd: 'analyseFile', fileName: 'bench.bbl', selectedLog: 0, options: { flightRpm: null, gains: true, curves: false } }, S.slice(0));
    assert.deepEqual(R.flightRpm, { value: 3000, source: 'default', basis: null, profile: null, seconds: null, logs: [] });
    assert.ok(R.notes.some(n => n.startsWith('flight rpm 3000 is the toolkit default: no log of the file gives one (of 1 log: 1 with neither AIRBORNE_STATE nor governor-state events). ')), R.notes.join('\n'));
    assert.equal(R.decisions, null);
    assert.ok(R.notes.includes('gains not analysed: extract.cjs found no segment (airborne outside rescue, one PID profile, no logging gap, 20 s or more at a median headspeed of 2500 rpm or more: 5/6 of the flight rpm 3000)'), R.notes.join('\n'));
});

test('finding texts count logs from 1 as the viewer does; a logging rate is not a log number', () => {
    const TW = worker().ctx.TuningWorker;
    for (const [text, want] of [
        ['yaw wag 7.12 Hz (log 32 profile 2, P x mean stop gain/I/D 55/120/14) vs 7.86 Hz (log 40 profile 1, P x mean stop gain/I/D 50/120/14)',
            'yaw wag 7.12 Hz (log 33 profile 2, P x mean stop gain/I/D 55/120/14) vs 7.86 Hz (log 41 profile 1, P x mean stop gain/I/D 50/120/14)'], // health_loop T4
        ['droop 2.10 % +- 0.30 % over 12 rises (worst 4.52 % at log 38 127.938 s); 0 at the throttle ceiling', 'droop 2.10 % +- 0.30 % over 12 rises (worst 4.52 % at log 39 127.938 s); 0 at the throttle ceiling'], // health_gov G3
        ['yawPID: 100,140,14,0,0 -> 80,120,10,0,0 (since log 0, start profile 1)', 'yawPID: 100,140,14,0,0 -> 80,120,10,0,0 (since log 1, start profile 1)'], // health_setup H
        ['Rotorflight 4.6.0 (sim) STM32F7X2; log 1000 Hz (PID 1000, gyro 8000, decimation 500 Hz)', null], ['log 333.3 Hz', null], ['3 logging gaps; a catalog 5', null]])
        assert.equal(TW.viewerText(text), want === null ? text : want);
});

test('advice gets the selected log, its arming profile, viewer log numbering and the log dates; its CLI script comes back', async () => {
    const S = sim(), echo = `'use strict';
module.exports = { advise: (i) => ({ recommendations: [{ id: 'X', severity: 'action', cli: ['set x = 1'] }], coverage: [{ area: 'logging' }],
    notes: [JSON.stringify({ headerLog: i.headerLog, headerProfile: i.headerProfile, logBase: i.logBase, logs: i.logs.map(l => [l.log, l.start]) })] }),
    script: (recs) => recs.map(r => r.cli.join('\\n')).join('\\n') + '\\nsave' };`;
    const R = await worker({ 'advice.cjs': echo }).result({ cmd: 'analyseFile', fileName: 'sim.bbl', selectedLog: 4, options: { flightRpm: TRUTH.rpm, curves: false, keepMetrics: true } }, S.bytes);
    const got = JSON.parse(R.advice.notes[0]), arming = R.records.find(r => r.log === 4).metrics.setup.startProfile;
    assert.deepEqual([got.headerLog, got.headerProfile, got.logBase], [4, arming, 1], 'the selected log, its setup startProfile, viewer numbering');
    assert.deepEqual(got.logs.find(l => l[0] === 3), [3, '2026-10-04T12:20:00.000+00:00'], 'record start as a date');
    assert.ok(got.logs.some(l => l[0] === 2 && l[1] === null), 'the parser-error record has no start');
    assert.equal(R.advice.script, 'set x = 1\nsave', 'result.advice.script is advice.script(recommendations)');
});

test('the toolkit modules as they are in the repo (health_track, health_more, advice when present) run end to end', async () => {
    const S = sim(), W = worker(), R = await W.result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, logCount: S.count, options: { flightRpm: TRUTH.rpm } }, S.slice(1));
    // these files are being written in parallel: whatever state they are in, the engine reports their outcome
    for (const [name, file] of [['track', 'health_track.cjs'], ['more', 'health_more.cjs'], ['advice', 'advice.cjs']]) {
        if (!fs.existsSync(path.join(TK, file))) { assert.ok(R.notes.some(n => n.startsWith(`${file} not available`)), `${file} missing is noted`); continue; }
        if (R.notes.some(n => n.startsWith(`${file} failed to load`))) continue;
        if (name === 'advice') { assert.ok(Array.isArray(R.advice.recommendations) && Array.isArray(R.advice.coverage));
            assert.equal(R.advice.script, require('../tools/autotune/advice.cjs').script(R.advice.recommendations), 'advice.script of the recommendations'); }
        else assert.ok(R.findings.some(f => f.module === name), `${file}: findings (or error findings) of module ${name}`);
    }
    assert.ok(R.findings.length > 50 && R.records.length === 2);
});

// ---------------------------------------------------------------------------------------------
// T3: a real log (opt-in)
// ---------------------------------------------------------------------------------------------

// the Gaui X4 II flash dump of 2026-10-04 (RTFL_BLACKBOX_LOG_20261004_113720.BBL, 59 logs): AUTOTUNE_REAL_LOG is its path
const GAUI = process.env.AUTOTUNE_REAL_LOG || '';
test('T3: Gaui X4 #50 equals the CLI at 2000 rpm (AUTOTUNE_REAL_LOG)', { skip: !GAUI || !fs.existsSync(GAUI) }, async () => {
    const all = fs.readFileSync(GAUI), at = []; for (let i = all.indexOf(MARKER); i >= 0; i = all.indexOf(MARKER, i + 1)) at.push(i);
    const li = 50, bytes = new Uint8Array(all.subarray(at[li], at[li + 1])), dir = path.join(tmp, 'gaui'), file = path.join(dir, path.basename(GAUI)), out = path.join(dir, 'out');
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, bytes); // the CLI on this log alone (a whole-file run reads gyro_decimation_hz of log #0: decoder bug)
    node('health.cjs', [out, file], 2000); node('health_report.cjs', [out], 2000);
    const H = JSON.parse(fs.readFileSync(path.join(out, 'health.json'), 'utf8')), F = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')).findings;
    // the slice is log 0 of its own file to the CLI; labelled the same here, everything else must match to the byte
    const W = worker(), R = await W.result({ cmd: 'analyseLog', fileName: path.basename(GAUI), logIndex: 0, logCount: 1, options: { flightRpm: 2000, excludeAbnormal: false, keepMetrics: true } }, bytes);
    assert.equal(J(R.records.map(healthPart)), J(H.logs), 'records');
    assert.equal(J(coreFindings(R.findings)), J(viewerFindings(F, W.ctx.TuningWorker)), 'findings (log numbers in texts from 1)');
    assert.ok(H.logs[0].flown && F.length > 50, `#50 is a flight: ${H.logs[0].flyingS} s, ${F.length} findings`);
    // the 4.06 x rotor line flags F5 without a CLI dump; measured, the filters pass almost none of it (the peer's VIB-T21: 0.0-0.2 %)
    const f5 = R.findings.find(f => f.id === 'F5' && f.severity === 'flag'), line = f5 && f5.filterPass && f5.filterPass.find(q => Math.abs(q.hz - 155.7) < 1);
    assert.ok(line && ['roll', 'pitch', 'yaw'].every(ax => line[ax] !== null && line[ax] < 0.05), J(f5 && f5.filterPass));
    const rec = R.advice.recommendations.find(r => r.id === 'F5');
    assert.deepEqual([rec.severity, rec.cli], ['info', []]);
    assert.match(rec.title, /already filtered out/);
    assert.equal(f5.explained, rec.title, 'the F5 flag is explained by its information-only recommendation');
});

// the viewer opens the first log of a file, here the RF 4.4 bench log #0: the file's flight rpm must still come from its flights
test('T3: Gaui X4 #0, #50, #51 in file scope with the bench log #0 on screen: flight rpm 1900 from the 2300 rpm target (AUTOTUNE_REAL_LOG)', { skip: !GAUI || !fs.existsSync(GAUI) }, async () => {
    const all = fs.readFileSync(GAUI), at = []; for (let i = all.indexOf(MARKER); i >= 0; i = all.indexOf(MARKER, i + 1)) at.push(i);
    const bytes = new Uint8Array(Buffer.concat([0, 50, 51].map(li => all.subarray(at[li], at[li + 1]))));
    const R = await worker().result({ cmd: 'analyseFile', fileName: 'gaui_0_50_51.bbl', selectedLog: 0, options: { flightRpm: null, gains: false, curves: false } }, bytes);
    assert.deepEqual([R.flightRpm.value, R.flightRpm.source, R.flightRpm.basis, R.flightRpm.logs], [1900, 'govTarget', 2300, [1, 2]], JSON.stringify(R.flightRpm));
    assert.deepEqual(R.records.map(r => r.flown), [false, true, true], 'the bench log is not a flight, #50 and #51 are');
    assert.ok(R.records[1].flyingS > 60 && R.records[2].flyingS > 75, J(R.records.map(r => r.flyingS)));
});
