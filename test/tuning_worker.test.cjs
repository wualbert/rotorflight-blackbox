// Tests of js/tuning_worker.js, the Tuning Lab engine. The worker script runs in a vm realm that stands in for a Web
// Worker global (importScripts, fetch and postMessage over the repo files, messages structured-cloned as postMessage
// does); the reference is the toolkit's own CLI (tools/autotune/health.cjs, health_report.cjs, extract.cjs, report.cjs)
// run as child processes on the same synthetic .bbl (test/helpers/bbl_encode.cjs). The derive command is tested against
// the toolkit functions it calls and against signals of known content.
//
//   node --test test/tuning_worker.test.cjs
//   AUTOTUNE_REAL_LOG=<Gaui dump .BBL> node --test test/tuning_worker.test.cjs     # also Gaui X4 #50 against the CLI at 2000 rpm, its
//                                                                     # time map against the frame clock, and the auto flight rpm
//                                                                     # of #0, #50, #51 with #0 on screen
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
const has = (file) => fs.existsSync(path.join(TK, file)); // the modules of the other parts, written in parallel: tests that need one skip without it

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
// builtins newer than Chromium 99. `override` replaces fetched toolkit files by name (null: 404). fetches: the URLs fetched.
function worker(override = {}) {
    const ctx = vm.constants && vm.constants.DONT_CONTEXTIFY ? vm.createContext(vm.constants.DONT_CONTEXTIFY) : vm.createContext({});
    const run = (code, filename) => vm.runInContext(code, ctx, { filename }), pending = new Map(), progress = [], fetches = [];
    run(POST_CHROMIUM_99, 'chromium-99-builtins.js');
    Object.assign(ctx, {
        console: { log() {}, info() {}, warn() {}, debug() {}, error() {} }, setTimeout,
        importScripts: (...urls) => { for (const u of urls) { const f = path.resolve(JS, u); run(fs.readFileSync(f, 'utf8'), f); } },
        fetch: async (url) => {
            fetches.push(url);
            const f = path.resolve(JS, url), name = path.basename(f), own = Object.prototype.hasOwnProperty.call(override, name);
            const text = own ? override[name] : fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
            return text === null ? { ok: false, status: 404, text: async () => 'not found' } : { ok: true, status: 200, text: async () => text };
        },
        postMessage: (m) => { const c = structuredClone(m); if (c.type === 'progress') progress.push(c); else { const done = pending.get(c.id); pending.delete(c.id); done(c); } },
    });
    run('var self = globalThis;', 'worker-global.js');
    run(fs.readFileSync(WORKER, 'utf8'), WORKER);
    let next = 1;
    return { ctx, progress, fetches,
        post(data) { const id = next++; return new Promise(resolve => { pending.set(id, resolve); ctx.onmessage({ data: Object.assign({ id }, data) }); }); },
        send(data, bytes) { // bytes are copied into a buffer of the realm, as a transferred ArrayBuffer arrives
            const ab = run(`new ArrayBuffer(${bytes.length})`); new Uint8Array(ab).set(bytes);
            return this.post(Object.assign({ bytes: ab }, data));
        },
        async result(data, bytes) { const m = await this.send(data, bytes); assert.equal(m.type, 'result', `worker error: ${m.message}\n${m.stack}`); return m.result; },
        async derive(kind, cols, rate, params) { const m = await this.post({ cmd: 'derive', kind, rate, cols, params }); assert.equal(m.type, 'derived', `derive error: ${m.message}\n${m.stack}`); return m.result; } };
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
    return { bytes, file, cliFile, slice, count: at.length, flightA, logs };
})()); })();
// D12: the same file without the field govRequest (a log without the governor fields, or a firmware before 4.6): the headspeed
// step of the PID profile at the start has no data, so the governor target gives only an estimate
const simNoRequest = (() => { let v = null; return () => v || (v = (() => {
    const logs = sim().logs.map(l => l.broken ? l : Object.assign({}, l, { w: Object.assign({}, l.w, { extra: Object.fromEntries(Object.entries(l.w.extra || {}).filter(([k]) => k !== 'govRequest')) }) }));
    const bytes = bbl.encode(logs).bytes, buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length), at = []; for (let i = buf.indexOf(MARKER); i >= 0; i = buf.indexOf(MARKER, i + 1)) at.push(i);
    return { bytes, slice: (li) => bytes.subarray(at[li], li + 1 < at.length ? at[li + 1] : bytes.length) };
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

// the part of a worker record that health.json has (health.cjs runs setup, gov, loop); the worker adds the time map, the
// phases and profiles (SPEC2 D12, D13) and the spans evidence.cjs locates
const APP_RECORD = ['excluded', 'normalS', 'timeMap', 'logClass', 'phases', 'flights', 'phaseSeconds', 'profiles', 'noData', 'noDataReason'];
function healthPart(rec) {
    const o = Object.assign({}, rec); for (const k of APP_RECORD) delete o[k];
    for (const k of ['metrics', 'errors']) if (o[k]) { o[k] = Object.assign({}, o[k]); for (const m of ['track', 'more', 'phase', 'rescue', 'limits', 'config', 'power', 'locate']) delete o[k][m]; }
    return o;
}
// the toolkit's findings, without what the worker adds for the app: fid, summary, node, evidence (SPEC2 3.6), phase, phases
// and pidProfile (D13, D12), cliSection (D4: the CLI section compared), rateChanges (R1 in a log with rate profile changes),
// filterPass on F5 (the measured filter transmission), explained (a flag that every recommendation on it makes information)
const APP_FIELDS = ['fid', 'summary', 'evidence', 'node', 'tuner', 'area', 'phase', 'phases', 'pidProfile', 'cliSection', 'rateChanges', 'explained', 'filterPass', 'status', 'noun', 'display', 'dataset', 'datasetLabel', 'stale'];
const coreDecisions = (D) => D && D.map(d => { const o = Object.assign({}, d); delete o.fid; delete o.evidence; delete o.stale; return o; });
const coreFindings = (F) => F.filter(f => ['setup', 'gov', 'loop', 'health'].includes(f.module)).map(f => { const o = Object.assign({}, f); for (const k of APP_FIELDS) delete o[k]; return o; });
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
// test modules standing in for catalog.cjs, hierarchy.cjs and evidence.cjs (SPEC2 3.1-3.3): each gives back what the worker passed it
const STUB_CATALOG = `'use strict';
module.exports = { CHECKS: { C12: { noun: 'tracking error' } }, summary: (f) => 'Check ' + f.id + ': summary.', status: () => 'monitor' };`;
const STUB_HIERARCHY = `'use strict';
module.exports = { homeOf: (id, axis) => 'node:' + id + ':' + axis,
    status: (findings, recs, o) => ({ nodes: { n: { status: 'problem', fids: findings.filter(f => f.severity === 'flag').map(f => f.fid) } }, startHere: ['n'],
        seen: { findings: findings.length, complete: findings.filter(f => f.fid && f.summary && f.node && f.evidence).length, recs: recs.map(r => r.id), logs: o.logs.map(l => l.log), coverage: Array.isArray(o.coverage) } }) };`;
const STUB_EVIDENCE = `'use strict';
module.exports = {
    locate: (w, ctx, metrics) => ({ n: w.n, fromS: w.fromS, modules: Object.keys(metrics).filter(k => metrics[k]), flyingGov: !!ctx.flyingGov }),
    forFinding: (f, ctx) => { const rec = ctx.record; return { v: 1, fid: f.fid, id: f.id, log: rec ? rec.log : null, segment: rec ? rec.segment : null,
        locate: rec && rec.metrics ? rec.metrics.locate || null : null, timeMap: !!(rec && rec.timeMap), metrics: !!(rec && rec.metrics && rec.metrics[f.module]),
        others: Object.keys(ctx.others).map(Number), curves: ctx.curves ? [ctx.curves.log, ctx.curves.segment] : null, findings: ctx.findings.length, spans: [] }; } };`;
// a stand-in for health_phase.cjs (SPEC2 section 6: phases(w, ctx), flightMask(w, ctx), the health module contract): a flight
// is each AIRBORNE_STATE run of 3 s or more less LIFT_S (1 s) at the start and DOWN_S (1 s) at the end (liftoff after the flag
// sets, touchdown before it drops); out of flight: ACTIVE is ground, SPOOLUP spool-up, after the last touchdown spool-down, else
// idle. code: the phase index of each sample (health_phase PHASES order), not enumerable, as health_phase gives it
const STUB_PHASE = `'use strict';
const SHRINK_S = 1, LIFT_S = 1, DOWN_S = 1, NAMES = ['idle', 'spoolup', 'ground', 'flight', 'spooldown'], sum = (m) => { let s = 0; for (let i = 0; m && i < m.length; i++) s += m[i]; return s; };
function phases(w, ctx) {
    const n = w.n, rate = ctx.rate, k = Math.round(SHRINK_S * rate), kl = Math.round(LIFT_S * rate), kd = Math.round(DOWN_S * rate), air = w.airborneAt, events = ctx.airborneEvents !== undefined ? ctx.airborneEvents : air.some(v => !v), fl = new Uint8Array(n), lift = [], down = [], flights = [];
    if (events) for (let i = 0; i < n;) { if (!air[i]) { i++; continue; } let j = i; while (j < n && air[j]) j++;
        if (j - i >= 2 * k + rate) { fl.fill(1, i + kl, j - kd); lift.push(i + kl); down.push(j - kd); flights.push({ i0: i + kl, i1: j - kd, method: 'stub', confidence: 0.9, liftoffBy: 'airborne' }); } i = j; }
    const last = down.length ? down[down.length - 1] : -1, g = w.govStateAt;
    const label = (i) => fl[i] ? 'flight' : g && g[i] === 4 ? 'ground' : g && g[i] === 2 ? 'spoolup' : last >= 0 && i >= last ? 'spooldown' : 'idle';
    const spans = [], code = new Uint8Array(n); for (let i = 0; i < n;) { const p = label(i); let j = i + 1; while (j < n && label(j) === p) j++; spans.push({ phase: p, i0: i, i1: j }); code.fill(NAMES.indexOf(p), i, j); i = j; }
    return Object.defineProperty({ flight: flights.length > 0, spans, liftoffs: lift, touchdowns: down, flights }, 'code', { value: code, enumerable: false });
}
function flightMask(w, ctx) { const P = ctx.phases || phases(w, ctx), m = new Uint8Array(w.n); for (const q of P.spans) if (q.phase === 'flight') m.fill(1, q.i0, q.i1); return m; }
module.exports = { EXTRA: ['time'], RULE: { shrinkS: SHRINK_S }, DEFAULT_RULES: {}, phases, flightMask,
    analyse: (w, ctx) => ({ flyingN: sum(ctx.flying), flightN: sum(ctx.flightMask), spans: ctx.phases ? ctx.phases.spans.length : null }),
    judge: (flights) => flights.map(f => ({ id: 'D7', severity: 'note', log: f.log, profile: null, phase: 'all', value: f.metrics.flightN, se: null, n: 1, threshold: null, source: 'test', unit: 'samples', thin: false, text: 'stub D7' })),
    curves: () => ({ strip: Float32Array.of(1, 2) }) };`;
// the stub with other ends of each flight: liftoff `lift` s after the airborne flag sets, touchdown `down` s before it drops
const stubPhaseAt = (lift, down) => STUB_PHASE.replace('LIFT_S = 1, DOWN_S = 1,', `LIFT_S = ${lift}, DOWN_S = ${down},`);
// the stub in this process, for the truth of the tests
const stubPhase = (() => { const m = { exports: {} }; new Function('module', 'exports', STUB_PHASE)(m, m.exports); return m.exports; })();
const NO_APP_MODULES = { 'catalog.cjs': null, 'hierarchy.cjs': null, 'evidence.cjs': null, 'health_phase.cjs': null };
const NO_PHASE = { 'health_phase.cjs': null }; // tests that are not about the flight phases stay the same when health_phase.cjs is in the repo

// the frame seconds of an index time through a time map of js/tuning_worker.js timeMapOf (knots every `every` samples, the
// last sample, both sides of each frame-time jump), as the reference for evidence.cjs toFrame when that module is absent. The
// modules round their times to 1 ms, about one sample: an index time half a sample or less before a jump is of the sample after
// it (the D2 event of a stall is that sample; strictly before the jump, Gaui #50 83.728 s would map 25.5 ms early)
function toFrameRef(tm, tIndex) {
    const E = tm.every, N = tm.frameS.length, last = tm.n - 1, i = (tIndex - tm.fromS) * tm.actualRate;
    if (i <= 0) return tm.frameS[0] + i / tm.actualRate;
    if (i >= last) return tm.endS + (i - last) / tm.actualRate;
    const k = Math.min(N - 1, Math.floor(i / E));
    let a = k * E, sa = tm.frameS[k], b = k + 1 < N ? (k + 1) * E : last, sb = k + 1 < N ? tm.frameS[k + 1] : tm.endS;
    for (const [j, s0, s1] of tm.jumps) { if (j <= a || j > b) continue; if (i >= j - 0.5) { a = j; sa = s1; } else { b = j - 1; sb = s0; } }
    return b === a ? sa + (i - a) / tm.actualRate : sa + (i - a) / (b - a) * (sb - sa);
}
const toFrameOf = () => has('evidence.cjs') ? require('../tools/autotune/evidence.cjs').toFrame : toFrameRef;
// the largest |frame seconds of the map - the frame clock| over the samples of a decoded segment w (every `step`-th)
function mapError(tm, w, toFrame, step = 1) {
    const t = w.extra.time; let max = 0, at = 0;
    for (let i = 0; i < w.n; i += step) { const e = Math.abs(toFrame(tm, w.fromS + i / w.flight.actualRate) - (w.fromS + (t[i] - t[0]) / 1e6)); if (e > max) { max = e; at = i; } }
    return { max, at, atS: w.fromS + (t[at] - t[0]) / 1e6 };
}
const decoded = (file, extra = ['time']) => { const lib = require('../tools/autotune/lib.cjs'); return [...lib.segments(lib.loadApp(), file, { whole: true, extra })].filter(w => !w.skipped); };

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
    const dir = /const DIR = '([^']+)'/.exec(src)[1], required = ['REQUIRED', 'GAINS'].flatMap(k => quoted(new RegExp(`const ${k} = \\[([^\\]]*)\\]`).exec(src)[1]));
    const optional = quoted(/const OPTIONAL = \{([^}]*)\}/.exec(src)[1].replace(/\w+: /g, '')), onDemand = quoted(/const ON_DEMAND = \[([^\]]*)\]/.exec(src)[1]);
    return { src, dir, names: required.concat(optional, onDemand), optional: optional.concat(onDemand) }; // ON_DEMAND: fetched with the others, loaded by its command (filterTune)
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
    const { dir, names, optional } = fetchedToolkit();
    assert.equal(names.length, 22);
    assert.deepEqual(optional, ['health_track', 'health_more', 'health_phase', 'health_rescue', 'health_limits', 'health_config', 'health_power', 'advice', 'catalog', 'hierarchy', 'evidence', 'datasets', 'param_epochs', 'filter_tune']);
    let esbuild = null; try { esbuild = require(path.join(REPO, 'node_modules/esbuild')); } catch (e) { /* the API check still runs */ }
    for (const n of names) {
        const file = path.join(JS, `${dir}${n}.cjs`);
        if (optional.includes(n) && !fs.existsSync(file)) { t.diagnostic(`${n}.cjs is not in the repo yet: not examined`); continue; }
        const text = fs.readFileSync(file, 'utf8');
        assert.doesNotMatch(text, POST_99_API, `${n}.cjs: post-99 API`);
        if (!esbuild) continue;
        const wrapped = `(function (require, module, exports, process, __dirname, __filename, console) {\n${text.replace(/^#![^\n]*/, '')}\n})`; // as the shim runs it
        assert.equal(esbuild.transformSync(wrapped, { target: 'chrome99' }).code, esbuild.transformSync(wrapped, { target: 'esnext' }).code, `${n}.cjs: syntax newer than Chromium 99`);
    }
    if (!esbuild) t.skip('esbuild not installed: API names checked, syntax not');
});

test('T0: every file the worker loads is a relative URL to a file that exists and is packaged (gulpfile distSources)', (t) => {
    const { src, dir, names, optional } = fetchedToolkit(), gulp = fs.readFileSync(path.join(REPO, 'gulpfile.js'), 'utf8');
    const list = /(?:var distSources|APP_ASSET_SOURCES) = \[([\s\S]*?)\];/.exec(gulp)[1], quoted = (s) => [...s.matchAll(/'([^']+)'/g)].map(m => m[1]);
    const scripts = quoted(/importScripts\(([^)]*)\)/.exec(src)[1]).map(u => path.posix.join('js', u));
    const toolkit = names.map(n => path.posix.normalize(path.posix.join('js', `${dir}${n}.cjs`)));
    assert.equal(scripts.length, 12); assert.equal(names.length, 22);
    toolkit.forEach((f, i) => { if (optional.includes(names[i]) && !fs.existsSync(path.join(REPO, f))) { t.diagnostic(`${f} is not in the repo yet: an optional module`); toolkit[i] = null; } });
    for (const f of scripts.concat(toolkit.filter(Boolean))) {
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

test('T1: whole file, excludeAbnormal and phases off: records equal health.cjs, findings and report.md equal health_report.cjs', async () => {
    const S = sim(), C = cliHealth(), W = worker({ 'health_phase.cjs': STUB_PHASE }), TW = W.ctx.TuningWorker; // phases off: a phase module changes nothing
    const R = await W.result({ cmd: 'analyseFile', fileName: 'sim.bbl', selectedLog: 1,
        options: { flightRpm: null, cliText: CLI, cliName: TRUTH.cliName, excludeAbnormal: false, phases: false, datasets: false, keepMetrics: true, gains: false } }, S.bytes);
    assert.ok(R.records.every(l => !l.logClass && !l.phases) && R.flights.length === 0 && R.benchRuns.length === 0 && R.findings.every(f => f.phase === null), 'no phases');
    assert.deepEqual(rpmOf(R.flightRpm), FILE_RPM, 'auto flight rpm from the lowest governor target, pooled over the flown logs');
    assert.deepEqual(Object.keys(R.flightRpm), ['value', 'source', 'basis', 'profile', 'seconds', 'logs']);
    assert.ok(R.notes.includes(`The flight rpm is 2100 (\`floor(0.85 x 2500 / 100) x 100\`). 2500 rpm is the lowest median governor target in flight of a PID profile (the PID profile at the start of the log). ` +
        `The app calculated it from ${R.flightRpm.seconds} s of flight in logs 2, 4 and 5. 4 of the 7 logs have a minimum of 5 s of flight at 10 deg/s rms.`), R.notes.join('\n'));
    assert.deepEqual(R.cli, { kind: 'diff', version: '4.6.0', selectedProfile: 0, selectedRateProfile: null }, 'the CLI dump ends with `profile 0`');
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
        options: { flightRpm: null, cliText: CLI, cliName: TRUTH.cliName, excludeAbnormal: false, phases: false, datasets: false, keepMetrics: true, gains: false, curves: false } }, S.bytes);
    assert.equal(B.logIndex, 0);
    sameJson(B.flightRpm, R.flightRpm, 'flight rpm with log 0 on screen');
    sameJson(B.records, R.records, 'records with log 0 on screen');
    sameJson(B.findings.map(f => { const o = Object.assign({}, f); delete o.evidence; return o; }), R.findings.map(f => { const o = Object.assign({}, f); delete o.evidence; return o; }), 'findings with log 0 on screen (evidence aside: its curves are of the log on screen)');
});

test('T1: one log at a time: records equal health.cjs, findings equal health_report.cjs over that log', async () => {
    const S = sim(), C = cliHealth(), W = worker(), TW = W.ctx.TuningWorker;
    for (let li = 0; li < S.count; li++) {
        const R = await W.result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: li, logCount: S.count,
            options: { flightRpm: TRUTH.rpm, cliText: CLI, cliName: TRUTH.cliName, excludeAbnormal: false, phases: false, datasets: false, keepMetrics: true, curves: false } }, S.slice(li));
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
    const R = await W.result({ cmd: 'analyseFile', fileName: 'sim.bbl', selectedLog: 4, options: { flightRpm: TRUTH.rpm, excludeAbnormal: false, phases: false, gains: true, curves: false } }, S.bytes);
    assert.ok(ref.groups.length >= 3, `report.cjs formed groups: ${ref.groups.length}`);
    assert.equal(J(coreDecisions(R.decisions)), J(ref.decisions), 'decisions (the fid and evidence of the app aside)');
    // the app's fields of a decision (C7): a unique fid before advice, and evidence over the extract.cjs segments of its headspeed bin
    assert.ok(R.decisions.length && R.decisions.every(d => /^report\|C7\|\|\|\|(roll|pitch|yaw)\|\d+(\.\d+)?$/.test(d.fid)) && new Set(R.decisions.map(d => d.fid)).size === R.decisions.length, J(R.decisions.map(d => d.fid)));
    if (has('evidence.cjs')) for (const d of R.decisions) {
        assert.ok(d.evidence && d.evidence.id === 'C7' && d.evidence.fid === d.fid && d.evidence.spans.length >= 1 && d.evidence.spans.length <= 3, J(d.evidence));
        const segs = JSON.parse(fs.readFileSync(path.join(out, 'segments.json'), 'utf8')).segments;
        for (const q of d.evidence.spans) assert.ok(segs.some(g => g.log === q.log && Math.abs(g.fromS - q.t0) < 1e-3 && Math.round(g.headspeed.median / 250) * 250 === d.bin), `span ${J(q)} is an extract.cjs segment of ${d.bin} rpm`);
    }
    assert.equal(J(R.groups), J(ref.groups), 'groups');
    assert.ok(R.reportMarkdown.endsWith(`\n\n${md}`), 'report.cjs report.md follows the health report');
    assert.ok(R.timing.gainsS > 0);
    const f = W.progress.filter(p => p.id === 1).map(p => p.fraction);
    assert.ok(f.every((v, i) => v >= 0 && v <= 1 && (!i || v >= f[i - 1])), `progress fractions rise from 0 to 1: ${f.join(' ')}`);
    assert.ok(W.progress.some(p => p.stage === 'gains' && /^"extract\.cjs": "sim\.bbl #4/.test(p.text)), 'extract.cjs progress lines reach the dialog, as quoted text');
});

test('T1: auto flight rpm: lowest per-profile governor target, else airborne headspeed, else the toolkit default', async () => {
    const S = sim(), W = worker(NO_PHASE), TW = W.ctx.TuningWorker, rule = TW.kit(await TW.sources(), null).health.RULE.flight; // the flight phases: test D13
    const auto = async (li) => (await W.result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: li, options: { excludeAbnormal: false, curves: false } }, S.slice(li)));
    const none = { value: 3000, source: 'default', basis: null, profile: null, seconds: null, logs: [] };
    const DEFAULT = 'The flight rpm is 3000. This is the value that the toolkit uses when it cannot calculate the flight rpm. ';
    const bench = await auto(0);
    assert.deepEqual(bench.flightRpm, none);
    assert.ok(bench.notes.some(n => n.startsWith(`${DEFAULT}The log does not record AIRBORNE_STATE or the governor condition. Thus, the app cannot find the flight. `)), bench.notes.join('\n'));
    assert.deepEqual(rpmOf((await auto(3)).flightRpm), { value: 2100, source: 'govTarget', basis: 2500, profile: 0, seconds: 38, logs: [3] });
    const bare = (await auto(5)).flightRpm; // no govTarget logged: 0.85 x the median airborne headspeed (2500 rpm less the collective droop)
    assert.ok(bare.source === 'headspeed' && bare.value === 2100 && bare.basis > 2400 && bare.basis < 2550 && J(bare.logs) === '[5]', J(bare));
    const skipped = await auto(6);
    assert.deepEqual(skipped.flightRpm, none, 'a log the toolkit skips gives no rpm');
    assert.ok(skipped.notes.some(n => n.startsWith(`${DEFAULT}The log has no part that the app can read. `)), skipped.notes.join('\n'));

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
    assert.equal(TW.rpmWhy([spool], rule, false), 'The log does not record AIRBORNE_STATE, and the governor is not ACTIVE in the log. Thus, the log is possibly a test on the ground.');
    assert.equal(TW.rpmWhy([spool, TW.rpmEvidence([seg({ hs: 2300, events: false })], 1), TW.rpmEvidence([seg({ n: 3000, hs: 2300 })], 2)], rule, true),
        'No log of the file gives a flight rpm (3 logs). Logs with less than 5 s of flight at 10 deg/s rms: 1. Logs without AIRBORNE_STATE and with no ACTIVE governor (tests on the ground): 1. ' +
        'Logs that do not record AIRBORNE_STATE or the governor condition: 1.');
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
    const S = sim(), W = worker(Object.assign({ 'health_track.cjs': STUB_TRACK, 'health_more.cjs': STUB_MORE, 'advice.cjs': null }, NO_APP_MODULES));
    const L = await W.result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, logCount: S.count, options: {} }, S.slice(1));
    const F = await W.result({ cmd: 'analyseFile', fileName: 'sim.bbl', selectedLog: 4, options: { flightRpm: TRUTH.rpm } }, S.bytes);
    const KEYS = ['version', 'scope', 'selection', 'fileName', 'logIndex', 'logs', 'flightRpm', 'cli', 'timing', 'records', 'flights', 'benchRuns', 'noData', 'profiles', 'header', 'headerLog', 'fields', 'findings', 'decisions', 'groups', 'advice', 'hierarchy', 'curves',
        'datasets', 'issues', 'top', 'areas', 'notchFit', 'epochs', 'freshness', 'cliStatus', 'reportMarkdown', 'notes'];   // round 3: datasets (M1), issues, top, areas (M3), noData (M4); notchFit (the notch orders of the log); epochs, freshness, cliStatus (values that are possibly not current)
    const SUMMARY = ['log', 'segment', 'start', 'durationS', 'fromS', 'seconds', 'flown', 'flyingS', 'rate', 'actualRate', 'bodyRate', 'profileSeconds', 'targetOf', 'govStateLogged', 'excluded', 'normalS', 'skipped', 'errors', 'timeMap',
        'logClass', 'phases', 'flights', 'phaseSeconds', 'profiles', 'noData', 'noDataReason'];
    const RANK = { error: 0, flag: 1, note: 2, ok: 3, skipped: 4 };
    for (const [R, scope, li] of [[L, 'log', 1], [F, 'file', 4]]) {
        assert.deepEqual(Object.keys(R), KEYS, `${scope}: keys`);
        assert.equal(R.version, 1); assert.equal(R.scope, scope); assert.equal(R.fileName, 'sim.bbl'); assert.equal(R.logIndex, li);
        assert.deepEqual(R.logs, scope === 'log' ? [1] : [0, 1, 2, 3, 4, 5, 6]);
        assert.equal(R.cli, null);
        for (const k of ['decodeS', 'analyseS', 'judgeS', 'gainsS', 'totalS']) assert.ok(typeof R.timing[k] === 'number' && R.timing[k] >= 0, `timing.${k}`);
        for (const rec of R.records) assert.ok(Object.keys(rec).every(k => SUMMARY.includes(k)), `${scope}: record keys ${Object.keys(rec)}`);
        for (const rec of R.records) assert.ok(rec.skipped ? !rec.timeMap : rec.timeMap && rec.timeMap.frameS instanceof Float32Array && rec.timeMap.every === 250, `${scope}: log ${rec.log}.${rec.segment} time map`);
        assert.equal(R.records.filter(r => r.log === 1).length, 2, 'log 1 has two segments (the gap)');
        assert.equal(R.header['Firmware revision'], 'Rotorflight 4.6.0 (sim) STM32F7X2'); assert.deepEqual(R.header.rollPID, [50, 100, 0, 100, 0]);
        for (const [k, v] of [['headspeed', 'present'], ['gyroRAW[0]', 'present'], ['mixer[2]', 'present'], ['flightModeFlags', 'present'], ['rcCommand[0]', 'present'], ['axisB[0]', 'absent'], ['EscRPM', 'absent']]) assert.equal(R.fields[k], v, `fields[${k}]`);
        R.findings.forEach((f, i) => {
            assert.ok(typeof f.module === 'string' && typeof f.id === 'string' && f.severity in RANK && Array.isArray(f.times) && typeof f.fid === 'string', `finding ${i} ${J(f).slice(0, 120)}`);
            assert.ok(!('summary' in f) && !('node' in f) && !('evidence' in f), 'no catalog, hierarchy or evidence module: no summary, node or evidence');
            if (i) { const p = R.findings[i - 1]; assert.ok(RANK[p.severity] < RANK[f.severity] || (RANK[p.severity] === RANK[f.severity] && p.id.localeCompare(f.id, 'en', { numeric: true }) <= 0), `sorted at ${i}: ${p.severity} ${p.id}, ${f.severity} ${f.id}`); }
        });
        const stub = R.findings.filter(f => f.module === 'track');
        assert.ok(stub.length && stub.every(f => J(f.times) === J([3.25, 12.5])), 'new-module findings carry module and times (events and "at N s")');
        assert.equal(R.decisions, null); assert.equal(R.groups, null); assert.equal(R.hierarchy, null);
        assert.deepEqual(R.advice.recommendations, []); assert.deepEqual(R.advice.coverage, []); assert.match(R.advice.notes[0], /^The toolkit file "advice\.cjs" is not available\. Thus, the results do not include recommendations\.$/);
        for (const [file, lost] of [['advice', 'recommendations'], ['catalog', 'the STE summaries'], ['hierarchy', 'the tuning sequence'], ['evidence', 'the part of the log that gave each result'], ['health_phase', 'the flight phases and the ground checks']])
            assert.ok(R.notes.includes(`The toolkit file "${file}.cjs" is not available (HTTP 404). Thus, the results do not include ${lost}.`), R.notes.join('\n'));
        assert.ok(R.curves.length && R.curves.every(c => c.log === li && J(Object.keys(c)) === J(['log', 'segment', 'fromS', 'seconds', 'track', 'more', 'phase']) && c.phase === null), `${scope}: curves of the selected log only`);
        assert.deepEqual([R.flights, R.benchRuns], [[], []], 'no flight phases without health_phase.cjs');
        assert.ok(R.records.filter(l => !l.skipped).every(l => l.logClass === null && !('phases' in l) && l.profiles && Array.isArray(l.profiles.pid)), 'a record without phases has its profiles');
        assert.ok(R.findings.every(f => f.phase === null && (f.pidProfile === null || (Number.isInteger(f.pidProfile) && f.pidProfile >= 1 && f.pidProfile <= 6))), 'phase and pidProfile on every finding');
        assert.ok(R.curves[0].track.roll.time.t instanceof Float32Array && R.curves[0].more.gov.t.length === 3, 'curves keep their typed arrays');
        assert.ok(typeof R.reportMarkdown === 'string' && R.reportMarkdown.startsWith('# Health report'));
    }
    const stages = new Set(W.progress.map(p => p.stage));
    assert.ok([...stages].every(s => ['load', 'decode', 'analyse', 'judge', 'gains', 'advice'].includes(s)), [...stages].join());
    assert.ok(W.progress.every(p => /^[A-Z"].*[.]$|^"extract\.cjs": /.test(p.text)), `progress texts are sentences: ${[...new Set(W.progress.map(p => p.text))].filter(t => !/^[A-Z"].*[.]$/.test(t)).join(' | ')}`);
});

// ---------------------------------------------------------------------------------------------
// The app's fields of a finding (SPEC2 3.6): fid, summary, node and evidence before advice; hierarchy after it
// ---------------------------------------------------------------------------------------------

test('fid, summary, node and evidence on every finding before advice; the hierarchy after advice; explained by fid', async () => {
    const S = sim(), echo = `'use strict';
