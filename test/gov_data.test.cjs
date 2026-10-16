'use strict';

// Tests of tools/autotune/gov_data.cjs: the governor run objects (docs/GOVERNOR_AUTOTUNE.md section 2) from named columns, from a
// whole-log segment of lib.segments (the worker path, runOf), and from a dev data directory (flight runs, bench runs on request);
// missing fields give null and a reason.
//
//   node --test test/gov_data.test.cjs
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GD = require(path.resolve(__dirname, '../tools/autotune/gov_data.cjs'));

// a synthetic segment of n samples at 1 kHz: columns as the extracted data have them ('time' in s from the start)
function columns(n, o = {}) {
    const c = { profileAt: new Uint8Array(n), airborneAt: new Uint8Array(n), govStateAt: new Uint8Array(n), rescueAt: new Uint8Array(n), hs: new Float64Array(n), time: new Float64Array(n) };
    for (const k of ['govP', 'govI', 'govD', 'govF', 'govSum', 'govTarget', 'govRequest', 'motor[0]', 'rcCommand[4]', 'mixer[0]', 'mixer[1]', 'mixer[2]', 'mixer[3]', 'Vbat', 'Ibat', 'vario', 'flightModeFlags']) c[k] = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        const on = i >= n / 4;
        c.time[i] = i * 0.001006; c.hs[i] = on ? 3000 + i % 7 : 0; c.govStateAt[i] = on ? 4 : 1; c.profileAt[i] = i < n / 2 ? 0 : 2; c.airborneAt[i] = on ? 1 : 0;
        c['motor[0]'][i] = on ? 700 + i % 5 : 0; c['rcCommand[4]'][i] = on ? 1000 : 509; c.govRequest[i] = 3500; c.govTarget[i] = on ? 3500 : 0;
        c.govP[i] = i % 11 - 5; c.govI[i] = 650; c.govF[i] = 30; c.govSum[i] = c.govP[i] + 680; c.govD[i] = 0;
        ['mixer[0]', 'mixer[1]', 'mixer[2]', 'mixer[3]'].forEach((k, j) => { c[k][i] = (j + 1) * 37 * Math.sin(i / 50 + j); });
        c.Vbat[i] = 2480 - i / 100; c.Ibat[i] = on ? 4200 : 0; c.vario[i] = 12; c.flightModeFlags[i] = 1;
    }
    return Object.assign(c, o);
}
const META = { log: 7, segment: 0, name: 'log07_0', file: 'test.bbl', craft: 'Test', n: 0, rate: 1000, actualRate: 994, fromS: 1.5, timeStartUs: 5000000,
    header: { govPID: [18, 60, 2, 32, 55], looptime: 500, pid_process_denom: 2, yaw_tta: [0, 20] } };
const meta = (n, o = {}) => Object.assign({}, META, { n }, o);
const PH = (n) => ({ class: 'flight', flights: [{ i0: n / 2, i1: n - 10, t0: 1, t1: 2, seconds: 1 }], code: Uint8Array.from({ length: n }, (_, i) => i < n / 4 ? 0 : i < n / 2 ? 2 : 3) });

test('columns give a run in the units of section 2', () => {
    const n = 400, run = GD.fromColumns(columns(n), meta(n), PH(n));
    assert.equal(run.log, 7); assert.equal(run.n, n); assert.equal(run.rate, 1000); assert.equal(run.pidHz, 1000); assert.equal(run.loopsPerFrame, 1);
    assert.equal(run.t0Us, 5000000); assert.equal(run.class, 'flight'); assert.equal(run.phase[n - 1], 3); assert.deepEqual(run.flights[0], { i0: 200, i1: 390, t0: 1, t1: 2 });
    assert.ok(Math.abs(run.u[n - 1] - (700 + (n - 1) % 5) / 1000) < 1e-6);
    assert.ok(Math.abs(run.thr[0] - 0.509) < 1e-6);
    assert.ok(Math.abs(run.coll[10] - 4 * 37 * Math.sin(10 / 50 + 3) / 1000) < 1e-6);
    assert.ok(Math.abs(run.vbat[0] - 24.8) < 1e-5);
    assert.ok(Math.abs(run.ibat[n - 1] - 42) < 1e-5);
    assert.ok(Math.abs(run.govI[0] - 0.65) < 1e-6); assert.equal(run.request[0], 3500); assert.equal(run.target[n - 1], 3500);
    assert.ok(Math.abs(run.vario[0] - 0.12) < 1e-6);
    assert.equal(run.state[n - 1], 4); assert.equal(run.profile[n - 1], 2); assert.equal(run.armed[0], 1);
    assert.ok(Math.abs(run.time[1] - 0.001006) < 1e-12);
    assert.ok(run.hasVoltage && run.hasCurrent && run.hasGovernor);
    assert.deepEqual(run.reasons, []);
    assert.ok(run.time instanceof Float64Array && run.hs instanceof Float32Array);
});

