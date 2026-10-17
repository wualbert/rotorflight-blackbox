'use strict';

// Tests of tools/autotune/param_epochs.cjs: the spans of a log and why the header values can be wrong in each (re-arm
// in the grace period, profile switch, unlogged governor-request step, adjustment, logging resume).
//
//   node --test test/param_epochs.test.cjs
//   PARAM_EPOCHS_LOG=<Fireball dump RTFL_BLACKBOX_LOG_SAB_Fireball_20261005_204823.BBL> node --max-old-space-size=8000 --test test/param_epochs.test.cjs
//     also the real log (read only): its re-arms
//   PARAM_EPOCHS_LOG=analysis/fireball-crash-20261015/crash.bbl node --test test/param_epochs.test.cjs
//     a log of firmware with blackbox_params (a FULL parameter snapshot): the snapshot values of every PID profile, the PID profile at
//     the start, the journal epochs of the 4.7 table, the I-term limits of L6 (IMP-05)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PE = require(path.resolve(__dirname, '../tools/autotune/param_epochs.cjs'));
const { EV } = PE;

// frame times at 100 Hz from 0 to end s
const frames = (end) => Float64Array.from({ length: Math.round(end * 100) + 1 }, (_, i) => i / 100);
const mode = (t, on) => ({ event: EV.FLIGHT_MODE, t, data: { newFlags: on ? 1 : 0, lastFlags: on ? 0 : 1 } });
const disarm = (t) => ({ event: EV.DISARM, t, data: { reason: 4 } });
const adjust = (t, func, value, name) => ({ event: EV.INFLIGHT_ADJUSTMENT, t, data: { func, value, name } });
const brief = (spans) => spans.map(s => [s.t0, s.t1, s.arm, s.armed, s.pidProfile, s.reasons.join(',')]);

test('one arm with no event: one fresh span', () => {
    const spans = PE.paramEpochs({ events: [], frameS: frames(30), profileAtStart: 1 });
    assert.deepEqual(brief(spans), [[0, 30, 0, true, 1, '']]);
    assert.equal(spans[0].fresh, true);
});

test('a re-arm in the grace period starts arm 1 in the same log', () => {
    const events = [mode(9.99, false), disarm(10), mode(11, true), mode(19.99, false), disarm(20)];
    assert.deepEqual(brief(PE.paramEpochs({ events, frameS: frames(25), profileAtStart: 1 })), [
        [0, 10, 0, true, 1, ''], [10, 11, 0, false, 1, 'grace'], [11, 20, 1, true, 1, 'rearm'], [20, 25, 1, false, 1, 'grace']]);
});

test('a refused arm (switch on and off with no disarm) is not the arm; a receiver blip is ignored', () => {
    const events = [mode(9.99, false), disarm(10), mode(10.5, true), mode(10.8, false), mode(11.2, true),
        mode(15, false), mode(15.003, true), mode(19.99, false), disarm(20)];
    const spans = PE.paramEpochs({ events, frameS: frames(25), profileAtStart: 1 });
    assert.deepEqual(brief(spans).map(s => s.slice(0, 4)), [[0, 10, 0, true], [10, 11.2, 0, false], [11.2, 20, 1, true], [20, 25, 1, false]]);
});

test('after the last disarm: armed again only if the log goes on past the grace period', () => {
    const tail = PE.paramEpochs({ events: [mode(9.99, false), disarm(10)], frameS: frames(15), profileAtStart: 1 });
    assert.deepEqual(brief(tail).map(s => s.slice(0, 4)), [[0, 10, 0, true], [10, 15, 0, false]]);
    const again = PE.paramEpochs({ events: [mode(9.99, false), disarm(10), mode(12, true)], frameS: frames(30), profileAtStart: 1 });
    assert.deepEqual(brief(again).map(s => s.slice(0, 4)), [[0, 10, 0, true], [10, 12, 0, false], [12, 30, 1, true]]);
    // a switch rise in the tail that does not arm (the log ends at the grace limit)
    const refused = PE.paramEpochs({ events: [mode(9.99, false), disarm(10), mode(12, true)], frameS: frames(15), profileAtStart: 1 });
    assert.deepEqual(brief(refused).map(s => s.slice(0, 4)), [[0, 10, 0, true], [10, 15, 0, false]]);
});