module.exports = { advise: (i) => { const [a, b] = i.findings.filter(f => f.severity === 'flag');
    return { recommendations: [{ id: 'A', severity: 'info', title: 'Information only', evidence: [{ fid: a.fid }] }, { id: 'B', severity: 'action', title: 'Act', evidence: [{ fid: b.fid }, { fid: a.fid + 'x' }] }],
        coverage: [{ area: 'logging' }], notes: [JSON.stringify({ n: i.findings.length, complete: i.findings.every(f => f.fid && f.summary && f.node && f.evidence && f.evidence.fid === f.fid) })] }; } };`;
    const W = worker(Object.assign({ 'catalog.cjs': STUB_CATALOG, 'hierarchy.cjs': STUB_HIERARCHY, 'evidence.cjs': STUB_EVIDENCE, 'advice.cjs': echo }, NO_PHASE));
    const R = await W.result({ cmd: 'analyseFile', fileName: 'sim.bbl', selectedLog: 1, options: { flightRpm: TRUTH.rpm, cliText: CLI, keepMetrics: true } }, S.bytes);
    const F = R.findings, recs = (log) => R.records.filter(l => l.log === log);
    assert.ok(F.length > 150, `${F.length} findings`);
    // fid: module|id|log|segment|profile|axis|k, unique; k counts from 0 the findings that agree in the rest
    assert.equal(new Set(F.map(f => f.fid)).size, F.length, 'fid unique');
    const groups = new Map();
    for (const f of F) {
        // round 3 M1: with configurations, module|id|log|segment|profile|axis|dataset|k
        const p = f.fid.split('|'), e = f.evidence, n = R.datasets ? 8 : 7;
        assert.equal(p.length, n, f.fid);
        assert.deepEqual(p.slice(0, 3).concat(p.slice(4, 6)), [f.module, f.id, logsOf(f).join('+'), String(f.profile ?? ''), String(f.axis ?? '')], f.fid);
        if (R.datasets) assert.equal(p[6], f.dataset || '', `${f.fid}: the configuration`);
        assert.equal(p[3], e.segment === null ? '' : String(e.segment), 'the segment of the fid is the record its evidence used');
        const key = p.slice(0, n - 1).join('|'); groups.set(key, (groups.get(key) || []).concat(+p[n - 1]));
    }
    for (const [key, ks] of groups) assert.deepEqual(ks.slice().sort((a, b) => a - b), ks.map((_, i) => i), `k of ${key}`);
    assert.ok([...groups.values()].some(ks => ks.length > 1), 'the fixture has findings that agree in all but k');
    // advice got every finding with its fields
    assert.deepEqual(JSON.parse(R.advice.notes[0]), { n: F.length, complete: true });
    // summary and node: catalog.summary(f) and hierarchy.homeOf(f.id, f.axis)
    for (const f of F) { assert.equal(f.summary, `Check ${f.id}: summary.`); assert.equal(f.node, `node:${f.id}:${f.axis === undefined ? null : f.axis}`); }
    // evidence: ctx.record of the finding's first log, holding its first time; the metrics with locate and the time map; every log; that record's curves
    for (const f of F) {
        const e = f.evidence, log = logsOf(f)[0], list = log === undefined ? [] : recs(log), t = f.times[0];
        assert.equal(e.fid, f.fid); assert.equal(e.findings, F.length); assert.deepEqual(e.others, [0, 1, 2, 3, 4, 5, 6]);
        if (log === undefined) { assert.equal(e.log, null); continue; }
        assert.equal(e.log, log, f.fid);
        const rec = list.find(l => l.segment === e.segment);
        if (typeof t === 'number' && list.some(l => typeof l.fromS === 'number' && t >= l.fromS && t <= l.fromS + l.seconds)) assert.ok(t >= rec.fromS - 1e-3 && t <= rec.fromS + rec.seconds + 0.05, `${f.fid}: time ${t} in the record`);
        if (rec.skipped) { assert.deepEqual([e.locate, e.timeMap], [null, false], 'a record without data'); continue; }
        assert.deepEqual(e.locate, { n: rec.n, fromS: rec.fromS === null ? null : e.locate.fromS, modules: Object.keys(rec.metrics).filter(k => k !== 'locate' && rec.metrics[k]), flyingGov: e.locate.flyingGov }, f.fid);
        assert.equal(typeof e.locate.flyingGov, 'boolean', f.fid);
        within(e.locate.fromS, rec.fromS, 1e-3, 'locate saw the segment');
        assert.equal(e.timeMap, true);
        assert.deepEqual(e.curves, log === 1 ? [1, rec.segment] : null, `${f.fid}: curves of the record (log 1 on screen)`);
    }
    assert.ok(F.some(f => f.evidence.log === 1 && f.evidence.segment === 1) && F.some(f => f.evidence.log === 1 && f.evidence.segment === 0), 'findings of both segments of log 1');
    // A7: the governor mask has no ground contact (rescue, level modes and failsafe only), so locate gets it as ctx.flyingGov
    assert.ok(F.some(f => f.evidence.locate && f.evidence.locate.flyingGov === true), 'the governor mask differs from the attitude mask');
    const d1 = F.filter(f => f.id === 'D1' && f.log === 1);
    assert.deepEqual(d1.map(f => f.evidence.segment), [0, 1], 'one D1 of each segment, with no time: in judge order');
    // the records keep the time map and the located spans (keepMetrics)
    for (const rec of R.records) if (!rec.skipped) assert.ok(rec.timeMap.every === 250 && rec.metrics.locate.n === rec.n);
    // the hierarchy: hierarchy.status after advice, over the findings with all their fields, the recommendations, the logs and the coverage
    assert.deepEqual(R.hierarchy.seen, { findings: F.length, complete: F.length, recs: ['A', 'B'], logs: R.records.map(l => l.log), coverage: true });
    assert.deepEqual(R.hierarchy.nodes.n.fids, F.filter(f => f.severity === 'flag').map(f => f.fid));
    // explained: a flag that every recommendation citing it (by fid) makes information
    const [a, b] = F.filter(f => f.severity === 'flag');
    assert.equal(a.explained, 'Information only');
    assert.ok(!('explained' in b), 'a flag that an action cites');
    assert.equal(F.filter(f => f.explained).length, 1);
});

test('explained: an evidence row without fid cites its finding by module, id, log, profile and text', async () => {
    const S = sim(), legacy = `'use strict';
module.exports = { advise: (i) => { const f = i.findings.find(q => q.severity === 'flag');
    return { recommendations: [{ id: 'A', severity: 'info', title: 'Old row', evidence: [{ module: f.module, id: f.id, log: f.log, profile: f.profile, text: f.text }] }], coverage: [{ area: 'x' }], notes: [] }; } };`;
    const R = await worker(Object.assign({ 'advice.cjs': legacy }, NO_APP_MODULES)).result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, options: { flightRpm: TRUTH.rpm, curves: false } }, S.slice(1));
    const flags = R.findings.filter(f => f.severity === 'flag'), same = flags.filter(f => f.module === flags[0].module && f.id === flags[0].id && J(f.log) === J(flags[0].log) && f.profile === flags[0].profile && f.text === flags[0].text);
    assert.ok(flags.length > 1);
    assert.deepEqual(flags.filter(f => f.explained).map(f => f.fid), same.map(f => f.fid));
});

test('optional modules: a catalog, hierarchy or evidence that is missing, does not load or throws becomes a note, and the rest stays', async () => {
    const S = sim(), log = { cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, options: { flightRpm: TRUTH.rpm, curves: false, keepMetrics: true } };
    const boom = await worker({ 'health_phase.cjs': null,
        'catalog.cjs': "module.exports = { summary: (f) => { if (f.id === 'D2') throw new Error('no D2'); return 'S.'; } };",
        'hierarchy.cjs': "module.exports = { homeOf: (id) => id === 'G0' ? null : 'n', status: () => { throw new Error('no status'); } };",
        'evidence.cjs': "module.exports = { timeMap: () => { throw new Error('no map'); }, locate: () => { throw new Error('no locate'); }, forFinding: (f) => { if (f.id === 'D1') throw new Error('no D1'); return f.id === 'D3' ? null : { v: 1, fid: f.fid }; } };",
    }).result(log, S.slice(1));
    const F = boom.findings;
    assert.ok(F.filter(f => f.id === 'D2').every(f => !('summary' in f)) && F.filter(f => f.id !== 'D2').every(f => f.summary === 'S.'), 'summary on all but the throwing check');
    assert.ok(F.filter(f => f.id === 'D1').every(f => !('evidence' in f)) && F.filter(f => f.id === 'D3').every(f => f.evidence === null) && F.filter(f => !/^D[13]$/.test(f.id)).every(f => f.evidence.fid === f.fid), 'evidence on all but the throwing check');
    assert.ok(F.filter(f => f.id === 'G0').every(f => f.node === null) && F.every(f => typeof f.fid === 'string'));
    assert.equal(boom.hierarchy, null);
    for (const t of ['The app cannot make the summary of check D2. The error is "no D2".', 'The app cannot find the part of the log of check D1. The error is "no D1".', 'The app cannot calculate the tuning sequence. The error is "no status".',
        'The function "timeMap" of "evidence.cjs" stopped. The error is "no map". Thus, the app calculates the frame times with a different method (log 2).',
        'The function "locate" of "evidence.cjs" stopped. The error is "no locate". Thus, some results do not show their part of the log (log 2).'])
        assert.ok(boom.notes.includes(t), `${t}\n${boom.notes.join('\n')}`);
    assert.ok(boom.records.every(rec => rec.timeMap.every === 250 && !('locate' in rec.metrics)), 'the worker\'s own time map; no located spans');
    const bad = await worker({ 'evidence.cjs': 'const x = ;', 'catalog.cjs': null, 'hierarchy.cjs': "throw new Error('at load');", 'health_phase.cjs': null }).result(log, S.slice(1));
    assert.ok(bad.notes.some(n => /^The app cannot load the toolkit file "evidence\.cjs"\. The error is "Unexpected token.*"\. Thus, the results do not include the part of the log that gave each result\.$/.test(n)), bad.notes.join('\n'));
    assert.ok(bad.notes.includes('The app cannot load the toolkit file "hierarchy.cjs". The error is "at load". Thus, the results do not include the tuning sequence.'), bad.notes.join('\n'));
    assert.ok(bad.findings.every(f => typeof f.fid === 'string' && !('evidence' in f) && !('node' in f) && !('summary' in f)) && bad.hierarchy === null);
});

// ---------------------------------------------------------------------------------------------
// Frame seconds: the time map of each record against the frame clock
// ---------------------------------------------------------------------------------------------

// a flight whose frame clock is not the index clock: a 26 ms loop stall at frame 31234 (the Gaui #50 stall), then from frame
// 45100 frames 1040 us apart (the slow frames after a landing). From knot to knot (every 250 samples) the map is a straight
// line, so at the rate change it is off by 40 us x 100 x 150 / 250 = 2.4 ms; the stall is a knot of its own
const clockLog = (() => { let v = null; return () => v || (v = (() => {
    const flight = bbl.simulateFlight({ seconds: 60, seed: 21, airborne: [6, 54], start: '2026-10-04T14:00:00.000+00:00', clock: { periods: [[45100, 1040]], stalls: [[31234, 26000]] } });
    const file = path.join(tmp, 'clock.bbl'); fs.writeFileSync(file, bbl.encode([flight]).bytes);
    return { file, w: decoded(file)[0] };
})()); })();
const nearRateChange = (i) => i >= 45000 && i < 45250;
const indexOnly = (w) => mapError({ fromS: w.fromS, every: 1, frameS: Float32Array.of(0), n: 1, endS: 0, jumps: [], actualRate: w.flight.actualRate }, w, (m, t) => t);

test('time map (the worker\'s timeMapOf): index times to the frame clock within 0.05 ms across a 26 ms loop stall, within 2.5 ms at a change of the frame rate', () => {
    const { w } = clockLog(), TW = worker().ctx.TuningWorker, tm = TW.timeMapOf(w);
    assert.ok(indexOnly(w).max > 0.02, `index time is off the frame clock by ${(indexOnly(w).max * 1000).toFixed(1)} ms: the map matters`);
    sameJson([tm.every, tm.n, tm.frameS.length, tm.jumps.map(j => j[0])], [250, w.n, Math.ceil(w.n / 250), [31234]], 'one knot every 250 samples, the stall as a jump');
    const all = mapError(tm, w, toFrameRef);
    assert.ok(all.max < 0.0025 && nearRateChange(all.at), `largest error ${(all.max * 1000).toFixed(3)} ms at frame ${all.at}`);
    let off = 0; for (let i = 0; i < w.n; i++) if (!nearRateChange(i)) off = Math.max(off, Math.abs(toFrameRef(tm, w.fromS + i / w.flight.actualRate) - (w.fromS + (w.extra.time[i] - w.extra.time[0]) / 1e6)));
    assert.ok(off < 5e-5, `away from the rate change: ${(off * 1000).toFixed(4)} ms, the stall included`);
    // an event time as the modules give it (w.fromS + i / rate to 1 ms, health_setup D2) at the sample after the stall: its frame time
    for (const d of [-0.0004, 0, 0.0004]) { const tEv = +(w.fromS + 31234 / w.flight.actualRate).toFixed(3) + d, F = w.fromS + (w.extra.time[31234] - w.extra.time[0]) / 1e6;
        within(toFrameRef(tm, tEv), F, 0.001, `the stall event at ${tEv} s (index time, rounded to 1 ms${d ? ` and ${d * 1000} ms` : ''})`); }
    // the jumps: a frame interval 1 ms or more over the nominal one, the largest TIMEMAP.maxJumps of them
    const many = Object.assign({}, w, { extra: { time: Float64Array.from(w.extra.time, (v, i) => v + 3000 * Math.floor(i / 50)) } }), big = TW.timeMapOf(many);
    assert.equal(big.jumps.length, TW.TIMEMAP.maxJumps, 'a log with more jumps keeps the largest');
    assert.ok(big.jumps.every((j, k) => !k || j[0] > big.jumps[k - 1][0]), 'in sample order');
});

test('records keep a time map: the seek error through evidence.cjs toFrame (else the worker\'s map) is less than 5 ms on the stall fixture (SPEC2 D1)', async () => {
    const { file, w } = clockLog(), R = await worker().result({ cmd: 'analyseLog', fileName: 'clock.bbl', logIndex: 0, options: { flightRpm: TRUTH.rpm, curves: false } }, fs.readFileSync(file));
    assert.equal(R.records.length, 1);
    const e = mapError(R.records[0].timeMap, w, toFrameOf());
    assert.ok(e.max < 0.005, `largest seek error ${(e.max * 1000).toFixed(2)} ms at frame ${e.at} (${e.atS.toFixed(3)} s; the stall is at frame 31234)`);
});

// the Gaui X4 II flash dump of 2026-10-04 (RTFL_BLACKBOX_LOG_20261004_113720.BBL, 59 logs): AUTOTUNE_REAL_LOG is its path
const GAUI = process.env.AUTOTUNE_REAL_LOG || '';
const gauiSlice = (() => { let v = null; return () => v || (v = (() => {
    const all = fs.readFileSync(GAUI), at = []; for (let i = all.indexOf(MARKER); i >= 0; i = all.indexOf(MARKER, i + 1)) at.push(i);
    return { all, at, log: (li) => new Uint8Array(all.subarray(at[li], at[li + 1])) };
})()); })();
// the worker on Gaui X4 #50 alone at 2000 rpm, as test T3 compares it with the CLI (one run for the tests below)
const gaui50 = (() => { let v = null; return () => v || (v = (async () => {
    const bytes = gauiSlice().log(50), dir = path.join(tmp, 'gaui'), file = path.join(dir, path.basename(GAUI));
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, bytes);
    const W = worker(), R = await W.result({ cmd: 'analyseLog', fileName: path.basename(GAUI), logIndex: 0, logCount: 1, options: { flightRpm: 2000, excludeAbnormal: false, phases: false, keepMetrics: true } }, bytes);
    return { bytes, dir, file, W, R };
})()); })();
const REAL = { skip: !GAUI || !fs.existsSync(GAUI) };

test('T3: frame seconds on Gaui X4 #50: the time map is within 5 ms of the frame clock, the 26 ms stall included; the D2 seek is at the stall (AUTOTUNE_REAL_LOG)', REAL, async () => {
    const { file, R, W } = await gaui50(), segs = decoded(file), TW = W.ctx.TuningWorker;
    assert.equal(segs.length, R.records.length);
    segs.forEach((w, s) => {
        const drift = indexOnly(w), own = mapError(TW.timeMapOf(w), w, toFrameRef), used = mapError(R.records[s].timeMap, w, toFrameOf());
        assert.ok(drift.max > 0.15, `index time is ${(drift.max * 1000).toFixed(1)} ms off the frame clock at most (evidence.md 0.4: 180 ms)`);
        assert.ok(own.max < 0.005, `segment ${s}, the worker's timeMapOf: largest seek error ${(own.max * 1000).toFixed(2)} ms at ${own.atS.toFixed(3)} s`);
        assert.ok(used.max < 0.005, `segment ${s}, the map of the result${has('evidence.cjs') ? ' (evidence.cjs)' : ''}: largest seek error ${(used.max * 1000).toFixed(2)} ms at ${used.atS.toFixed(3)} s`);
    });
    // the D2 flag of the stall: a span holds the frame time of the first frame after the stall, and the viewer seeks there
    const w = segs[0], t = w.extra.time; let j = 1; for (let i = 2; i < w.n; i++) if (t[i] - t[i - 1] > t[j] - t[j - 1]) j = i;
    const stallS = w.fromS + (t[j] - t[0]) / 1e6;
    within(t[j] - t[j - 1], 26206, 1, 'the 26 ms stall of #50'); within(stallS, 83.574, 0.001, 'at 83.574 s');
    const d2 = R.findings.find(f => f.id === 'D2' && f.severity === 'flag');
    assert.ok(d2, 'D2 flags the stall');
    if (!has('evidence.cjs')) return;
    const spans = d2.evidence && d2.evidence.spans || [], view = d2.evidence && d2.evidence.view;
    assert.ok(spans.some(q => q.t0 <= stallS && stallS <= q.t1), `a D2 span holds ${stallS.toFixed(3)} s: ${J(spans)}`);
    assert.ok(view && Math.abs(view.at - stallS) < 0.005, `the seek of the D2 evidence is at the stall: view.at ${view && view.at} against ${stallS.toFixed(4)} s`);
});

// ---------------------------------------------------------------------------------------------
// The normal-flight mask (ground truth: the simulated rescue span)
// ---------------------------------------------------------------------------------------------

test('excludeAbnormal ANDs health_more.normalMask into ctx.flying for every module; rec.excluded has the seconds', async () => {
    const S = sim(), W = worker(Object.assign({ 'health_track.cjs': STUB_TRACK, 'health_more.cjs': STUB_MORE }, NO_PHASE));
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
    const W = worker(Object.assign({ 'health_track.cjs': STUB_TRACK, 'health_more.cjs': none, 'evidence.cjs': STUB_EVIDENCE }, NO_PHASE));
    const run = (excludeAbnormal) => W.result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, options: { flightRpm: TRUTH.rpm, cliText: CLI, excludeAbnormal, keepMetrics: true, datasets: false } }, S.slice(1)); // the truth has the PID profile labels
    const off = await run(false), on = await run(true), TW = W.ctx.TuningWorker, K = TW.kit(await TW.sources(), TRUTH.rpm);
    // the truth: health_gov over the health.cjs mask with the labels of the modules (the raw label 0 before the first change, D12)
    K.files.set('/v/whole.bbl', S.slice(1)); const segs = [...K.lib.segments(W.ctx, '/v/whole.bbl', { whole: true, extra: K.extraAll })].filter(x => !x.skipped); K.files.delete('/v/whole.bbl');
    const whole = (w) => K.core.gov.analyse(w, K.health.buildCtx(w, w.flight, { flying: K.health.flightMask(w, w.flight.actualRate).flying, profile: Uint8Array.from(w.profileAt), cli: CLI, cliParsed: K.core.setup.parseCli(CLI), app: W.ctx }));
    on.records.forEach((rec, i) => {
        assert.ok(rec.flown && rec.normalS === 0, `segment ${i}: flown, ${rec.normalS} s normal`);
        assert.equal(rec.metrics.loop, null, 'no loop metrics');
        assert.equal(J(rec.metrics.gov), J(whole(segs[i])), 'governor metrics over the whole flight, as health.cjs computes them');
        assert.equal(rec.metrics.track.flyingN, 0, 'the other modules keep the masked flight');
        assert.deepEqual([rec.metrics.locate.flyingGov, off.records[i].metrics.locate.flyingGov], [true, false], 'locate gets the governor mask as ctx.flyingGov when it differs');
    });
    const of = (R, module) => R.findings.filter(f => f.module === module);
    assert.equal(of(on, 'loop').filter(f => logsOf(f).includes(1)).length, 0, 'no loop findings of the log');
    assert.ok(of(on, 'loop').every(f => f.log === null && /^no finding: /.test(f.text)), J(of(on, 'loop'))); // health_loop judging no flight (T4)
    const core = (list) => list.map(f => { const o = Object.assign({}, f); for (const k of APP_FIELDS) delete o[k]; return o; });
    const perLog = (R) => core(of(R, 'gov').filter(f => ['D5', 'G0', 'G1', 'G12', 'G13'].includes(f.id))); // the checks of no PID profile: the labels do not matter
    assert.equal(J(perLog(on)), J(perLog(off)), 'the governor findings of the whole flight');
    assert.ok(of(on, 'gov').some(f => f.id === 'G0' && /PID governor running \(govSum non-zero in [1-9]\d* of /.test(f.text)), 'G0 counts in-flight samples');
    assert.ok(on.notes.includes('After the app removes rescue, level modes, failsafe and ground contact, the log has 0 s of usual flight at 0 deg/s rms. A flight is a minimum of 5 s at 10 deg/s rms (health.cjs RULE.flight). ' +
        'Thus, the app does not do the loop checks, and the governor checks use all of the flight (log 2).'), on.notes.join('\n'));

    // the repo's health_more on a flight flown in ANGLE mode throughout: every in-flight sample is excluded
    const level = bbl.simulateFlight({ seconds: 20, seed: 13, airborne: [6, 18], level: [0, 20], start: '2026-10-04T13:00:00.000+00:00' });
    const L = await worker(NO_PHASE).result({ cmd: 'analyseLog', fileName: 'level.bbl', logIndex: 0, options: { flightRpm: TRUTH.rpm, keepMetrics: true, curves: false } }, bbl.encode([level]).bytes);
    const rec = L.records[0];
    assert.ok(level.truth.levelFrames === 20000 && rec.flown && rec.flyingS > 10 && rec.normalS === 0 && rec.excluded.levelModeS > 10, J(rec));
    assert.equal(rec.metrics.loop, null);
    assert.ok(L.findings.filter(f => f.id === 'G0').every(f => !/ in 0 of 0 /.test(f.text)), J(L.findings.filter(f => f.id === 'G0')));
    assert.ok(L.notes.some(n => /^After the app removes rescue, .* Thus, the app does not do the loop checks, and the governor checks use all of the flight \(log 1\)\.$/.test(n)), L.notes.join('\n'));
});

// review A5, A7: the governor checks use all phases of a flight log, with the mask that the rule of each check is valid for
test('governor masks (review A5, A7): rescue, level modes and failsafe only, no ground contact; in a flight log every phase for FALLBACK, voltage and motor, ground and flight for tracking', async () => {
    const S = sim(), log1 = { cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, options: { flightRpm: TRUTH.rpm, curves: false, keepMetrics: true, cliText: CLI, datasets: false } }; // govTruth: the PID profile labels
    // the rescue of log 1: RESCUE_STATE 40 to 44.5 s (the switch 40 to 44 s), widened by health_more RULE.spanGuardS (1 s) on each side
    const keep = Uint8Array.from({ length: S.flightA.w.n }, (_, i) => i >= 39000 && i < 45500 ? 0 : 1);
    // without the flight phases: the health.cjs mask less rescue; the attitude checks also lose the ground contact and its widening
    const N = await worker(NO_PHASE).result(log1, S.slice(1)), n0 = N.records[0];
    within(n0.metrics.gov.flyingS, n0.flyingS - 6.5, 0.051, 'governor: the flight less rescue');
    assert.ok(n0.excluded.groundS > 0 && n0.normalS < n0.metrics.gov.flyingS - 1, `the attitude checks: ${n0.normalS} s, the governor ${n0.metrics.gov.flyingS} s`);
    // with the flight phases: exactly health_gov on the masks of the phases (govTruth), rescue out of the tracking mask only
    const W = worker({ 'health_phase.cjs': STUB_PHASE }), P = await W.result(log1, S.slice(1)), p0 = P.records[0], pm = p0.metrics.gov.phaseMasks;
    assert.equal(J(p0.metrics.gov), J(await govTruth(W, TRUTH.rpm, S.slice(1), 0, CLI, keep)), 'governor metrics of the phase masks');
    within(pm.all.seconds, p0.seconds, 0.051, 'all phases: the whole segment');
    const gf = p0.phases.filter(q => q.phase === 'ground' || q.phase === 'flight').reduce((a, q) => a + q.t1 - q.t0, 0);
    assert.ok(pm.tracking.seconds < gf - 6 && pm.tracking.seconds > gf - 9, `tracking ${pm.tracking.seconds} s of ${gf.toFixed(1)} s on the ground and in flight, less 6.5 s of rescue (and the spool-up below the flight rpm)`);
    assert.ok(p0.metrics.gov.states.seconds.SPOOLUP > 2.9 && p0.metrics.gov.states.secondsFlying.SPOOLUP > 2.9, 'the states of every phase, the spool-up included');
    // a flight log that health.cjs does not call flown (4 s in the air < RULE.flight.minS): the governor checks run, the attitude checks do not
    const hop = bbl.encode([bbl.simulateFlight({ seconds: 20, seed: 19, airborne: [6, 10], start: '2026-10-04T18:00:00.000+00:00' })]).bytes;
    const H = await worker({ 'health_phase.cjs': STUB_PHASE }).result({ cmd: 'analyseLog', fileName: 'hop.bbl', logIndex: 0, options: { flightRpm: TRUTH.rpm, curves: false, keepMetrics: true } }, hop), h0 = H.records[0];
    assert.deepEqual([h0.logClass, h0.flown, !!h0.metrics.gov, h0.metrics.loop, h0.metrics.track === undefined || h0.metrics.track === null], ['flight', false, true, null, true], J({ c: h0.logClass, f: h0.flown, m: Object.keys(h0.metrics) }));
    assert.ok(H.findings.some(f => f.module === 'gov' && f.log === 0 && f.id === 'G1') && H.findings.filter(f => f.module === 'gov' && f.log === 0).every(f => f.phase === 'all' || f.phase === 'ground+flight'));
});

// review A3, D-H4: report.cjs gets an extract.cjs segment only if 90 % of it is in the attitude mask (the flight phases less rescue,
// level modes and failsafe) and it lies from a liftoff to the touchdown + 0.1 s of that flight
const threeFlights = (o = {}) => bbl.encode([1, 2, 3].map(k => bbl.simulateFlight(Object.assign({ seconds: 40, seed: 40 + k, airborne: [6, 34], start: `2026-10-04T19:0${k}:00.000+00:00` }, o)))).bytes;
test('gains (review A3, D-H4): only segments in the attitude mask, from liftoff to touchdown + 0.1 s, reach report.cjs', async () => {
    const S = sim(), gains = (phase, o, bytes = S.bytes) => worker({ 'health_phase.cjs': phase, 'health_track.cjs': null }).result({ cmd: 'analyseFile', fileName: 'sim.bbl', selectedLog: 1,
        options: Object.assign({ flightRpm: TRUTH.rpm, gains: true, curves: false, excludeAbnormal: false }, o) }, bytes);
    const kept = (R) => R.decisions !== null && R.decisions.length > 0, why = (R) => R.notes.filter(n => /segments? of "extract\.cjs"/.test(n));
    const dropped = (R) => { const m = why(R).map(n => /^(\d+) of the (\d+) segments/.exec(n)).find(Boolean); return m ? [+m[1], +m[2]] : [0, null]; };
    // the flights are the airborne runs (the stub with no shrink): every segment is kept
    const R0 = await gains(stubPhaseAt(0, 0), {});
    assert.ok(kept(R0) && !why(R0).length, J(R0.notes));
    if (has('evidence.cjs')) for (const d of R0.decisions) for (const q of d.evidence.spans) {
        const fl = R0.flights.filter(f => f.log === q.log);
        assert.ok(fl.some(f => q.t0 >= f.t0 - 1e-3 && q.t1 <= f.t1 + 0.1 + 0.01), `segment ${J(q)} inside a flight of ${J(fl)}`);
    }
    // the three segments of extract.cjs start where the airborne flag sets (logs 1, 3, 4) and end where it drops (log 3, 4) or at a
    // change of profile: a liftoff 0.5 s after the flag, or a touchdown 0.5 s before its drop, drops them (with a note)
    for (const [lift, down, want] of [[0.5, 0, 3], [0, 0.5, 2], [0.5, 0.5, 3]]) { const R = await gains(stubPhaseAt(lift, down), {});
        assert.deepEqual(dropped(R), [want, 3], `liftoff +${lift} s, touchdown -${down} s: ${J(R.notes)}`);
        if (want === 3) assert.equal(R.decisions, null, 'no segment left: report.cjs does not run'); }
    // touchdown 0.05 s before the flag drops: within SEGMENT.touchdownS, kept
    assert.deepEqual(dropped(await gains(stubPhaseAt(0, 0.05), {})), [0, null]);
    // flights in ANGLE mode throughout (review A3: normalS 0, levelModeS 28 s each): no segment reaches report.cjs
    const L = await gains(stubPhaseAt(0, 0), { excludeAbnormal: true }, threeFlights({ level: [0, 40] }));
    assert.ok(L.records.every(l => l.normalS === 0 && l.excluded.levelModeS > 20) && L.decisions === null && J(dropped(L)) === J([3, 3]) &&
        L.notes.includes('The app did not calculate the gains, because no segment of "extract.cjs" is in a flight without rescue, level modes and failsafe.'), J({ rec: L.records.map(l => l.excluded), notes: L.notes }));
    // with excludeAbnormal, the rescue of log 1 leaves the segments (lib.segments ends them at rescue) in the attitude mask; the CLI's
    // view (no phases, no exclusions) gives report.cjs every segment
    assert.ok(kept(await gains(stubPhaseAt(0, 0), { excludeAbnormal: true })), 'excludeAbnormal keeps the normal segments');
    assert.ok(kept(await gains(null, { phases: false })), 'the CLI view');
});

// T4: failures are findings or notes, not crashes
// ---------------------------------------------------------------------------------------------

test('T4: a module that throws becomes an error finding; one that does not load or is missing becomes a note', async () => {
    const S = sim(), loop = fs.readFileSync(path.join(TK, 'health_loop.cjs'), 'utf8') + '\nmodule.exports.analyse = () => { throw new Error("loop boom"); };\n';
    const track = STUB_TRACK.replace(/analyse: \(w, ctx\) => \(/, 'analyse: (w, ctx) => { throw new Error("track boom"); }, unused: (w, ctx) => (');
    const more = STUB_MORE.replace('judge: () => [],', 'judge: () => { throw new Error("more judge boom"); },').replace('curves: () =>', 'curves: () => { throw new Error("curves boom"); }, unused: () =>');
    const W = worker({ 'health_loop.cjs': loop, 'health_track.cjs': track, 'health_more.cjs': more, 'health_phase.cjs': null, 'advice.cjs': 'module.exports = { advise() { throw new Error("advice boom"); } };' });
    const R = await W.result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, options: { flightRpm: TRUTH.rpm } }, S.slice(1));
    const err = (module, re) => R.findings.filter(f => f.module === module && f.severity === 'error' && re.test(f.text));
    assert.equal(err('loop', /^analyse failed: Error: loop boom/).length, 2, 'health_report error finding per segment');
    assert.equal(err('track', /^The analysis of "health_track\.cjs" stopped\. The error is "Error: track boom"\.$/).length, 2, 'track analyse error per segment');
    assert.equal(err('more', /^The app cannot compare the results of "health_more\.cjs" with the limits\. The error is "more judge boom"\.$/).length, 1, 'more judge error');
    assert.ok(R.findings.some(f => f.module === 'gov' && f.severity !== 'error') && R.findings.some(f => f.module === 'setup'), 'the other modules still report');
    assert.ok(R.advice.notes.includes('The app cannot make the recommendations of "advice.cjs". The error is "advice boom".'), R.advice.notes.join('\n'));
    assert.ok(R.notes.includes('The app cannot make the curves of "health_more.cjs". The error is "curves boom" (log 2).'), R.notes.join('\n'));

    const B = worker({ 'health_track.cjs': 'this is not javascript', 'health_more.cjs': null, 'advice.cjs': null });
    const R2 = await B.result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, options: { flightRpm: TRUTH.rpm } }, S.slice(1));
    for (const re of [/^The app cannot load the toolkit file "health_track\.cjs"\. The error is "Unexpected identifier.*"\. Thus, the results do not include its checks\.$/, /^The toolkit file "health_more\.cjs" is not available \(HTTP 404\)\. Thus, the results do not include its checks\.$/,
        /^The toolkit file "advice\.cjs" is not available \(HTTP 404\)\./, /^The analysis includes the periods of rescue, level modes, failsafe and ground contact, because "health_more\.cjs" is missing\.$/])
        assert.ok(R2.notes.some(n => re.test(n)), `${re}: ${R2.notes.join('\n')}`);
    const R3 = await worker({ 'health_more.cjs': null }).result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, options: { flightRpm: TRUTH.rpm, curves: false } }, S.slice(1));
    assert.ok(R3.notes.includes('The analysis includes the periods of rescue, level modes, failsafe and ground contact, because "health_more.cjs" is missing. ' +
        'The checks of "health_track.cjs" do not use the rescue periods that RESCUE_STATE shows. The configuration, governor and loop checks use them.'), R3.notes.join('\n'));
    assert.ok(R2.curves.every(c => c.track === null && c.more === null) && R2.findings.length > 50);

    const E = worker({ 'health_gov.cjs': null });
    const m = await E.send({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, options: {} }, S.slice(1));
    assert.equal(m.type, 'error'); assert.equal(m.message, 'These toolkit files are not available: "tools/autotune/health_gov.cjs" (HTTP 404).');
    const cancel = worker(), done = cancel.send({ cmd: 'analyseFile', fileName: 'sim.bbl', selectedLog: 1, options: { flightRpm: TRUTH.rpm } }, S.bytes);
    cancel.ctx.onmessage({ data: { cmd: 'cancel', id: 1 } });
    assert.equal((await done).message, 'You canceled the analysis.');
    const odd = await worker().post({ cmd: 'nothing' });
    assert.deepEqual([odd.type, odd.message], ['error', 'The command "nothing" is unknown.']);
    const empty = await worker().post({ cmd: 'analyseLog', fileName: 'x.bbl', options: {} });
    assert.deepEqual([empty.type, empty.message], ['error', 'The command has no log data.']);
});