test('the PID rate comes from the header: 2 kHz logged at 1 kHz gives two loops per frame', () => {
    const n = 100, run = GD.fromColumns(columns(n), meta(n, { header: { looptime: 250, pid_process_denom: 2 } }), null);
    assert.equal(run.pidHz, 2000); assert.equal(run.loopsPerFrame, 2);
    assert.equal(run.class, null); assert.equal(run.phase, null);
});

test('a missing, zero or rare field gives null and a reason, never an exception', () => {
    const n = 400;
    const noV = GD.fromColumns(columns(n, { Vbat: undefined }), meta(n), null);
    assert.equal(noV.vbat, null); assert.equal(noV.hasVoltage, false); assert.ok(noV.reasons.includes(GD.TEXT.noVbat));
    const zeroV = GD.fromColumns(columns(n, { Vbat: new Float64Array(n) }), meta(n), null);
    assert.equal(zeroV.vbat, null);
    // Ibat non-zero in less than half of the motor-running samples: the Fireball ESC has no current sensor
    const rare = columns(n); for (let i = 0; i < n; i++) rare.Ibat[i] = i % 3 === 0 ? 100 : 0;
    const noI = GD.fromColumns(rare, meta(n), null);
    assert.equal(noI.ibat, null); assert.equal(noI.hasCurrent, false); assert.ok(noI.reasons.includes(GD.TEXT.noIbat));
    const half = columns(n); for (let i = 0; i < n; i++) half.Ibat[i] = i % 2 === 0 ? 100 : 0;
    assert.ok(GD.fromColumns(half, meta(n), null).ibat);
    // without motor[0], the rule counts every sample: Ibat all 0 is no current
    const noMotor = GD.fromColumns(columns(n, { 'motor[0]': undefined, Ibat: new Float64Array(n) }), meta(n), null);
    assert.equal(noMotor.ibat, null); assert.equal(noMotor.hasCurrent, false);
    const noGov = GD.fromColumns(columns(n, { govP: undefined, govRequest: undefined, govStateAt: undefined }), meta(n), null);
    assert.equal(noGov.govP, null); assert.equal(noGov.request, null); assert.equal(noGov.state, null); assert.equal(noGov.hasGovernor, false);
    assert.ok(noGov.reasons.includes(GD.TEXT.noGov) && noGov.reasons.includes(GD.TEXT.noState));
    const bare = GD.fromColumns({ hs: new Float64Array(n) }, meta(n, { header: {} }), null);
    assert.equal(bare.u, null); assert.equal(bare.thr, null); assert.equal(bare.coll, null); assert.equal(bare.pidHz, 1000);
    assert.equal(bare.armed.length, n); assert.equal(bare.armed[0], 1); assert.equal(bare.profile[0], 0);
    for (const k of ['noMotor', 'noThr', 'noMixer', 'noVbat', 'noGov', 'noState']) assert.ok(bare.reasons.includes(GD.TEXT[k]), k);
    assert.ok(bare.time[n - 1] > 0);
});

test('the arming profile fills the samples before the first logged change, and profileFilled counts them', () => {
    const n = 400, run = GD.fromColumns(columns(n), meta(n, { armingProfile: 3 }), null);
    assert.equal(run.profile[0], 3); assert.equal(run.profile[n / 2 - 1], 3); assert.equal(run.profile[n / 2], 2);
    assert.equal(run.profileFilled, n / 2); assert.equal(GD.fromColumns(columns(n), meta(n), null).profileFilled, 0);
});