test('profile switches: back on the start profile is fresh only when the start profile is known', () => {
    const events = [adjust(5, 2, 2, 'PID Profile'), adjust(8, 2, 1, 'PID Profile')];
    assert.deepEqual(brief(PE.paramEpochs({ events, frameS: frames(12), profileAtStart: 1 })),
        [[0, 5, 0, true, 1, ''], [5, 8, 0, true, 2, 'switched'], [8, 12, 0, true, 1, '']]);
    assert.deepEqual(brief(PE.paramEpochs({ events, frameS: frames(12), profileAtStart: 0 })),
        [[0, 5, 0, true, 0, ''], [5, 8, 0, true, 2, 'switched'], [8, 12, 0, true, 1, 'switched']]);
    // a profile event at the first frame gives the start profile
    const first = PE.paramEpochs({ events: [adjust(0, 2, 3, 'PID Profile')], frameS: frames(4), profileAtStart: 0 });
    assert.deepEqual(brief(first), [[0, 4, 0, true, 3, '']]);
    // a rate profile switch
    const rate = PE.paramEpochs({ events: [adjust(2, 1, 4, 'Rate Profile')], frameS: frames(4), profileAtStart: 1, rateAtStart: 1 });
    assert.deepEqual(rate.map(s => [s.rateProfile, s.reasons.join(',')]), [[1, ''], [4, 'switched']]);
});

test('a governor-request step with no profile event is unlogged; with the event it is not', () => {
    const frameS = frames(20), req = Float64Array.from(frameS, t => t < 10 ? 3500 : t < 10.2 ? 3500 + (t - 10) * 5000 : 4500);
    const silent = PE.paramEpochs({ events: [], frameS, govRequest: req, profileAtStart: 1 });
    assert.deepEqual(brief(silent).map(s => s.slice(0, 2).concat(s[5])), [[0, 10.2, ''], [10.2, 20, 'unlogged']]);
    const logged = PE.paramEpochs({ events: [adjust(10.01, 2, 2, 'PID Profile')], frameS, govRequest: req, profileAtStart: 1 });
    assert.ok(logged.every(s => !s.reasons.includes('unlogged')));
    // governor off (0) between two equal plateaus is not a step
    const off = Float64Array.from(frameS, t => t > 8 && t < 12 ? 0 : 3500);
    assert.ok(PE.paramEpochs({ events: [], frameS, govRequest: off, profileAtStart: 1 }).every(s => s.fresh));
});

test('adjustments and logging resume', () => {
    const events = [adjust(7, 5, 120, 'Roll Rate'), { event: EV.LOGGING_RESUME, t: 9, data: { logIteration: 0, currentTime: 0 } }];
    const spans = PE.paramEpochs({ events, frameS: frames(12), profileAtStart: 1 });
    assert.deepEqual(brief(spans).map(s => [s[0], s[1], s[5]]), [[0, 7, ''], [7, 9, 'adjusted'], [9, 12, 'adjusted,resume']]);
    assert.deepEqual(spans[1].adjust, [{ t: 7, func: 5, name: 'Roll Rate', value: 120 }]);
});

// the real log: a param log (blackbox_params) or a stock dump; each real-log test skips the other kind
const PL = require(path.resolve(__dirname, '../tools/autotune/param_log.cjs'));
function realLog() {
    if (!process.env.PARAM_EPOCHS_LOG) return null;
    const lib = require(path.resolve(__dirname, '../tools/autotune/lib.cjs')), app = lib.loadApp(), log = new app.FlightLog(require('node:fs').readFileSync(process.env.PARAM_EPOCHS_LOG));
    return { lib, app, log, param: log.openLog(0) && PL.isParamLog(log.getSysConfig()) };
}
const REAL = realLog();