test('T4: a toolkit file that does not parse is named; stack lines are the file\'s; a hashbang line is accepted', async () => {
    const S = sim(), log = { cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, options: { flightRpm: TRUTH.rpm, curves: false } };
    // V8 gives a syntax error no location in the module: the message names it
    const m = await worker({ 'health_loop.cjs': 'const x = ;' }).send(log, S.slice(1));
    assert.equal(m.type, 'error'); assert.match(m.message, /^tools\/autotune\/health_loop\.cjs: Unexpected token/);
    const R = await worker({ 'health_track.cjs': 'const x = ;' }).result(log, S.slice(1));
    assert.ok(R.notes.some(n => /^The app cannot load the toolkit file "health_track\.cjs"\. The error is "Unexpected token/.test(n)), R.notes.join('\n'));
    // an error thrown while a module loads: the stack names its file and line, as Node's CommonJS loader numbers them
    const t = await worker({ 'health_loop.cjs': "'use strict';\n// line 2\nthrow new Error('boom at line 3');\n" }).send(log, S.slice(1));
    assert.equal(t.type, 'error'); assert.match(t.stack, /tools\/autotune\/health_loop\.cjs:3:\d+/);
    // a hashbang first line (fine for `node tools/autotune/x.cjs`, a syntax error inside a function body) is blanked
    const H = await worker({ 'health_track.cjs': '#!/usr/bin/env node\n' + STUB_TRACK }).result(log, S.slice(1));
    assert.ok(H.findings.some(f => f.module === 'track' && f.id === 'C12') && !H.notes.some(n => /health_track/.test(n)), H.notes.join('\n'));
    // gains: report.cjs that does not parse is named in the note (the CLI's view, so that report.cjs gets every segment)
    const G = await worker({ 'report.cjs': 'const x = ;', 'health_phase.cjs': null }).result({ cmd: 'analyseFile', fileName: 'one.bbl', selectedLog: 0, options: { flightRpm: TRUTH.rpm, gains: true, curves: false, excludeAbnormal: false } }, S.slice(4));
    assert.ok(G.decisions === null && G.notes.some(n => /^The app did not calculate the gains\. The error is "tools\/autotune\/report\.cjs: Unexpected token/.test(n)), G.notes.join('\n'));
});

test('a file with no flight: the toolkit default rpm, why, and gains not analysed for want of a segment (not a TypeError)', async () => {
    const S = sim(), R = await worker(NO_PHASE).result({ cmd: 'analyseFile', fileName: 'bench.bbl', selectedLog: 0, options: { flightRpm: null, gains: true, curves: false } }, S.slice(0));
    assert.deepEqual(R.flightRpm, { value: 3000, source: 'default', basis: null, profile: null, seconds: null, logs: [] });
    assert.ok(R.notes.some(n => n.startsWith('The flight rpm is 3000. This is the value that the toolkit uses when it cannot calculate the flight rpm. No log of the file gives a flight rpm (1 log). ' +
        'Logs that do not record AIRBORNE_STATE or the governor condition: 1. ')), R.notes.join('\n'));
    assert.equal(R.decisions, null);
    assert.ok(R.notes.includes('The app did not calculate the gains, because "extract.cjs" found no applicable segment. A segment is a minimum of 20 s of flight with one PID profile, no rescue and no missing data. ' +
        'Its median headspeed is 2500 rpm or more (5/6 of the flight rpm 3000).'), R.notes.join('\n'));
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
    const got = JSON.parse(R.advice.notes[0]), rec4 = R.records.find(r => r.log === 4), arming = rec4.profiles.arming;
    assert.deepEqual([got.headerLog, got.headerProfile, got.logBase], [4, 1, 1], 'the selected log, its confirmed PID profile at the start (D12: headspeed), viewer numbering');
    assert.deepEqual([arming.profile, arming.estimate, arming.basis, arming.confirmed, rec4.metrics.setup.startProfile], [1, null, ['headspeed'], true, 0],
        'no profile change and no CLI dump: govRequest at the start (2500 rpm) is the headspeed of PID profile 1 only, at the changes of log 1 (the label of the modules is 0)');
    assert.deepEqual(got.logs.find(l => l[0] === 3), [3, '2026-10-04T12:20:00.000+00:00'], 'record start as a date');
    assert.ok(got.logs.some(l => l[0] === 2 && l[1] === null), 'the parser-error record has no start');
    assert.equal(R.advice.script, 'set x = 1\nsave', 'result.advice.script is advice.script(recommendations)');
});

// review C1, D-H1: in file scope, advice reads the header and the field states of a flight log, never of a bench run
test('header (review C1, D-H1): the selected log when it is a flight log, else the last flight log of the file, with a note; never a bench run', async () => {
    const S = sim(), echo = `'use strict';
module.exports = { advise: (i) => ({ recommendations: [], coverage: [], notes: [JSON.stringify({ headerLog: i.headerLog, start: i.header ? i.header['Log start datetime'] : null, fields: !!i.fields })] }) };`;
    const run = (sel, o, bytes = S.bytes) => worker({ 'advice.cjs': echo, 'health_phase.cjs': STUB_PHASE }).result({ cmd: 'analyseFile', fileName: 'sim.bbl', selectedLog: sel, options: Object.assign({ flightRpm: TRUTH.rpm, curves: false }, o) }, bytes);
    const got = (R) => JSON.parse(R.advice.notes[0]);
    // log 0 (a bench run) on screen: the header of log 5, the last flight log (log 6 has no headspeed)
    const B = await run(0, {});
    assert.deepEqual(got(B), { headerLog: 5, start: '2026-10-04T12:40:00.000+00:00', fields: true }, J(got(B)));
    assert.deepEqual([B.headerLog, B.header['Log start datetime'], B.fields.headspeed], [5, '2026-10-04T12:40:00.000+00:00', 'present']);
    assert.ok(B.notes.includes('Log 1 is a bench run. Thus, the recommendations use the log header of log 6. This is the last flight log in the file.'), B.notes.join('\n'));
    // a flight log on screen: its own header, no note
    const F = await run(3, {});
    assert.deepEqual(got(F), { headerLog: 3, start: '2026-10-04T12:20:00.000+00:00', fields: true }); assert.deepEqual(F.header.yawPID, [80, 120, 10, 0, 0]);
    assert.ok(!F.notes.some(n => /last flight log/.test(n)));
    // without the flight phases: a log that is not flown is not a flight log either
    const P = await run(0, { phases: false });
    assert.equal(got(P).headerLog, 5);
    assert.ok(P.notes.includes('Log 1 is not a flight log. Thus, the recommendations use the log header of log 6. This is the last flight log in the file.'), P.notes.join('\n'));
    // a file of bench runs only: no header for advice, the header of the selected log for the display
    const N = await run(0, {}, S.slice(0));
    assert.deepEqual([got(N), N.headerLog, N.header['Craft name']], [{ headerLog: null, start: null, fields: false }, null, 'sim']);
    assert.ok(N.notes.includes('The file has no flight log. Thus, the recommendations do not use a log header.'), N.notes.join('\n'));
});

// review C5: the CLI file of the saved report (advice.script) has the meta of the export panel (js/tuning_dialog.js exportMeta)
test('script (review C5): advice.exportScript with the default picks and the meta of the export panel', async () => {
    const S = sim(), echo = `'use strict';
module.exports = { advise: () => ({ recommendations: [{ id: 'X', severity: 'action', profile: 2, cli: ['profile 1', 'set x = 1'] }, { id: 'Y', severity: 'check', cli: [] }], coverage: [], notes: [] }),
    defaultPicks: (recs) => recs.filter(r => r.cli.length).map(r => r.id), exportScript: (recs, picks, meta) => JSON.stringify({ recs: recs.map(r => r.id), picks, meta }) };`;
    const R = await worker({ 'advice.cjs': echo, 'health_phase.cjs': STUB_PHASE }).result({ cmd: 'analyseFile', fileName: 'sim.bbl', selectedLog: 1, options: { flightRpm: TRUTH.rpm, curves: false, cliText: CLI, cliName: TRUTH.cliName } }, S.bytes);
    const got = JSON.parse(R.advice.script), m = got.meta, d = new Date(), two = (n) => ('0' + n).slice(-2);
    assert.deepEqual([got.recs, got.picks], [['X', 'Y'], null], 'every recommendation, the default picks');
    assert.deepEqual([m.craft, m.file, m.logs, m.firmware, m.logBase, m.activeProfile, m.activeRateProfile], ['sim', 'sim.bbl', ['1', '2', '3', '4', '5', '6', '7'], 'Rotorflight 4.6.0 (sim) STM32F7X2', 1, 0, null]);
    assert.equal(m.date, `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`, 'the local date');
    assert.deepEqual(m.profiles, [1, 2], 'the PID profiles 1-6 of the analysis');
    const line = R.flights.filter(q => q.log === 1).map(q => `${+q.t0.toFixed(1)} s to ${+q.t1.toFixed(1)} s`).join(', ');
    assert.ok(m.flights.startsWith('Log 1: Bench run (no analysis). Log 2: ') && m.flights.includes(`Log 2: ${line}.`) && m.flights.includes('Log 3: No data that the app can read.'), m.flights); // round 3 M4, as js/tuning_dialog.js flightsLine
    // no recommendation with CLI text: no script
    const none = echo.replace("cli: ['profile 1', 'set x = 1']", 'cli: []'), E = await worker({ 'advice.cjs': none, 'health_phase.cjs': null }).result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, options: { flightRpm: TRUTH.rpm, curves: false } }, S.slice(1));
    assert.equal(E.advice.script, '');
});

// review C7: the PID profile (and rate profile) that the CLI dump selects at its end, only when the dump is not cut
test('CLI selection (review C7): selectedProfile only when the dump has one `profile` line or one more than its sections', async () => {
    const S = sim(), W = worker(Object.assign({ 'advice.cjs': null }, NO_APP_MODULES)), sel = async (text) => (await W.result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 4, options: { flightRpm: TRUTH.rpm, curves: false, cliText: text } }, S.slice(4))).cli;
    const head = '# diff all\n# Rotorflight / STM32F7X2 (S7X2) 4.6.0 Jun 30 2026 / 07:20:47 (118e912) MSP API: 12.08\n';
    assert.deepEqual(await sel(CLI), { kind: 'diff', version: '4.6.0', selectedProfile: 0, selectedRateProfile: null }, 'two sections and the selection line');
    assert.equal((await sel(`${head}profile 0\nset gov_headspeed = 2500\nprofile 1\nset gov_headspeed = 2700\n`)).selectedProfile, null, 'cut after the last section: the last line is a section');
    assert.equal((await sel(`${head}profile 2\nset gov_headspeed = 2500\n`)).selectedProfile, 2, 'one section only');
    const rates = `${head}profile 0\nset gov_headspeed = 2500\nprofile 0\nrateprofile 0\nset roll_rc_rate = 50\nrateprofile 2\nset roll_rc_rate = 60\nrateprofile 2\n`;
    assert.deepEqual([(await sel(rates)).selectedProfile, (await sel(rates)).selectedRateProfile], [0, 2]);
    assert.equal((await sel(rates.replace(/rateprofile 2\n$/, ''))).selectedRateProfile, null, 'rate profiles cut');
});

// review D-H2: the F5 filter pass of every flight log with an F5 flag, not only of the log on screen
test('filterPass (review D-H2): every flight log with an F5 flag has the measured filter pass, the same as when it is on screen', async () => {
    const S = sim(), W = worker(), run = (sel) => W.result({ cmd: 'analyseFile', fileName: 'sim.bbl', selectedLog: sel, options: { flightRpm: TRUTH.rpm, curves: true } }, S.bytes);
    const A = await run(1), f5 = (R) => R.findings.filter(f => f.id === 'F5' && f.severity === 'flag');
    const logs = [...new Set(f5(A).map(f => f.log))];
    assert.ok(logs.length >= 2 && logs.some(l => l !== 1), `F5 flags of logs ${J(logs)}`);
    assert.ok(f5(A).every(f => Array.isArray(f.filterPass) && f.filterPass.length && f.filterPass.every(q => ['roll', 'pitch', 'yaw'].every(ax => typeof q[ax] === 'number'))), J(f5(A).map(f => [f.fid, f.filterPass])));
    // the simulated filters pass 10 % of the rotor lines (gyroADC = 0.1 x the lines of gyroRAW)
    for (const f of f5(A)) for (const q of f.filterPass) assert.ok(['roll', 'pitch', 'yaw'].some(ax => q[ax] > 0.05 && q[ax] < 0.2), J(q));
    const other = logs.find(l => l !== 1), B = await run(other), key = (f) => f.fid;
    for (const f of f5(B).filter(q => q.log === other)) assert.deepEqual(f5(A).find(g => key(g) === key(f)).filterPass, f.filterPass, `${f.fid}: the same on screen and not`);
});

// ---------------------------------------------------------------------------------------------
// The toolkit modules as they are in the repo
// ---------------------------------------------------------------------------------------------

test('the toolkit modules as they are in the repo (health_track, health_more, advice, catalog, hierarchy, evidence when present) run end to end', async () => {
    const S = sim(), W = worker(), R = await W.result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, logCount: S.count, options: { flightRpm: TRUTH.rpm } }, S.slice(1));
    // these files are being written in parallel: whatever state they are in, the engine reports their outcome
    for (const [name, file] of [['track', 'health_track.cjs'], ['more', 'health_more.cjs'], ['phase', 'health_phase.cjs'], ['advice', 'advice.cjs'], ['catalog', 'catalog.cjs'], ['hierarchy', 'hierarchy.cjs'], ['evidence', 'evidence.cjs']]) {
        if (!has(file)) { assert.ok(R.notes.some(n => n.startsWith(`The toolkit file "${file}" is not available`)), `${file} missing is noted`); continue; }
        if (R.notes.some(n => n.startsWith(`The app cannot load the toolkit file "${file}"`))) continue;
        if (name === 'advice') { assert.ok(Array.isArray(R.advice.recommendations) && Array.isArray(R.advice.coverage));
            const A = require('../tools/autotune/advice.cjs'), picks = A.defaultPicks(R.advice.recommendations); // review C5: the export meta
            if (!picks.length) assert.equal(R.advice.script, '', 'no CLI text: no script');
            else assert.ok(R.advice.script.includes('# Craft name: "sim"') && R.advice.script.includes('# Log file: "sim.bbl"') && R.advice.script.endsWith('save'), R.advice.script); }
        else if (name === 'catalog') { const C = require('../tools/autotune/catalog.cjs');
            assert.ok(R.findings.every(f => typeof f.summary === 'string' && f.summary.length > 0), 'a summary on every finding');
            const odd = R.findings.filter(f => !(f.status === C.status(f) && f.noun === (C.CHECKS[f.id] && typeof C.CHECKS[f.id].noun === 'string' ? C.CHECKS[f.id].noun : null) && f.display && typeof f.display.unit === 'string'));
            assert.deepEqual(odd.map(f => [f.fid, f.status, C.status(f), f.noun, f.display]), [], 'status, noun and display from catalog.cjs');
            assert.ok(R.findings.some(f => typeof f.display.limit === 'string' && typeof f.display.value === 'string'), 'limits and values'); }
        else if (name === 'hierarchy') assert.ok(R.findings.every(f => 'node' in f) && R.hierarchy && R.hierarchy.nodes && Array.isArray(R.hierarchy.startHere), 'nodes and the result hierarchy');
        else if (name === 'evidence') assert.ok(R.findings.filter(f => f.severity === 'flag').every(f => f.evidence && f.evidence.fid === f.fid), 'evidence on every flag');
        else if (name === 'phase') assert.ok(R.records.every(l => l.skipped || ['flight', 'bench', null].includes(l.logClass)) && (R.records.some(l => l.logClass === 'bench') || R.findings.some(f => f.module === 'phase')), 'log class, and findings of health_phase.cjs');
        else assert.ok(R.findings.some(f => f.module === name), `${file}: findings (or error findings) of module ${name}`);
    }
    assert.ok(R.findings.length > 50 && R.records.length === 2);
});

test('evidence.cjs (when present): every flag has evidence; spans in frame seconds, 3 or less, in the log', { skip: !has('evidence.cjs') }, async () => {
    const S = sim(), R = await worker().result({ cmd: 'analyseFile', fileName: 'sim.bbl', selectedLog: 1, options: { flightRpm: TRUTH.rpm, cliText: CLI, cliName: TRUTH.cliName } }, S.bytes);
    const flags = R.findings.filter(f => f.severity === 'flag'), dur = (log) => Math.max(...R.records.filter(l => l.log === log).map(l => l.durationS || 0));
    assert.ok(flags.length > 10, `${flags.length} flags`);
    const lost = flags.filter(f => !f.evidence);
    assert.equal(lost.length, 0, `flags without evidence: ${J(lost.map(f => f.fid))}`);
    for (const f of R.findings) {
        if (!f.evidence) continue;
        const e = f.evidence;
        assert.equal(e.v, 1, f.fid); assert.equal(e.fid, f.fid);
        // 3 or less; a check of the control limits keeps up to 10 periods (catalog.cjs evidence.maxSpans: CLAUDE.md "Control limits")
        assert.ok(Array.isArray(e.spans) && e.spans.length <= (/^(L\d|P1)$/.test(f.id) ? 10 : 3), `${f.fid}: spans ${J(e.spans)}`);
        for (const q of e.spans) assert.ok(isFinite(q.t0) && isFinite(q.t1) && q.t0 <= q.t1 && q.t1 >= 0 && q.t0 <= dur(q.log === undefined ? logsOf(f)[0] : q.log) + 5, `${f.fid}: span ${J(q)}`);
        if (e.view) assert.ok(isFinite(e.view.t0) && isFinite(e.view.t1) && e.view.t0 <= e.view.t1, `${f.fid}: view ${J(e.view)}`);
    }
});

test('hierarchy.cjs (when present): result.hierarchy is hierarchy.status of the findings, the recommendations and the logs', { skip: !has('hierarchy.cjs') }, async () => {
    const S = sim(), R = await worker().result({ cmd: 'analyseFile', fileName: 'sim.bbl', selectedLog: 1, options: { flightRpm: TRUTH.rpm, cliText: CLI, cliName: TRUTH.cliName, keepMetrics: true } }, S.bytes);
    const H = require('../tools/autotune/hierarchy.cjs'), dated = (s) => typeof s === 'string' && /^[1-9]\d{3}-/.test(s) ? s : null;
    const armOf = (log) => { const q = R.records.find(l => l.log === log && l.profiles); return q ? q.profiles.arming : null; };
    const logs = R.records.map(l => ({ log: l.log, segment: l.segment, start: dated(l.start), flown: !!l.flown, flyingS: l.flyingS || 0, profileSeconds: l.profileSeconds || {}, targetOf: l.targetOf || {},
        excluded: l.excluded || null, skipped: l.skipped || null, startProfile: l.metrics && l.metrics.setup ? l.metrics.setup.startProfile : null,
        armingProfile: armOf(l.log) ? armOf(l.log).profile : null, armingBasis: armOf(l.log) ? armOf(l.log).basis : [], logClass: l.logClass || null }));
    const plain = JSON.parse(J({ findings: R.findings, recs: R.advice.recommendations, logs, coverage: R.advice.coverage }));
    assert.ok(R.hierarchy && R.hierarchy.nodes && Array.isArray(R.hierarchy.startHere), J(R.hierarchy).slice(0, 300));
    const { graph, byDataset, ...status } = R.hierarchy;
    sameJson(status, H.status(plain.findings, plain.recs, { logs: plain.logs, coverage: plain.coverage }), 'hierarchy.status recomputed');
    // round 3: the diagram of each analysed configuration, hierarchy.status in its PID profile
    assert.deepEqual(Object.keys(byDataset), R.datasets.analysed);
    for (const [id, x] of Object.entries(byDataset)) { const d = R.datasets.datasets.find(q => q.id === id), F = plain.findings.filter(f => !f.dataset || f.dataset === id);
        const recs = plain.recs.filter(r => r.dataset === id || (r.supportedBy || []).includes(id) || (!r.dataset && !(r.supportedBy || []).length)), st = H.status(F, recs, { logs: plain.logs, coverage: plain.coverage, profile: d.pidProfile > 0 ? d.pidProfile : 0 });
        sameJson(x, { pidProfile: d.pidProfile, nodes: st.nodes, startHere: st.startHere, prereqProblems: st.prereqProblems }, `the diagram of configuration ${id}`); }
    sameJson(graph, H.graph(), 'the graph of the diagram (K1: prereq, blocks, edges, rules)');
    assert.deepEqual([graph.prereq.map(n => n.id), graph.blocks.map(n => n.id)], [H.PREREQ.map(n => n.id), H.BLOCKS.map(n => n.id)]);
    assert.ok(Array.isArray(R.hierarchy.prereqProblems));
    // K2, K3: every finding has its item, the tuner link and its subsystem
    const C = require('../tools/autotune/catalog.cjs');
    for (const f of R.findings.filter(x => C.CHECKS[x.id])) { assert.equal(f.node, H.homeOf(f.id, f.axis ?? null), f.fid); assert.equal(f.tuner, H.isBlock(f.node), f.fid); assert.equal(f.area, C.areaOf(f), f.fid); assert.ok(C.AREAS.includes(f.area), `${f.fid}: area ${f.area}`); }
    const fids = new Set(R.findings.map(f => f.fid));
    for (const [id, n] of Object.entries(R.hierarchy.nodes)) for (const fid of n.fids || []) assert.ok(fids.has(fid), `node ${id}: fid ${fid} is a finding`);
});

// ---------------------------------------------------------------------------------------------
// derive: filters, spectra and window statistics of raw log data (persistent worker, no decode)
// ---------------------------------------------------------------------------------------------

const lcg = (seed) => { let s = seed >>> 0; return () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296; };
const noise = (n, seed, sd) => { const u = lcg(seed); return Float64Array.from({ length: n }, () => sd * Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u())); };
// the largest |got - want| against the largest |want|; NaN where want is NaN
function close(got, want, tol, what) {
    let m = 0, ref = 0;
    for (let i = 0; i < want.length; i++) { if (Number.isNaN(want[i])) { assert.ok(Number.isNaN(got[i]), `${what}: NaN at ${i}`); continue; } m = Math.max(m, Math.abs(got[i] - want[i])); ref = Math.max(ref, Math.abs(want[i])); }
    assert.ok(m <= tol * ref, `${what}: largest error ${m} of ${ref}`);
}

test('export: advice.exportScript of the recommendations, the picks and the meta, as CLI text; an error without advice.cjs', async () => {
    const echo = `'use strict';
module.exports = { advise: () => ({ recommendations: [], coverage: [], notes: [] }), exportScript: (recs, picks, meta) => JSON.stringify({ recs: recs.map(r => r.id), picks, meta }) };`;
    const m = await worker({ 'advice.cjs': echo }).post({ cmd: 'export', recs: [{ id: 'A' }, { id: 'B' }], picks: ['B'], meta: { craft: 'sim', activeProfile: 0 } });
    assert.deepEqual([m.type, JSON.parse(m.result)], ['exported', { recs: ['A', 'B'], picks: ['B'], meta: { craft: 'sim', activeProfile: 0 } }]);
    const d = await worker({ 'advice.cjs': echo }).post({ cmd: 'export', recs: [{ id: 'A' }] });
    assert.deepEqual(JSON.parse(d.result), { recs: ['A'], picks: null, meta: {} }, 'no picks: the advice defaults');
    if (has('advice.cjs')) { const A = require('../tools/autotune/advice.cjs'), real = await worker().post({ cmd: 'export', recs: [], picks: [], meta: { date: '2026-10-05' } });
        assert.deepEqual([real.type, real.result], ['exported', A.exportScript([], [], { date: '2026-10-05' })]); }
    const none = await worker({ 'advice.cjs': null }).post({ cmd: 'export', recs: [] });
    assert.deepEqual([none.type, none.message], ['error', 'The toolkit file "advice.cjs" is not available, or it has no function "exportScript".']);
});

test('derive: init loads the toolkit once; derive never decodes, makes no fs call and fetches nothing more; bad requests are errors', async () => {
    const W = worker(), TW = W.ctx.TuningWorker;
    W.ctx.FlightLog = W.ctx.FlightLogIndex = function () { throw new Error('the derive worker decoded a log'); };
    const ready = await W.post({ cmd: 'init' });
    assert.equal(ready.type, 'ready');
    assert.deepEqual(Object.keys(ready.result.modules), ['track', 'more', 'gov', 'catalog']);
    assert.ok(ready.result.modules.track && ready.result.modules.more && ready.result.modules.gov, J(ready.result));
    assert.equal(ready.result.modules.catalog, has('catalog.cjs'));
    assert.equal(W.fetches.length, 22, 'each toolkit file fetched once');
    const x = Float32Array.from(noise(4000, 1, 10));
    await W.derive('bandpass', { x }, 1000, { lo: 5, hi: 50 });
    await W.derive('window', { 'setpoint[0]': x, 'gyroADC[0]': x }, 1000, {});
    assert.equal(W.fetches.length, 22, 'no fetch after init');
    assert.equal((await TW.deriveKit()).calls.n, 0, 'no fs call');
    const bad = async (msg, text) => { const m = await W.post(Object.assign({ cmd: 'derive' }, msg)); assert.deepEqual([m.type, m.message], ['error', text]); };
    await bad({ kind: 'nope', rate: 1000, cols: { x } }, 'The function "nope" is unknown.');
    await bad({ kind: 'bandpass', rate: 0, cols: { x } }, 'The command has no sample rate.');
    await bad({ kind: 'bandpass', rate: 1000, cols: {} }, 'The command has no data.');
    await bad({ kind: 'bandpass', rate: 1000, cols: { x }, params: { hi: 50 } }, 'The parameter "lo" is not a number.');
    await bad({ kind: 'transmission', rate: 1000, cols: { x }, params: { from: 'a', to: 'x' } }, 'The data has no column "a" (from).');
    await bad({ kind: 'spectrum', rate: 1000, cols: { x: Float32Array.of(1, 2, 3) } }, 'The data has 3 samples. A minimum of 16 samples is necessary for a spectrum.');
    const noTrack = worker({ 'health_track.cjs': null }), m = await noTrack.post({ cmd: 'derive', kind: 'lowpass', rate: 1000, cols: { x }, params: { hz: 30 } });
    assert.deepEqual([m.type, m.message], ['error', 'The function "lowpass" cannot operate without "health_track.cjs".']);
    const r = await noTrack.post({ cmd: 'init' });
    assert.ok(r.result.notes.includes('The toolkit file "health_track.cjs" is not available (HTTP 404).') && r.result.modules.track === false, J(r.result));
});

test('derive: band-pass, low-pass, pt2 and shift equal the toolkit functions; spectrum agrees with a direct Welch DFT; transmission gives a known filter', async () => {
    const W = worker(), lib = require('../tools/autotune/lib.cjs'), track = require('../tools/autotune/health_track.cjs'), gov = require('../tools/autotune/health_gov.cjs');
    const rate = 1000, n = 8192, x = Float32Array.from(noise(n, 5, 20), (v, i) => v + 30 * Math.sin(2 * Math.PI * 12 * i / rate) + 10 * Math.sin(2 * Math.PI * 87 * i / rate)), X = Float64Array.from(x);
    const one = async (kind, params) => { const R = await W.derive(kind, { x }, rate, params); assert.deepEqual([R.kind, R.rate, R.n, Object.keys(R.cols)], [kind, rate, n, ['x']]); assert.ok(R.cols.x instanceof Float32Array); return R.cols.x; };
    close(await one('bandpass', { lo: 8, hi: 16 }), lib.bandpass(X, 8, 16, rate), 1e-6, 'bandpass');
    close(await one('lowpass', { hz: 30 }), track.lowpass(X, 30, rate), 1e-6, 'lowpass');
    close(await one('pt2', { hz: 10 }), gov.pt2(X, 10, rate), 1e-6, 'pt2');
    close(await one('shift', { ms: 2.5 }), Float64Array.from(X, (v, i) => i + 3 < n ? X[i + 2] + 0.5 * (X[i + 3] - X[i + 2]) : NaN), 1e-6, 'shift by 2.5 samples');
    const two = await W.derive('bandpass', { x, y: x }, rate, { lo: 8, hi: 16, fields: ['y'] });
    assert.deepEqual(Object.keys(two.cols), ['y'], 'params.fields selects the columns');

    // spectrum: the one-sided PSD of Welch with lib.fftFor's Hann window, hop N / 2, each window's mean removed, at three bins by a direct DFT
    const N = 1024, S = await W.derive('spectrum', { x }, rate, { N }), win = Float64Array.from({ length: N }, (_, i) => 0.5 * (1 - Math.cos(2 * Math.PI * i / (N - 1)))), power = win.reduce((a, v) => a + v * v, 0);
    assert.deepEqual([S.N, S.windows, S.f.length], [N, (n - N) / (N / 2) + 1, N / 2 + 1]);
    for (const k of [12, 89, 300]) {
        let acc = 0, windows = 0;
        for (let s = 0; s + N <= n; s += N / 2, windows++) { let m = 0; for (let i = 0; i < N; i++) m += X[s + i]; m /= N; let re = 0, im = 0;
            for (let i = 0; i < N; i++) { const v = (X[s + i] - m) * win[i], a = -2 * Math.PI * k * i / N; re += v * Math.cos(a); im += v * Math.sin(a); } acc += re * re + im * im; }
        within(S.psd.x[k], acc / windows * 2 / (rate * power), 1e-5 * S.psd.x[k], `PSD at bin ${k}`);
        within(S.amplitude.x[k], Math.sqrt(acc / windows) / (N / 4), 1e-5 * S.amplitude.x[k], `amplitude at bin ${k}`);
        within(S.f[k], k * rate / N, 1e-3, `f of bin ${k}`);
    }
    // an on-bin sinusoid: its amplitude; lib.fftFor's Hann window is the symmetric one (sum (N - 1) / 2), so the scale N / 4 of the
    // vibration curves (health_more) reads (N - 1) / N of it
    const tone = await W.derive('spectrum', { x: Float32Array.from({ length: 4096 }, (_, i) => 7 * Math.sin(2 * Math.PI * 50 * i / 1024)) }, 1024, { N: 1024 });
    within(tone.amplitude.x[50], 7 * 1023 / 1024, 1e-4, 'amplitude of a 7 deg/s sinusoid at 50 Hz');

    // transmission: white noise through lib.lpf1 at 40 Hz: |H|, the phase and the coherence-weighted phase delay over 8-16 Hz (health_more F11)
    const raw = noise(n, 9, 50), filt = lib.lpf1(raw, 40, rate), T = await W.derive('transmission', { raw: Float32Array.from(raw), filt: Float32Array.from(filt) }, rate, { from: 'raw', to: 'filt', N });
    const H = (f) => lib.lpf1Response(f, 40, rate);
    for (const hz of [10, 20, 50, 120]) { const k = Math.round(hz * N / rate), h = H(k * rate / N);
        within(T.gain[k], Math.hypot(h[0], h[1]), 0.01 * Math.hypot(h[0], h[1]), `gain at ${hz} Hz`);
        within(T.phaseDeg[k], Math.atan2(h[1], h[0]) * 180 / Math.PI, 0.5, `phase at ${hz} Hz`);
        assert.ok(T.coherence[k] > 0.999, `coherence at ${hz} Hz: ${T.coherence[k]}`); }
    let s = 0, c = 0; for (let k = 1; k * rate / N <= 16; k++) { const f = k * rate / N; if (f < 8) continue; const h = H(f); s += -Math.atan2(h[1], h[0]) / (2 * Math.PI * f); c++; }
    assert.deepEqual(T.band, [8, 16]);
    within(T.delayMs, 1000 * s / c, 0.02, 'phase delay of the 40 Hz low-pass at 8-16 Hz');
});