test('the worker path (runOf of a lib.segments segment) gives the same run as the columns; health_phase without ctx.phases', () => {
    const n = 400, c = columns(n), ph = PH(n);
    // lib.segments(whole): hs and the event columns at the top level, the logged fields in extra, time in microseconds
    const extra = {}; for (const k of GD.EXTRA) extra[k] = k === 'time' ? Float64Array.from(c.time, v => 5000000 + v * 1e6) : c[k];
    const w = { flight: { log: 7, file: 'test.bbl', craft: 'Test', header: META.header, actualRate: 994 }, whole: true, fromS: 1.5, rate: 1000, n,
        profileAt: c.profileAt, airborneAt: c.airborneAt, govStateAt: c.govStateAt, rescueAt: c.rescueAt, hs: c.hs, extra };
    assert.equal(GD.runOf, GD.fromSegment);
    const a = GD.runOf(w, { phases: ph, segment: 0, name: 'log07_0' });
    const cols = Object.assign({}, c, { time: Float64Array.from(extra.time, v => (v - extra.time[0]) / 1e6) });
    const b = GD.fromColumns(cols, meta(n), ph);
    assert.deepStrictEqual(a, b);
    // without mixer[0..2] in extra, lib w.u (mixer / 1000) gives them
    const x2 = Object.assign({}, extra, { 'mixer[0]': null, 'mixer[1]': null, 'mixer[2]': null });
    const u = [0, 1, 2].map(j => Float64Array.from(c[`mixer[${j}]`], v => v / 1000));
    const a2 = GD.fromSegment(Object.assign({}, w, { extra: x2, u }), { phases: ph, segment: 0, name: 'log07_0' });
    for (const k of ['roll', 'pitch', 'yaw']) for (let i = 0; i < n; i += 37) assert.ok(Math.abs(a2[k][i] - b[k][i]) < 1e-6, k);
    // without ctx.phases: health_phase.phases (a bench run here); when it fails (no gyro), class null and a reason
    const gyro = [0, 1, 2].map(j => Float64Array.from({ length: n }, (_, i) => Math.sin(i * 0.01 * (j + 1))));
    const lazy = GD.runOf(Object.assign({}, w, { gyro }), {});
    assert.equal(lazy.class, 'bench'); assert.equal(lazy.phase.length, n); assert.ok(!lazy.reasons.includes(GD.TEXT.noPhase));
    const failed = GD.runOf(w, {});
    assert.equal(failed.class, null); assert.equal(failed.phase, null); assert.ok(failed.reasons.includes(GD.TEXT.noPhase));
});

test('load reads a dev data directory (meta.json, phases.json, interleaved float32 columns, phase codes)', () => {
    const n = 300, c = columns(n), names = ['profileAt', 'govStateAt', 'hs', 'time', 'govP', 'govRequest', 'motor[0]', 'Vbat'];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gov_data_'));
    try {
        const buf = new Float32Array(n * names.length); for (let i = 0; i < n; i++) names.forEach((k, j) => { buf[i * names.length + j] = c[k][i]; });
        fs.writeFileSync(path.join(dir, 'log07_0.f32'), Buffer.from(buf.buffer));
        fs.writeFileSync(path.join(dir, 'log07_0.phase'), Buffer.from(PH(n).code.buffer));
        fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ file: 'test.bbl', segments: [Object.assign({}, META, { n, columns: names })] }));
        fs.writeFileSync(path.join(dir, 'phases.json'), JSON.stringify({ log07_0: { class: 'bench', flights: [] } }));
        assert.equal(GD.load(dir).length, 0); // a bench run: only with bench: true
        const runs = GD.load(dir, { bench: true }), r = runs[0];
        assert.equal(runs.length, 1); assert.equal(r.log, 7); assert.equal(r.class, 'bench'); assert.equal(r.phase[n - 1], 3); assert.equal(r.file, 'test.bbl');
        assert.ok(Math.abs(r.hs[n - 1] - c.hs[n - 1]) < 1e-3); assert.ok(Math.abs(r.time[n - 1] - Math.fround(c.time[n - 1])) < 1e-9);
        assert.equal(r.govI, null); assert.equal(r.hasGovernor, false); assert.equal(GD.load(dir, { logs: [3], bench: true }).length, 0);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the real extracted data: Fireball without current, Gaui with current, both with voltage and governor fields', { skip: !fs.existsSync(path.resolve(__dirname, '../analysis/governor-20261014/data/fireball/meta.json')) && 'no analysis/governor-20261014/data' }, () => {
    const dir = path.resolve(__dirname, '../analysis/governor-20261014/data');
    const fb = GD.load(path.join(dir, 'fireball'), { logs: [9, 10], bench: true }), ga = GD.load(path.join(dir, 'gaui'), { logs: [38] });
    assert.deepEqual(fb.map(r => r.class), ['bench', 'flight']);
    assert.deepEqual(GD.load(path.join(dir, 'fireball'), { logs: [9, 10] }).map(r => r.log), [10]); // flight runs only by default
    for (const r of fb) { assert.equal(r.pidHz, 1000); assert.equal(r.loopsPerFrame, 1); assert.ok(r.hasVoltage && !r.hasCurrent && r.hasGovernor); }
    assert.equal(ga[0].pidHz, 2000); assert.equal(ga[0].loopsPerFrame, 2); assert.ok(ga[0].hasVoltage && ga[0].hasCurrent && ga[0].hasGovernor);
});

