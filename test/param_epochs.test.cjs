'use strict';

// Tests of tools/autotune/param_epochs.cjs: the spans of a log and why the header values can be wrong in each (re-arm
// in the grace period, profile switch, unlogged governor-request step, adjustment, logging resume).
//
//   node --test test/param_epochs.test.cjs
//   PARAM_EPOCHS_LOG=<Fireball dump RTFL_BLACKBOX_LOG_SAB_Fireball_20261005_204823.BBL> node --max-old-space-size=8000 --test test/param_epochs.test.cjs
//     also the real log (read only): its re-arms
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

test('real log: the re-arms of the Fireball dump of 2026-10-05', { skip: !process.env.PARAM_EPOCHS_LOG }, () => {
    const lib = require(path.resolve(__dirname, '../tools/autotune/lib.cjs'));
    const app = lib.loadApp(), log = new app.FlightLog(require('node:fs').readFileSync(process.env.PARAM_EPOCHS_LOG));
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