test('derive window: the log lens statistics against signals of known tracking error, oscillation, headspeed error, tail limit, D-term noise and lines', async () => {
    const W = worker(), track = require('../tools/autotune/health_track.cjs'), more = require('../tools/autotune/health_more.cjs');
    const rate = 1024, n = 12 * rate, pad = rate, sin = (A, f, i, ph = 0) => A * Math.sin(2 * Math.PI * f * i / rate + ph), col = (fn) => Float32Array.from({ length: n }, (_, i) => fn(i)), wn = noise(n, 3, 2);
    // roll: the gyro 20 samples after the setpoint and a 30 deg/s error at 2 Hz; pitch: 8 deg/s of stick and a 40 deg/s oscillation at 12 Hz;
    // yaw: the gyro 31 samples after the setpoint; governor 1.5 % over its target; the tail at a 250 permille limit; D-term 200 at 100 Hz on 100 at 10 Hz;
    // gyroRAW[0] lines at 96, 64 and 32 Hz on 0.2 deg/s of noise (on the bins of a 1 s window)
    const spR = (i) => sin(100, 1, i) + sin(60, 2.3, i, 0.4), errR = (i) => sin(30, 2, i, 1), spY = (i) => sin(80, 0.5, i), u = noise(n, 4, 0.2);
    const C = { 'setpoint[0]': col(spR), 'gyroADC[0]': col(i => spR(i - 20) + errR(i)), 'setpoint[1]': col(i => sin(8, 0.7, i)), 'gyroADC[1]': col(i => sin(8, 0.7, i) + sin(40, 12, i)),
        'setpoint[2]': col(spY), 'gyroADC[2]': col(i => spY(i - 31)), headspeed: col(i => 1948.8 + wn[i]), govTarget: col(() => 1920), 'mixer[2]': col(i => Math.min(250, sin(300, 0.7, i))),
        'axisD[0]': col(i => sin(100, 10, i) + sin(200, 100, i, 0.3)), 'axisD[1]': col(() => 0), 'gyroRAW[0]': col(i => sin(5, 96, i) + sin(3, 64, i, 1) + sin(1.5, 32, i, 2) + u[i]) };
    const R = await W.derive('window', C, rate, { t0: 100, padS: 1, notchHz: { roll: [97] }, tailLimits: { lo: -500, hi: 250 } });
    const item = (key) => R.items.find(q => q.key === key), STATUS = ['satisfactory', 'monitor', 'insufficient', 'notMeasured', 'information'];
    assert.deepEqual(R.items.map(q => q.key), ['track.roll', 'track.pitch', 'track.yaw', 'osc.roll', 'osc.pitch', 'osc.yaw', 'gov.error', 'tail.limit', 'dterm.roll', 'dterm.pitch', 'dterm.yaw', 'lines.roll', 'lines.pitch', 'lines.yaw']);
    assert.deepEqual([R.kind, R.rate, R.n, R.t0, R.t1, R.seconds, R.padS], ['window', rate, n, 101, 111, 10, 1]);
    for (const q of R.items) {
        assert.ok(STATUS.includes(q.status) && typeof q.text === 'string' && /^[A-Z0-9].*\.$/.test(q.text) && !/;/.test(q.text), `${q.key}: ${q.status}, ${q.text}`);
        assert.equal(q.check, { track: q.axis === 'yaw' ? 'T11' : 'C12', osc: q.axis === 'yaw' ? 'T1' : 'C5', gov: 'G2', tail: 'T8', dterm: q.axis === 'yaw' ? 'F10' : 'C11', lines: 'F5' }[q.key.split('.')[0]], q.key);
    }
    // tracking error: sqrt(sum of the error after the delay / sum of setpoint^2) over the samples with |setpoint| > 5 deg/s (C12), the delay fitted
    const ratio = (sp, err, k, end) => { let e = 0, s = 0; for (let i = pad; i < end; i++) { const v = sp(i); if (Math.abs(v) <= 5) continue; e += err(i + k) ** 2; s += v * v; } return Math.sqrt(e / s); };
    const maxK = Math.round(track.RULE.track.maxS * rate), roll = item('track.roll');
    assert.deepEqual([roll.detail.tauMs, roll.detail.tauSource, roll.status, roll.over, roll.limits], [19.5, 'fitted', 'satisfactory', 0, [{ value: 0.3, level: 'note' }, { value: 0.45, level: 'flag' }]]);
    within(roll.value, ratio(spR, errR, 20, n - pad - maxK), 0.005 * roll.value, 'roll tracking error, fitted delay');
    within(roll.value, 0.2572, 0.01, 'about 30 / sqrt(100^2 + 60^2)');
    assert.equal(roll.text, `The roll tracking error is ${(roll.value * 100).toFixed(1)} % of the setpoint, with a time delay of 19.5 ms. The limits are 30 % and 45 % (check C12).`);
    const given = (await W.derive('window', C, rate, { padS: 1, tauMs: { roll: 19.53 } })).items[0];
    assert.equal(given.detail.tauSource, 'given');
    within(given.value, ratio(spR, errR, 20, n - pad - 20), 0.005 * given.value, 'roll tracking error, delay given');
    const pitch = item('track.pitch'), yaw = item('track.yaw');
    assert.deepEqual([pitch.status, pitch.text], ['insufficient', 'The pitch setpoint is 5.7 deg/s rms. The tracking error is not accurate at less than 20 deg/s rms (check C12).']);
    assert.ok(yaw.status === 'satisfactory' && yaw.value < 0.01 && Math.abs(yaw.detail.tauMs - 31 / rate * 1000) < 0.1, J(yaw));
    // oscillation: the 12 Hz sine through the 8-16 Hz band-pass (health_track bandGain), 6 cycles in each 0.5 s window, no stick in the band
    const osc = item('osc.pitch'), G = track.bandGain(12, [8, 16], rate);
    within(osc.value, 40 * G, 0.01 * 40 * G, 'pitch oscillation amplitude');
    assert.ok(osc.status === 'monitor' && osc.over === 1 && Math.abs(osc.detail.hz - 12) <= 1 && osc.detail.shareAtLimit === 1 && osc.detail.stickFree === 20, J(osc));
    assert.ok(osc.detail.worst.t0 >= 101 && osc.detail.worst.t1 <= 111 && osc.detail.worst.t1 - osc.detail.worst.t0 === 0.5, J(osc.detail.worst));
    assert.ok(item('osc.roll').value < 2 && item('osc.roll').status === 'satisfactory', J(item('osc.roll')));
    // headspeed: 1948.8 against 1920 rpm is 1.5 %, more than the 1 % median limit, inside the 2 % band
    const gv = item('gov.error');
    within(gv.value, 0.015, 2e-4, 'median headspeed error'); assert.deepEqual([gv.status, gv.over, gv.detail.reference], ['monitor', 1, 'govTarget']);
    assert.ok(gv.detail.p5 > 0.013 && gv.detail.p95 < 0.017, J(gv.detail));
    // the tail: the samples at the 250 permille limit (within 1.5 permille, health_loop limitTol) and their periods, given limits or found in the window
    let at = 0, runs = 0, prev = false; for (let i = pad; i < n - pad; i++) { const on = C['mixer[2]'][i] >= 248.5; if (on) { at++; if (!prev) runs++; } prev = on; }
    const tail = item('tail.limit');
    assert.deepEqual([tail.value, tail.n, tail.status, tail.detail.limitSource, tail.detail.share], [+(at / rate).toFixed(3), runs, 'monitor', 'given', +(at / (n - 2 * pad)).toFixed(4)]);
    const found = (await W.derive('window', C, rate, { padS: 1 })).items.find(q => q.key === 'tail.limit');
    assert.deepEqual([found.value, found.n, found.detail.lo, found.detail.hi, found.detail.limitSource], [tail.value, runs, null, 250, 'window']);
    // D-term: the power share of the band-pass from 30 Hz to 0.45 x rate (health_more F10): bandGain of each sine
    const g = (f) => track.bandGain(f, [more.RULE.noise.hz, 0.45 * rate], rate), share = ((100 * g(10)) ** 2 + (200 * g(100)) ** 2) / (100 ** 2 + 200 ** 2), d = item('dterm.roll');
    within(d.value, share, 0.002, 'D-term share at more than 30 Hz'); assert.deepEqual([d.status, d.n, d.limits], ['monitor', 10, [{ value: 0.5, level: 'flag' }]]);
    assert.deepEqual([item('dterm.pitch').status, item('dterm.yaw').status], ['notMeasured', 'notMeasured']);
    // lines: on the bins, amplitude and frequency; rotor orders from the median headspeed; the nearest notch
    const L = item('lines.roll').detail.lines, rotorHz = 1948.8 / 60;
    assert.equal(L.length, 3);
    [[96, 5], [64, 3], [32, 1.5]].forEach(([hz, A], k) => { within(L[k].hz, hz, 0.05, `line ${k} Hz`); within(L[k].amplitude, A, 0.02 * A, `line ${k} amplitude`); within(L[k].order, hz / rotorHz, 0.003, `line ${k} order`); });
    assert.deepEqual(L[0].notch, { hz: 97, distance: +(1 / 96).toFixed(4) });
    assert.equal(item('lines.roll').text, `The strongest roll gyro lines are at 96.0 Hz (${(96 / rotorHz).toFixed(2)} × the rotor frequency), 64.0 Hz (${(64 / rotorHz).toFixed(2)} × the rotor frequency) and 32.0 Hz (${(32 / rotorHz).toFixed(2)} × the rotor frequency). Check F5 uses these lines.`);
    const lp = item('lines.pitch');
    assert.ok(lp.detail.field === 'gyroADC[1]' && Math.abs(lp.detail.lines[0].hz - 12) < 0.1 && R.notes.includes('The log does not record "gyroRAW[1]". Thus, the pitch gyro lines come from "gyroADC[1]", after the gyro filters.'), J(lp));
    // without the fields: not measured, and the reason
    const bare = await W.derive('window', { 'setpoint[0]': C['setpoint[0]'] }, rate, {});
    const b = (key) => bare.items.find(q => q.key === key);
    assert.deepEqual([b('track.roll').status, b('track.roll').text], ['notMeasured', 'The log does not record "gyroADC[0]". Thus, the app cannot calculate the roll tracking error (check C12).']);
    assert.deepEqual([b('gov.error').status, b('tail.limit').status], ['notMeasured', 'notMeasured']);
    const noTarget = (await W.derive('window', { headspeed: C.headspeed }, rate, {})).items.find(q => q.key === 'gov.error');
    assert.ok(noTarget.detail.reference === 'median headspeed' && Math.abs(noTarget.detail.median) < 1e-3, J(noTarget));
});

// ---------------------------------------------------------------------------------------------
// D13: log class and flight phases (health_phase.cjs; ground truth: the stub's phases on the simulated logs)
// ---------------------------------------------------------------------------------------------

// truth of a decoded segment w at a flight rpm: the health.cjs mask, the stub's flight mask and its spans in frame seconds
function phaseTruth(w, rpm, airborneEvents) {
    const H = require('../tools/autotune/health.cjs'), rate = w.flight.actualRate, { flying } = H.flightMask(w, rate, { headspeed: rpm, rate: 10, minS: 5 });
    const P = stubPhase.phases(w, { rate, airborneEvents }), fm = stubPhase.flightMask(w, { rate, phases: P }), t = w.extra.time, at = (i) => w.fromS + (t[Math.min(i, w.n - 1)] - t[0]) / 1e6 + (i >= w.n ? (i - w.n + 1) / rate : 0);
    let both = 0, all = 0, flight = 0; for (let i = 0; i < w.n; i++) { all += flying[i]; flight += fm[i]; both += flying[i] & fm[i]; }
    return { P, flying, fm, all, flight, both, spans: P.spans.map(q => ({ phase: q.phase, t0: at(q.i0), t1: at(q.i1) })) };
}
// the truth of the governor metrics of segment `seg` of one log (bytes) as the worker must give them in a flight log: health_gov of
// the worker's kit at that flight rpm, over the stub's phases: D5, G13, G12 and states on every phase, G1 on the ground and flight
// phases, the rest on the ground and flight phases at the flight rpm or more less `keep` (rescue, level modes, failsafe; null:
// nothing), and phaseMasks
async function govTruth(W, rpm, bytes, seg, cliText, keep) {
    const TW = W.ctx.TuningWorker, K = TW.kit(await TW.sources(), rpm), file = '/v/truth.bbl', r1 = (v) => +v.toFixed(1);
    K.files.set(file, bytes); const w = [...K.lib.segments(W.ctx, file, { whole: true, extra: K.extraAll })].filter(x => !x.skipped)[seg]; K.files.delete(file);
    const rate = w.flight.actualRate, { flying } = K.health.flightMask(w, rate), airborneEvents = w.airborneAt.some(v => !v), P = stubPhase.phases(w, { rate, airborneEvents });
    const all = new Uint8Array(w.n), rotor = new Uint8Array(w.n), tracking = new Uint8Array(w.n);
    for (const q of P.spans) { all.fill(1, q.i0, q.i1); if (q.phase === 'ground' || q.phase === 'flight') { rotor.fill(1, q.i0, q.i1); for (let i = q.i0; i < q.i1; i++) tracking[i] = w.hs[i] >= rpm && (!keep || keep[i]) ? 1 : 0; } }
    const ctx = K.health.buildCtx(w, w.flight, { flying, profile: Uint8Array.from(w.profileAt), cli: cliText, cliParsed: cliText ? K.core.setup.parseCli(cliText) : null, app: W.ctx });
    const run = (mask) => K.core.gov.analyse(w, Object.assign({}, ctx, { flying: mask, flyingAll: flying })), a = run(all), b = run(rotor), out = run(tracking);
    for (const k of ['D5', 'G13', 'G12', 'states']) out[k] = a[k];
    out.G1 = b.G1;
    const sum = (m) => m.reduce((x, v) => x + v, 0);
    out.phaseMasks = { all: { phases: ['idle', 'spoolup', 'ground', 'flight', 'spooldown'], seconds: r1(sum(all) / rate), checks: ['D5', 'G13', 'G12'] },
        rotor: { phases: ['ground', 'flight'], seconds: r1(sum(rotor) / rate), checks: ['G1'] }, tracking: { phases: ['ground', 'flight'], seconds: r1(sum(tracking) / rate), active: !!w.govStateAt } };
    return out;
}
const simSegments = (() => { let v = null; return () => v || (v = (() => { const S = sim(), out = {};
    for (let li = 0; li < S.count; li++) { const f = path.join(tmp, `sim-${li}.bbl`); fs.writeFileSync(f, S.slice(li)); try { out[li] = decoded(f, ['time', 'govTarget', 'flightModeFlags']); } catch (e) { out[li] = []; } }
    return out; })()); })();

test('D13: a log with no flight is a bench run, which the app does not analyse; flight logs keep all phases in frame seconds', async () => {
    const S = sim(), W = worker(Object.assign({ 'health_phase.cjs': STUB_PHASE, 'health_track.cjs': STUB_TRACK, 'health_more.cjs': STUB_MORE }, { 'evidence.cjs': null }));
    const run = (o) => W.result({ cmd: 'analyseFile', fileName: 'sim.bbl', selectedLog: 1, options: Object.assign({ flightRpm: null, cliText: CLI, excludeAbnormal: false, keepMetrics: true, datasets: false }, o) }, S.bytes); // the governor truth: PID profile labels
    const R = await run({}), off = await run({ phases: false }), segs = simSegments();
    // the class of each log: log 0 never leaves the ground (no AIRBORNE_STATE event), log 2 does not parse, log 6 has no headspeed
    assert.deepEqual(R.records.map(l => [l.log, l.logClass === undefined ? 'none' : l.logClass]), [[0, 'bench'], [1, 'flight'], [1, 'flight'], [3, 'flight'], [4, 'flight'], [5, 'flight'], [6, 'none'], [2, 'none']]);
    assert.deepEqual(R.benchRuns.map(b => b.log), [0]);
    within(R.benchRuns[0].phaseSeconds.idle, 8, 0.05, 'the bench run is idle throughout');
    assert.ok(R.notes.includes('Log 1 is a bench run (no flight). The app does not do the analysis of a bench run.'), R.notes.join('\n'));
    // no analysis of the bench run: only its log class (health_phase D7, which advice and the hierarchy list), not in health_report.cjs
    assert.deepEqual(Object.keys(R.records[0].metrics), ['phase']);
    assert.deepEqual(R.findings.filter(f => logsOf(f).includes(0)).map(f => [f.module, f.id]), [['phase', 'D7']]);
    assert.ok(off.findings.filter(f => logsOf(f).includes(0)).length > 10, 'findings of log 0 with phases off');
    // the auto flight rpm from the flight phases: profile 0 of logs 1, 3 and 4, 1 s less at each end of each flight
    assert.deepEqual(rpmOf(R.flightRpm), Object.assign({}, FILE_RPM, { seconds: 83 }), J(R.flightRpm));
    // phases in frame seconds: the stub's spans of each segment through the frame clock, to 0.1 ms; contiguous; flights from the flight spans
    for (const rec of R.records.filter(l => l.logClass)) {
        const w = segs[rec.log][rec.segment], T = phaseTruth(w, R.flightRpm.value, segs[rec.log].some(x => x.airborneAt.some(v => !v)));
        assert.equal(rec.phases.length, T.spans.length, `log ${rec.log}.${rec.segment} spans`);
        rec.phases.forEach((q, k) => { assert.equal(q.phase, T.spans[k].phase); within(q.t0, T.spans[k].t0, 1e-4, `${rec.log}.${rec.segment} span ${k} t0`); within(q.t1, T.spans[k].t1, 1e-4, `${rec.log}.${rec.segment} span ${k} t1`);
            if (k) assert.equal(q.t0, rec.phases[k - 1].t1, 'contiguous'); });
        within(rec.phases[0].t0, rec.fromS, 1e-3, 'from the first sample');
        const fl = rec.phases.filter(q => q.phase === 'flight');
        assert.deepEqual(rec.flights.map(q => [q.t0, q.t1, q.method, q.confidence]), fl.map(q => [q.t0, q.t1, 'stub', 0.9]), `${rec.log}.${rec.segment} flights`);
        within(Object.values(rec.phaseSeconds).reduce((a, b) => a + b, 0), rec.phases[rec.phases.length - 1].t1 - rec.phases[0].t0, 0.3, 'phase seconds');
        if (rec.logClass !== 'flight') continue;
        // masks: the attitude and filter modules get the health.cjs mask AND the flight phases; health_phase gets the health.cjs mask
        const m = rec.metrics;
        if (m.track) assert.equal(m.track.flyingN, T.both, `${rec.log}.${rec.segment}: health_track sees the flight phases only`);
        if (m.more) assert.equal(m.more.flyingN, T.both, `${rec.log}.${rec.segment}: health_more sees the flight phases only`);
        assert.deepEqual([m.phase.flyingN, m.phase.flightN], [T.all, T.flight], `${rec.log}.${rec.segment}: health_phase sees all phases and the flight mask`);
        if (rec.flown) within(m.setup.flyingS, T.both / rec.actualRate, 0.051, 'health_setup (filters, vibration) on the flight phases');
        // the governor keeps all phases (review A5, A7): FALLBACK, voltage and motor on every phase, the tracking checks on the
        // ground and flight phases at the flight rpm; health_gov.analyse on the stub's masks is the truth
        const o = off.records.find(l => l.log === rec.log && l.segment === rec.segment);
        assert.equal(J(m.gov), J(await govTruth(W, R.flightRpm.value, S.slice(rec.log), rec.segment, CLI, null)), `${rec.log}.${rec.segment}: governor metrics of all phases`);
        assert.notEqual(J(m.gov.G2), J(o.metrics.gov.G2), `${rec.log}.${rec.segment}: the tracking checks see the ground phase too`);
        if (m.loop && o.metrics.loop) assert.notEqual(J(m.loop), J(o.metrics.loop), 'health_loop on the flight phases');
        if (rec.flown) within(rec.normalS, T.both / rec.actualRate, 0.051, 'normalS: the seconds the attitude checks use');
    }
    assert.ok(R.records.filter(l => l.logClass === 'flight').some(l => l.metrics.track && l.metrics.track.flyingN < off.records.find(o => o.log === l.log && o.segment === l.segment).metrics.track.flyingN), 'the phases remove time');
    // result.flights: every flight of the records
    assert.deepEqual(R.flights.map(q => [q.log, q.segment, q.t0, q.t1]), R.records.flatMap(l => l.logClass === 'flight' ? l.flights.map(q => [l.log, l.segment, q.t0, q.t1]) : []));
    assert.ok(R.flights.length >= 5 && R.flights.every(q => q.seconds > 1), J(R.flights));
    // a finding carries its phase: the module's own (health_phase), 'all' for the governor and D2, null for a header check, else 'flight'
    const ph = (pred) => R.findings.filter(pred).map(f => f.phase);
    assert.ok(ph(f => f.module === 'phase').length && ph(f => f.module === 'phase').every(p => p === 'all'), 'health_phase findings');
    const govPh = R.findings.filter(f => f.module === 'gov' && logsOf(f).length);
    assert.ok(govPh.length && govPh.every(f => f.phase === (['D5', 'G13', 'G12'].includes(f.id) ? 'all' : 'ground+flight')) && ph(f => f.module === 'loop' && logsOf(f).length).every(p => p === 'flight'), 'governor all or ground+flight, loop flight');
    assert.ok(govPh.every(f => J(f.phases) === J(f.phase === 'all' ? ['idle', 'spoolup', 'ground', 'flight', 'spooldown'] : ['ground', 'flight'])), 'phases: the phase names of the masks');
    assert.ok(ph(f => ['D1', 'D3', 'SETUP', 'F1', 'F2', 'F4'].includes(f.id) && logsOf(f).length).every(p => p === null) && ph(f => f.id === 'F5' && logsOf(f).length).every(p => p === 'flight'), 'header checks have no phase');
    // with excludeAbnormal the attitude mask is also normal (no rescue): health_more sees flying, normal and the flight phases
    const N = await run({ excludeAbnormal: true }), rec = N.records.find(l => l.log === 1 && l.segment === 0), w = segs[1][0], T = phaseTruth(w, N.flightRpm.value, true), f = w.extra.flightModeFlags;
    let both = 0; for (let i = 0; i < w.n; i++) if (T.flying[i] && T.fm[i] && !(f[i] & 32)) both++;
    assert.deepEqual([rec.metrics.more.flyingN, rec.metrics.track.flyingN], [both, both], 'health_more and health_track: flying, normal and flight phases');
    assert.equal(rec.metrics.more.flyingAllN, T.all, 'ctx.flyingAll is the health.cjs mask');
    within(rec.normalS, both / rec.actualRate, 0.051, 'normalS');
});

test('D13: a bench run alone: the default flight rpm with the reason, no analysis, and the run in benchRuns', async () => {
    const S = sim(), W = worker({ 'health_phase.cjs': STUB_PHASE });
    const L = await W.result({ cmd: 'analyseLog', fileName: 'bench.bbl', logIndex: 0, options: { flightRpm: null, curves: true } }, S.slice(0));
    assert.deepEqual([L.flightRpm.source, L.records.map(l => l.logClass), L.benchRuns.map(b => b.log), L.flights, L.curves], ['default', ['bench'], [0], [], []]);
    assert.deepEqual(L.findings.filter(f => logsOf(f).includes(0)).map(f => f.id), ['D7'], J(L.findings.filter(f => logsOf(f).includes(0)).map(f => f.fid)));
    assert.ok(L.notes.some(n => n.includes('The flight phases of "health_phase.cjs" show no flight in the log. Thus, the log is a bench run.')), L.notes.join('\n'));
    assert.equal(L.header['Craft name'], 'sim', 'the header of the log on screen');
    const F = await W.result({ cmd: 'analyseFile', fileName: 'bench.bbl', selectedLog: 0, options: { flightRpm: null, curves: false } }, S.slice(0));
    assert.ok(F.notes.some(n => n.includes('Bench runs (no flight phase in "health_phase.cjs"): 1.')), F.notes.join('\n'));
    // a phase module that stops: a note, and the log is analysed as without phases
    const boom = await worker({ 'health_phase.cjs': STUB_PHASE.replace('function phases(w, ctx) {', 'function phases(w, ctx) { throw new Error("no phases");') })
        .result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, options: { flightRpm: TRUTH.rpm, curves: false } }, S.slice(1));
    assert.ok(boom.records.every(l => l.logClass === null) && boom.findings.some(f => f.module === 'loop') && boom.notes.includes('The function "phases" of "health_phase.cjs" stopped. The error is "no phases". ' +
        'Thus, the app does not find the flight phases of the log, and the checks use all of the airborne time (log 2).'), boom.notes.join('\n'));
});

test('frame-second spans: the phases on the stall fixture are at the frame clock across a 26 ms stall and a change of the frame rate (SPEC2 D1)', async () => {
    const { file, w } = clockLog(), R = await worker({ 'health_phase.cjs': STUB_PHASE }).result({ cmd: 'analyseLog', fileName: 'clock.bbl', logIndex: 0, options: { flightRpm: TRUTH.rpm, curves: false } }, fs.readFileSync(file));
    const rec = R.records[0], fl = rec.phases.find(q => q.phase === 'flight'), t = w.extra.time, frame = (i) => w.fromS + (t[i] - t[0]) / 1e6, index = (i) => w.fromS + i / w.flight.actualRate;
    const [truth] = stubPhase.phases(w, { rate: w.flight.actualRate }).flights; // its samples: 1 s at the mean rate after the flag sets and before it drops
    assert.ok(truth.i0 < 31234 && truth.i1 > 45100, J(truth));
    within(fl.t0, frame(truth.i0), 1e-4, `liftoff (sample ${truth.i0}, before the stall)`); within(fl.t1, frame(truth.i1), 1e-4, `touchdown (sample ${truth.i1}, after the stall and the slow frames)`);
    assert.ok(Math.abs(frame(truth.i1) - index(truth.i1)) > 0.1, `index time is ${((frame(truth.i1) - index(truth.i1)) * 1000).toFixed(1)} ms off at touchdown`);
    assert.deepEqual(R.flights.map(q => [q.t0, q.t1]), [[fl.t0, fl.t1]]);
});

// review A8: D7 (health_phase) lists its flights in index time, as every module; the worker gives them in frame seconds, from the
// flights of the records, in the fields and in the sentence of each flight. The stub's D7 here is health_phase's form: flights
// [{ segment, i0, i1, t0, t1, seconds }] and "Flight k is from a s to b s (c s)." with index times
const STUB_PHASE_D7 = STUB_PHASE.replace("analyse: (w, ctx) => ({ flyingN: sum(ctx.flying), flightN: sum(ctx.flightMask), spans: ctx.phases ? ctx.phases.spans.length : null }),",
    "analyse: (w, ctx) => ({ flyingN: sum(ctx.flying), flightN: sum(ctx.flightMask), spans: ctx.phases ? ctx.phases.spans.length : null, flights: ctx.phases.flights.map(q => ({ i0: q.i0, i1: q.i1, t0: +(w.fromS + q.i0 / ctx.rate).toFixed(3), t1: +(w.fromS + q.i1 / ctx.rate).toFixed(3), seconds: +((q.i1 - q.i0) / ctx.rate).toFixed(2) })) }),")
    .replace("judge: (flights) => flights.map(f => ({ id: 'D7', severity: 'note', log: f.log, profile: null, phase: 'all', value: f.metrics.flightN, se: null, n: 1, threshold: null, source: 'test', unit: 'samples', thin: false, text: 'stub D7' })),",
        "judge: (flights) => flights.map(f => { const fl = f.metrics.flights.map(q => Object.assign({ segment: f.segment }, q)); return { id: 'D7', severity: 'note', log: f.log, profile: null, phase: null, value: f.metrics.flightN, se: null, n: fl.length, threshold: 'report only', source: 'test', unit: 's', thin: false, flights: fl, " +
            "text: 'This log is a flight log.\\n' + fl.map((q, k) => 'Flight ' + (k + 1) + ' is from ' + q.t0.toFixed(1) + ' s to ' + q.t1.toFixed(1) + ' s (' + q.seconds.toFixed(1) + ' s).').join(' ') }; }),");
test('D7 (review A8): the flights of D7 in frame seconds, in its fields and its text, on the stall fixture', async () => {
    assert.notEqual(STUB_PHASE_D7, STUB_PHASE);
    const { file, w } = clockLog(), R = await worker({ 'health_phase.cjs': STUB_PHASE_D7 }).result({ cmd: 'analyseLog', fileName: 'clock.bbl', logIndex: 0, options: { flightRpm: TRUTH.rpm, curves: false } }, fs.readFileSync(file));
    const d7 = R.findings.find(f => f.id === 'D7'), rec = R.records[0], [q] = rec.flights, t = w.extra.time, frame = (i) => w.fromS + (t[i] - t[0]) / 1e6;
    assert.deepEqual(d7.flights.map(x => [x.t0, x.t1, x.seconds]), [[q.t0, q.t1, q.seconds]], 'the frame seconds of the record');
    within(d7.flights[0].t1, frame(d7.flights[0].i1), 1e-4, 'touchdown on the frame clock');
    assert.ok(Math.abs(d7.flights[0].t1 - (w.fromS + d7.flights[0].i1 / w.flight.actualRate)) > 0.1, 'index time is more than 0.1 s off at touchdown');
    assert.ok(d7.text.includes(`Flight 1 is from ${q.t0.toFixed(1)} s to ${q.t1.toFixed(1)} s (${q.seconds.toFixed(1)} s).`), d7.text);
});

// ---------------------------------------------------------------------------------------------
// D12: PID profiles, rate profiles and in-flight adjustments
// ---------------------------------------------------------------------------------------------

// a CLI dump whose section `profile 0` agrees with the simulated header (yaw gains 100/140/14) and `profile 1` does not (4.6 defaults);
// CLI_GAINS without the gov_headspeed lines
const CLI_YAW = CLI.replace('profile 0\nset gov_headspeed = 2500\n', 'profile 0\nset gov_headspeed = 2500\nset yaw_p_gain = 100\nset yaw_i_gain = 140\nset yaw_d_gain = 14\n');
const CLI_GAINS = CLI_YAW.replace(/set gov_headspeed = \d+\n/g, '');