test('real log: the re-arms of the Fireball dump of 2026-10-05', { skip: !REAL ? 'PARAM_EPOCHS_LOG not set' : REAL.param && 'PARAM_EPOCHS_LOG is a param log' }, () => {
    const log = REAL.log;
    const armsOf = (i) => {
        assert.ok(log.openLog(i));
        const tMin = log.getMinTime(), chunks = log.getChunksInTimeRange(tMin, Infinity), t = [], events = [];
        for (const c of chunks) { for (const f of c.frames) t.push((f[1] - tMin) / 1e6); for (const e of c.events) events.push({ event: e.event, t: (e.time - tMin) / 1e6, data: e.data }); }
        return PE.paramEpochs({ events, frameS: Float64Array.from(t), profileAtStart: 0 }).filter(s => s.armed).map(s => s.arm)
            .filter((a, k, all) => all.indexOf(a) === k).length;
    };
    // logs 2, 3, 5 and 12 (1-based) hold 2, 3, 2 and 3 arms (DISARM events and the arm switch, 2026-10-06)
    assert.deepEqual([1, 2, 4, 11, 0, 5].map(armsOf), [2, 3, 2, 3, 1, 1]);
});

test('real param log (crash.bbl): snapshot values of PID profile 2, the start profile, journal epochs, L6 limits', { skip: !REAL ? 'PARAM_EPOCHS_LOG not set' : !REAL.param && 'PARAM_EPOCHS_LOG is not a param log' }, () => {
    const file = process.env.PARAM_EPOCHS_LOG, log = REAL.log; assert.ok(log.openLog(0));
    const sc = log.getSysConfig(), got = PL.collect(log), rec = PL.assemble(got.strings), snap = PL.snapshotCli(sc, rec);
    assert.ok(snap, 'a complete FULL snapshot');
    assert.equal(snap.selectedProfile, 0, 'param_pid_profile 0: PID profile 1 at the start');
    const want = { pitch_p_gain: 99, roll_i_gain: 110, pitch_i_gain: 110, yaw_p_gain: 50, yaw_i_gain: 116 };
    for (const [n, v] of Object.entries(want)) assert.equal(snap.profiles[1][n], v, n);
    // datasets.cjs: PID profile 2 has the snapshot values (source 'log snapshot'), PID profile 1 is the start profile
    const DS = require(path.resolve(__dirname, '../tools/autotune/datasets.cjs'));
    const inputs = DS.inputsOfFile(file, { app: REAL.lib.loadApp() }), ds = DS.datasets(inputs, null);
    assert.equal(ds.logs[0].armingProfile, 1);
    const B = ds.datasets.find(d => d.pidProfile === 2);
    assert.ok(B && !B.assumed, 'PID profile 2 is known');
    for (const [n, v] of Object.entries(want)) assert.deepEqual([B.values[n], B.sources[n]], [v, 'log snapshot'], n);
    assert.ok(!ds.notes.some(t => /No log header shows the values of PID profile 2/.test(t)));
    // the journal epochs with the 4.7 table: no effect-unknown, and the classic lines agree with the snapshot (self-test)
    const tl = PL.buildTimeline({ sysConfig: sc, records: rec, frames: got.frames, resumes: got.resumes });
    assert.equal(tl.semantics.known, true);
    const frameS = Float64Array.from(got.frames.time, t => (t - log.getMinTime()) / 1e6), ep = PE.paramEpochs({ timeline: tl, frameS });
    assert.ok(ep.length > 1);
    assert.ok(ep.every(s => !s.reasons.includes('effect-unknown')), JSON.stringify(ep.map(s => s.reasons)));
    const st = PL.selfTest(tl, sc);
    assert.ok(st.compared > 0); assert.equal(st.mismatches.length, 0, JSON.stringify(st.mismatches));
    // L6 (health_limits.cjs): the I-term limits of PID profile 2 from the snapshot, without a CLI dump
    const HL = require(path.resolve(__dirname, '../tools/autotune/health_limits.cjs')), RS = require(path.resolve(__dirname, '../tools/autotune/health_rescue.cjs'));
    const app = REAL.lib.loadApp();
    for (const w of REAL.lib.segments(app, file, { whole: true, extra: [...new Set(HL.EXTRA.concat(RS.EXTRA))] })) {
        if (w.skipped) continue;
        const m = HL.analyse(w, { rate: w.flight.actualRate, header: w.flight.header });
        const lim = (axis) => m.channels.find(c => c.id === 'L6' && c.axis === axis).limits;
        assert.deepEqual(['roll', 'pitch', 'yaw'].map(a => lim(a).byProfile[2]), [990, 990, 2900]);
        assert.ok(['roll', 'pitch', 'yaw'].every(a => lim(a).unknownProfiles.length === 0 && /snapshot/.test(lim(a).source)));
    }
});