// ---- arming: DISARM events, run.armed, run.disarms, run.preroll ----

test('DISARM events give run.armed: disarmed to the first governor state other than OFF after RULES.disarmHoldS', () => {
    const n = 2000, c = columns(n);
    for (let i = 0; i < n; i++) c.govStateAt[i] = i < 500 ? 4 : i < 1200 ? 0 : 1; // ACTIVE, OFF (disarmed, then armed with the throttle off), IDLE
    const t = c.time[600] + 1.5; // a DISARM event at 1.5 s (fromS) + time of sample 600
    const run = GD.fromColumns(c, meta(n, { events: [{ t, name: 'DISARM' }, { t: 0.2, name: 'Governor Gain', value: 40 }] }), null);
    assert.equal(run.armSource, 'events'); assert.deepEqual(run.disarms, [600]);
    assert.equal(run.armed[599], 1); assert.equal(run.armed[600], 0); assert.equal(run.armed[1199], 0); assert.equal(run.armed[1200], 1);
    // the event form of the worker decode (epochEvents: { event: 15 }) gives the same
    const b = GD.fromColumns(c, meta(n, { events: [{ t, event: 15, data: {} }] }), null);
    assert.deepEqual(Array.from(b.armed), Array.from(run.armed));
    // a state other than OFF inside RULES.disarmHoldS after the event does not arm (the state event can come late)
    const c2 = columns(n); for (let i = 0; i < n; i++) c2.govStateAt[i] = i < 610 ? 4 : 0;
    const late = GD.fromColumns(c2, meta(n, { events: [{ t, name: 'DISARM' }] }), null);
    assert.equal(late.armed[605], 0); assert.equal(late.armed[n - 1], 0);
    // the OFF state one sample before the event sample is the disarm (Gaui log 48, Fireball log 10); an OFF long before is not
    const c3 = columns(n); for (let i = 0; i < n; i++) c3.govStateAt[i] = i < 599 ? 5 : 0;
    assert.deepEqual(GD.fromColumns(c3, meta(n, { events: [{ t, name: 'DISARM' }] }), null).disarms, [599]);
    const c4 = columns(n); for (let i = 0; i < n; i++) c4.govStateAt[i] = i < 300 ? 5 : 0;
    assert.deepEqual(GD.fromColumns(c4, meta(n, { events: [{ t, name: 'DISARM' }] }), null).disarms, [600]);
    // an ARM event arms again; without governor states the next rise of the arm switch arms
    const arm = GD.fromColumns(c2, meta(n, { events: [{ t, name: 'DISARM' }, { t: c.time[900] + 1.5, name: 'ARM' }] }), null);
    assert.equal(arm.armed[899], 0); assert.equal(arm.armed[900], 1);
    const c5 = columns(n, { govStateAt: undefined }); for (let i = 0; i < n; i++) c5.flightModeFlags[i] = i >= 590 && i < 1500 ? 0 : 1;
    const sw = GD.fromColumns(c5, meta(n, { events: [{ t, name: 'DISARM' }] }), null);
    assert.equal(sw.armed[1499], 0); assert.equal(sw.armed[1500], 1);
    // without events: the arm switch (flightModeFlags bit 0) as before, or 1 without it
    const none = GD.fromColumns(c5, meta(n), null);
    assert.equal(none.armSource, 'switch'); assert.equal(none.armed[600], 0); assert.deepEqual(none.disarms, []);
    // arming() again: the same result for the same events, the arm switch without them
    GD.arming(sw, [{ t, name: 'DISARM' }]); assert.equal(sw.armed[1499], 0); assert.equal(sw.armed[1500], 1);
    GD.arming(sw, []); assert.equal(sw.armSource, 'switch'); assert.deepEqual(Array.from(sw.armed), Array.from(none.armed));
    assert.equal(GD.fromColumns(columns(n, { flightModeFlags: undefined }), meta(n), null).armSource, 'none');
});