test('D12: the PID profile at the start of a log, from the CLI dump, the governor target or the other logs; profile runs, labels and the PID profile of each finding', async () => {
    const S = sim(), N = simNoRequest(), echo = `'use strict';
module.exports = { advise: (i) => ({ recommendations: [], coverage: [], notes: [JSON.stringify({ headerProfile: i.headerProfile, inferred: i.headerProfileInferred, logs: i.logs.map(l => [l.log, l.armingProfile, l.armingBasis, l.armingEstimate, l.profileSeconds]) })] }) };`;
    const W = worker(Object.assign({ 'advice.cjs': echo }, NO_PHASE)), file = (o, bytes = S.bytes) => W.result({ cmd: 'analyseFile', fileName: 'sim.bbl', selectedLog: 1, options: Object.assign({ flightRpm: TRUTH.rpm, curves: false, keepMetrics: true }, o) }, bytes);
    const one = (li, o, slice = S.slice) => W.result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: li, options: Object.assign({ flightRpm: TRUTH.rpm, curves: false, keepMetrics: true }, o) }, slice(li));
    const arm = (R, log) => R.records.find(l => l.log === log && l.profiles).profiles.arming, basis = (R, log) => [arm(R, log).profile, arm(R, log).basis, arm(R, log).confirmed];

    // no CLI dump, and the logs do not record govRequest (the headspeed step has no data). Log 1: profiles 1 (at the start, not logged), 2
    // from 28 s, 1 from 49 s; the start target (2500 rpm) is that of profile 1 only. The toolkit's label is an inference: one rule (review
    // M2), the stretch stays "PID profile unknown" and 1 is only the estimate
    const R = await file({}, N.bytes);
    const [a, b] = R.records.filter(l => l.log === 1);
    assert.deepEqual(a.profiles.arming, { profile: 0, estimate: 1, basis: ['govTarget'], candidates: [1], inferred: 1, target: 2500, firstChangeS: a.profiles.arming.firstChangeS, conflict: false, confirmed: false,
        headspeed: { headspeed: null, why: 'noField' } });
    within(a.profiles.arming.firstChangeS, 28, 0.002, 'the first PID profile change');
    assert.deepEqual(a.profiles.pid.map(q => q.profile), [0, 2, 1]); assert.deepEqual(b.profiles.pid.map(q => q.profile), [1]);
    within(a.profiles.pid[1].t0, 28, 0.002, 'profile 2 from 28 s'); within(a.profiles.pid[2].t0, 49, 0.002, 'profile 1 from 49 s'); within(a.profiles.pid[2].t1, b.fromS - 0.3, 0.01, 'to the gap');
    assert.ok(a.profiles.pid.every((q, k) => !k || q.t0 === a.profiles.pid[k - 1].t1) && Math.abs(b.profiles.pid[0].t0 - b.fromS) < 1e-3, 'contiguous runs in frame seconds');
    assert.deepEqual([a.profiles.rate, a.profiles.adjustments], [[], []]);
    // the modules get the raw label 0 for the stretch (review A2), with its target in targetOf['0']
    assert.equal(a.metrics.setup.startProfile, 0);
    assert.deepEqual([a.targetOf['0'], a.targetOf['1'], a.targetOf['2']], [2500, 2500, 2700], J(a.targetOf));
    within(a.profileSeconds['0'], 28 - 6, 0.3, 'the stretch before the first change, in flight (airborne from 6 s)');
    // logs 3, 4 and 5 do not change profile: their target is the one that profile 1 flies in log 1, again an estimate only
    for (const l of [3, 4, 5]) { assert.deepEqual(basis(R, l), [0, ['fileTarget'], false], `log ${l}`); assert.deepEqual([arm(R, l).inferred, arm(R, l).estimate], [0, 1]);
        assert.deepEqual(R.records.filter(q => q.log === l).flatMap(q => q.profiles.pid.map(x => x.profile)), [0], `log ${l} runs`); }
    // the PID profile of each finding: the log profile; 0 (the stretch) only as a confirmed profile, here unknown; D4 not without a CLI dump
    for (const f of R.findings) {
        const sp = typeof f.profile === 'string' && /^start profile \d$/.test(f.profile) ? +f.profile.slice(-1) : null;
        const want = f.id === 'D4' || f.profile === 0 ? null : Number.isInteger(f.profile) && f.profile >= 1 && f.profile <= 6 ? f.profile : sp !== null && sp > 0 ? sp : null;
        assert.equal(f.pidProfile, want, `${f.fid}: profile ${J(f.profile)}`);
    }
    // per-profile separation: in each segment, one result of a check and axis for each label
    const c12 = R.findings.filter(f => f.module === 'track' && f.id === 'C12' && f.log === 1 && f.axis === 'roll'), seg = (f) => f.fid.split('|')[3];
    assert.ok(c12.length >= 3 && J([...new Set(c12.map(f => f.profile))].sort()) === J([0, 1, 2]) && [...new Set(c12.map(seg))].every(s => { const p = c12.filter(f => seg(f) === s).map(f => f.profile); return new Set(p).size === p.length; }),
        J(c12.map(f => [f.fid, f.pidProfile])));
    // result.profiles: in-flight seconds per PID profile, the label 0 as "PID profile unknown" (0) while it is not confirmed
    const P = R.profiles, sumOf = (k) => R.records.reduce((s, l) => s + (l.profileSeconds ? l.profileSeconds[k] || 0 : 0), 0);
    assert.deepEqual(Object.keys(P.pid).map(Number).sort(), [0, 1, 2]);
    within(P.pid[2].seconds, a.profileSeconds['2'], 0.05, 'profile 2 seconds'); assert.deepEqual(P.pid[2].logs, [1]);
    within(P.pid[1].seconds, sumOf('1'), 0.05, 'profile 1: its own label only'); within(P.pid[0].seconds, sumOf('0'), 0.05, 'unknown: the stretches');
    assert.deepEqual(P.pid[0].logs.slice().sort(), [1, 3, 4, 5]); assert.deepEqual(P.rateChanges, []);
    assert.deepEqual(P.arming.map(q => [q.log, q.profile, q.basis, q.confirmed, q.estimate]), [[0, 0, [], false, null], [1, 0, ['govTarget'], false, 1], [3, 0, ['fileTarget'], false, 1], [4, 0, ['fileTarget'], false, 1], [5, 0, ['fileTarget'], false, 1]]);
    // the note says why, from the log only (user rule 2026-10-06: no text asks for a CLI dump)
    assert.ok(R.notes.includes('The log does not record "govRequest", the headspeed of the PID profile. The governor target at the start of the log agrees with PID profile 1. ' +
        'The governor target does not show the PID profile without other data. Thus, the app cannot find the PID profile at the start of the log. The results of that part show "PID profile unknown" (logs 2, 4, 5 and 6).'), R.notes.join('\n'));
    assert.ok(!R.notes.some(n => /CLI dump/.test(n)), R.notes.join('\n'));
    const got = JSON.parse(R.advice.notes[0]);
    assert.deepEqual([got.headerProfile, got.inferred], [0, true], 'advice: the header of log 1 has no confirmed PID profile; an estimate exists');
    assert.deepEqual(got.logs.find(l => l[0] === 1).slice(0, 4), [1, 0, ['govTarget'], 1]);
    assert.ok('0' in got.logs.find(l => l[0] === 1)[4], 'advice: the label 0 stays unknown in profileSeconds');

    // the same file with govRequest (D12 headspeed, user decision 2026-10-06): the changes of log 1 show 2700 rpm for PID profile 2 (28-49 s)
    // and 2500 rpm for PID profile 1 (49 s to the end). The starts of logs 1, 3 and 4 (2500 rpm) are PID profile 1, confirmed with no CLI dump.
    // Log 5 does not record govRequest: its estimate stays
    const Q = await file({}), qa = Q.records.find(l => l.log === 1).profiles.arming, map = { 1: 2500, 2: 2700 };
    assert.deepEqual(Q.profiles.arming.map(q => [q.log, q.profile, q.basis, q.confirmed, q.estimate]), [[0, 0, [], false, null], [1, 1, ['headspeed'], true, null], [3, 1, ['headspeed'], true, null], [4, 1, ['headspeed'], true, null], [5, 0, ['fileTarget'], false, 1]]);
    assert.deepEqual(qa.headspeed, { headspeed: 2500, why: null, profile: 1, observations: { switches: 1, logs: 1 }, map }, J(qa));
    assert.deepEqual(Q.profiles.arming.find(q => q.log === 1).headspeed, qa.headspeed, 'result.profiles.arming has the evidence');
    assert.deepEqual(Q.records.filter(l => l.log === 1)[0].profiles.pid.map(q => q.profile), [1, 2, 1], 'the confirmed profile names the stretch');
    assert.ok(Q.findings.filter(f => f.profile === 0 && f.id !== 'D4' && logsOf(f).length === 1 && [1, 3, 4].includes(logsOf(f)[0])).every(f => f.pidProfile === 1), 'label 0 is PID profile 1');
    const qg = JSON.parse(Q.advice.notes[0]);
    assert.deepEqual([qg.headerProfile, qg.inferred, qg.logs.find(l => l[0] === 1).slice(0, 4)], [1, false, [1, 1, ['headspeed'], null]], 'advice: the confirmed basis');
    assert.ok(!('0' in qg.logs.find(l => l[0] === 1)[4]), 'advice: the stretch is PID profile 1 in profileSeconds');
    for (const t of ['At the start of logs 2, 4 and 5, "govRequest" is 2500 rpm. In the PID profile changes of this file, only PID profile 1 has this value (1 change in 1 log). Thus, these logs start in PID profile 1.',
        'The log does not record "govRequest", the headspeed of the PID profile. The governor target at the start of the log agrees with PID profile 1. The governor target does not show the PID profile without other data. ' +
        'Thus, the app cannot find the PID profile at the start of the log. The results of that part show "PID profile unknown" (log 6).']) assert.ok(Q.notes.includes(t), `${t}\n${Q.notes.join('\n')}`);
    // one log alone, no CLI dump, no profile change: no change shows the headspeed of a PID profile, unknown with a note that says why
    const U = await one(4, {});
    assert.deepEqual(basis(U, 4), [0, [], false]);
    assert.deepEqual(arm(U, 4).headspeed, { headspeed: 2500, why: 'none', profiles: null, map: {} });
    assert.ok(U.findings.filter(f => f.profile === 0).every(f => f.pidProfile === null) && U.notes.includes('At the start of the log, "govRequest" is 2500 rpm. No PID profile change in this log shows this value. ' +
        'Thus, the app cannot find the PID profile at the start of the log. The results of that part show "PID profile unknown" (log 5).'), U.notes.join('\n'));
    assert.deepEqual([JSON.parse(U.advice.notes[0]).headerProfile, JSON.parse(U.advice.notes[0]).inferred], [0, false]);
    // the CLI dump: the exact govRequest before the first change against gov_headspeed (2500 rpm = `profile 0` = PID profile 1), confirmed
    // only for a log whose header agrees with a section of the dump (log 4: cliStatus below). A dump that agrees with no section of a log
    // header does not describe that log, and gives no evidence for it (review: the dump of cliStatus used false never confirms): logs 2
    // and 5 by the headspeed step only, and log 6 (no govRequest) gets the estimate of the other logs. Without govRequest, log 2 stays an estimate
    const T = await file({ cliText: CLI });
    assert.deepEqual(basis(T, 1), [1, ['headspeed'], true]);
    assert.deepEqual(basis(T, 3), [1, ['cliTarget', 'headspeed'], true], 'log 4: its header agrees with `profile 0`');
    assert.deepEqual(basis(T, 4), [1, ['headspeed'], true]);
    assert.deepEqual(basis(T, 5), [0, ['fileTarget'], false]);
    assert.deepEqual(basis(await file({ cliText: CLI }, N.bytes), 1), [0, ['govTarget'], false]);
    assert.equal(JSON.parse(T.advice.notes[0]).inferred, false);
    assert.equal(JSON.parse(T.advice.notes[0]).headerProfile, 1);
    assert.deepEqual(T.records.filter(l => l.log === 1)[0].profiles.pid.map(q => q.profile), [1, 2, 1], 'a confirmed profile names the stretch');
    // advice and result.profiles: the label 0 as PID profile 1 where it is confirmed (review A1): no profile-0 entry for logs 2, 4 and 5
    const Tl = JSON.parse(T.advice.notes[0]).logs, t1 = T.records.filter(l => l.log === 1)[0];
    for (const [log, , , , ps] of Tl) if (log !== 5) assert.ok(!('0' in ps), `log ${log}: ${J(ps)}`);
    within(Tl.find(l => l[0] === 1 && l[4]['2'] !== undefined)[4]['1'], t1.profileSeconds['0'] + t1.profileSeconds['1'], 0.051, 'log 1: the stretch is PID profile 1');
    assert.deepEqual(Object.keys(T.profiles.pid).map(Number).sort(), [0, 1, 2]);
    assert.ok(T.findings.filter(f => f.profile === 0 && f.id !== 'D4' && logsOf(f).length === 1 && [1, 3, 4].includes(logsOf(f)[0])).every(f => f.pidProfile === 1), 'label 0 is PID profile 1');
    // the header against the CLI sections: log 4 agrees only with `profile 0`
    const C = await one(4, { cliText: CLI_GAINS });
    assert.deepEqual(C.records[0].metrics.setup.D4.mismatchesByProfile, { 0: 0, 1: 3 }, J(C.records[0].metrics.setup.D4.mismatches));
    assert.deepEqual(basis(C, 4), [1, ['cli'], true]);
    assert.ok(C.findings.some(f => f.profile === 0) && C.findings.filter(f => f.profile === 0 && f.id !== 'D4').every(f => f.pidProfile === 1), 'label 0 is PID profile 1');
    assert.ok(C.findings.filter(f => f.id === 'D4').every(f => f.pidProfile === (f.profile === 0 ? 1 : null)), 'D4 of section `profile 0` is PID profile 1');
    assert.deepEqual(C.findings.filter(f => f.id === 'D4').map(f => f.cliSection), [{ section: 0, chosenBy: 'fewest mismatches', arming: 1, usable: true }], 'D4 compared the section of the confirmed profile');
    assert.deepEqual(basis(await one(1, { cliText: CLI_YAW }), 1), [1, ['cli', 'cliTarget', 'headspeed'], true]);
    // no section agrees with the header; `profile 1` agrees best. The dump does not describe this log (cliStatus used false), so its
    // gov_headspeed is no evidence: the start stays unknown (one log with no PID profile change: no estimate either)
    const O = await one(4, { cliText: CLI.replace('profile 1\nset gov_headspeed = 2700\n', 'profile 1\nset gov_headspeed = 2700\nset yaw_p_gain = 100\nset yaw_i_gain = 140\nset yaw_d_gain = 14\nset roll_p_gain = 60\n') });
    assert.deepEqual([basis(O, 4), arm(O, 4).estimate, O.cliStatus.used], [[0, [], false], null, false], J(O.records[0].metrics.setup.D4.mismatchesByProfile));
    // a header that agrees with `profile 1` (PID profile 2), where the first change goes to 2 and the headspeed (2500 rpm) says 1: the log
    // wins (user rule "No access to the flight controller"): PID profile 1 by the headspeed, the 'cli' basis goes, and result.cliStatus
    // has the conflict. Without govRequest, the governor target says 1, an estimate only: the dump keeps it unknown, with the note of
    // the governor target
    const cliX = CLI_GAINS.replace('profile 0\nset yaw_p_gain = 100\nset yaw_i_gain = 140\nset yaw_d_gain = 14\nprofile 1\n', 'profile 0\nprofile 1\nset yaw_p_gain = 100\nset yaw_i_gain = 140\nset yaw_d_gain = 14\n');
    const X = await one(1, { cliText: cliX, cliName: 'x.txt' });
    assert.deepEqual([arm(X, 1).profile, arm(X, 1).basis, arm(X, 1).confirmed, arm(X, 1).conflict, arm(X, 1).headspeed.why, arm(X, 1).headspeed.dumpSections], [1, ['headspeed'], true, false, null, [2]], J(arm(X, 1)));
    assert.deepEqual(X.cliStatus, { name: 'x.txt', used: true, conflicts: [{ what: 'profile', profile: 1, sections: [2], logs: [1],
        text: 'The log header of log 2 agrees with the CLI section `profile 1`. But "govRequest" at the start of the log shows PID profile 1. The app uses PID profile 1.' }] });
    for (const t of ['At the start of log 2, "govRequest" is 2500 rpm. In the PID profile changes of this log, only PID profile 1 has this value (1 change in 1 log). Thus, this log starts in PID profile 1.',
        'The CLI dump "x.txt" does not agree with the log. The app uses the values of the log.']) assert.ok(X.notes.includes(t), `${t}\n${X.notes.join('\n')}`);
    assert.ok(!X.notes.some(n => /PID profile at the start of the log is unknown/.test(n)), X.notes.join('\n'));
    assert.ok(X.findings.filter(f => f.profile === 0 && f.id !== 'D4').every(f => f.pidProfile === 1), 'label 0 is PID profile 1');
    const Xn = await one(1, { cliText: cliX }, N.slice);
    assert.deepEqual([arm(Xn, 1).profile, arm(Xn, 1).conflict], [0, true], J(arm(Xn, 1)));
    assert.ok(Xn.notes.includes('The governor target agrees with PID profile 1, but the log header does not agree with the CLI section `profile 0`. Thus, the PID profile at the start of the log is unknown (log 2).'), Xn.notes.join('\n'));
    // a CLI dump whose gov_headspeed of PID profile 1 is not the logged one: that value is older than the log and is not used; the log
    // confirms PID profile 1, and result.cliStatus has the conflict
    const Y = await one(1, { cliText: CLI.replace('profile 0\nset gov_headspeed = 2500\n', 'profile 0\nset gov_headspeed = 2400\n') });
    assert.deepEqual([arm(Y, 1).profile, arm(Y, 1).basis, arm(Y, 1).confirmed, arm(Y, 1).conflict, arm(Y, 1).headspeed.why], [1, ['headspeed'], true, false, null], J(arm(Y, 1)));
    assert.deepEqual(Y.cliStatus, { name: null, used: false, conflicts: [
        { what: 'gov_headspeed', profile: 1, cli: 2400, log: [2500], text: 'In the CLI dump, `gov_headspeed` of `profile 0` is 2400. The PID profile changes in this log show 2500 rpm for PID profile 1. The app uses the values of the log.' },
        { what: 'header', logs: [1], text: 'No section of the CLI dump agrees with the log header of log 2.' }] });
    assert.ok(Y.notes.includes('The CLI dump does not agree with the log. The app uses the values of the log.'), Y.notes.join('\n'));
    // the fixture dump (a short `diff all`: the 4.6 defaults for the gains) agrees with the header of log 4 only; the headspeeds agree.
    // Without a dump: no status
    assert.deepEqual(T.cliStatus, { name: null, used: true, conflicts: [{ what: 'header', logs: [0, 1, 4, 5], text: 'No section of the CLI dump agrees with the log header of logs 1, 2, 5 and 6.' }] });
    assert.equal(R.cliStatus, null);
});

// review A2: a flight armed in PID profile 3, then 1 from 22 s, then 3 from 38 s, all at 2500 rpm; the CLI dump agrees with the header
// in `profile 2` only (yaw gains 100/140/14), and `profile 0` has other yaw gains. The truth: profile 3 before 22 s
const CLI_A2 = `# diff all
# Rotorflight / STM32F7X2 (S7X2) 4.6.0 Jun 30 2026 / 07:20:47 (118e912) MSP API: 12.08
set gyro_rpm_notch_preset = 1
set battery_cell_count = 6
profile 0
set gov_headspeed = 2500
set yaw_p_gain = 80
profile 2
set gov_headspeed = 2500
set yaw_p_gain = 100
set yaw_i_gain = 140
set yaw_d_gain = 14
profile 0
`;
const a2Flight = (() => { let v = null; return () => v || (v = bbl.encode([bbl.simulateFlight({ seconds: 60, seed: 3, airborne: [6, 54], start: '2026-10-04T16:00:00.000+00:00',
    profiles: [{ from: 0, profile: 3, target: 2500 }, { from: 22, profile: 1, target: 2500 }, { from: 38, profile: 3, target: 2500 }] })]).bytes); })();

test('D12 (review A1, A2, M2): the modules get the raw label 0 before the first change; 0 is the arming profile only when it is confirmed; D4 compares the right section', async () => {
    const echo = `'use strict';
module.exports = { advise: (i) => ({ recommendations: [], coverage: [], notes: [JSON.stringify({ headerProfile: i.headerProfile, logs: i.logs.map(l => ({ ps: l.profileSeconds, t: l.targetOf, d4: l.d4 })) })] }) };`;
    const run = (o) => worker(Object.assign({ 'advice.cjs': echo }, NO_PHASE)).result({ cmd: 'analyseLog', fileName: 'a2.bbl', logIndex: 0, options: Object.assign({ flightRpm: TRUTH.rpm, curves: false, keepMetrics: true, cliText: CLI_A2 }, o) }, a2Flight());
    const R = await run({}), rec = R.records[0], A = rec.profiles.arming, got = JSON.parse(R.advice.notes[0]);
    // the arming profile: 3 by the CLI (the header agrees with `profile 2` only), confirmed; the toolkit's guess was 1 (it flies 2500 rpm later)
    assert.deepEqual([A.profile, A.basis, A.confirmed, A.inferred], [3, ['cli'], true, 1], J(A));
    // the modules: label 0 before 22 s (never the guess), so no profile-1 result holds profile-3 data
    assert.equal(rec.metrics.setup.startProfile, 0);
    within(rec.profileSeconds['0'], 22 - 6, 0.3, 'the stretch'); within(rec.profileSeconds['1'], 16, 0.3, 'profile 1, 22-38 s'); within(rec.profileSeconds['3'], 54 - 38, 0.3, 'profile 3, 38-54 s');
    // D4: no label at the first sample, so the section with the fewest mismatches: `profile 2`, which agrees (no false stale CLI)
    const d4 = R.findings.filter(f => f.id === 'D4');
    assert.deepEqual(d4.map(f => [f.severity, f.profile, f.pidProfile]), [['ok', 2, 3]], J(d4.map(f => f.text)));
    assert.deepEqual(d4[0].cliSection, { section: 2, chosenBy: 'fewest mismatches', arming: 3, usable: true });
    assert.deepEqual(got.logs[0].d4, d4[0].cliSection, 'advice gets the section of D4 with each log');
    // findings of the stretch are PID profile 3; profile 1 is its own
    assert.ok(R.findings.filter(f => f.profile === 0 && f.id !== 'D4').length > 10 && R.findings.filter(f => f.profile === 0 && f.id !== 'D4').every(f => f.pidProfile === 3));
    assert.ok(R.findings.filter(f => f.profile === 1).every(f => f.pidProfile === 1) && R.findings.some(f => f.profile === 1));
    // advice and result.profiles: profile 3 holds the stretch, no profile 0 (review A1); the target of the stretch is profile 3's
    within(got.logs[0].ps['3'], rec.profileSeconds['0'] + rec.profileSeconds['3'], 0.051, 'profile 3 in advice'); assert.ok(!('0' in got.logs[0].ps) && !('0' in got.logs[0].t), J(got.logs[0]));
    assert.deepEqual([got.logs[0].t['3'], got.logs[0].t['1'], got.headerProfile], [2500, 2500, 3]);
    assert.deepEqual(Object.keys(R.profiles.pid).map(Number).sort(), [1, 3]);
    within(R.profiles.pid[3].seconds, 32, 0.4, 'profile 3: 6-22 s and 38-54 s'); within(R.profiles.pid[1].seconds, 16, 0.3, 'profile 1: 22-38 s');
    assert.deepEqual(rec.profiles.pid.map(q => q.profile), [3, 1, 3]);
    // the CLI's view (toolkit labels, for parity): the guess labels the stretch 1, D4 compares `profile 0`, the section of a guess:
    // it is not the section of the confirmed profile, so advice must not take it for a stale CLI dump
    const V = await run({ phases: false, excludeAbnormal: false }), v4 = V.findings.filter(f => f.id === 'D4');
    assert.deepEqual([V.records[0].metrics.setup.startProfile, v4.map(f => [f.severity, f.profile])], [1, [['flag', 0]]], J(v4.map(f => f.text)));
    assert.deepEqual(v4[0].cliSection, { section: 0, chosenBy: 'guess', arming: 3, usable: false });
    assert.equal(v4[0].pidProfile, null, 'the guessed section is no PID profile of the header');
});

test('D12 (review A6): the governor-target step does not decide for a profile that the first change excludes, or for a target that two candidates share', async () => {
    const cli = (sections) => `# diff all\n# Rotorflight / STM32F7X2 (S7X2) 4.6.0 Jun 30 2026 / 07:20:47 (118e912) MSP API: 12.08\nset battery_cell_count = 6\n${sections}profile 0\n`;
    const armOf = async (profiles, text) => { const b = bbl.encode([bbl.simulateFlight({ seconds: 60, seed: 4, airborne: [6, 54], start: '2026-10-04T17:00:00.000+00:00', profiles })]).bytes;
        return (await worker(NO_PHASE).result({ cmd: 'analyseLog', fileName: 'a6.bbl', logIndex: 0, options: { flightRpm: TRUTH.rpm, curves: false, cliText: text } }, b)).records[0].profiles.arming; };
    // armed in 3 (2500 rpm), then 1 (2500 rpm) from 22 s; the header agrees with `profile 2` only. The toolkit's guess is 1, the first change
    const yaw = 'set yaw_p_gain = 100\nset yaw_i_gain = 140\nset yaw_d_gain = 14\n';
    const a = await armOf([{ from: 0, profile: 3, target: 2500 }, { from: 22, profile: 1, target: 2500 }], cli(`profile 0\nset yaw_p_gain = 80\nprofile 2\n${yaw}`));
    assert.deepEqual([a.inferred, a.profile, a.basis, a.conflict, a.confirmed], [1, 3, ['cli'], false, true], J(a));
    // armed in 2 (2500 rpm), then 1 (2700 rpm) from 22 s, then 3 (2500 rpm) from 40 s; the CLI gives 2500 rpm to `profile 1` and `profile 2`
    // and the header agrees with every section: the target cannot tell PID profile 2 from 3, so the guess 3 does not decide
    const b = await armOf([{ from: 0, profile: 2, target: 2500 }, { from: 22, profile: 1, target: 2700 }, { from: 40, profile: 3, target: 2500 }],
        cli(`profile 0\nset gov_headspeed = 2700\n${yaw}profile 1\nset gov_headspeed = 2500\n${yaw}profile 2\nset gov_headspeed = 2500\n${yaw}`));
    assert.deepEqual([b.inferred, b.profile, b.estimate, b.candidates, b.conflict, b.confirmed], [3, 0, null, [2, 3], false, false], J(b));
    // the headspeed step: the changes of the log show 2500 rpm for PID profile 3 only, but the CLI dump gives 2500 rpm to PID profile 2 too:
    // the dump stops the step. Without the dump, the log alone confirms 3 by the rule of the user decision 2026-10-06: a PID profile that no
    // logged change shows (here 2, the truth) can have the same headspeed, and only a CLI dump or a change in the log can show it
    assert.deepEqual([b.headspeed.headspeed, b.headspeed.why, b.headspeed.profiles, b.headspeed.map], [2500, 'cliShared', [2, 3], { 1: 2700, 3: 2500 }], J(b.headspeed));
    const c = await armOf([{ from: 0, profile: 2, target: 2500 }, { from: 22, profile: 1, target: 2700 }, { from: 40, profile: 3, target: 2500 }], null);
    assert.deepEqual([c.profile, c.basis, c.confirmed], [3, ['headspeed'], true], J(c));
});

// D12 headspeed (user decision 2026-10-06): the PID profile at the start of a log is confirmed when govRequest there agrees with the headspeed
// of exactly one PID profile at the logged PID profile changes of the same file. The fixtures: flights at 1 kHz (bbl_encode simulateFlight,
// govRequest = the target of the PID profile while the governor runs) and bench runs whose govRequest is set for every frame
const ECHO_LOGS = `'use strict';
module.exports = { advise: (i) => ({ recommendations: [], coverage: [], notes: [JSON.stringify({ headerProfile: i.headerProfile, logs: i.logs.map(l => [l.log, l.armingProfile, l.armingBasis, l.armingConfirmed]) })] }) };`;
const HS_TARGET = { 1: 2300, 2: 2500, 3: 2700 };
const hsFlight = (seed, seconds, profiles, start) => bbl.simulateFlight({ seconds, seed, airborne: [6, seconds - 4], start: `2026-10-04T${start}:00.000+00:00`, profiles: profiles.map(([from, profile, target]) => ({ from, profile, target: target || HS_TARGET[profile] })) });
const hsBench = (seed, seconds, profiles, start) => { const l = bbl.simulateFlight({ seconds, seed, airborne: null, start: `2026-10-04T${start}:00.000+00:00`, profiles: profiles.map(([from, profile]) => ({ from, profile, target: HS_TARGET[profile] })) });
    l.w.extra.govRequest = Float64Array.from(l.profile, p => HS_TARGET[p]); return l; }; // a bench run whose governor is not ACTIVE: govRequest is the headspeed of its PID profile
const hsFile = (() => { let v = null; return () => v || (v = bbl.encode([
    hsFlight(21, 30, [[0, 2]], '13:00'),                                  // log 0: no change, 2500 rpm: PID profile 2, from the bench run (log 3) only
    hsFlight(22, 34, [[0, 1], [14, 3], [24, 1]], '13:10'),                // log 1: 2300 rpm, then 3 (2700 rpm) and 1 (2300 rpm): PID profile 1
    hsFlight(23, 30, [[0, 3], [15, 1]], '13:20'),                         // log 2: 2700 rpm, then 1: PID profile 3
    hsBench(24, 8, [[0, 3], [3, 2], [5, 1]], '13:30')]).bytes); })();      // log 3: a bench run, 3 (not logged), 2 from 3 s, 1 from 5 s

test('D12 headspeed: the PID profile changes of the file give three headspeeds; a log that starts at one of them is confirmed, also from the changes of a bench run', async () => {
    const W = worker({ 'advice.cjs': ECHO_LOGS }), run = (o) => W.result({ cmd: 'analyseFile', fileName: 'hs.bbl', selectedLog: 0, options: Object.assign({ flightRpm: 1900, curves: false }, o) }, hsFile());
    const R = await run({}), map = { 1: 2300, 2: 2500, 3: 2700 }, arm = (R, l) => R.profiles.arming.find(q => q.log === l);
    assert.deepEqual(R.benchRuns.map(b => b.log), [3]);
    assert.deepEqual(R.profiles.arming.map(q => [q.log, q.profile, q.basis, q.confirmed, q.estimate]), [[0, 2, ['headspeed'], true, null], [1, 1, ['headspeed'], true, null], [2, 3, ['headspeed'], true, null]]);
    // the evidence: the headspeed at the start, the changes that show it (the bench run's change to 2 at 3 s for log 0), the map of the file
    assert.deepEqual(arm(R, 0).headspeed, { headspeed: 2500, why: null, profile: 2, observations: { switches: 1, logs: 1 }, map });
    assert.deepEqual(arm(R, 1).headspeed.observations, { switches: 3, logs: 3 }, '2300 rpm: logs 1 (24 s), 2 (15 s) and the bench run (5 s)');
    assert.deepEqual(arm(R, 2).headspeed.observations, { switches: 1, logs: 1 });
    // every consumer: the PID profile runs, the findings, advice (logsInput) and the configurations
    const runs = (l) => R.records.filter(q => q.log === l).flatMap(q => q.profiles.pid.map(x => x.profile));
    assert.deepEqual([runs(0), runs(1), runs(2)], [[2], [1, 3, 1], [3, 1]]);
    const f0 = R.findings.filter(f => logsOf(f).length === 1 && logsOf(f)[0] === 0 && f.pidProfile !== null && !['D4', 'F4', 'H'].includes(f.id));
    assert.ok(f0.length > 5 && f0.every(f => f.pidProfile === 2), J(f0.map(f => [f.fid, f.pidProfile])));
    const got = JSON.parse(R.advice.notes[0]);
    assert.deepEqual(got.logs.filter(l => l[0] < 3).map(l => l.slice(1)), [[2, ['headspeed'], true], [1, ['headspeed'], true], [3, ['headspeed'], true]]);
    assert.equal(got.headerProfile, 2, 'the header of log 0 (on screen) is the header of PID profile 2');
    if (R.datasets) assert.deepEqual([0, 1, 2].map(l => R.datasets.logs.find(q => q.log === l).armingProfile), [2, 1, 3], J(R.datasets.logs));
    if (R.hierarchy && Array.isArray(R.hierarchy.profiles)) assert.ok(!R.hierarchy.profiles.includes('0'), J(R.hierarchy.profiles));
    // the notes: one for each headspeed, the logs from 1 (STE, from the log only)
    for (const t of ['At the start of log 1, "govRequest" is 2500 rpm. In the PID profile changes of this file, only PID profile 2 has this value (1 change in 1 log). Thus, this log starts in PID profile 2.',
        'At the start of log 2, "govRequest" is 2300 rpm. In the PID profile changes of this file, only PID profile 1 has this value (3 changes in 3 logs). Thus, this log starts in PID profile 1.',
        'At the start of log 3, "govRequest" is 2700 rpm. In the PID profile changes of this file, only PID profile 3 has this value (1 change in 1 log). Thus, this log starts in PID profile 3.']) assert.ok(R.notes.includes(t), `${t}\n${R.notes.join('\n')}`);
    assert.ok(!R.notes.some(n => /PID profile unknown|CLI dump|arm the helicopter/.test(n)), R.notes.join('\n'));
    // no first pass (a flight rpm of the user and no configurations): log 0 is analysed before the bench run that shows its headspeed;
    // after the main pass the map has every log, and log 0 gets PID profile 2 with its runs and findings, before the judgement
    const L = await run({ datasets: false });
    assert.deepEqual(L.profiles.arming.map(q => [q.log, q.profile, q.basis, q.confirmed]), R.profiles.arming.map(q => [q.log, q.profile, q.basis, q.confirmed]));
    assert.deepEqual(L.records.filter(q => q.log === 0).flatMap(q => q.profiles.pid.map(x => x.profile)), [2]);
    assert.ok(L.findings.filter(f => logsOf(f).length === 1 && logsOf(f)[0] === 0 && f.pidProfile !== null && !['D4', 'F4', 'H'].includes(f.id)).every(f => f.pidProfile === 2));
    // PID profile 3 flies in log 1, and no flight log of the selection starts in it: the log header has its values only when the pilot arms the
    // helicopter in it, and the app can then find it (2700 rpm is PID profile 3 only). No instruction for a PID profile with a CLI section
    const p3 = 'No flight log in the analysis starts in PID profile 3. The log header records the values of the PID profile that is active when you arm the helicopter. ' +
        'Thus, the log header has the values of PID profile 3 only when you arm the helicopter in PID profile 3.';
    const S = await run({ flights: [{ log: 0, flight: null }, { log: 1, flight: null }] });
    assert.ok(S.notes.includes(p3), S.notes.join('\n'));
    assert.ok(!S.notes.some(n => /arm the helicopter in PID profile [12]\b/.test(n)), S.notes.join('\n'));
    const C = await run({ flights: [{ log: 0, flight: null }, { log: 1, flight: null }], cliText: '# diff all\nprofile 2\nset gov_headspeed = 2700\nprofile 0\n' });
    assert.ok(!C.notes.includes(p3), C.notes.join('\n'));
});

// two PID profiles with the same headspeed; the first-change rule; govRequest that changes with no logged PID profile change
const hsFile2 = (() => { let v = null; return () => v || (v = (() => {
    const shared = [hsFlight(31, 40, [[0, 1, 2500], [12, 2, 2500], [22, 1, 2500], [30, 3, 2700]], '14:00'), hsFlight(32, 30, [[0, 1, 2500]], '14:10')];
    const rules = [hsFlight(33, 34, [[0, 1], [12, 2], [24, 1]], '15:00'), hsFlight(34, 30, [[0, 3, 2500], [15, 2]], '15:10'), hsFlight(35, 30, [[0, 1]], '15:20')];
    rules[2].w.extra.govRequest = Float64Array.from(rules[2].w.extra.govRequest, (v, i) => v > 0 ? (i >= 15000 ? 2500 : 2300) : 0); // a change of govRequest at 15 s that the log does not record
    return { shared: bbl.encode(shared).bytes, rules: bbl.encode(rules).bytes };
})()); })();

test('D12 headspeed: not confirmed when two PID profiles have the headspeed, when the first change goes to its PID profile, or when govRequest changes with no logged change', async () => {
    const W = worker(), run = (bytes) => W.result({ cmd: 'analyseFile', fileName: 'hs2.bbl', selectedLog: 0, options: { flightRpm: 1900, curves: false } }, bytes), F = hsFile2();
    // (b) 2500 rpm at the changes to PID profiles 1 and 2: the start of logs 0 and 1 (2500 rpm) cannot be told; PID profile 3 (2700 rpm) can
    const B = await run(F.shared);
    assert.deepEqual(B.profiles.arming.map(q => [q.log, q.profile, q.confirmed, q.headspeed.why, q.headspeed.profiles]), [[0, 0, false, 'shared', [1, 2]], [1, 0, false, 'shared', [1, 2]]], J(B.profiles.arming));
    assert.deepEqual(B.profiles.arming[0].headspeed.map, { 1: 2500, 2: 2500, 3: 2700 });
    assert.ok(B.notes.includes('At the start of the log, "govRequest" is 2500 rpm. In the PID profile changes of this file, PID profiles 1 and 2 have this value. ' +
        'Thus, the app cannot find the PID profile at the start of the log. The results of that part show "PID profile unknown" (logs 1 and 2).'), B.notes.join('\n'));
    assert.ok(B.findings.filter(f => f.profile === 0 && !['D4', 'F4', 'H'].includes(f.id)).every(f => f.pidProfile === null));
    assert.ok(B.notes.includes('No flight log in the analysis starts in PID profile 3. The log header records the values of the PID profile that is active when you arm the helicopter. ' +
        'Thus, the log header has the values of PID profile 3 only when you arm the helicopter in PID profile 3.'), B.notes.join('\n'));
    assert.ok(!B.notes.some(n => /arm the helicopter in PID profile [12]\b/.test(n)), 'no instruction for a PID profile that the app cannot find');
    // (d) log 1 starts in PID profile 3 at 2500 rpm (no change shows PID profile 3), and its first change goes to PID profile 2 (2500 rpm): a log
    // records only a change, so the start is not PID profile 2. (c) log 2 records no change, but govRequest goes from 2300 to 2500 rpm at 15 s
    const R = await run(F.rules), arm = (l) => R.profiles.arming.find(q => q.log === l);
    assert.deepEqual([arm(0).profile, arm(0).basis], [1, ['headspeed']]);
    assert.deepEqual([arm(1).profile, arm(1).confirmed, arm(1).headspeed.why, arm(1).headspeed.profile, arm(1).headspeed.observations], [0, false, 'excluded', 2, { switches: 2, logs: 2 }], J(arm(1)));
    assert.deepEqual([arm(2).profile, arm(2).confirmed, arm(2).headspeed.why, arm(2).headspeed.values], [0, false, 'changes', [2300, 2500]], J(arm(2)));
    assert.deepEqual(R.records.filter(q => q.log === 1).flatMap(q => q.profiles.pid.map(x => x.profile)), [0, 2]);
    for (const t of ['At the start of the log, "govRequest" is 2500 rpm. PID profile 2 has this value. But the log changes to PID profile 2 at 15 s, and a log records only a change of the PID profile. ' +
        'Thus, the app cannot find the PID profile at the start of the log. The results of that part show "PID profile unknown" (log 2).']) assert.ok(R.notes.includes(t), `${t}\n${R.notes.join('\n')}`);
    assert.ok(R.notes.some(n => n.startsWith('The log records no PID profile change, but "govRequest" has more than one value (2300 and 2500 rpm). ') && n.endsWith('The results of that part show "PID profile unknown" (log 3).')), R.notes.join('\n'));
});

test('D12 headspeed: hsInfo reads the stretches of profileAt (HS.settleS after a change left out, a stretch with two values not used) and hsMap identifies a headspeed', async () => {
    const TW = worker().ctx.TuningWorker, n = 400, pa = new Uint8Array(n), gr = new Float64Array(n);
    for (let i = 0; i < n; i++) { pa[i] = i < 100 ? 0 : i < 200 ? 2 : i < 300 ? 1 : 3; gr[i] = i < 10 ? 0 : i < 120 ? 2300 : i < 200 ? 2500 : i < 300 ? 2300 : i < 375 ? 2700 : 2750; }
    const seg = (profileAt, govRequest) => ({ n: profileAt.length, rate: 1000, flight: { actualRate: 1000 }, profileAt, extra: { govRequest } }), plain = (x) => JSON.parse(J(x)); // objects of the worker realm
    assert.equal(TW.HS.settleS, 0.05);
    // the change to 2 at sample 100: govRequest is 2300 for 20 more samples (within 50 ms), then 2500; the stretch of 3 has 2700 and, after 75 ms, 2750
    assert.deepEqual(plain(TW.hsInfo([seg(pa, gr)])), { field: true, obs: [{ profile: 2, h: 2500 }, { profile: 1, h: 2300 }], dropped: 1, start: { values: [2300], first: 2 } });
    // a logging gap: the stretch goes on in the next segment; a change at the first frame: no start
    assert.deepEqual(plain(TW.hsInfo([seg(pa.subarray(0, 150), gr.subarray(0, 150)), seg(pa.subarray(150), gr.subarray(150))])).obs, [{ profile: 2, h: 2500 }, { profile: 1, h: 2300 }]);
    assert.equal(TW.hsInfo([seg(pa.subarray(100), gr.subarray(100))]).start, null);
    assert.deepEqual(plain(TW.hsInfo([seg(pa, null)])), { field: false, obs: [], dropped: 0, start: null });
    const M = TW.hsMap({ hsLogs: new Map([[0, { obs: [{ profile: 1, h: 2300 }, { profile: 2, h: 2500 }] }], [1, { obs: [{ profile: 1, h: 2300 }, { profile: 3, h: 2500 }, { profile: 4, h: 2900 }, { profile: 4, h: 3000 }] }]]) });
    assert.deepEqual(plain([M.table, M.switches, M.logs]), [{ 1: 2300, 2: 2500, 3: 2500, 4: [2900, 3000] }, 6, 2]);
    // PID profile 4 has two values (gov_headspeed changed between the logs): each identifies it while no other PID profile has it
    assert.deepEqual(plain([2300, 2500, 2900, 3000, 2700].map(h => M.identify(h))), [{ profile: 1, switches: 2, logs: 2, excludedBy: [] }, { why: 'shared', profiles: [2, 3] }, { profile: 4, switches: 1, logs: 1, excludedBy: [] },
        { profile: 4, switches: 1, logs: 1, excludedBy: [] }, { why: 'none' }]);
    // the observations of PID profile 4 nearest to a log in the file (the value at that time when gov_headspeed changed between logs)
    assert.deepEqual(plain([M.nearest(4, 1), M.nearest(4, 0), M.nearest(5, 0)]), [{ logs: [1], values: [2900, 3000] }, { logs: [1], values: [2900, 3000] }, { logs: [], values: [] }]);
    // a log that starts at 2300 rpm and changes first to PID profile 1 (2300 rpm): a different PID profile also has 2300 rpm
    const X = TW.hsMap({ hsLogs: new Map([[0, { obs: [{ profile: 1, h: 2300 }], start: null }], [1, { obs: [{ profile: 1, h: 2300 }], start: { values: [2300], first: 1 } }]]) });
    assert.deepEqual(plain(X.identify(2300)), { profile: 1, switches: 2, logs: 2, excludedBy: [1] });
});

test('D12: rate profile changes and other in-flight adjustments are found in the log, in frame seconds, and reported', async () => {
    const flight = bbl.simulateFlight({ seconds: 40, seed: 17, airborne: [6, 36], start: '2026-10-04T15:00:00.000+00:00', rateProfiles: [{ from: 0, profile: 1 }, { from: 20, profile: 3 }], adjustments: [[25, 18, 55]] });
    const bytes = bbl.encode([flight]).bytes, R = await worker(NO_PHASE).result({ cmd: 'analyseLog', fileName: 'rates.bbl', logIndex: 0, options: { flightRpm: TRUTH.rpm, curves: false } }, bytes);
    const p = R.records[0].profiles;
    assert.equal(p.rate.length, 1); within(p.rate[0].t, 20, 0.002, 'the rate profile change'); assert.equal(p.rate[0].profile, 3);
    assert.deepEqual(p.adjustments.map(q => [q.func, q.name, q.value]), [[18, 'Roll P-gain', 55]]); within(p.adjustments[0].t, 25, 0.002, 'the adjustment');
    assert.deepEqual(R.profiles.rateChanges, [{ log: 0, t: p.rate[0].t, profile: 3 }]);
    for (const t of ['The log records a change of the rate profile. Check R1 uses the rate values of the log header, which are the values of the rate profile at the start of the log (log 1).',
        'The log records in-flight adjustments of tuning values. The log header shows only the values at the start of the log (log 1).']) assert.ok(R.notes.includes(t), `${t}\n${R.notes.join('\n')}`);
    const r1 = R.findings.filter(f => f.id === 'R1');
    if (has('health_track.cjs')) assert.ok(r1.length && r1.every(f => f.rateChanges === 1), J(r1.map(f => [f.fid, f.rateChanges])));
    // the PID profile changes stay as lib.cjs reads them: no rate change in a log without one
    const plain = await worker(NO_PHASE).result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, options: { flightRpm: TRUTH.rpm, curves: false } }, sim().slice(1));
    assert.ok(plain.records.every(l => l.profiles.rate.length === 0 && l.profiles.adjustments.length === 0) && plain.findings.every(f => !('rateChanges' in f)));
});

// ---------------------------------------------------------------------------------------------
// T3: a real log (opt-in)
// ---------------------------------------------------------------------------------------------

test('T3: Gaui X4 #50 equals the CLI at 2000 rpm (AUTOTUNE_REAL_LOG)', REAL, async () => {
    const { file, dir, W, R } = await gaui50(), out = path.join(dir, 'out');
    node('health.cjs', [out, file], 2000); node('health_report.cjs', [out], 2000); // the CLI on this log alone (a whole-file run reads gyro_decimation_hz of log #0: decoder bug)
    const H = JSON.parse(fs.readFileSync(path.join(out, 'health.json'), 'utf8')), F = JSON.parse(fs.readFileSync(path.join(out, 'results.json'), 'utf8')).findings;
    // the slice is log 0 of its own file to the CLI; labelled the same here, everything else must match to the byte
    assert.equal(J(R.records.map(healthPart)), J(H.logs), 'records');
    assert.equal(J(coreFindings(R.findings)), J(viewerFindings(F, W.ctx.TuningWorker)), 'findings (log numbers in texts from 1)');
    assert.ok(H.logs[0].flown && F.length > 50, `#50 is a flight: ${H.logs[0].flyingS} s, ${F.length} findings`);
    assert.equal(new Set(R.findings.map(f => f.fid)).size, R.findings.length, 'fid unique');
    if (has('evidence.cjs')) assert.deepEqual(R.findings.filter(f => f.severity === 'flag' && !f.evidence).map(f => f.fid), [], 'evidence on every flag');
    // the 4.06 x rotor line flags F5 without a CLI dump; measured, the filters pass almost none of it (the peer's VIB-T21: 0.0-0.2 %)
    const f5 = R.findings.find(f => f.id === 'F5' && f.severity === 'flag'), line = f5 && f5.filterPass && f5.filterPass.find(q => Math.abs(q.hz - 155.7) < 1);
    assert.ok(line && ['roll', 'pitch', 'yaw'].every(ax => line[ax] !== null && line[ax] < 0.05), J(f5 && f5.filterPass));
    const rec = R.advice.recommendations.find(r => r.id === 'F5');
    assert.deepEqual([rec.severity, rec.cli], ['info', []]);
    assert.equal(f5.explained, rec.title, 'the F5 flag is explained by its information-only recommendation');
});

// D13 on the whole Gaui X4 II dump of 2026-10-04 (59 logs): the flights are #49, #50, #51 and #58 (analysis/gaui-x4/spoolup
// census, the peer's ground truth); every other log that decodes is a bench run, which the app does not analyse
const GAUI_FLIGHTS = [49, 50, 51, 58];
test('T3: Gaui X4 dump in file scope: only #49, #50, #51 and #58 are analysed, the other logs are bench runs (AUTOTUNE_REAL_LOG, health_phase.cjs)', { skip: REAL.skip || !has('health_phase.cjs') }, async () => {
    const { all } = gauiSlice(), W = worker(), t0 = Date.now();
    const R = await W.result({ cmd: 'analyseFile', fileName: path.basename(GAUI), selectedLog: 50, options: { flightRpm: null, gains: true, curves: true } }, new Uint8Array(all));
    const cls = (c) => [...new Set(R.records.filter(l => l.logClass === c).map(l => l.log))];
    assert.deepEqual(cls('flight'), GAUI_FLIGHTS, `flight logs: ${J(cls('flight'))}`);
    const decoded = [...new Set(R.records.filter(l => !l.skipped).map(l => l.log))];
    assert.deepEqual(R.benchRuns.map(b => b.log), decoded.filter(l => !GAUI_FLIGHTS.includes(l)), 'every other log that decodes is a bench run');
    const runs = R.benchRuns.map(b => b.log + 1).reduce((o, n) => { const l = o[o.length - 1]; if (l && n === l[1] + 1) l[1] = n; else o.push([n, n]); return o; }, []).map(([a, b]) => a === b ? String(a) : b === a + 1 ? `${a}, ${b}` : `${a} to ${b}`);
    assert.ok(R.notes.includes(`${R.benchRuns.length} of the 59 logs are bench runs (no flight). The app does not do the analysis of these logs: ${runs.join(', ').replace(/, ([^,]+)$/, ' and $1')}.`), R.notes.join('\n'));
    // no analysis of a bench run: its only finding is the log class (D7)
    const bench = new Set(R.benchRuns.map(b => b.log)), stray = R.findings.filter(f => logsOf(f).length && logsOf(f).every(l => bench.has(l)) && f.id !== 'D7');
    assert.deepEqual(stray.map(f => f.fid), [], 'findings of bench runs');
    assert.ok(R.findings.some(f => f.module === 'phase' && f.log === 50), 'health_phase findings of #50');
    // the flight rpm from the flights only
    assert.ok(R.flightRpm.source === 'govTarget' && R.flightRpm.logs.every(l => GAUI_FLIGHTS.includes(l)), J(R.flightRpm));
    // the flights in frame seconds, inside their records; phases contiguous; the attitude checks on the flight phases only
    for (const l of R.records.filter(q => q.logClass === 'flight')) {
        assert.ok(l.phases.every((q, k) => q.t1 >= q.t0 && (!k || Math.abs(q.t0 - l.phases[k - 1].t1) < 1e-6)) && Math.abs(l.phases[0].t0 - l.fromS) < 1e-3, `#${l.log}.${l.segment} phases`);
        for (const q of l.flights) assert.ok(q.t0 >= l.fromS && q.t1 <= l.fromS + l.durationS + 1 && q.seconds > 5, `#${l.log} flight ${J(q)}`);
        if (l.flown) assert.ok(l.normalS <= (l.phaseSeconds.flight || 0) + 0.2, `#${l.log}.${l.segment}: attitude ${l.normalS} s, flight phase ${l.phaseSeconds.flight} s`);
    }
    assert.equal(R.flights.length, R.records.reduce((n, l) => n + (l.logClass === 'flight' ? l.flights.length : 0), 0));
    assert.ok(R.findings.filter(f => f.module === 'loop' && logsOf(f).length).every(f => f.phase === 'flight') && R.findings.filter(f => f.module === 'gov' && logsOf(f).length).every(f => f.phase === (['D5', 'G13', 'G12'].includes(f.id) ? 'all' : 'ground+flight')), 'phases of the findings');
    // review A8: D7 lists the flights in frame seconds, the flights of the records
    for (const l of GAUI_FLIGHTS) { const d7 = R.findings.find(f => f.id === 'D7' && f.log === l), fl = R.flights.filter(q => q.log === l);
        assert.deepEqual(d7.flights.map(q => [q.t0, q.t1]), fl.map(q => [q.t0, q.t1]), `#${l} D7 flights`);
        for (const q of fl) assert.ok(d7.text.includes(`from ${q.t0.toFixed(1)} s to ${q.t1.toFixed(1)} s`), d7.text); }
    // review D-H2: every F5 flag of the four flight logs has the measured filter pass (the 4.06 x line: 0.0-0.2 %, the peer's VIB-T21)
    const f5 = R.findings.filter(f => f.id === 'F5' && f.severity === 'flag');
    assert.ok(new Set(f5.map(f => f.log)).size >= 3 && f5.every(f => Array.isArray(f.filterPass) && f.filterPass.length), J(f5.map(f => [f.fid, f.filterPass])));
    for (const f of f5) for (const m of String(f.text).matchAll(/line at ([\d.]+) x rotor \(([\d.]+) Hz/g)) {
        if (Math.abs(+m[1] - 4.06) > 0.02) continue; // the 4.06 x line (orders of the text: health_setup F5)
        const q = f.filterPass.find(x => x.hz === +m[2]); assert.ok(q && ['roll', 'pitch', 'yaw'].every(ax => q[ax] !== null && q[ax] < 0.05), `${f.fid}: ${J(q)}`); }
    // review C1: the selected log is a flight log, so its header
    assert.equal(R.headerLog, 50);
    // review A3, D-H4: the gains use only the extract.cjs segments in the flight from liftoff to touchdown + 0.1 s. Of the 10, #49
    // 31.25 s and #50 14.89 s start before the liftoff (0.12 and 0.57 s), and #49, #50, #51 and #58 end 0.95 to 2.16 s after the
    // touchdown: 4 are left, too few for a decision of report.cjs (a headspeed bin needs 3 flights)
    assert.ok(Array.isArray(R.decisions) && R.notes.includes('6 of the 10 segments of "extract.cjs" are not in a flight, or they have rescue, a level mode or failsafe. Thus, the app does not use them to calculate the gains.'),
        R.notes.filter(n => /segment/.test(n)).join('\n'));
    if (has('evidence.cjs')) for (const d of R.decisions) for (const q of d.evidence.spans) assert.ok(R.flights.some(f => f.log === q.log && q.t0 >= f.t0 - 1e-3 && q.t1 <= f.t1 + 0.15), `C7 segment ${J(q)}`);
    // D12: PID profiles of the flights; no rate profile change in this dump
    assert.ok(Object.keys(R.profiles.pid).length >= 2 && R.profiles.rateChanges.length === 0, J(R.profiles));
    // D12 headspeed (user decision 2026-10-06): govRequest at the start is 2300 rpm in #49, #50 and #58 and 2500 rpm in #51. At the PID
    // profile changes of the dump, 2300 rpm is PID profile 1 only (13 changes in 8 logs) and 2500 rpm PID profile 2 only (20 changes in 8
    // logs); PID profile 1 also has 2100 rpm in the logs 8 to 27 (gov_headspeed changed). Thus, no result is "PID profile unknown"
    assert.deepEqual(R.profiles.arming.map(q => [q.log, q.profile, q.basis, q.headspeed.headspeed, q.headspeed.observations]),
        [[49, 1, ['headspeed'], 2300, { switches: 13, logs: 8 }], [50, 1, ['headspeed'], 2300, { switches: 13, logs: 8 }], [51, 2, ['headspeed'], 2500, { switches: 20, logs: 8 }], [58, 1, ['headspeed'], 2300, { switches: 13, logs: 8 }]], J(R.profiles.arming));
    assert.deepEqual(R.profiles.arming[0].headspeed.map, { 1: [2100, 2300], 2: [1000, 2500], 3: [1000, 2700] });
    assert.ok(!R.findings.some(f => f.display && f.display.profile === 'PID profile unknown'), 'no result of an unknown PID profile');
    // round 3 M1: the configurations of the dump: PID profile 1 of #49 (yaw 80/120/10, stop 120/80: A), of #50 and #51 (yaw 100/140/14,
    // stop 120/80: D) and of #58 (stop 140/100: E); the PID profiles 2 and 3 (B, C)
    const D = R.datasets, byId = Object.fromEntries(D.datasets.map(d => [d.id, d]));
    assert.deepEqual(D.datasets.map(d => [d.id, d.pidProfile, d.logs]), [['A', 1, [49]], ['B', 2, [49, 50, 51, 58]], ['C', 3, [49, 58]], ['D', 1, [50, 51]], ['E', 1, [58]]]);
    assert.deepEqual([byId.D.values.yaw_cw_stop_gain, byId.D.values.yaw_ccw_stop_gain, byId.E.values.yaw_cw_stop_gain, byId.E.values.yaw_ccw_stop_gain, byId.A.values.yaw_p_gain, byId.D.values.yaw_p_gain], [120, 80, 140, 100, 80, 100]);
    assert.ok(R.findings.filter(f => ['gov', 'loop', 'track', 'more', 'phase', 'rescue', 'limits'].includes(f.module) && f.profile !== null && logsOf(f).length === 1 && GAUI_FLIGHTS.includes(logsOf(f)[0])).every(f => typeof f.dataset === 'string'), 'a configuration on each result of the modules that pool by configuration');
    // the A/B of the stop gains (D against E, PID profile 1 now with its arming stretches): the periods at the tail limit (L4) and at the
    // tail output limit (T8), both by 2 SE or more
    const de = D.comparisons.find(c => c.a === 'D' && c.b === 'E'), res = (id) => de.results.find(x => x.check === id);
    assert.deepEqual(de.names, ['yaw_cw_stop_gain', 'yaw_ccw_stop_gain']);
    assert.deepEqual([res('L4').testable, res('L4').significant, res('T8').testable, res('T8').significant], [true, true, true, true], J(de.results.map(x => [x.check, x.delta, x.se])));
    within(res('L4').delta, -7.6, 0.5, 'L4: E - D periods for each minute'); within(res('L4').se, 3.5, 0.5, 'L4 SE');
    within(res('T8').delta, -26.4, 1, 'T8: E - D periods for each minute of flight'); within(res('T8').se, 6.2, 0.5, 'T8 SE');
    assert.match(de.text, /Of these, 4 are different by 2 SE or more: check T13 \(yaw\), check T8, check T11 \(yaw\) and check L4 \(yaw\)\./);
    // the recommendations of the tail at its limit carry this pair (no "PID profile unknown" item L4:tail:p0 now)
    for (const id of ['T8', 'L4:tail:p1']) { const rec = R.advice.recommendations.find(r => r.id === id); assert.ok(rec && rec.ab.some(q => q.a === 'D' && q.b === 'E' && q.significant && q.unit), `${id}: ${J(rec && rec.ab)}`); }
    assert.ok(!R.advice.recommendations.some(r => r.id === 'L4:tail:p0'));
    // round 3 M3: the items of the overview
    assert.ok(R.issues.length >= 5 && R.top.length === 3 && R.issues.every(x => x.fids.length >= 1), J(R.top));
    assert.ok(R.issues.some(x => x.key === 'L4|yaw' && x.status === 'problem' && x.count >= 4), J(R.issues.map(x => x.key)));
    for (const l of R.records.filter(q => q.logClass === 'flight')) assert.ok(l.profiles.pid.length >= 1 && l.profiles.pid.every(q => q.profile >= 0 && q.profile <= 6), J(l.profiles.pid));
    process.stderr.write(`# Gaui dump: ${R.records.length} records, ${R.flights.length} flights (${R.flights.map(q => `#${q.log} ${q.t0}-${q.t1} s ${q.method} ${q.confidence}`).join('; ')}), ${R.benchRuns.length} bench runs, ` +
        `flight rpm ${R.flightRpm.value} from ${R.flightRpm.basis} (${R.flightRpm.source}), ${R.findings.length} findings, ${((Date.now() - t0) / 1000).toFixed(0)} s\n`);
});

// the viewer opens the first log of a file, here the RF 4.4 bench log #0: the file's flight rpm must still come from its flights
test('T3: Gaui X4 #0, #50, #51 in file scope with the bench log #0 on screen: flight rpm 1900 from the 2300 rpm target (AUTOTUNE_REAL_LOG)', REAL, async () => {
    const { all, at } = gauiSlice(), bytes = new Uint8Array(Buffer.concat([0, 50, 51].map(li => all.subarray(at[li], at[li + 1]))));
    const R = await worker().result({ cmd: 'analyseFile', fileName: 'gaui_0_50_51.bbl', selectedLog: 0, options: { flightRpm: null, gains: false, curves: false } }, bytes);
    assert.deepEqual([R.flightRpm.value, R.flightRpm.source, R.flightRpm.basis, R.flightRpm.logs], [1900, 'govTarget', 2300, [1, 2]], JSON.stringify(R.flightRpm));
    assert.deepEqual(R.records.map(r => r.flown), [false, true, true], 'the bench log is not a flight, #50 and #51 are');
    assert.ok(R.records[1].flyingS > 60 && R.records[2].flyingS > 75, J(R.records.map(r => r.flyingS)));
    // review C1, D-H1: #0 is an RF 4.4 bench run; advice reads the header of #51, the last flight log
    if (has('health_phase.cjs')) {
        assert.deepEqual([R.headerLog, R.header['Firmware revision'].includes('4.6.0'), R.fields && R.fields.headspeed], [2, true, 'present'], J([R.headerLog, R.header['Firmware revision']]));
        assert.ok(R.notes.includes('Log 1 is a bench run. Thus, the recommendations use the log header of log 3. This is the last flight log in the file.'), R.notes.join('\n'));
    }
});

// review (Fireball 2026-10-05, 16 logs): a log with no data ("parser: Log truncated, no data") is named in one note, and it is
// not a bench run or a flight log; the log numbers of a note are items: "1, 3 and 4", never "1 and 3, 4"
test('notes: the logs with no data have their own note; a pair of log numbers is two items', async () => {
    const S = sim(), head = (b) => { const s = Buffer.from(b); let i = 0, end = 0; // the header lines only: the decoder finds no frame
        for (let j = s.indexOf(10, i); j >= 0 && s[i] === 0x48 && s[i + 1] === 0x20; i = j + 1, j = s.indexOf(10, i)) end = j + 1; return s.subarray(0, end); };
    const bytes = new Uint8Array(Buffer.concat([S.slice(0), S.slice(1), S.slice(0), S.slice(0), head(S.slice(3)), head(S.slice(4))].map(b => Buffer.from(b))));
    const R = await worker().result({ cmd: 'analyseFile', fileName: 'sim.bbl', selectedLog: 1, options: { flightRpm: TRUTH.rpm, curves: false } }, bytes);
    const empty = R.records.filter(l => l.skipped && !l.logClass).map(l => l.log);
    assert.deepEqual([...new Set(empty)], [4, 5], JSON.stringify(R.records.map(l => [l.log, l.skipped, l.logClass])));
    const note = R.notes.find(n => /no data/.test(n)); assert.ok(note, R.notes.join('\n'));
    assert.match(note, /^Logs 5 and 6 have no data that the app can read \("[^"]+"\)\. The app does not use these logs\.$/);
    assert.deepEqual(R.benchRuns.map(b => b.log), [0, 2, 3], 'the logs with no data are not bench runs');
    assert.ok(R.notes.includes('3 of the 6 logs are bench runs (no flight). The app does not do the analysis of these logs: 1, 3 and 4.'), R.notes.join('\n'));
});

// review V5, V6, V11: what the views show of each finding is catalog.cjs display (value, bound, limit), the evidence rows of
// the recommendations carry the same; advice gets the name of the CLI dump
test('display (review V5, V6) on every finding and on the evidence rows; advice gets the name of the CLI dump (V11)', async () => {
    const S = sim(), C = require('../tools/autotune/catalog.cjs');
    const R = await worker().result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, logCount: S.count, options: { flightRpm: TRUTH.rpm, cliText: CLI, cliName: TRUTH.cliName } }, S.slice(1));
    const BARE = /^[−-]?\d[\d.,]*(?: ± [\d.,]+)?$/;
    for (const f of R.findings) {
        const d = C.display(f);
        assert.deepEqual([f.display.value, f.display.bound, f.display.limit], [d.value, d.bound, d.limit], f.fid);
        assert.ok(f.display.value === null || !BARE.test(f.display.value), `no bare number: ${f.fid} ${f.display.value}`);
        assert.ok(f.display.bound === null || !/>=|<=|\|\w|implicated|minWindows/.test(f.display.bound), `${f.fid}: ${f.display.bound}`);
    }
    const byFid = new Map(R.findings.map(f => [f.fid, f]));
    for (const r of R.advice.recommendations) for (const e of r.evidence) if (e.fid && byFid.has(e.fid)) {
        const x = byFid.get(e.fid).display; assert.deepEqual(e.display, { value: x.value, bound: x.bound, limit: x.limit }, `${r.id} ${e.fid}`); }
    // advice reads the name of the CLI dump: a previous value that the dump gives with the same value names it
    const echo = `'use strict';\nmodule.exports = { advise: (i) => ({ recommendations: [], coverage: [{ area: 'logging' }], notes: [JSON.stringify({ cliName: i.cliName })] }) };`;
    const W = worker({ 'advice.cjs': echo });
    const named = await W.result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, options: { flightRpm: TRUTH.rpm, curves: false, cliText: CLI, cliName: TRUTH.cliName } }, S.slice(1));
    assert.deepEqual(JSON.parse(named.advice.notes[0]), { cliName: TRUTH.cliName });
    const none = await W.result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, options: { flightRpm: TRUTH.rpm, curves: false } }, S.slice(1));
    assert.deepEqual(JSON.parse(none.advice.notes[0]), { cliName: null }, 'no CLI dump: no name');
});

// ---------------------------------------------------------------------------------------------
// Flight selection (SPEC3 D): options.flights = [{ log, flight }], the flight 0-based in its log
// ---------------------------------------------------------------------------------------------

// a 90 s log with two flights: the simulated flight on the ground from 40 s to 50 s (no airborne flag, no movement, the
// collective down): health_phase finds 6.0-39.0 s and 50.0-83.0 s
function twoFlights() {
    const log = bbl.simulateFlight({ seconds: 90, seed: 31, airborne: [6, 84], start: '2026-10-04T15:00:00.000+00:00' }), w = log.w, X = w.extra, at = (s) => Math.round(s * 1000);
    for (let i = at(40); i < at(50); i++) { log.airborne[i] = 0; for (let a = 0; a < 3; a++) { w.gyro[a][i] = 0; w.sp[a][i] = 0; X[`gyroRAW[${a}]`][i] = 0; w.u[a][i] = 0; } w.coll[i] = -250; X['mixer[3]'][i] = -250; }
    return log;
}

test('flight selection (SPEC3 D): only the selected logs and flights; a log with two flights keeps the time from the touchdown before to the liftoff after', async () => {
    const bytes = bbl.encode([bbl.simulateFlight({ seconds: 40, seed: 7, airborne: [6, 34], start: '2026-10-04T14:50:00.000+00:00' }), twoFlights()]).bytes, W = worker();
    const run = (flights) => W.result({ cmd: 'analyseFile', fileName: 'two.bbl', selectedLog: 1, options: { flightRpm: TRUTH.rpm, curves: false, flights } }, bytes);
    const all = await run(null), two = all.flights.filter(q => q.log === 1);
    assert.equal(all.selection, null, 'no selection: every log');
    assert.deepEqual(two.map(q => [Math.round(q.t0), Math.round(q.t1)]), [[6, 39], [50, 83]], 'the two flights of log 2');
    // the second flight of log 2: the time from the touchdown of the first flight to the end of the log
    const R = await run([{ log: 1, flight: 1 }]);
    assert.deepEqual(R.logs, [1]); assert.ok(R.records.every(l => l.log === 1), 'only the selected log');
    assert.deepEqual(R.selection.flights.map(q => [q.log, q.flight, Math.round(q.t0), Math.round(q.t1)]), [[1, 1, 50, 83]]);
    assert.equal(R.selection.windows.length, 1); within(R.selection.windows[0].t0, two[0].t1, 0.01, 'from the touchdown of flight 1'); within(R.selection.windows[0].t1, 90, 0.01, 'to the end of the log');
    assert.deepEqual(R.flights.map(q => [q.log, Math.round(q.t0), Math.round(q.t1)]), [[1, 50, 83]], 'the analysis has only the selected flight');
    assert.equal(R.selection.text, 'Flights in the analysis: log 2 flight 2 (50.0 s to 83.0 s).');
    assert.ok(R.reportMarkdown.startsWith(`${R.selection.text}\n\n`) && R.notes.includes(R.selection.text), 'the report text and the notes');
    assert.ok(R.notes.some(t => /from the landing before a selected flight to the liftoff after it/.test(t)));
    // a log with one flight is the whole log; both flights of a log are the whole log
    const one = await run([{ log: 0, flight: 0 }]);
    assert.deepEqual(one.logs, [0]); assert.deepEqual(one.selection.windows.map(w => [w.log, Math.round(w.t0), Math.round(w.t1)]), [[0, 0, 40]]);
    const both = await run([{ log: 1, flight: 0 }, { log: 1, flight: 1 }]);
    assert.deepEqual(both.selection.windows.map(w => [w.log, Math.round(w.t0), Math.round(w.t1)]), [[1, 0, 90]]);
    assert.equal(both.flights.length, 2);
    // { log, flight: null }: every flight of that log (the whole log), listed in the text; the flight rpm from the selected logs only
    const mixed = await run([{ log: 0, flight: null }, { log: 1, flight: 1 }]);
    assert.deepEqual(mixed.logs, [0, 1]); assert.deepEqual(mixed.selection.all, [0]);
    assert.match(mixed.selection.text, /^Flights in the analysis: log 1 \(all flights\), log 2 flight 2 \(50\.0 s to 83\.0 s\)\.$/);
    assert.deepEqual(mixed.flights.map(q => [q.log, Math.round(q.t0)]), [[0, 6], [1, 50]], 'result.flights: the analysed flights only');
    const auto = await W.result({ cmd: 'analyseFile', fileName: 'two.bbl', selectedLog: 1, options: { curves: false, flights: [{ log: 1, flight: null }] } }, bytes);
    assert.deepEqual(auto.logs, [1]); assert.deepEqual(auto.flightRpm.logs, [1], 'the flight rpm comes from the selected logs');
    assert.ok(!auto.records.some(l => l.log === 0));
    // a flight that the log does not have, and a log that the file does not have: notes
    const bad = await run([{ log: 0, flight: 3 }, { log: 9, flight: 0 }]);
    assert.ok(bad.notes.some(t => /does not use the selected flight 4/.test(t)) && bad.notes.some(t => /flight selection/.test(t)), J(bad.notes));
});