test('preroll: the loops armed before sample 0 from the IDLE ramp at the log start (1 and 2 loops per sample)', () => {
    for (const [pidHz, looptime, L] of [[1000, 500, 1], [2000, 250, 2]]) {
        const n = 3000, c = columns(n), T = 100, per = 10 / (pidHz * T), pre = 79, h = Object.assign({}, META.header, { looptime });
        // IDLE: the throttle ramps from the arm (pre loops before sample 0) to the handover throttle 25 %, logged in counts
        for (let i = 0; i < n; i++) { c.govStateAt[i] = i < 2600 ? 1 : 2; c['motor[0]'][i] = Math.min(250, Math.round((pre + L * (i + 1)) * per * 1000)); }
        const run = GD.fromColumns(c, meta(n, { header: h }), null);
        assert.equal(run.loopsPerFrame, L);
        assert.ok(Math.abs(run.preroll - pre) <= 2, `${pidHz} Hz: ${run.preroll}`);
        assert.equal(GD.fromColumns(columns(n), meta(n), null).preroll, 0); // a start in OFF
    }
});

test('load passes the arming events of each log; the real data reproduce the arming of analysis/governor-twin/parity.cjs', { skip: !fs.existsSync(path.resolve(__dirname, '../analysis/governor-twin/out/disarm_fireball.json')) && 'no analysis/governor-twin/out' }, () => {
    const root = path.resolve(__dirname, '..');
    for (const craft of ['fireball', 'gaui']) {
        const dir = path.join(root, 'analysis/governor-20261014/data', craft), m = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
        const d = JSON.parse(fs.readFileSync(path.join(root, 'analysis/governor-twin/out', `disarm_${craft}.json`), 'utf8')), events = {};
        for (const s of m.segments) events[s.log] = (d.us[s.log] || []).map(us => ({ t: (us - s.timeStartUs) / 1e6 + (s.fromS || 0), name: 'DISARM' }));
        for (const run of GD.load(dir, { events, bench: true })) {
            // parity.cjs armedOf: disarmed from the first sample at or after the event, for 50 samples, then to the first state other than OFF
            const a = new Uint8Array(run.n).fill(1), st = run.state;
            for (const us of d.us[run.log] || []) { let k = 0; const rel = (us - run.t0Us) / 1e6; while (k < run.n && run.time[k] < rel) k++; const k0 = k; for (; k < run.n && ((st[k] !== 0 && k < k0 + 50) || st[k] === 0); k++) a[k] = 0; }
            let diff = 0; for (let i = 0; i < run.n; i++) if (a[i] !== run.armed[i]) diff++;
            assert.ok(diff <= 2 * run.disarms.length, `${craft} log ${run.log}: ${diff} samples`); // the back-off: at most 1 sample per disarm
            assert.equal(run.armSource, 'events');
            assert.equal(run.preroll, craft === 'fireball' && run.log === 13 ? 79 : 0, `${craft} log ${run.log}`);
        }
    }
});