// round 2 (SPEC3 A, I; coordinator): the new modules in the worker on real flight logs. The Gaui X4 records Vbat as 0 (no voltage
// sensor): P1 is "not measured" with that reason. The Fireball dump of 2026-10-05 (AUTOTUNE_RESCUE_LOG, 16 logs): P1 at the load
// steps of each flight log, P2 not measured (Ibat is 0), D9 from the rescues of the log, G20 the cause of each FALLBACK
const FB = process.env.AUTOTUNE_RESCUE_LOG || '';
test('round 2: Gaui X4 #50 in the worker: P1 not measured (Vbat 0), D9 for the PID profiles of the log, node, tuner and area on every finding (AUTOTUNE_REAL_LOG)', REAL, async () => {
    const { R } = await gaui50();
    const p1 = R.findings.filter(f => f.id === 'P1'), d9 = R.findings.filter(f => f.id === 'D9');
    assert.deepEqual(p1.map(f => [f.module, f.severity, f.noVoltage, f.node, f.area, f.tuner]), [['power', 'skipped', 'zero', 'power', 'power', false]]);
    assert.match(p1[0].summary, /`Vbat`\) is 0 in all samples/);
    assert.ok(d9.length >= 1 && d9.every(f => f.module === 'config' && f.node === 'rescue' && f.tuner === false), J(d9.map(f => [f.severity, f.profile])));
    assert.ok(R.hierarchy.graph.prereq.length === 6 && R.hierarchy.graph.blocks.length === 6 && Array.isArray(R.hierarchy.prereqProblems));
});
test('round 2: Fireball 2026-10-05 in file scope: P1 at the load steps of each flight log, P2 not measured, D9 from the rescues, G20 at each FALLBACK (AUTOTUNE_RESCUE_LOG)', { skip: !FB || !fs.existsSync(FB) || !has('health_power.cjs') }, async () => {
    const R = await worker().result({ cmd: 'analyseFile', fileName: path.basename(FB), selectedLog: 15, options: { flightRpm: null, excludeAbnormal: true, phases: true, curves: false, gains: false } }, new Uint8Array(fs.readFileSync(FB)));
    const p1 = R.findings.filter(f => f.id === 'P1' && f.severity !== 'skipped'), p2 = R.findings.filter(f => f.id === 'P2');
    assert.deepEqual(p1.map(f => f.log), [5, 10, 11, 13, 14, 15], 'one P1 for each flight log');
    for (const f of p1) { assert.equal(f.cells, 6, `log ${f.log}: 6 cells`); assert.ok(f.n >= 5 && f.value > 0.03 && f.value < 0.15 && f.se > 0, `log ${f.log}: ${f.n} steps, ${f.value} ± ${f.se} V for each cell`);
        assert.ok(f.minCell > 3.4 && f.minCell < f.beforeCell, `log ${f.log}: lowest ${f.minCell} V from ${f.beforeCell} V`); assert.equal(f.severity, 'ok'); assert.ok(f.evidence && f.evidence.spans.length > 0 && f.evidence.plot.caption); }
    assert.ok(p2.length && p2.every(f => f.severity === 'skipped'), 'Ibat is 0: P2 not measured');
    const d9 = R.findings.filter(f => f.id === 'D9' && f.severity === 'ok').map(f => f.pidProfile).sort();
    assert.deepEqual(d9, [1, 2], 'a rescue state in PID profiles 1 and 2');
    const g20 = R.findings.filter(f => f.id === 'G20');
    assert.deepEqual(g20.map(f => [f.log, f.value, f.n]), [[11, 2, 2], [14, 1, 1]], 'log 12: 2 FALLBACKs at the throttle limit; log 15: 1 at the rescue');
    const g1 = R.findings.filter(f => f.id === 'G1' && f.severity === 'flag');
    assert.ok(g1.length === 2 && g1.every(f => f.status === 'monitor' && Array.isArray(f.resultOf)), J(g1.map(f => [f.log, f.status])));
    assert.notEqual(R.hierarchy.nodes.rpm.status, 'problem', 'a FALLBACK at the throttle limit is no problem of the RPM signal');
    assert.ok(!R.hierarchy.startHere.some(id => R.hierarchy.nodes[id].status !== 'startHere'));
    // SPEC3 F on the real results: a problem or a value to monitor says first what the helicopter does and why (catalog.cjs lead), then the number
    const C = require('../tools/autotune/catalog.cjs'); let n = 0;
    for (const f of R.findings.filter(x => (x.status === 'problem' || x.status === 'monitor') && C.CHECKS[x.id] && C.lead(x, x.status).length)) { n++;
        const [first, second] = f.summary.split('\n'); assert.equal(first, C.lead(f, f.status).join(' '), f.fid); assert.ok(second && /\d/.test(second), `${f.fid}: the number in the second paragraph`); }
    assert.ok(n > 20, `${n} problems and values to monitor with a lead`);
    // D12 headspeed (user decision 2026-10-06): govRequest at the start is 3500 rpm in the flight logs 6, 11, 14, 15 and 16, PID profile 1 only at
    // the PID profile changes of the dump (2 changes in 2 logs), and 4500 rpm in log 12, PID profile 2 only (12 changes in 6 logs). Log 12 also
    // changes to PID profile 1 at 11.55 s first, and its header (yaw 45/105/10) is not the header of the logs at 3500 rpm (yaw 65/120/12)
    assert.deepEqual(R.profiles.arming.map(q => [q.log, q.profile, q.basis, q.headspeed.headspeed, q.headspeed.observations]), [[5, 1, ['headspeed'], 3500, { switches: 2, logs: 2 }],
        [10, 1, ['headspeed'], 3500, { switches: 2, logs: 2 }], [11, 2, ['headspeed'], 4500, { switches: 12, logs: 6 }], [13, 1, ['headspeed'], 3500, { switches: 2, logs: 2 }],
        [14, 1, ['headspeed'], 3500, { switches: 2, logs: 2 }], [15, 1, ['headspeed'], 3500, { switches: 2, logs: 2 }]], J(R.profiles.arming));
    assert.deepEqual(R.profiles.arming[0].headspeed.map, { 1: 3500, 2: 4500, 3: 5000 });
    assert.ok(!R.findings.some(f => f.display && f.display.profile === 'PID profile unknown'), 'no result of an unknown PID profile');
    // round 3 M1: the rates change between logs 14 and 15 (expo 25/25/33 to 20/20/20): PID profile 2 has two configurations
    const D = R.datasets, two = D.datasets.filter(d => d.pidProfile === 2);
    assert.deepEqual(two.map(d => [d.values.roll_expo, d.values.yaw_expo]), [[25, 33], [20, 20]], J(two.map(d => d.id)));
    assert.deepEqual(D.newestByProfile[2], two[1].id);
    assert.ok(D.datasets.every(d => d.pidProfile > 0), 'no configuration of an unknown PID profile');
    assert.ok(D.diff.some(x => x.name === 'yaw_expo' && x.samePidProfile), J(D.diff.map(x => x.name)));
    assert.ok(R.findings.some(f => f.id === 'G3' && f.dataset === two[0].id) && R.findings.some(f => f.id === 'G3' && f.dataset === two[1].id), 'G3 pooled over the logs by configuration');
    // round 3 M4: logs 8 and 13 have no data that the app can read
    assert.deepEqual(R.noData.map(x => x.log), [7, 12]);
});

// round 3 M2: the filter search on the real flight logs, with no CLI dump. The tail rotor notch filter comes from the log. On the Gaui X4
// dump the model does not agree with the recorded gyroADC, and the result is a check with that reason
test('round 3 M2: filterTune on the Gaui X4 flight logs and on the Fireball 2026-10-05 flight logs, with no CLI dump: a check that says why (AUTOTUNE_REAL_LOG, AUTOTUNE_RESCUE_LOG)', { skip: REAL.skip && (!FB || !fs.existsSync(FB)) }, async () => {
    const W = worker(), run = async (file, options) => { const m = await W.send({ cmd: 'filterTune', fileName: path.basename(file), options }, new Uint8Array(fs.readFileSync(file)));
        assert.equal(m.type, 'filterTuned', `${m.message}\n${m.stack}`); return m.result; };
    for (const [file, logs, rpm] of [[GAUI, GAUI_FLIGHTS, 1900], [FB, [5, 10, 11, 13, 14, 15], null]]) {
        if (!file || !fs.existsSync(file)) continue;
        const R = await run(file, { logs, flightRpm: rpm });
        assert.deepEqual(R.logs, logs);
        if (file === GAUI) { assert.equal(R.model.passed, false, J(R.model.parity.map(p => [p.log, p.passed])));
            assert.deepEqual(R.recommendations.map(r => [r.id, r.severity, r.cli]), [['F:filters', 'check', []]]);
            assert.ok(/does not agree with the recorded gyroADC/.test(R.text.why[0]), J(R.text.why)); }
        // the user rule of 2026-10-06: the log is the only input that the analysis needs, and no text asks for a CLI dump. The tail rotor notch
        // filter comes from the log (the dips of |gyroADC / gyroRAW| at its rotor order)
        assert.ok(!(R.text.why || []).some(t => /CLI dump/.test(t)), J(R.text.why));
        assert.ok(/tail rotor notch filter/.test(R.text.parity) && !/CLI dump/.test(R.text.parity), R.text.parity);
        process.stderr.write(`# filterTune ${path.basename(file)}: ${R.recommended.status}, ${R.recommended.predicted ? `${R.recommended.predicted.totalDb} ± ${R.recommended.predicted.se} dB` : ''}, ${R.timing.totalS} s\n`);
    }
});

// ---------------------------------------------------------------------------------------------
// Round 3: the configurations (M1), the filter search (M2), the issues (M3), the logs with no data (M4)
// ---------------------------------------------------------------------------------------------

// a stand-in for health_track.cjs that records what the worker gives it: the labels of ctx.profile, the PID profile labels, the PID
// profile of each label (ctx.pidProfileOf) and gov_headspeed by label; one finding for each label, whose text names the label
const STUB_LABELS = `'use strict';
const set = (a) => a ? [...new Set(a)].sort((x, y) => x - y) : null;
module.exports = { EXTRA: [], RULE: {}, DEFAULT_RULES: {},
    analyse: (w, ctx) => { const L = set(ctx.profile); return { labels: L, pid: set(ctx.pidLabels), pidOf: L.map(l => typeof ctx.pidProfileOf === 'function' ? ctx.pidProfileOf(l) : null), gh: ctx.govHeadspeed || null }; },
    judge: (flights) => [].concat(...flights.map(f => f.metrics.labels.map(L => ({ id: 'C12', severity: 'note', thin: true, log: f.log, profile: L, axis: 'roll', value: L, se: null, n: 1, threshold: null, source: 'test', unit: 'samples',
        text: 'label ' + L + ': PID profile ' + L + ' and profile ' + L + '.' })))),
    curves: () => null };`;
test('round 3 M1: every sample has the label of its configuration, the modules pool by configuration; f.dataset, the fid and result.datasets', async () => {
    const S = sim(), W = worker({ 'health_phase.cjs': STUB_PHASE, 'health_track.cjs': STUB_LABELS });
    const run = (o, sel = 1) => W.result({ cmd: 'analyseFile', fileName: 'sim.bbl', selectedLog: sel, options: Object.assign({ flightRpm: TRUTH.rpm, cliText: CLI, curves: false, keepMetrics: true }, o) }, S.bytes);
    const R = await run({}), D = R.datasets;
    // the configurations of the file: PID profile 1 of logs 1 and 4; PID profile 2 of log 1 (its CLI section); PID profile 1 of log 3 (other yaw
    // gains); log 5 (no govRequest, and no section of the dump agrees with its header: the dump gives no evidence of its PID profile at
    // arming) in a PID profile that is not known
    assert.deepEqual(D.datasets.map(d => [d.id, d.pidProfile, d.logs, d.analysed]), [['A', 1, [1, 4], true], ['B', 2, [1], true], ['C', 1, [3], true], ['D', null, [5], true]]);
    assert.deepEqual(D.diff.find(x => x.name === 'yaw_p_gain').values, { A: 100, B: 80, C: 80, D: 100 });
    assert.deepEqual([D.newestByProfile, D.analysed, D.benchRuns], [{ 1: 'A', 2: 'B', unknown: 'D' }, ['A', 'B', 'C', 'D'], [0]]);
    assert.deepEqual(D.labels.filter(q => q.log === 1).map(q => q.dataset), ['A', 'B', 'A', 'A'], 'log 1: PID profile 1, 2 from 28 s, 1 from 49 s, and the segment after the gap');
    within(D.labels.find(q => q.log === 1 && q.dataset === 'B').t0, 28, 0.002, 'the configuration B from the PID profile change');
    assert.ok(D.datasets.every(d => typeof d.analysedSeconds === 'number' && typeof d.analysedFlightSeconds === 'number') && Array.isArray(D.comparisons), J(D.datasets[0]));
    // the modules got the labels of the configurations: in log 1 two labels (A, B) with PID profiles 1 and 2, the PID profile labels 0, 2, 1 in ctx.pidLabels
    const m1 = R.records.find(l => l.log === 1 && l.segment === 0).metrics.track, m3 = R.records.find(l => l.log === 3).metrics.track, m4 = R.records.find(l => l.log === 4).metrics.track;
    assert.deepEqual([m1.labels.length, m1.pidOf.slice().sort(), m1.pid], [2, [1, 2], [0, 1, 2]]);
    assert.ok(m4.labels.length === 1 && m1.labels.includes(m4.labels[0]), 'log 4 has the label of configuration A of log 1: one label for one configuration in every log');
    assert.ok(m3.labels.length === 1 && !m1.labels.includes(m3.labels[0]) && m3.pidOf[0] === 1, 'log 3: PID profile 1 with other yaw gains is another configuration');
    const lA = m4.labels[0], lB = m1.labels.find(l => l !== lA);
    assert.deepEqual(m1.gh, { [lA]: 2500, [lB]: 2700, [m3.labels[0]]: 2500 }, 'gov_headspeed of each label (all labels so far): the CLI value of its PID profile');
    // the findings: the configuration, its PID profile, the PID profile label in f.profile, the configuration in the fid and in the toolkit text
    const T = R.findings.filter(f => f.module === 'track');
    assert.ok(T.length >= 5);
    for (const f of T) { const d = D.datasets.find(x => x.id === f.dataset), named = `configuration ${d.id} (${d.pidProfile > 0 ? `PID profile ${d.pidProfile}` : 'PID profile unknown'})`;
        assert.ok(d, f.fid); assert.deepEqual([f.pidProfile, f.profile, f.fid.split('|')[6], typeof f.datasetLabel], [d.pidProfile, d.pidProfile > 0 ? d.pidProfile : 0, f.dataset, 'number'], f.fid);
        assert.equal(f.text, `label ${f.datasetLabel}: ${named} and ${named}.`, f.text); }
    assert.ok(R.findings.filter(f => f.module === 'setup' && f.id === 'F6').every(f => f.dataset === null || D.datasets.some(d => d.id === f.dataset)), 'health_setup: a PID profile label of one log');
    assert.ok(R.findings.filter(f => f.id === 'D4').every(f => f.dataset === null), 'D4 is no configuration');
    assert.match(R.reportMarkdown, /\n## Configurations\n\nIn the toolkit tables, the column "profile" of the checks of seven modules gives the number of a configuration\./);
    // the diagram of each analysed configuration (hierarchy.status in its PID profile)
    assert.deepEqual(Object.keys(R.hierarchy.byDataset), ['A', 'B', 'C', 'D']);
    assert.ok(Object.values(R.hierarchy.byDataset).every(x => x.nodes && x.nodes.filters && typeof x.nodes.filters.status === 'string' && Array.isArray(x.startHere)), J(R.hierarchy.byDataset.A));
    assert.deepEqual(Object.values(R.hierarchy.byDataset).map(x => x.pidProfile), [1, 2, 1, null]);
    // datasets false: the PID profile labels, no configuration (the CLI's labels when phases and excludeAbnormal are off too)
    const P = await run({ datasets: false });
    assert.equal(P.datasets, null);
    assert.deepEqual(P.records.find(l => l.log === 1 && l.segment === 0).metrics.track.labels, [0, 1, 2]);
    assert.ok(P.findings.every(f => f.dataset === undefined && f.fid.split('|').length === 7), 'no configuration, the fid of 7 parts');
    // the flight selection: the configurations of every log of the file, the labels of the analysed time only
    const one = await run({ flights: [{ log: 3, flight: null }] }, 3);
    assert.deepEqual([one.datasets.datasets.map(d => d.id), one.datasets.analysed, [...new Set(one.datasets.labels.map(q => q.log))]], [['A', 'B', 'C', 'D'], ['C'], [3]]);
    // one log: the configurations of that log
    const L = await W.result({ cmd: 'analyseLog', fileName: 'sim.bbl', logIndex: 1, options: { flightRpm: TRUTH.rpm, cliText: CLI, curves: false } }, S.slice(1));
    assert.deepEqual(L.datasets.datasets.map(d => [d.id, d.pidProfile, d.logs]), [['A', 1, [1]], ['B', 2, [1]]]);
});

test('round 3 M2: filterTune runs the filter search of filter_tune.cjs on the flight logs of the file, with STE texts and the recommendations of advice.cjs', async () => {
    const S = sim(), W = worker({ 'health_phase.cjs': STUB_PHASE }), go = async (o) => { const m = await W.send({ cmd: 'filterTune', fileName: 'sim.bbl', options: Object.assign({ flightRpm: TRUTH.rpm, cliText: CLI, loo: false, budgetMs: 2000 }, o) }, S.bytes);
        assert.equal(m.type, 'filterTuned', `${m.message}\n${m.stack}`); return m.result; };
    const R = await go({ blockedBy: ['rpm', 'filters', 'The step "Governor" has a problem.', 'x'] });
    // options.blockedBy: the ids of the diagram (the titles of hierarchy.cjs graph) or STE texts
    assert.deepEqual(R.blockedBy, ['The prerequisite "RPM signal and motor poles" has a problem.', 'The step "Filters" has a problem.', 'The step "Governor" has a problem.']);
    // the flight logs with the raw gyro (log 5 has no extra field), not the bench run (log 0) or the logs with no data (2, 6)
    assert.deepEqual(R.logs, [1, 3, 4, 5]);
    assert.ok(R.model && Array.isArray(R.model.parity) && R.recommended && typeof R.recommended.status === 'string' && R.current && R.units, Object.keys(R).join());
    assert.deepEqual(Object.keys(R.text), ['status', 'summary', 'parity', 'recommendation', 'delay', 'validation', 'why', 'rows']);
    assert.ok(R.text.summary.startsWith('The app calculated the vibration for '), R.text.summary);
    assert.deepEqual([R.fileName, R.flightRpm.value, R.flightRpm.source], ['sim.bbl', TRUTH.rpm, 'user']);
    const act = R.recommended.status === 'recommended' && R.model.passed === true;
    assert.ok(R.recommendations.length >= 1 && R.recommendations.every(r => r.node === 'filters' && r.severity === (act ? 'action' : 'check') && (act || !r.cli.length)), J(R.recommendations.map(r => [r.id, r.severity, r.cli])));
    // r.stale (CLAUDE.md "Values that are possibly not current"): the parts of the flight logs that the search used. The global values of the
    // filters: a PID profile change of log 2 (28 to 49 s) does not count, the logging pause of log 2 (56 s) does
    assert.ok(R.recommendations.every(r => 'stale' in r), J(R.recommendations.map(r => [r.id, r.stale])));
    for (const r of R.recommendations.filter(x => x.scope === 'global')) assert.ok(r.stale && !r.stale.reasons.includes('switched') && r.stale.reasons.includes('resume') && /^This recommendation uses a part of the log /.test(r.stale.text), J(r.stale));
    // options.logs: only those logs; a bench run alone: no flight log, one check
    assert.deepEqual((await go({ logs: [3] })).logs, [3]);
    const B = await go({ logs: [0] });
    assert.deepEqual([B.logs, B.recommended.status, B.text.status, B.recommendations.map(r => [r.id, r.severity])], [[], 'no flight log', 'no flight log', [['F:filters', 'check']]]);
});

test('round 3 M3, M4: the issues of the overview (one for each check and axis, ranked) and the logs with no data that the app can read', async () => {
    const S = sim(), R = await worker({ 'health_phase.cjs': STUB_PHASE }).result({ cmd: 'analyseFile', fileName: 'sim.bbl', selectedLog: 1, options: { flightRpm: TRUTH.rpm, cliText: CLI, curves: false } }, S.bytes);
    assert.ok(R.issues.length > 3, J(R.issues.map(x => x.key)));
    assert.deepEqual(R.issues.map(x => x.rank), R.issues.map((_, i) => i + 1));
    assert.equal(new Set(R.issues.map(x => x.key)).size, R.issues.length, 'one issue for each check and axis');
    const fids = new Set(R.findings.map(f => f.fid));
    for (const x of R.issues) { assert.ok(['problem', 'monitor'].includes(x.status) && x.fids.length === x.count && x.fids.every(id => fids.has(id)), x.key);
        assert.ok(x.fids.every(id => { const f = R.findings.find(q => q.fid === id); return f.id === x.id && ['problem', 'monitor'].includes(f.status); }), x.key);
        assert.ok(typeof x.title === 'string' && x.title && typeof x.summary === 'string' && /\.$/.test(x.summary), x.key); }
    assert.ok(R.issues.every((x, i) => !i || R.issues[i - 1].status === 'problem' || x.status === 'monitor'), 'the problems first');
    assert.deepEqual(R.top, R.issues.slice(0, 3).map(x => x.key));
    for (const [a, A] of Object.entries(R.areas)) assert.equal(A.status, R.issues.some(x => x.area === a && x.status === 'problem' && !x.small) ? 'problem' : 'monitor', a);
    // M4: logs 2 (it does not parse) and 6 (no headspeed): each record has noData with the reason of the decoder
    assert.deepEqual(R.noData, [{ log: 2, reason: 'parser: Log truncated, no data' }, { log: 6, reason: 'log lacks setpoint, gyro, mixer, PID or headspeed fields' }].filter(x => R.noData.some(y => y.log === x.log)).sort((a, b) => a.log - b.log));
    assert.deepEqual(R.noData.map(x => x.log), [2, 6]);
    assert.ok(R.records.filter(l => l.log === 2 || l.log === 6).every(l => l.noData === true && typeof l.noDataReason === 'string' && l.noDataReason === l.skipped));
    assert.ok(R.records.filter(l => l.log !== 2 && l.log !== 6).every(l => l.noData === undefined));
    assert.ok(R.notes.includes('Log 3 has no data that the app can read ("parser: Log truncated, no data"). The app does not use this log.'), R.notes.join('\n'));
});

// ---------------------------------------------------------------------------------------------
// The notch orders of the log (gearPlan, 2026-10-06): the log header has no gear ratio. Without a CLI dump, filter_tune.cjs
// tailOrder finds the order of the tail rotor notch filters that the firmware uses, from the dip in |gyroADC / gyroRAW|. The
// checks (health_setup F5, F6, F8, F9), the notch markers of the curves and advice get it as ctx.gear (basis 'log notch')
// ---------------------------------------------------------------------------------------------

// A bench run and three flights of 50 s whose gyroADC is the filter replica of filter_tune.cjs (runChain, RPM notches only; the
// fixture logs at its filter rate: looptime 500 us, denominators 2) of the logged gyroRAW, with the tail rotor notch at the
// configured 61/15 = 4.0667 x the rotor speed (preset 1: source 21 on every axis). The sim CLI dump gives 19,77 (4.0526). tail2:
// a line of that amplitude (deg/s) at tail rotor harmonic 2 (2 x 61/15) in gyroRAW, which no notch filter follows; side: in the
// last flight, a line at 2 x 61/15 + 1 (a resonance 1 x rotor from that harmonic, as 9.12 x on the Gaui X4)
const GEAR_TRUTH = { main: [1, 1], tail: [15, 61], motorisedTail: false };
const simGear = (() => { const v = {}; return (tail2 = 0, side = 0) => v[`${tail2}|${side}`] || (v[`${tail2}|${side}`] = (() => {
    const FT = require(path.join(TK, 'filter_tune.cjs'));
    const notched = (l, k) => { const w = l.w, n = w.n, raw = [0, 1, 2].map(a => w.extra[`gyroRAW[${a}]`]), s = k === 2 ? side : 0;
        if (tail2 || s) { let th = 0; for (let i = 0; i < n; i++) { th += w.hs[i] / 60 / 1000;
            for (let a = 0; a < 3; a++) raw[a][i] = Math.round(raw[a][i] + tail2 * Math.sin(2 * Math.PI * 2 * 61 / 15 * th + a) + s * Math.sin(2 * Math.PI * (2 * 61 / 15 + 1) * th + 2 * a)); } }
        const M = FT.compile(FT.config(Object.assign({}, l.header, { looptime: 500, pid_process_denom: 2 }), { gear: GEAR_TRUTH, actualRate: 1000 }));
        w.gyro = FT.runChain(M, { n, raw, hs: w.hs, tail: null }, 'rpm').y.map(c => Float64Array.from(c, Math.round));
        return l; };
    const logs = [bbl.simulateFlight({ seconds: 8, seed: 2, airborne: null, start: '2026-10-04T12:00:00.000+00:00' })]
        .concat([[31, '12:10'], [32, '12:20'], [33, '12:30']].map(([seed, t], k) => notched(bbl.simulateFlight({ seconds: 50, seed, airborne: [6, 46], start: `2026-10-04T${t}:00.000+00:00` }), k)));
    const bytes = bbl.encode(logs).bytes, buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length), at = []; for (let i = buf.indexOf(MARKER); i >= 0; i = buf.indexOf(MARKER, i + 1)) at.push(i);
    return { bytes, slice: (li) => bytes.subarray(at[li], li + 1 < at.length ? at[li + 1] : bytes.length), count: at.length };
})()); })();
const fitOf = (N) => N && JSON.parse(J(Object.assign({}, N, { ms: null })));

test('notch orders of the log: without a CLI dump, the tail rotor notch order of the log reaches F5, F6, F9, the notch markers and advice; a dump, the CLI\'s view and logGear false do not run the fit', async () => {
    const G = simGear(), W = worker(), T = 61 / 15;
    const run = (options) => W.result({ cmd: 'analyseFile', fileName: 'gear.bbl', selectedLog: 1, options: Object.assign({ flightRpm: null, keepMetrics: true }, options) }, G.bytes);
    const R = await run({}), N = R.notchFit;
    assert.ok(N && N.used === true && J(N.logs) === J([1, 2, 3]) && N.motor === null, J(N));
    assert.ok(N.tail.passed && N.tail.unit === 'flight' && N.tail.n === 3 && N.tail.axis === 'yaw' && J(N.tail.sources) === J([21]) && N.tail.Q === 5, J(N.tail));
    within(N.tail.order, T, 0.002, 'the tail rotor notch order of the log (61/15)');
    assert.ok(N.tail.seUnits < 0.002 && N.tail.se < 0.005 && N.tail.overlap === false && N.tail.depthDb <= -10, J(N.tail)); // se: with 0.1 % of the order for the time base
    assert.ok(R.notes.includes(`In the log, the tail rotor notch filter is at ${N.tail.order} ± ${N.tail.se} x the rotor frequency (yaw axis, 3 flight logs). `
        + `At this frequency, the filters decrease the gyro signal by ${Math.round(-N.tail.depthDb)} dB. The checks of the notch filters and the vibration plots use this value.`), R.notes.join('\n'));
    // health_setup: the order with its basis, F6 measures source 21, F9 knows every frequency, the 4.061 x line has a notch filter (F5)
    const flown = R.records.filter(l => l.logClass === 'flight');
    assert.ok(flown.length === 3 && flown.every(l => l.metrics.setup.F5.gear === 'log notch' && l.metrics.setup.setup.rpm.banks.yaw.find(b => b.code === 21).order === N.tail.order), J(flown.map(l => l.metrics.setup.F5.gear)));
    const f6 = R.findings.filter(f => f.id === 'F6');
    assert.ok(f6.length && !f6.some(f => f.severity === 'skipped' || f.status === 'notMeasured'), J(f6.filter(f => f.severity === 'skipped').map(f => f.text)));
    assert.ok(f6.some(f => f.text.startsWith(`yaw notch 21 (tail rotor 1, ${N.tail.order} x rotor`) && f.status === 'satisfactory'), J(f6.map(f => f.text)));
    assert.ok(R.findings.filter(f => f.id === 'F9').every(f => f.status === 'satisfactory' && !/unknown frequency/.test(f.text)), 'F9');
    assert.ok(R.findings.filter(f => f.id === 'F5').every(f => f.severity !== 'flag'), J(R.findings.filter(f => f.id === 'F5').map(f => f.text)));
    assert.ok(!R.advice.recommendations.some(r => /^F[5689]/.test(r.id)), J(R.advice.recommendations.map(r => r.id)));
    // the notch markers of the curves of the log on screen (the Tuning view, the log lens): the tail rotor notch has its frequency
    const yaw = R.curves[0].more.vib.notches.yaw.find(q => q.code === 21);
    assert.ok(yaw.order === N.tail.order && yaw.hz > 150 && yaw.hz < 180, J(yaw));
    // no first pass for the flight rpm or the configurations: analyseFile runs one for the fit, with the same result
    sameJson(fitOf((await run({ flightRpm: TRUTH.rpm, datasets: false })).notchFit), fitOf(N), 'a user flight rpm and no configurations');
    // logGear false: today's results, the order unknown
    const O = await run({ logGear: false });
    assert.equal(O.notchFit, null);
    assert.ok(O.findings.some(f => f.id === 'F6' && f.severity === 'skipped' && /^yaw source 21 \(tail rotor\): order unknown/.test(f.text)), 'F6 not measured');
    assert.ok(O.findings.some(f => f.id === 'F9' && f.status === 'monitor') && O.records.filter(l => l.logClass === 'flight').every(l => l.metrics.setup.F5.gear === null), 'F9, no gear');
    assert.ok(!O.notes.some(t => /notch filter is at|not sufficient to find/.test(t)), O.notes.join('\n'));
    // a CLI dump gives the gear ratios (a diff: its absent keys are the default 1,1): no fit, the dump's order
    const C = await run({ cliText: CLI, cliName: TRUTH.cliName });
    assert.equal(C.notchFit, null);
    assert.ok(C.records.filter(l => l.logClass === 'flight').every(l => /^cli/.test(l.metrics.setup.F5.gear) && Math.abs(l.metrics.setup.setup.rpm.banks.yaw.find(b => b.code === 21).order - 77 / 19) < 1e-9), 'the order of the dump');
    // the CLI's view (health.cjs parity: no phases, no exclusions): no fit
    assert.equal((await run({ phases: false, excludeAbnormal: false, datasets: false })).notchFit, null);
    // log scope: one flight of 50 s gives 2 periods of 30 s, so the fit does not pass and changes nothing; the note gives the cause
    const L = await W.result({ cmd: 'analyseLog', fileName: 'gear.bbl', logIndex: 1, logCount: G.count, options: { flightRpm: null } }, G.slice(1));
    assert.ok(L.notchFit && !L.notchFit.used && L.notchFit.tail.unit === 'block' && L.notchFit.tail.n === 2 && L.notchFit.tail.reasons[0].code === 'too few units', J(L.notchFit));
    within(L.notchFit.tail.order, T, 0.002, 'log scope: the order of the two periods');
    assert.ok(L.notes.includes('The data in the log is not sufficient to find the tail rotor notch filter. The log has only 2 periods of 30 s of flight with sufficient data, and 3 or more are necessary. Thus, the frequency of the tail rotor notch filters is unknown.'), L.notes.join('\n'));
    assert.ok(L.findings.some(f => f.id === 'F6' && f.severity === 'skipped'), 'a fit that does not pass: F6 as before');
});

test('notch orders of the log: a line at a tail rotor harmonic gets an RPM notch filter with source 20 + k (advice F5), not the words of a resonance', async () => {
    const G = simGear(10), W = worker(), run = (options, g = G) => W.result({ cmd: 'analyseFile', fileName: 'gear2.bbl', selectedLog: 1, options: Object.assign({ flightRpm: null }, options) }, g.bytes);
    const R = await run({});
    assert.ok(R.notchFit.used, J(R.notchFit));
    const f5 = R.findings.filter(f => f.id === 'F5' && f.severity === 'flag');
    assert.ok(f5.length === 3 && f5.every(f => /^line at 8\.13\d* x rotor/.test(f.text)), J(f5.map(f => f.text)));
    const r = R.advice.recommendations.find(x => x.id === 'F5');
    assert.deepEqual([r.severity, r.title], ['action', 'RPM notch filter at tail rotor harmonic 2']);
    assert.match(r.text, /is at `8\.13\d* × rotor` \([\d.]+ Hz, prominence [\d.]+, log \d, PID profile unknown\), tail rotor harmonic 2\. The gear ratios in the configuration are correct\./);
    assert.match(r.text, /\nAdd an RPM notch filter with source 22 and Q 4\.0 \(FILT\) on the roll, pitch and yaw axes\.$/);
    assert.match(r.rule, /RPM notch filters follow the main rotor harmonics 1 to 8 and the tail rotor harmonics 1 to 8\./);
    assert.ok(!/resonance/i.test(`${r.title} ${r.text} ${r.caveats.join(' ')}`), r.text);
    assert.ok(r.caveats.includes('The gyro filters let 100 % to 100 % of tail rotor harmonic 2 through.'), J(r.caveats));
    // without the orders of the log, the same line is a check: the log does not give the frequency of the tail rotor notch filter
    const O = await run({ logGear: false }), o = O.advice.recommendations.find(x => x.id === 'F5');
    assert.equal(o.severity, 'check'); assert.match(o.text, /The log does not record the frequency of the tail rotor notch filters\./);
    // a resonance 1 x rotor from the harmonic (the strongest line of the last flight): the harmonic is not a part of it
    const S = await run({}, simGear(10, 25)), rs = S.advice.recommendations.find(x => /^Resonance at /.test(x.title)), th = S.advice.recommendations.find(x => /tail rotor harmonic 2/.test(x.title));
    assert.ok(rs && th && th.severity === 'action', J(S.advice.recommendations.map(x => [x.id, x.title])));
    assert.match(rs.text, /is at `9\.13\d* × rotor` .*It is not a main rotor harmonic or a tail rotor harmonic \(the nearest tail rotor harmonic is harmonic 2, at `8\.13\d* × rotor`, 1[0-9]\.\d % from the line\)/);
    assert.ok(!rs.caveats.some(t => /`8\.1\d × rotor`.* 1 × rotor from this resonance/.test(t)), J(rs.caveats));
});

// ---------------------------------------------------------------------------------------------
// Values that are possibly not current (CLAUDE.md): param_epochs.cjs on each analysed log, result.epochs, result.freshness, f.stale,
// r.stale, the stale of the limits periods and of the issues; a CLI dump that disagrees with the log (result.cliStatus)
// ---------------------------------------------------------------------------------------------

// log 0: armed in PID profile 1 (2300 rpm), disarmed at 3 s (the arm switch off at 2.99 s, DISARM at 3 s), armed again at 4 s (the
// switch on) in the grace period: the same log, no new header; flight from 8 to 36 s. Log 1: armed in PID profile 2 (2500 rpm, which no
// change shows: unknown), then PID profile 1 (2300 rpm) from 14 s: the change that shows 2300 rpm for PID profile 1
const ARM = 1, EVT = bbl.EV;
const rearmFile = (() => { let v = null; return () => v || (v = (() => {
    const a = hsFlight(41, 40, [[0, 1]], '18:00'), b = hsFlight(42, 34, [[0, 2], [14, 1]], '18:10');
    a.events = [[2990, EVT.FLIGHT_MODE, { newFlags: 0, lastFlags: ARM }], [3000, EVT.DISARM, { reason: 4 }], [4000, EVT.FLIGHT_MODE, { newFlags: ARM, lastFlags: 0 }]];
    return bbl.encode([a, b]).bytes;
})()); })();
const spansOf = (R, log) => R.epochs.find(e => e.log === log).spans;
const brief = (R, log) => spansOf(R, log).map(q => [Math.round(q.t0 * 10) / 10, Math.round(q.t1 * 10) / 10, q.arm, q.armed, q.pidProfile, q.reasons.join(), q.source.pid, q.source.rate]);
const FRESHNESS = {
    caveat: 'The log does not record a change that the transmitter or the Configurator makes after the pilot arms the helicopter.',
    reasons: ['grace', 'rearm', 'switched', 'unlogged', 'adjusted', 'resume'] };
// the check of f reads a value of a PID profile (js/tuning_worker.js READS, datasets.cjs scopeOf): true, false, or null (not in READS: every cause)
const DSM = require('../tools/autotune/datasets.cjs');
const readsProfile = (W, f) => { const l = W.ctx.TuningWorker.READS[f.id]; if (!l) return null;
    return l.some(n => n.charAt(0) === '@' ? n === '@profile' : DSM.scopeOf(n.replace('{ax}', f.axis || 'roll')) === 'profile'); };

test('values that are possibly not current: a re-arm in the grace period, a PID profile switch and its source, f.stale, r.stale and the limits periods', async () => {
    const W = worker(), R = await W.result({ cmd: 'analyseFile', fileName: 'rearm.bbl', selectedLog: 0, options: { flightRpm: 1900 } }, rearmFile());
    assert.deepEqual(R.profiles.arming.map(q => [q.log, q.profile, q.basis]), [[0, 1, ['headspeed']], [1, 0, []]]);
    // log 0: arm 0 to the disarm at 3 s, the grace period to the arm at 4 s, arm 1 to the end; the source of the values is the header
    assert.deepEqual(brief(R, 0), [[0, 3, 0, true, 1, '', 'header', 'header'], [3, 4, 0, false, 1, 'grace', 'header', 'header'], [4, 40, 1, true, 1, 'rearm', 'header', 'header']]);
    assert.deepEqual(spansOf(R, 0).map(q => [q.fresh, q.text]), [[true, ''],
        [false, 'The pilot disarmed the helicopter at 3 s, and the log does not record a change in this part. The app uses the values of the log header of log 1.'],
        [false, 'The pilot armed the helicopter again at 4 s, and the log header has the values of the first arm only. The app uses the values of the log header of log 1.']]);
    // log 1: armed in an unknown PID profile, then PID profile 1 from 14 s, whose values the header of log 0 (armed in PID profile 1) has
    assert.deepEqual(brief(R, 1), [[0, 14, 0, true, 0, '', 'header', 'header'], [14, 34, 0, true, 1, 'switched', 'log 0', 'header']]);
    assert.equal(spansOf(R, 1)[1].text, 'This part flies PID profile 1, and the log header has the values of the PID profile at the start of the log. ' +
        'For PID profile 1, the app uses the values of the log header of log 1. For the other values, the app uses the log header of log 2.');
    assert.deepEqual([R.freshness.caveat, Object.keys(R.freshness.reasons)], [FRESHNESS.caveat, FRESHNESS.reasons]);
    assert.equal(R.cliStatus, null, 'no CLI dump: no status');
    // f.stale: every result of log 0 that measures the flight (8 to 36 s) is after the re-arm; in log 1, the results of PID profile 1 are
    // in the switched part, and those of the start (label 0, PID profile unknown) are not. A check of the log itself has none
    const of = (log) => R.findings.filter(f => logsOf(f).length === 1 && logsOf(f)[0] === log && !/^(D1|D2|D3|D6|D7|H)$/.test(f.id));
    const flight0 = of(0).filter(f => J(f.phases) === J(['flight']) && !(f.events && f.events.length));
    assert.ok(flight0.length > 10 && flight0.every(f => f.stale && J(f.stale.reasons) === J(['rearm']) && f.stale.spans.length === 1 && f.stale.spans[0].log === 0 && f.stale.spans[0].t0 === 4), J(flight0.map(f => [f.fid, f.stale])));
    assert.equal(flight0[0].stale.text, 'This result uses a part of the log in which the values are possibly not the values of the log header. The cause is a second arm in the same log. ' +
        'The app uses the values of the log header of log 1.');
    assert.equal(flight0[0].stale.source, 'The app uses the values of the log header of log 1.', 'the source of the values (CLAUDE.md: each flag gives it, or "unknown")');
    // a PID profile change applies only to a check that reads a value of a PID profile (CLAUDE.md: use only the causes that can change the
    // value, READS): the global checks of PID profile 1 (filters, battery, motor_poles) have no flag
    const p1 = of(1).filter(f => f.pidProfile === 1), start = of(1).filter(f => f.pidProfile === null && f.profile === 0);
    const p1p = p1.filter(f => readsProfile(W, f) !== false), p1g = p1.filter(f => readsProfile(W, f) === false);
    assert.ok(p1p.length > 5 && p1p.every(f => f.stale && J(f.stale.reasons) === J(['switched'])), J(p1p.map(f => [f.fid, f.stale])));
    assert.ok(p1g.length && p1g.every(f => f.stale === null), J(p1g.map(f => [f.fid, f.stale])));
    assert.ok(p1p.filter(f => !(f.events && f.events.length)).every(f => /For PID profile 1, the app uses the values of the log header of log 1\. For the other values, the app uses the log header of log 2\.$/.test(f.stale.text)), J(p1p.map(f => f.stale.text)));
    assert.ok(start.length > 5 && start.every(f => f.stale === null), J(start.map(f => [f.fid, f.stale])));
    assert.ok(R.findings.filter(f => /^(D1|D2|D3|D6|D7|H)$/.test(f.id)).every(f => f.stale === null), 'a check of the log itself');
    assert.ok(R.findings.every(f => 'stale' in f), 'stale on every finding');
    // the periods of the limits checks (frame seconds): each with its own stale
    const periods = R.findings.filter(f => f.module === 'limits' && Array.isArray(f.events) && f.events.length).flatMap(f => f.events.map(e => [logsOf(f)[0], e, f]));
    if (has('health_limits.cjs')) assert.ok(periods.length, 'the fixture has periods at a limit');
    for (const [log, e, f] of periods) {
        const want = log === 0 ? (e.tS >= 4 ? ['rearm'] : e.tS >= 3 ? ['grace'] : null) : e.pidProfile === 0 || e.tS < 14 ? null : ['switched'];
        if (want && log === 0) assert.deepEqual(e.stale && e.stale.reasons, want, J(e));
        if (log === 1 && e.tS >= 14) assert.deepEqual(e.stale ? e.stale.reasons : null, readsProfile(W, f) !== false ? ['switched'] : null, J([f.id, e]));
        if (log === 1 && e.t1S < 14) assert.equal(e.stale, null, J(e));
        if (e.stale) assert.match(e.stale.text, /^This period is in a part of the log in which the values are possibly not the values of the log header\. /);
    }
    // r.stale: the union over the results that a recommendation cites (by fid), and the issues of the overview
    const byFid = new Map(R.findings.map(f => [f.fid, f]));
    for (const x of R.advice.recommendations) {
        const cited = (x.evidence || []).map(e => e && byFid.get(e.fid)).filter(f => f && f.stale);
        if (!cited.length) { assert.equal(x.stale, null, x.id); continue; }
        assert.deepEqual(x.stale.reasons, FRESHNESS.reasons.filter(k => cited.some(f => f.stale.reasons.includes(k))), x.id);
        assert.equal(x.stale.findings, cited.length);
        assert.match(x.stale.text, /^\d+ results? of this recommendation uses? a part of the log in which the values are possibly not the values of the log header\. The causes? (is|are) .* (The app uses the values of the log header of log \d\.|For PID profile \d, the app uses the values of the log header of log \d\.)/);
    }
    assert.ok(R.advice.recommendations.some(x => x.stale), 'a recommendation from a stale result');
    assert.ok(R.issues.every(x => 'stale' in x) && R.issues.some(x => x.stale && /of this item/.test(x.stale.text)), J(R.issues.map(x => [x.key, x.stale])));
});

test('values that are possibly not current: the source of a switched PID profile (another log, unknown), a rate profile switch, an in-flight adjustment and a govRequest change with no event', async () => {
    const W = worker(), file = (bytes, o) => W.result({ cmd: 'analyseFile', fileName: 'hs.bbl', selectedLog: 0, options: Object.assign({ flightRpm: 1900, curves: false }, o) }, bytes);
    // hsFile log 1: PID profile 1 (2300 rpm), 3 from 14 s, 1 from 24 s. Log 2 starts in PID profile 3: the configurations give its header as
    // the source of PID profile 3. Back in PID profile 1 (the start), the values are the header's again
    const R = await file(hsFile(), {});
    assert.deepEqual(brief(R, 1).map(q => q.slice(4)), [[1, '', 'header', 'header'], [3, 'switched', 'log 2', 'header'], [1, '', 'header', 'header']]);
    assert.equal(spansOf(R, 1)[1].text, 'This part flies PID profile 3, and the log header has the values of PID profile 1. For PID profile 3, the app uses the values of the log header of log 3. ' +
        'For the other values, the app uses the log header of log 2.');
    assert.deepEqual(R.epochs.map(e => e.log), [0, 1, 2, 3], 'every analysed log, the bench run too');
    // without the configurations, no source of PID profile 3: unknown
    const N = await file(hsFile(), { datasets: false });
    assert.deepEqual(brief(N, 1)[1].slice(4), [3, 'switched', 'none', 'header']);
    assert.match(spansOf(N, 1)[1].text, / The values of PID profile 3 are unknown\. For the other values, the app uses the log header of log 2\.$/);
    // hsFile2 log 2: govRequest goes from 2300 to 2500 rpm at 15 s with no PID profile change in the log
    const U = await file(hsFile2().rules, {}), u = spansOf(U, 2);
    assert.deepEqual(u.map(q => q.reasons.join()), ['', 'unlogged']); within(u[1].t0, 15, 0.01, 'the end of the step');
    assert.equal(u[1].text, 'At 15 s, "govRequest" changes from 2300 rpm to 2500 rpm with no PID profile change in the log. The app uses the values of the log header of log 3.');
    // a rate profile change at 20 s and an in-flight adjustment of the roll P gain at 25 s (a value of the PID profile)
    const flight = bbl.simulateFlight({ seconds: 40, seed: 17, airborne: [6, 36], start: '2026-10-04T15:00:00.000+00:00', rateProfiles: [{ from: 0, profile: 1 }, { from: 20, profile: 3 }], adjustments: [[25, 18, 55]] });
    const A = await worker(NO_PHASE).result({ cmd: 'analyseLog', fileName: 'rates.bbl', logIndex: 0, options: { flightRpm: TRUTH.rpm, curves: false } }, bbl.encode([flight]).bytes);
    const a = spansOf(A, 0);
    assert.deepEqual(brief(A, 0).map(q => [q[0], q[1], q[5], q[6], q[7]]), [[0, 20, '', 'header', 'header'], [20, 25, 'switched', 'header', 'none'], [25, 40, 'switched,adjusted', 'adjustment', 'none']]);
    assert.deepEqual([a[1].rateProfile, a[2].adjust.map(q => [q.func, q.name, q.value])], [3, [[18, 'Roll P-gain', 55]]]);
    assert.equal(a[2].text, 'This part uses rate profile 3, and the log header has the values of the rate profile at the start of the log. ' +
        'An in-flight adjustment changed "Roll P-gain" to 55 at 25 s, and the log header has the value before this change. ' +
        'The values of rate profile 3 are unknown. For the values that an in-flight adjustment changed, the app uses the values of the log. For the other values, the app uses the log header of log 1.');
});

test('a CLI dump that disagrees with the log: the log wins, a PID profile that the headspeed confirms stays confirmed, and result.cliStatus has the conflicts', async () => {
    // the dump of an older configuration: gov_headspeed 1800 in every section (the Fireball dump of 2026-09-04 against the logs of 2026-10-05)
    const old = '# diff all\n# Rotorflight / STM32F7X2 (S7X2) 4.6.0 Jun 30 2026 / 07:20:47 (118e912) MSP API: 12.08\nprofile 0\nset gov_headspeed = 1800\nprofile 1\nset gov_headspeed = 1800\nprofile 2\nset gov_headspeed = 1800\nprofile 0\n';
    const W = worker(), run = (o) => W.result({ cmd: 'analyseFile', fileName: 'hs.bbl', selectedLog: 0, options: Object.assign({ flightRpm: 1900, curves: false }, o) }, hsFile());
    const R = await run({}), D = await run({ cliText: old, cliName: 'old.txt' });
    assert.deepEqual(D.profiles.arming.map(q => [q.log, q.profile, q.basis, q.confirmed]), R.profiles.arming.map(q => [q.log, q.profile, q.basis, q.confirmed]));
    assert.deepEqual(D.profiles.arming.map(q => q.profile), [2, 1, 3]);
    const hs = D.cliStatus.conflicts.filter(c => c.what === 'gov_headspeed');
    assert.deepEqual(hs.map(c => [c.profile, c.cli, c.log]), [[1, 1800, [2300]], [2, 1800, [2500]], [3, 1800, [2700]]]);
    assert.equal(hs[0].text, 'In the CLI dump, `gov_headspeed` of `profile 0` is 1800. The PID profile changes in this file show 2300 rpm for PID profile 1. The app uses the values of the log.');
    assert.equal(D.cliStatus.name, 'old.txt');
    assert.ok(D.notes.includes('The CLI dump "old.txt" does not agree with the log. The app uses the values of the log.'), D.notes.join('\n'));
    assert.ok(!D.notes.some(n => /PID profile unknown|start of the log is unknown/.test(n)), D.notes.join('\n'));
    const f0 = D.findings.filter(f => logsOf(f).length === 1 && logsOf(f)[0] === 0 && f.profile === 0 && !['D4', 'F4', 'H'].includes(f.id));
    assert.ok(f0.length && f0.every(f => f.pidProfile === 2), J(f0.map(f => [f.fid, f.pidProfile])));
    // the same dump with the headspeeds of the log: no gov_headspeed conflict, and the dump confirms with the log
    const ok = await run({ cliText: old.replace(/1800\nprofile 1/, '2300\nprofile 1').replace(/1800\nprofile 2/, '2500\nprofile 2').replace(/1800\nprofile 0\n$/, '2700\nprofile 0\n') });
    assert.ok(!ok.cliStatus.conflicts.some(c => c.what === 'gov_headspeed'), J(ok.cliStatus));
    assert.deepEqual(ok.profiles.arming.map(q => q.profile), [2, 1, 3]);
});

// ---------------------------------------------------------------------------------------------
// Review of 2026-10-06 (profile-id, freshness): the PID profile at the start of a log with a flight selection, against the log itself and
// the other logs, against a CLI dump; the causes that can change the values that a check reads; the time of a result; the source of
// the values; the stale of the A/B comparisons
// ---------------------------------------------------------------------------------------------

test('D12 (review): a flight selection keeps the PID profile of the whole log; a headspeed that the log, the nearest log or an excluded log contradicts; govRequest that changes and a dump that agrees with no header give no confirmation', async () => {
    const W = worker({ 'advice.cjs': ECHO_LOGS }), run = (bytes, o, sel = 0) => W.result({ cmd: 'analyseFile', fileName: 'r.bbl', selectedLog: sel, options: Object.assign({ flightRpm: 1900, curves: false }, o || {}) }, bytes);
    const arm = (R, l) => R.profiles.arming.find(q => q.log === l);
    // log 0 starts in PID profile 1 (2300 rpm) and changes to PID profile 2 (2500 rpm) at 15 s, with flights at 6-27 s and 36-59 s; log 1 shows
    // PID profile 1 at 2300 rpm. The second flight of log 0 alone: its window starts in PID profile 2, but the header has PID profile 1
    const l0 = hsFlight(51, 64, [[0, 1, 2300], [15, 2, 2500]], '10:00'); for (let i = 28000; i < 36000; i++) l0.airborne[i] = 0;
    const two = bbl.encode([l0, hsFlight(52, 34, [[0, 2, 2500], [12, 1, 2300]], '11:00')]).bytes;
    const whole = await run(two), cut = await run(two, { flights: [{ log: 0, flight: 1 }] });
    assert.ok(cut.selection && cut.selection.windows.length === 1 && cut.selection.windows[0].t0 > 20, J(cut.selection));
    for (const R of [whole, cut]) assert.deepEqual([arm(R, 0).profile, arm(R, 0).basis, arm(R, 0).confirmed], [1, ['headspeed'], true], J(arm(R, 0)));
    assert.equal(JSON.parse(cut.advice.notes[0]).headerProfile, 1, 'advice: the header of log 1 has PID profile 1');
    const sw = (R) => R.findings.filter(f => logsOf(f).length === 1 && logsOf(f)[0] === 0 && f.pidProfile === 2 && readsProfile(W, f));
    assert.ok(sw(cut).length > 3 && sw(cut).every(f => f.stale && f.stale.reasons.includes('switched')), J(sw(cut).map(f => [f.fid, f.stale && f.stale.reasons])));
    assert.ok(spansOf(cut, 0).some(s => s.pidProfile === 2 && s.reasons.includes('switched')), J(spansOf(cut, 0)));
    // the gov_headspeed values changed between the logs (all +200 rpm): log 0 has PID profile 1 at 2300 and 2 at 2500 rpm. Log 1 starts at
    // 2500 rpm in PID profile 1, then goes to 3 (2900 rpm) and to 2 (2700 rpm): the log itself shows PID profile 2 at 2700 rpm, not 2500
    const C = await run(bbl.encode([hsFlight(41, 34, [[0, 1, 2300], [12, 2, 2500], [22, 1, 2300]], '10:00'), hsFlight(42, 34, [[0, 1, 2500], [12, 3, 2900], [22, 2, 2700]], '12:00')]).bytes, {}, 1);
    assert.deepEqual([arm(C, 1).profile, arm(C, 1).confirmed, arm(C, 1).headspeed.why, arm(C, 1).headspeed.values, arm(C, 1).headspeed.own], [0, false, 'contradicted', [2700], true], J(arm(C, 1)));
    assert.equal(JSON.parse(C.advice.notes[0]).headerProfile, 0, 'advice: the header of log 2 has no confirmed PID profile');
    assert.ok(C.notes.some(n => n.startsWith('At the start of the log, "govRequest" is 2500 rpm. The PID profile changes of this file show this value for PID profile 2. But this log shows 2700 rpm for PID profile 2. ') &&
        n.endsWith('Thus, the app cannot find the PID profile at the start of the log. The results of that part show "PID profile unknown" (log 2).')), C.notes.join('\n'));
    // a log with no change at 2500 rpm between them: the nearest logs show PID profile 2 at 2500 and 2700 rpm
    const N = await run(bbl.encode([hsFlight(41, 34, [[0, 1, 2300], [12, 2, 2500], [22, 1, 2300]], '10:00'), hsFlight(43, 30, [[0, 1, 2500]], '11:00'), hsFlight(44, 34, [[0, 1, 2500], [12, 3, 2900], [22, 2, 2700]], '12:00')]).bytes);
    assert.deepEqual([arm(N, 1).profile, arm(N, 1).headspeed.why, arm(N, 1).headspeed.values, arm(N, 1).headspeed.logs], [0, 'contradicted', [2700], [0, 2]], J(arm(N, 1)));
    // log 0 starts at 2500 rpm (PID profile 3) and changes first to PID profile 2 at 2500 rpm: a different PID profile also has 2500 rpm, so
    // log 2 (2500 rpm, no change) is not confirmed as PID profile 2
    const A = await run(bbl.encode([hsFlight(45, 34, [[0, 3, 2500], [12, 2, 2500], [22, 1, 2300]], '10:00'), hsFlight(46, 30, [[0, 1, 2300], [12, 2, 2500]], '11:00'), hsFlight(47, 30, [[0, 3, 2500]], '12:00')]).bytes);
    assert.deepEqual([arm(A, 0).headspeed.why, arm(A, 2).profile, arm(A, 2).headspeed.why, arm(A, 2).headspeed.logs], ['excluded', 0, 'ambiguous', [0]], J(A.profiles.arming));
    assert.ok(A.notes.some(n => n.startsWith('At the start of the log, "govRequest" is 2500 rpm. The PID profile changes of this file show this value for PID profile 2. But log 1 starts at this value, ' +
        'and the first PID profile change goes to PID profile 2. Because a log records only a change of the PID profile, a different PID profile also has this value.')), A.notes.join('\n'));
    // armed in PID profile 1 (2300 rpm); at 8 s the transmitter selects PID profile 2 (2500 rpm) with no event. A current dump that agrees with
    // the log gives 2300 rpm to `profile 0`: govRequest changes before the first change, so neither the dump nor the governor target confirm
    const L = hsFlight(61, 50, [[0, 1, 2300], [8, 2, 2500]], '10:00'); L.profile = new Uint8Array(L.profile.length).fill(1);
    const dump = '# diff all\n# Rotorflight / STM32F7X2 (S7X2) 4.6.0 Jun 30 2026 / 07:20:47 (118e912) MSP API: 12.08\nprofile 0\nset gov_headspeed = 2300\nprofile 1\nset gov_headspeed = 2500\nprofile 0\n';
    const U = await run(bbl.encode([L]).bytes, { cliText: dump });
    assert.deepEqual([arm(U, 0).profile, arm(U, 0).basis, arm(U, 0).confirmed, arm(U, 0).headspeed.why], [0, [], false, 'changes'], J(arm(U, 0)));
    // armed in PID profile 1 at 2300 rpm, no change; an older dump (2100, 2300 and 2500 rpm) agrees with no section of the header: no evidence
    const O = await run(bbl.encode([hsFlight(71, 40, [[0, 1, 2300]], '10:00')]).bytes, { cliText: '# diff all\nprofile 0\nset gov_headspeed = 2100\nset roll_p_gain = 70\nprofile 1\nset gov_headspeed = 2300\nset roll_p_gain = 70\nprofile 2\nset gov_headspeed = 2500\nset roll_p_gain = 70\nprofile 0\n' });
    assert.deepEqual([arm(O, 0).profile, arm(O, 0).basis, arm(O, 0).confirmed, O.cliStatus.used], [0, [], false, false], J([arm(O, 0), O.cliStatus]));
});

test('values that are possibly not current (review): an adjustment counts for its PID profile and its parameter, a configuration for its own time, and a dump that the log contradicts is no source', async () => {
    const W = worker();
    // an adjustment of the roll P gain at 12 s in the PID profile at the start (unknown: it is not PID profile 2, the first logged change),
    // then PID profile 2 from 20 s: the part of PID profile 2 has no adjustment, and its values are unknown (no log header has them)
    const F = await W.result({ cmd: 'analyseLog', fileName: 'adj.bbl', logIndex: 0, options: { flightRpm: 1900, curves: false } },
        bbl.encode([bbl.simulateFlight({ seconds: 40, seed: 17, airborne: [6, 36], start: '2026-10-04T15:00:00.000+00:00', profiles: [{ from: 0, profile: 1, target: 2300 }, { from: 20, profile: 2, target: 2500 }], adjustments: [[12, 18, 55]] })]).bytes);
    const s = spansOf(F, 0);
    assert.deepEqual(brief(F, 0).map(q => [q[0], q[1], q[4], q[5], q[6]]), [[0, 12, 0, '', 'header'], [12, 20, 0, 'adjusted', 'adjustment'], [20, 40, 2, 'switched', 'none']], J(s));
    assert.deepEqual([s[1].adjust.map(a => a.func), s[2].adjust], [[18], []]);
    assert.match(s[2].text, /^This part flies PID profile 2, and the log header has the values of the PID profile at the start of the log\. The values of PID profile 2 are unknown\. For the other values, the app uses the log header of log 1\.$/);
    assert.ok(!/in-flight adjustment/.test(s[2].text), s[2].text);
    // one PID profile, an adjustment of the roll P gain at 25 s: configurations A (0-25 s) and B (25-50 s). A result of A has no flag; a
    // result of B has one only when its check reads the roll P gain
    const G = await W.result({ cmd: 'analyseLog', fileName: 'adj2.bbl', logIndex: 0, options: { flightRpm: 1900, curves: false } },
        bbl.encode([bbl.simulateFlight({ seconds: 50, seed: 19, airborne: [6, 46], start: '2026-10-04T15:10:00.000+00:00', profiles: [{ from: 0, profile: 1, target: 2300 }], adjustments: [[25, 18, 55]] })]).bytes);
    const ids = G.datasets.labels.map(q => q.dataset), byCfg = (d) => G.findings.filter(f => f.dataset === d);
    assert.equal(new Set(ids).size, 2, J(G.datasets.labels));
    const [A, B] = [ids[0], ids[ids.length - 1]], reads = (f) => (W.ctx.TuningWorker.READS[f.id] || ['roll_p_gain']).some(n => n === '{ax}_p_gain' && (!f.axis || f.axis === 'roll') || n === 'roll_p_gain' || n === '@profile');
    assert.ok(byCfg(A).length > 5 && byCfg(A).every(f => !f.stale), J(byCfg(A).filter(f => f.stale).map(f => [f.fid, f.stale.reasons])));
    assert.ok(byCfg(B).filter(reads).length && byCfg(B).filter(reads).every(f => f.stale && J(f.stale.reasons) === J(['adjusted'])), J(byCfg(B).filter(reads).map(f => [f.fid, f.stale])));
    assert.ok(byCfg(B).filter(f => !reads(f) && W.ctx.TuningWorker.READS[f.id]).every(f => !f.stale), J(byCfg(B).filter(f => !reads(f) && f.stale).map(f => [f.fid, f.stale.reasons])));
    // a CLI dump that the log contradicts (gov_headspeed 1800 in every section): not a source of the values of a PID profile
    const old = '# diff all\n# Rotorflight / STM32F7X2 (S7X2) 4.6.0 Jun 30 2026 / 07:20:47 (118e912) MSP API: 12.08\nprofile 0\nset gov_headspeed = 1800\nprofile 1\nset gov_headspeed = 1800\nprofile 2\nset gov_headspeed = 1800\nprofile 0\n';
    const D = await W.result({ cmd: 'analyseFile', fileName: 'cli.bbl', selectedLog: 0, options: { flightRpm: 1900, curves: false, cliText: old } }, bbl.encode([hsFlight(22, 34, [[0, 1], [14, 3], [24, 1]], '13:10')]).bytes);
    assert.equal(D.cliStatus.used, false, J(D.cliStatus));
    assert.ok(spansOf(D, 0).every(q => q.source.pid !== 'cli' && q.source.rate !== 'cli'), J(spansOf(D, 0)));
    assert.ok(D.datasets.labels.every(q => !q.source || (q.source.profile !== 'cli' && q.source.rate !== 'cli')), J(D.datasets.labels));
    assert.ok(spansOf(D, 0).some(q => q.pidProfile === 3 && /The values of PID profile 3 are unknown\./.test(q.text)), J(spansOf(D, 0).map(q => q.text)));
    // the A/B comparisons and each of their results have a stale (null or the union of their results)
    assert.ok(Array.isArray(G.datasets.comparisons) && G.datasets.comparisons.every(c => 'stale' in c && c.results.every(x => 'stale' in x)), J(G.datasets.comparisons));
    // their text names the pair of configurations: STE has no noun "comparison" (the integration run found it on the Fireball file)
    assert.ok(G.datasets.comparisons.every(c => [c, ...c.results].every(x => !x.stale || /^\d+ results? of this pair uses? /.test(x.stale.text))), J(G.datasets.comparisons));
});

test('values that are possibly not current (review): the time that a result measured, in its phases (all of the record when it has none of them) and its configuration', () => {
    const TW = worker().ctx.TuningWorker, T = TW.fresh, plain = (x) => JSON.parse(J(x));
    const rec = { log: 0, fromS: 0, seconds: 10, timeMap: { endS: 10 }, phases: [{ phase: 'idle', t0: 0, t1: 1 }, { phase: 'spoolup', t0: 1, t1: 3 }, { phase: 'flight', t0: 3, t1: 9 }, { phase: 'idle', t0: 9, t1: 10 }] };
    const J0 = { records: [rec], dsFull: { labels: [{ log: 0, t0: 0, t1: 5, dataset: 'A' }, { log: 0, t0: 5, t1: 10, dataset: 'B' }] }, K: {} };
    assert.deepEqual(plain(T.measuredIn(J0, { phases: ['flight'] }, 0)), [[3, 9]]);
    assert.deepEqual(plain(T.measuredIn(J0, { phases: ['ground'] }, 0)), [[0, 10]], 'no ground phase in the record: the whole record');
    assert.deepEqual(plain(T.measuredIn(J0, { phases: ['flight'], dataset: 'A' }, 0)), [[3, 5]], 'cut to the stretches of its configuration');
    assert.deepEqual(plain(T.cutTo([[2, 7], [6, 6], [8, 8]], [[0, 5], [6, 9]])), [[2, 5], [6, 7], [6, 6], [8, 8]]);
    // events in frame seconds (tS, t1S), else module times; the spans of the evidence (frame seconds) of this log
    assert.deepEqual(plain(T.placesIn(J0, { events: [{ tS: 4, t1S: 4.5 }, { t: 6, seconds: 1 }, { log: 1, tS: 2 }], evidence: { spans: [{ log: 0, t0: 7, t1: 9 }, { log: 1, t0: 1, t1: 2 }] } }, 0, true)), [[4, 4.5], [6, 7], [7, 9]]);
    // what a check reads: a check of the log itself reads nothing; a global check has no PID profile cause; an adjustment counts for its parameter
    const R = (id, axis) => T.readsOf({ K: { datasets: DSM } }, id, axis);
    assert.deepEqual([R('D4', null), R('H', null)].map(x => x.none), [true, true]);
    const meta = (reasons, o) => Object.assign({ span: { reasons }, pidSw: true, rateSw: false, adj: [] }, o);
    assert.deepEqual(plain(T.reasonsFor(meta(['rearm', 'switched', 'unlogged']), R('F6', null))), ['rearm']);
    assert.deepEqual(plain(T.reasonsFor(meta(['switched', 'unlogged']), R('C12', 'roll'))), ['switched', 'unlogged']);
    const adj = meta(['adjusted'], { pidSw: false, adj: [{ param: 'roll_p_gain', scope: 'profile' }] });
    assert.deepEqual([R('C12', 'roll'), R('C12', 'yaw'), R('G12', null)].map(x => plain(T.reasonsFor(adj, x))), [['adjusted'], [], []]);
});
