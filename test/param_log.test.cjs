'use strict';

// Tests of tools/autotune/param_log.cjs (RF-PARAM-1, Blackbox_Params_Spec.md sections 2, 4.2, 4.4 and 4.7) and of the
// decoder changes of spec 4.1 (js/flightlog_parser.js paramHeader; js/flightlog_index.js and js/flightlog.js keep the
// events before the first I-frame).
//
// The fixtures are hand-built: header line arrays as sysConfig.paramHeader holds them, event-101 strings with CRCs from
// an independent CRC-8 (a table, not the bit loop of the module), FNV-1 hashes from an independent BigInt loop, and
// typed frame arrays. Published check values pin both algorithms: CRC-8/DVB-S2 of "123456789" is 0xBC, FNV-1 (32 bit)
// of "a" is 0x050c5d7e.
//
//   node --test test/param_log.test.cjs

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const vm = require('node:vm');

const PL = require(path.resolve(__dirname, '../tools/autotune/param_log.cjs'));
const PS = require(path.resolve(__dirname, '../tools/autotune/param_semantics.cjs'));
const PE = require(path.resolve(__dirname, '../tools/autotune/param_epochs.cjs'));

// ---- independent CRC-8 (poly 0xD5, init 0, MSB first) and FNV-1 ------------------------------------------------------
const CRC_TABLE = (() => {
    const t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = (c & 0x80) ? ((c << 1) ^ 0xD5) & 0xFF : (c << 1) & 0xFF; t[i] = c; }
    return t;
})();
const crc = (s) => { let c = 0; for (const byte of Buffer.from(s, 'latin1')) c = CRC_TABLE[c ^ byte]; return c; };
const fnv = (lines) => {
    let h = 0x811c9dc5n;
    for (const byte of Buffer.from(lines.map(([k, v]) => `H ${k}:${v}\n`).join(''), 'latin1')) { h = (h * 0x01000193n) & 0xffffffffn; h ^= BigInt(byte); }
    return Number(h);
};
// one event-101 string: "P" TYPE SEQ " " AT fields "*" CRC
function ev(type, seq, at, ...fields) {
    const body = `P${type}${seq.toString(16)} ${at}${fields.length ? ' ' + fields.join(' ') : ''}`;
    return `${body}*${crc(body).toString(16).toUpperCase().padStart(2, '0')}`;
}

// ---- header fixtures (2.2) -------------------------------------------------------------------------------------------
const phaseText = (p) => Object.entries(p).map(([k, v]) => `${k}=${v}`).join(',');
const BODY = [
    ['set.gov_mode', 'ELECTRIC'], ['set.deadband', '2'], ['set.yaw_deadband', '3'], ['set.debug_mode', 'NONE'], ['set.debug_axis', '0'],
    ['set.rc_center', '1500'], ['set.gyro_lpf1_static_hz', '100'], ['set.gyro_lpf1_type', 'PT1'], ['set.acc_lpf_hz', '10'],
    ['set@p.roll_p_gain', '50|51|52|53|54|55'], ['set@p.roll_i_gain', '100|||||'], ['set@p.roll_d_gain', '10|||||'],
    ['set@p.roll_f_gain', '20|||||'], ['set@p.roll_b_gain', '0|||||'],
    ['set@p.yaw_p_gain', '70|||80||'], ['set@p.iterm_relax_cutoff', '10,10,15|||||'],
    ['set@p.gov_headspeed', '2300|2500|2700|||'], ['set@p.gov_p_gain', '40|||||'],
    ['set@r.rates_type', 'ROTORFLIGHT|||||'], ['set@r.roll_rc_rate', '120|||||'], ['set@r.pitch_rc_rate', '120|||||'], ['set@r.yaw_rc_rate', '200|||||'],
    ['set@r.setpoint_boost_gain', '0,0,0,0|||||'],
    ['set@p0.profile_name', 'Fast%20one'],
    ['el.servo.0-2', '1500,-700,700,500,500,333,0,0'], ['el.mixin.4', '1000,-200,200'], ['el.feature', '8'],
    ['pg.18+0', 'a0b1'],
    ['boot.set.gov_mode', 'DIRECT'], ['boot.el.servo.1', '1500,-700,700,500,500,200,0,0'],
];
const NO_BOOT = BODY.filter(([k]) => !k.startsWith('boot.'));   // no boot value that differs: no pending key at T0
function headerLines(o = {}) {
    const denom = o.denom || 2, fdenom = o.fdenom || 1, mode = o.mode || 'FULL';
    const lines = [['Param log', o.version || '1'], ['param_mode', mode], ['param_loop', `${denom},${fdenom},1,128`],
        ['param_phase', o.phase || phaseText(PL.PHASE_OF_DENOM[Math.min(denom, 8)])], ['param_pgs', '14.3/912,12.1/300,18.3/20'], ['param_fixes', o.fixes || '-'],
        // looptime is gyro.targetLooptime = pid_denom * the sample looptime (125 µs at 8 kHz); the classic line is the sample looptime
        ['param_rt', `gov_mode=4,features=8,pid_denom=${denom},filter_denom=${fdenom},looptime=${125 * denom},debug_mode=0,motors=1,servos=4`],
        ['param_pid_profile', String(o.pid0 === undefined ? 0 : o.pid0)], ['param_rate_profile', String(o.rate0 === undefined ? 0 : o.rate0)]];
    if (mode === 'FULL') lines.push(...(o.body || BODY));
    if (o.extra) lines.push(...o.extra);
    if (o.end !== false) lines.push(['param_end', `${o.endLines === undefined ? lines.length : o.endLines},${(o.endHash === undefined ? fnv(lines) : o.endHash).toString(16)}`]);
    return lines;
}

// ---- frames ------------------------------------------------------------------------------------------------------------
function frames(n, o = {}) {
    const f = { iter: new Float64Array(n), time: new Float64Array(n), pidProfile: new Float64Array(n), rateProfile: new Float64Array(n), armed: new Float64Array(n), paramSeq: new Float64Array(n) };
    for (let i = 0; i < n; i++) {
        f.iter[i] = (o.iter0 || 0) + i * (o.step || 1); f.time[i] = 1e6 + i * (o.dt || 1000);
        f.pidProfile[i] = o.pid ? o.pid(i) : 0; f.rateProfile[i] = o.rate ? o.rate(i) : 0; f.armed[i] = o.armed ? o.armed(i) : 1; f.paramSeq[i] = o.seq ? o.seq(i) : 0;
    }
    return f;
}
const SEM = (fixes) => PS.forFirmware('Rotorflight 4.6.0 (118e912) STM32G47X', fixes || []);
function build(o) {
    return PL.buildTimeline({ header: headerLines(o.h || {}), records: PL.assemble(o.events || []), frames: o.frames || frames(1000, o.f || {}),
        semantics: o.sem === undefined ? SEM(o.fixes) : o.sem, resumes: o.resumes, sysConfig: o.sysConfig });
}

// ---- header ----------------------------------------------------------------------------------------------------------------

test('check values: CRC-8/DVB-S2 of "123456789" is 0xBC and FNV-1 of "a" is 0x050c5d7e, for the module and the test', () => {
    assert.equal(PL.crc8('123456789'), 0xBC);
    assert.equal(crc('123456789'), 0xBC);
    assert.equal(PL.fnv1('a'), 0x050c5d7e);
    assert.equal(fnv([]), 0x811c9dc5);
    const lines = [['Param log', '1'], ['param_mode', 'FULL']];
    assert.equal(PL.fnv1('H Param log:1\nH param_mode:FULL\n'), fnv(lines));
});

test('header: the snapshot, the empty-field compression, runs, raw bytes, boot lines; complete when the count and the FNV-1 hash agree', () => {
    const h = PL.parseParamHeader(headerLines());
    assert.equal(h.version, 1);
    assert.equal(h.mode, 'FULL');
    assert.equal(h.complete, true);
    assert.equal(h.lines, 9 + BODY.length);
    assert.deepEqual(h.loop, { pidDenom: 2, filterDenom: 1, pInterval: 1, scanBytes: 128 });
    assert.deepEqual(h.phase, { pos: 0, sp: 0, pid: 0, flush: 0, mix: 1, mot: 1, fupd: 1, bb: 1 });
    assert.deepEqual(h.pgs[0], { pgn: 14, ver: 3, size: 912 });
    assert.deepEqual(h.fixes, []);
    assert.equal(h.rt.features, 8);
    assert.equal(h.rt.looptime, 250);
    assert.equal(h.pid0, 0);
    assert.deepEqual(h.pid.get('yaw_p_gain'), ['70', '70', '70', '80', '80', '80']);
    assert.deepEqual(h.pid.get('roll_p_gain'), ['50', '51', '52', '53', '54', '55']);
    assert.deepEqual(h.pid.get('iterm_relax_cutoff'), Array(6).fill('10,10,15'));
    assert.equal(h.pid.get('profile_name')[0], 'Fast%20one');
    assert.equal(PL.unescapeValue(h.pid.get('profile_name')[0]), 'Fast one');
    assert.deepEqual([...h.el.keys()], ['el.servo.0', 'el.servo.1', 'el.servo.2', 'el.mixin.4', 'el.feature']);
    assert.equal(h.raw.get('pg.18+0'), 'a0');
    assert.equal(h.raw.get('pg.18+1'), 'b1');
    assert.equal(h.boot.get('gov_mode'), 'DIRECT');
    assert.equal(h.boot.get('el.servo.1'), '1500,-700,700,500,500,200,0,0');
    const snap = PL.snapshotState(h);
    assert.equal(snap.get('p4.yaw_p_gain'), '80');
    assert.equal(snap.get('r5.roll_rc_rate'), '120');
    assert.equal(snap.get('gov_mode'), 'ELECTRIC');
});

test('header: param_pgs continues in param_pgs.1, param_pgs.2 (firmware HDR_PGS); the lines are in the hash', () => {
    const lines = headerLines({ extra: [] }).filter(([k]) => k !== 'param_end');
    const at = lines.findIndex(([k]) => k === 'param_pgs');
    lines.splice(at, 1, ['param_pgs', '14.0/912,12.4/300'], ['param_pgs.1', '18.3/13,504.3/2'], ['param_pgs.2', '56.0/7']);
    lines.push(['param_end', `${lines.length},${fnv(lines).toString(16).padStart(8, '0')}`]);
    const h = PL.parseParamHeader(lines);
    assert.equal(h.complete, true);
    assert.deepEqual(h.pgs.map(p => p.pgn), [14, 12, 18, 504, 56]);
    assert.deepEqual(h.pgs[4], { pgn: 56, ver: 0, size: 7 });
    assert.equal(h.extra.length, 0);
});

// The FULL header of the firmware host test (Blackbox_Params_Spec.md 6.1): BBP_HEADER_DUMP=<file> obj/test/blackbox_params_unittest
// writes it. PARAM_FW_HEADER=<file> node --test test/param_log.test.cjs reads it.
test('header: the FULL header of the firmware host test is complete, with 242 set, 102 PID profile and 32 rate profile names', { skip: !process.env.PARAM_FW_HEADER }, () => {
    const text = require('node:fs').readFileSync(process.env.PARAM_FW_HEADER, 'latin1');
    const lines = text.split('\n').filter(l => l.startsWith('H ')).map(l => { const s = l.slice(2), i = s.indexOf(':'); return [s.slice(0, i), s.slice(i + 1)]; });
    const h = PL.parseParamHeader(lines);
    assert.equal(h.complete, true, 'param_end count and FNV-1 agree with the firmware');
    assert.equal(h.end.hash, fnv(lines.slice(0, -1)));
    assert.equal(h.pgs.length, 30);
    assert.equal(h.master.size, 242);
    assert.equal(h.pid.size, 102);
    assert.equal(h.rate.size, 32);
    for (const name of h.master.keys()) assert.notEqual(PS.pgOfKey(name), null, name);
    for (const name of h.pid.keys()) assert.ok(PS.NAMES[PS.PG.PID_PROFILE].split(' ').includes(name), name);
    for (const name of h.rate.keys()) assert.ok(PS.NAMES[PS.PG.CONTROL_RATE_PROFILES].split(' ').includes(name), name);
    assert.deepEqual(h.extra, []);
    const tl = PL.buildTimeline({ header: h, records: PL.assemble([]), frames: frames(10), semantics: SEM() });
    assert.equal(tl.complete, true);
    assert.equal(tl.epochs.length, 1);
    assert.deepEqual(tl.epochs[0].reasons, []);
});

test('header: a wrong hash, a wrong count, a changed line or no param_end make the snapshot incomplete; unknown keys are hashed and kept', () => {
    assert.equal(PL.parseParamHeader(headerLines({ endHash: 0x12345678 })).complete, false);
    assert.equal(PL.parseParamHeader(headerLines({ endLines: 3 })).complete, false);
    assert.equal(PL.parseParamHeader(headerLines({ end: false })).complete, false);
    const lines = headerLines();
    lines[12] = [lines[12][0], '99'];
    assert.equal(PL.parseParamHeader(lines).complete, false);
    // a key of a later version 1 (2.1): ignored, but in the hash
    const future = PL.parseParamHeader(headerLines({ extra: [['param_future', 'x=1'], ['zz.new', '5']] }));
    assert.equal(future.complete, true);
    assert.deepEqual(future.extra, [['param_future', 'x=1'], ['zz.new', '5']]);
    // set@p<k> lines (a set@p line longer than 192 chars)
    const fallback = PL.parseParamHeader(headerLines({ body: [['set@p0.profile_name', 'a'], ['set@p3.profile_name', 'b']] }));
    assert.deepEqual(fallback.pid.get('profile_name').slice(0, 4), ['a', undefined, undefined, 'b']);
    // the stock log
    assert.equal(PL.parseParamHeader(undefined).version, null);
    assert.equal(PL.isParamLog({}), false);
    assert.equal(PL.isParamLog({ paramHeader: [['set.x', '1']] }), false);
    assert.equal(PL.isParamLog({ paramHeader: [['Param log', '1']] }), true);
});

// ---- records (2.4) ----------------------------------------------------------------------------------------------------------

test('records: the grammar, the CRC, the sources, intervals and the fields of each type; unknown fields are ignored', () => {
    const c = PL.parseRecord(ev('C', 0x1a, '48211.1', 's=m.202', 'n=1', 'p0.yaw_p_gain=72<70'));
    assert.equal(c.crcOk, true);
    assert.deepEqual([c.type, c.seq, c.at, c.src, c.arg, c.n], ['C', 26, { n: 48211, c: 1 }, 'm', 202, 1]);
    assert.deepEqual(c.items, [{ key: 'p0.yaw_p_gain', value: '72', old: '70' }]);
    const text = ev('C', 0x21, '83000.0~83022.0', 's=u', 'n=1', 'r0.cyclic_ring=150<140', 'zz=9');
    const u = PL.parseRecord(text);
    assert.deepEqual([u.src, u.arg, u.at], ['u', null, { n0: 83000, c0: 0, n1: 83022, c1: 0 }]);
    assert.equal(u.fields.zz, '9');
    // one changed character: the CRC fails
    assert.equal(PL.parseRecord(text.replace('150', '151')).crcOk, false);
    assert.equal(PL.parseRecord('PC1 100.0 s=m n=1 x=1<0').malformed, true);
    assert.equal(PL.parseRecord('PC1 100.0 s=m n=1 x=1<0*zz').crcOk, false);
    assert.equal(PL.parseRecord('Hello world'), null);
    assert.equal(PL.parseRecord('PX1 100.0*00'), null);
    const a = PL.parseRecord(ev('A', 0x1b, '48211.1', 'pid/0', 'fp=9C3A11F0'));
    assert.deepEqual([a.loader, a.slot, a.fp], ['pid', 0, '9c3a11f0']);
    const r = PL.parseRecord(ev('R', 2, 'p', 'gov_mode=4', 'features=8', 'fp.pid=aa', 'fp.gov=bb', 'fp.sp=cc'));
    assert.deepEqual(r.values, { gov_mode: '4', features: '8', 'fp.pid': 'aa', 'fp.gov': 'bb', 'fp.sp': 'cc' });
    assert.deepEqual(r.at, { pre: true });
    const m = PL.parseRecord(ev('M', 0x1f, '82000.0', 'eesave', 'us=71230'));
    assert.deepEqual([m.marker, m.fields.us], ['eesave', '71230']);
    assert.deepEqual(PL.parseRecord(ev('L', 7, '100.1', 'pgs=14,12')).pgs, [14, 12]);
    const q = PL.parseRecord(ev('Q', 9, '900.0', 'unsent=2', 'lostrec=1'));
    assert.deepEqual([q.unsent, q.lostrec], [2, 1]);
    assert.equal(PL.parseRecord(ev('C', 1, '1.0', 's=m.1', 'n=1', `p0.profile_name=${'x'.repeat(130)}<y`)).long, true);
});

test('assemble: continuations join their record and n is checked; CRC errors are lost; gaps, orphans and duplicates', () => {
    const head = ev('C', 5, '100.1', 's=m.202', 'n=3', 'p0.roll_p_gain=60<50', 'p0.roll_i_gain=110<100'), plus = ev('+', 5, '100.1', 'p0.roll_d_gain=12<10');
    const ok = PL.assemble([ev('C', 4, '50.0', 's=m.1', 'n=1', 'deadband=3<2'), head, plus]);
    assert.equal(ok.records.get(5).items.length, 3);
    assert.equal(ok.records.get(5).incomplete, undefined);
    assert.deepEqual(ok.gaps, [{ from: 1, to: 3, after: 0, before: 4 }]);
    // the + is missing, or has a bad CRC: the record is incomplete
    assert.deepEqual(PL.assemble([head]).incomplete, [5]);
    const bad = plus.slice(0, -2) + (plus.endsWith('00') ? '01' : '00');
    const withBad = PL.assemble([head, bad]);
    assert.deepEqual(withBad.incomplete, [5]);
    assert.equal(withBad.crcErrors.length, 1);
    // the head is lost: the + makes a record with headLost
    const orphan = PL.assemble([head.replace('n=3', 'n=4'), plus]);
    assert.equal(orphan.crcErrors.length, 1);
    assert.deepEqual(orphan.orphans, [5]);
    assert.equal(orphan.records.get(5).headLost, true);
    // gaps between records, and a duplicate
    const g = PL.assemble([ev('C', 1, '1.0', 's=m.1', 'n=1', 'deadband=3<2'), ev('C', 2, '2.0', 's=m.1', 'n=1', 'deadband=4<3'), ev('C', 2, '2.0', 's=m.1', 'n=1', 'deadband=4<3'), ev('C', 4, '4.0', 's=m.1', 'n=1', 'deadband=5<4')]);
    assert.deepEqual(g.gaps, [{ from: 3, to: 3, after: 2, before: 4 }]);
    assert.deepEqual(g.duplicates, [2]);
    assert.equal(g.maxSeq, 4);
    // { text, time } input keeps the event time
    assert.equal(PL.assemble([{ text: head, time: 123 }]).records.get(5).time, 123);
});

// ---- fold (2.6) -------------------------------------------------------------------------------------------------------------

test('a missing SEQ: every key is unknown from the point of the record before it until its next C item', () => {
    const t = build({ h: { body: NO_BOOT }, events: [
        ev('C', 1, '100.0', 's=m.202', 'n=1', 'p0.yaw_p_gain=72<70'), ev('A', 2, '100.0', 'pid/0'),
        // seq 3 is lost
        ev('C', 4, '300.0', 's=m.202', 'n=1', 'p0.roll_p_gain=60<50'), ev('A', 5, '300.0', 'pid/0'),
    ] });
    assert.deepEqual(t.losses.map(l => [l.why, l.seqs, l.pos]), [['gap', [3, 3], 100 * 256]]);
    assert.equal(t.valueAt('p0.yaw_p_gain', 99).status, 'exact');
    assert.equal(t.valueAt('p0.yaw_p_gain', 99).stored, '70');
    assert.equal(t.valueAt('p0.yaw_p_gain', 150).status, 'unknown');
    assert.equal(t.valueAt('gov_mode', 900).status, 'unknown');           // no later C item
    assert.equal(t.valueAt('p0.roll_p_gain', 299).status, 'unknown');
    assert.deepEqual([t.valueAt('p0.roll_p_gain', 300).status, t.valueAt('p0.roll_p_gain', 300).stored], ['exact', '60']);
    assert.equal(t.complete, false);
    const late = t.epochs.find(e => e.i0 <= 200 && e.i1 > 200);
    assert.ok(late.reasons.includes('lost') && late.reasons.includes('unknown'), late.reasons.join());
    assert.equal(t.epochs[0].reasons.length, 0, 'the frames before the loss are exact');
});

test('a trailing gap: frames whose S-frame paramSeq is above the highest SEQ received; unknown from the last frame with the old paramSeq', () => {
    const t = build({ events: [ev('C', 1, '100.0', 's=m.202', 'n=1', 'p0.yaw_p_gain=72<70'), ev('A', 2, '100.0', 'pid/0')],
        f: { seq: (i) => i < 100 ? 0 : i < 400 ? 2 : 3 } });
    assert.deepEqual(t.trailing, { from: 3, to: 3, frame: 400, pos: 400 * 256 });
    assert.equal(t.valueAt('p0.yaw_p_gain', 399).stored, '72');
    assert.equal(t.valueAt('p0.yaw_p_gain', 399).status, 'exact');
    assert.equal(t.valueAt('p0.yaw_p_gain', 400).status, 'unknown');
    assert.equal(t.valueAt('deadband', 999).status, 'unknown');
    // no trailing gap when paramSeq never passes the last record
    assert.equal(build({ events: [ev('C', 1, '100.0', 's=m.202', 'n=1', 'p0.yaw_p_gain=72<70')], f: { seq: (i) => i < 100 ? 0 : 1 } }).trailing, null);
});

test('a Q with unsent or lostrec records is a loss; a CRC error is lost', () => {
    const t = build({ events: [ev('C', 1, '100.0', 's=m.1', 'n=1', 'deadband=3<2'), ev('Q', 2, '900.0', 'unsent=1', 'lostrec=0')] });
    assert.ok(t.losses.some(l => l.why === 'Q'));
    assert.equal(t.valueAt('deadband', 950).status, 'unknown');
    const c = build({ events: [ev('C', 1, '100.0', 's=m.1', 'n=1', 'deadband=3<2').replace('3<2', '4<2'), ev('C', 2, '200.0', 's=m.1', 'n=1', 'yaw_deadband=4<3')] });
    assert.ok(c.flags.some(f => f.type === 'crc'));
    assert.deepEqual(c.losses.map(l => l.seqs), [[1, 1]]);
    assert.equal(c.valueAt('deadband', 500).status, 'unknown', 'from T0: the lost record has no record before it');
    assert.equal(c.valueAt('yaw_deadband', 500).stored, '4');
});

test('L and y: the keys of the listed PGs are unknown from the L point until their y record, which restores the keys it does not list', () => {
    const t = build({ events: [
        ev('C', 1, '50.0', 's=m.202', 'n=1', 'p0.yaw_p_gain=71<70'), ev('A', 2, '50.0', 'pid/0'),
        ev('L', 3, '100.0', 'pgs=14'),
        ev('C', 4, '100.0~120.0', 's=y', 'n=1', 'p0.yaw_p_gain=75<71'),
        ev('L', 5, '600.0', 'pgs=1001'),
    ] });
    assert.equal(t.valueAt('p0.roll_p_gain', 110).status, 'unknown');
    assert.deepEqual([t.valueAt('p0.roll_p_gain', 121).stored, t.valueAt('p0.roll_p_gain', 121).status], ['50', 'exact']);
    assert.equal(t.valueAt('p0.yaw_p_gain', 105).status, 'unknown');
    assert.equal(t.valueAt('p0.yaw_p_gain', 121).stored, '75');
    assert.equal(t.valueAt('deadband', 110).status, 'exact', 'a key of another PG');
    // an L with no y: unknown to the end
    assert.equal(t.valueAt('gov_mode', 999).status, 'unknown');
    assert.ok(t.flags.some(f => f.type === 'L-open' && f.pgn === 1001));
    assert.ok(t.flags.some(f => f.type === 'L' && f.seq === 3));
});

test('y without items: its pgs field ends the L loss of the PG, and the keys keep the value before the L', () => {
    const t = build({ events: [
        ev('C', 1, '50.0', 's=m.202', 'n=1', 'p0.yaw_p_gain=71<70'), ev('A', 2, '50.0', 'pid/0'),
        ev('L', 3, '100.0', 'pgs=14'),
        ev('C', 4, '100.0~120.0', 's=y', 'pgs=14', 'n=0'),
    ] });
    assert.equal(t.valueAt('p0.roll_p_gain', 110).status, 'unknown');
    assert.deepEqual([t.valueAt('p0.roll_p_gain', 121).stored, t.valueAt('p0.roll_p_gain', 121).status], ['50', 'exact']);
    assert.deepEqual([t.valueAt('p0.yaw_p_gain', 121).stored, t.valueAt('p0.yaw_p_gain', 121).status], ['71', 'exact']);
    assert.ok(!t.flags.some(f => f.type === 'L-open'));
});

test('y with part=1: the L loss goes on until a y record without it; the keys of the parts keep their values', () => {
    const t = build({ events: [
        ev('L', 1, '100.0', 'pgs=14'),
        ev('C', 2, '100.0~120.0', 's=y', 'pgs=14', 'part=1', 'n=1', 'p0.yaw_p_gain=75<70'),
        ev('C', 3, '100.0~140.0', 's=y', 'pgs=14', 'part=1', 'n=1', 'p1.yaw_p_gain=76<70'),
        ev('C', 4, '100.0~160.0', 's=y', 'pgs=14', 'n=1', 'p2.yaw_p_gain=77<70'),
    ] });
    assert.equal(t.valueAt('p0.roll_p_gain', 130).status, 'unknown', 'not yet resynced: unknown after the first part');
    assert.equal(t.valueAt('p2.yaw_p_gain', 150).status, 'unknown');
    assert.equal(t.valueAt('p0.yaw_p_gain', 130).stored, '75');
    assert.deepEqual([t.valueAt('p0.roll_p_gain', 161).stored, t.valueAt('p0.roll_p_gain', 161).status], ['50', 'exact']);
    for (const [k, v] of [['p0.yaw_p_gain', '75'], ['p1.yaw_p_gain', '76'], ['p2.yaw_p_gain', '77']]) assert.equal(t.valueAt(k, 161).stored, v, k);
    assert.ok(!t.flags.some(f => f.type === 'L-open'));
    const open = build({ events: [ev('L', 1, '100.0', 'pgs=14'), ev('C', 2, '100.0~120.0', 's=y', 'pgs=14', 'part=1', 'n=1', 'p0.yaw_p_gain=75<70')] });
    assert.equal(open.valueAt('p0.roll_p_gain', 999).status, 'unknown');
    assert.ok(open.flags.some(f => f.type === 'L-open' && f.pgn === 14));
});

test('an array element in a y record of an L loss: the key is known again when the loss ends, the other elements from before the L', () => {
    const t = build({ events: [
        ev('L', 1, '100.0', 'pgs=14'),
        ev('C', 2, '100.0~120.0', 's=y', 'pgs=14', 'part=1', 'n=1', 'p1.iterm_relax_cutoff[1]=20<10'),
        ev('C', 3, '100.0~140.0', 's=y', 'pgs=14', 'n=1', 'p2.iterm_relax_cutoff[2]=25<15'),
    ] });
    assert.equal(t.valueAt('p1.iterm_relax_cutoff', 130).status, 'unknown', 'the loss is open');
    // stored values that no loader applied yet: pending, not unknown
    assert.deepEqual([t.valueAt('p1.iterm_relax_cutoff', 141).stored, t.valueAt('p1.iterm_relax_cutoff', 141).status], ['10,20,15', 'pending']);
    assert.deepEqual([t.valueAt('p2.iterm_relax_cutoff', 141).stored, t.valueAt('p2.iterm_relax_cutoff', 141).status], ['10,10,25', 'pending']);
    assert.deepEqual([t.valueAt('p0.iterm_relax_cutoff', 141).stored, t.valueAt('p0.iterm_relax_cutoff', 141).status], ['10,10,15', 'exact']);
    // without an L, an element of a key that is unknown stays unknown
    const u = build({ h: { body: NO_BOOT.filter(([k]) => k !== 'set@p.iterm_relax_cutoff') }, events: [ev('C', 1, '100.0~120.0', 's=u', 'n=1', 'p1.iterm_relax_cutoff[1]=20<10')] });
    assert.equal(u.valueAt('p1.iterm_relax_cutoff', 500).status, 'unknown');
});

test('u intervals: the frames between the two points are uncertain, exact after the second point', () => {
    const t = build({ events: [ev('C', 1, '200.0~210.0', 's=u', 'n=1', 'r0.roll_rc_rate=130<120')] });
    assert.deepEqual([t.valueAt('r0.roll_rc_rate', 199).stored, t.valueAt('r0.roll_rc_rate', 199).status], ['120', 'exact']);
    const mid = t.valueAt('r0.roll_rc_rate', 205);
    assert.deepEqual([mid.status, mid.old, mid.new], ['uncertain', '120', '130']);
    assert.deepEqual([t.valueAt('r0.roll_rc_rate', 210, 'sp').stored, t.valueAt('r0.roll_rc_rate', 210, 'sp').status], ['130', 'exact']);
    assert.deepEqual(t.uncertain.map(u => [u.key, u.i0, u.i1]), [['r0.roll_rc_rate', 200, 210]]);
    assert.ok(t.epochs.some(e => e.i0 === 200 && e.i1 === 210 && e.reasons.includes('uncertain')));
});

test('mixed frames (2.5) for pid_process_denom 1, 2, 3, 4 and 8: a subtask uses the new value when its tick is c or later', () => {
    for (const D of [1, 2, 3, 4, 8]) {
        const phase = PL.PHASE_OF_DENOM[D], b = phase.bb;
        for (let c = 0; c <= b; c++) {
            const t = build({ h: { denom: D }, events: [ev('C', 1, `1000.${c}`, 's=m.202', 'n=1', 'p0.yaw_p_gain=72<70'), ev('A', 2, `1000.${c}`, 'pid/0')], f: {} , frames: frames(2000) });
            assert.equal(t.bbTick, b);
            assert.equal(t.valueAt('p0.yaw_p_gain', 999).stored, '70');
            assert.equal(t.valueAt('p0.yaw_p_gain', 1001).stored, '72');
            const whole = t.valueAt('p0.yaw_p_gain', 1000);
            if (c === 0) {
                assert.deepEqual([whole.status, whole.stored], ['exact', '72'], `D ${D} c 0`);
                assert.equal(t.mixed.has(1000), false);
            } else {
                assert.deepEqual([whole.status, whole.old, whole.new], ['mixed', '70', '72'], `D ${D} c ${c}`);
                assert.equal(t.mixed.has(1000), true);
                assert.ok(t.epochs.some(e => e.i0 === 1000 && e.i1 === 1001 && e.reasons.includes('mixed')), `D ${D} c ${c}: the mixed frame is its own epoch`);
            }
            for (const [S, tick] of Object.entries(phase)) assert.equal(t.valueAt('p0.yaw_p_gain', 1000, S).stored, tick >= c ? '72' : '70', `D ${D} c ${c} ${S}`);
        }
    }
    // the gyro-filter task runs in each tick k with k % filter_denom == 0: denominator 4, filter 2, change at tick 1
    const f = build({ h: { denom: 4, fdenom: 2 }, events: [ev('C', 1, '1000.1', 's=m.2', 'n=1', 'gyro_lpf1_static_hz=120<100'), ev('A', 2, '1000.1', 'gyrof')], frames: frames(2000) });
    assert.equal(f.valueAt('gyro_lpf1_static_hz', 1000, 'filter').status, 'mixed');
    assert.equal(f.valueAt('gyro_lpf1_static_hz', 1001, 'filter').stored, '120');
});

test('pending and boot values: a loader key waits for its A record; boot keys keep the boot value until the next boot', () => {
    const t = build({ events: [
        ev('C', 1, '100.0', 's=m.202', 'n=1', 'p0.yaw_p_gain=72<70'), ev('A', 2, '120.0', 'pid/0'),
        ev('C', 3, '130.0', 's=m.202', 'n=1', 'p1.yaw_p_gain=90<70'), ev('A', 4, '130.0', 'pid/0'),
        ev('C', 5, '200.0', 's=m.211', 'n=1', 'gov_mode=DIRECT<ELECTRIC'),
        ev('C', 6, '300.0', 's=m.1', 'n=1', 'debug_mode=GYRO<NONE'),
        ev('C', 7, '400.0', 's=m.200', 'n=1', 'r0.roll_rc_rate=130<120'),
    ] });
    const p = t.valueAt('p0.yaw_p_gain', 110);
    assert.deepEqual([p.stored, p.running, p.status], ['72', '70', 'pending']);
    assert.deepEqual([t.valueAt('p0.yaw_p_gain', 150).running, t.valueAt('p0.yaw_p_gain', 150).status], ['72', 'exact']);
    assert.equal(t.valueAt('p1.yaw_p_gain', 150).status, 'pending', 'an A of slot 0 does not load slot 1');
    assert.equal(t.valueAt('p1.yaw_p_gain', 150).inForce, false);
    // gov_mode: snapshot ELECTRIC, boot.* DIRECT
    const g = t.valueAt('gov_mode', 10);
    assert.deepEqual([g.stored, g.running, g.status, g.runningSource], ['ELECTRIC', 'DIRECT', 'pending', 'boot']);
    assert.equal(t.valueAt('gov_mode', 250).status, 'exact');
    // no boot line: the snapshot is the boot value
    assert.equal(t.valueAt('debug_mode', 10).status, 'exact');
    assert.deepEqual([t.valueAt('debug_mode', 350).running, t.valueAt('debug_mode', 350).status], ['NONE', 'pending']);
    // the servo rate is a boot field of the element
    const s = t.valueAt('el.servo.1', 10);
    assert.deepEqual([s.running, s.status], ['1500,-700,700,500,500,200,0,0', 'pending']);
    assert.equal(t.valueAt('el.servo.0', 10).status, 'exact');
    // no rule: effect-unknown
    assert.deepEqual([t.valueAt('pg.18+0', 10).stored, t.valueAt('pg.18+0', 10).status], ['a0', 'effect-unknown']);
    // two consumers: the setpoint curve reads the rate live, the cyclic ring limit waits for setpointInitProfile (A sp)
    assert.equal(t.valueAt('r0.roll_rc_rate', 450, 'sp').status, 'exact');
    assert.equal(t.valueAt('r0.roll_rc_rate', 450, 'sp-ring').status, 'pending');
    // the epochs list the pending keys of the profiles in force
    const e = t.epochs.find(x => x.i0 <= 110 && x.i1 > 110);
    assert.ok(e.pending.includes('p0.yaw_p_gain') && e.pending.includes('gov_mode') && !e.pending.includes('p1.yaw_p_gain'), e.pending.join());
    assert.ok(e.reasons.includes('pending'));
});

test('a change between logs (v) before T0: a loader key is uncertain until the next A record of its loader', () => {
    const t = build({ events: [
        ev('C', 1, 'p', 's=v', 'n=1', 'p0.yaw_p_gain=74<70'),          // since the previous log: did a loader run after it?
        ev('C', 2, 'p', 's=m.202', 'n=1', 'p0.roll_p_gain=60<50'),     // in the header window by MSP, no A: the old value
        ev('A', 3, '500.0', 'pid/0'),
    ] });
    const v = t.valueAt('p0.yaw_p_gain', 100);
    assert.deepEqual([v.stored, v.running, v.status], ['74', null, 'uncertain']);
    assert.ok(v.flags.includes('apply-unknown'));
    assert.deepEqual([t.valueAt('p0.yaw_p_gain', 600).running, t.valueAt('p0.yaw_p_gain', 600).status], ['74', 'exact']);
    const m = t.valueAt('p0.roll_p_gain', 100);
    assert.deepEqual([m.stored, m.running, m.status], ['60', '50', 'pending']);
    assert.ok(m.flags.includes('assumed-at-t0'), 'no A before the point: the value that the loader read before the log');
    assert.ok(t.epochs.find(x => x.i0 <= 100 && x.i1 > 100).reasons.includes('uncertain'));
});

test('adjustment refresh (4.3): a gain setter refreshes at once; the setpoint-boost setter does not, except with fix c3', () => {
    const events = [ev('C', 1, '300.0', 's=a.18', 'n=1', 'p0.roll_p_gain=60<50'), ev('C', 2, '310.0', 's=a.68', 'n=1', 'r0.setpoint_boost_gain[1]=20<0')];
    const t = build({ events });
    assert.deepEqual([t.valueAt('p0.roll_p_gain', 350).running, t.valueAt('p0.roll_p_gain', 350).status], ['60', 'exact']);
    assert.equal(t.valueAt('r0.setpoint_boost_gain', 350).stored, '0,20,0,0');
    assert.equal(t.valueAt('r0.setpoint_boost_gain[1]', 350).stored, '20');
    assert.equal(t.valueAt('r0.setpoint_boost_gain', 350).status, 'pending');
    const c3 = build({ events, fixes: ['c3'] });
    assert.equal(c3.valueAt('r0.setpoint_boost_gain', 350).status, 'exact');
    // 76: idle and auto throttle refresh together, although boot-cached (governor.c:1359-1377)
    const gov = build({ events: [ev('C', 1, '100.0', 's=a.76', 'n=1', 'gov_idle_throttle=30<25')], h: { body: BODY.concat([['set.gov_idle_throttle', '25'], ['set.gov_auto_throttle', '10']]) } });
    assert.equal(gov.valueAt('gov_idle_throttle', 150).status, 'exact');
});

test('chain-mismatch: a C.old that differs from the believed value makes the key unknown back to its last record; not before T0', () => {
    const t = build({ events: [
        ev('C', 1, 'p', 's=v', 'n=1', 'deadband=5<9'),                        // before T0: a header line can come after the change
        ev('C', 2, '100.0', 's=m.202', 'n=1', 'p0.yaw_p_gain=72<70'), ev('A', 3, '100.0', 'pid/0'),
        ev('C', 4, '300.0', 's=m.202', 'n=1', 'p0.yaw_p_gain=80<75'), ev('A', 5, '300.0', 'pid/0'),
    ] });
    const flags = t.flags.filter(f => f.type === 'chain-mismatch');
    assert.deepEqual(flags.map(f => [f.key, f.expected, f.found]), [['p0.yaw_p_gain', '72', '75']]);
    assert.equal(t.valueAt('p0.yaw_p_gain', 99).stored, '70');
    assert.equal(t.valueAt('p0.yaw_p_gain', 200).status, 'unknown');
    assert.deepEqual([t.valueAt('p0.yaw_p_gain', 301).stored, t.valueAt('p0.yaw_p_gain', 301).status], ['80', 'exact']);
    assert.equal(t.valueAt('deadband', 10).stored, '5');
    assert.equal(t.t0State.get('deadband'), '5');
    assert.ok(t.epochs.some(e => e.reasons.includes('chain-mismatch')));
});

test('profile index (2.6.8): the S-frame pidProfile is checked against the pid_profile items', () => {
    const events = [ev('C', 1, '500.0', 's=a.2', 'n=1', 'pid_profile=1<0'), ev('A', 2, '500.0', 'pid/1')];
    const ok = build({ events, f: { pid: (i) => i < 500 ? 0 : 1 } });
    assert.equal(ok.flags.filter(f => f.type === 'chain-mismatch').length, 0);
    assert.equal(ok.valueAt('pid_profile', 600).stored, '1');
    const bad = build({ events, f: { pid: () => 0 } });
    const f = bad.flags.filter(x => x.type === 'chain-mismatch');
    assert.deepEqual(f.map(x => [x.key, x.i0, x.i1, x.stored, x.frame]), [['pid_profile', 500, 1000, '1', 0]]);
});

test('order-unknown (3.6): a C with the same point after an A whose loader reads the key', () => {
    const t = build({ events: [ev('A', 1, '100.1', 'pid/0'), ev('C', 2, '100.1', 's=m.202', 'n=1', 'p0.yaw_p_gain=72<70')] });
    assert.ok(t.flags.some(f => f.type === 'order-unknown' && f.key === 'p0.yaw_p_gain'));
    const v = t.valueAt('p0.yaw_p_gain', 150);
    assert.deepEqual([v.status, v.flags], ['uncertain', ['order-unknown']]);
});

test('transition frames: a live key of the RX task is uncertain for one RX period after its point', () => {
    const t = build({ events: [ev('C', 1, '300.0', 's=m.1', 'n=1', 'rc_center=1510<1500')] });   // frames 1 ms apart
    assert.deepEqual(t.valueAt('rc_center', 310, 'rx').flags, ['transition']);
    assert.equal(t.valueAt('rc_center', 310, 'rx').status, 'uncertain');
    assert.equal(t.valueAt('rc_center', 340, 'rx').status, 'exact');
    assert.equal(t.valueAt('rc_center', 340, 'rx').stored, '1510');
    assert.ok(t.epochs.some(e => e.i0 === 331), 'an epoch starts after the transition');
    // the frames are in transitions and uncertain, and their epoch is uncertain (2.5, 4.6: datasets removes them)
    assert.deepEqual(t.transitions.map(x => [x.key, x.consumer, x.i0, x.i1]), [['rc_center', 'rx', 300, 331]]);
    assert.ok(t.uncertain.some(x => x.key === 'rc_center' && x.i0 === 300 && x.i1 === 331 && x.reason === 'transition'));
    const e = t.epochs.find(x => x.i0 === 300);
    assert.deepEqual([e.i1, e.status, e.uncertain], [331, 'uncertain', ['rc_center']]);
    assert.ok(e.reasons.includes('uncertain'));
    assert.ok(!t.epochs.find(x => x.i0 === 331).reasons.includes('uncertain'));
    // an ACC trim: one ACC period (1 ms) after the point
    const acc = build({ h: { body: NO_BOOT.concat([['set.acc_trim_roll', '0']]) }, events: [ev('C', 1, '300.0', 's=a.65', 'n=1', 'acc_trim_roll=5<0')] });
    assert.deepEqual(acc.transitions.map(x => [x.key, x.consumer, x.i0, x.i1]), [['acc_trim_roll', 'acc', 300, 301]]);
});

test('fingerprints (4.3 step 6): an R change with no A or refreshing adjustment in its interval is unexplained-runtime; an A whose fp did not change after a change that its loader applies is table-suspect', () => {
    const t = build({ events: [
        ev('R', 1, 'p', 'fp.pid=aaaa0001', 'fp.gov=bbbb0001', 'fp.sp=cccc0001'),
        ev('R', 2, '500.0~520.0', 'fp.pid=aaaa0002'),
        ev('R', 3, '600.0~620.0', 'fp.gov=bbbb0002'), ev('A', 4, '610.0', 'gov/0', 'fp=bbbb0002'),
    ] });
    const u = t.flags.filter(f => f.type === 'unexplained-runtime');
    assert.deepEqual(u.map(f => [f.module, f.seq]), [['pid', 2]]);
    assert.ok(t.epochs.some(e => e.i0 >= 500 && e.reasons.includes('unexplained-runtime')));
    const s = build({ events: [
        ev('A', 1, '100.0', 'pid/0', 'fp=11111111'),
        ev('C', 2, '200.0', 's=m.202', 'n=1', 'p0.yaw_p_gain=72<70'), ev('A', 3, '200.0', 'pid/0', 'fp=11111111'),
        ev('C', 4, '300.0', 's=m.202', 'n=1', 'p0.yaw_p_gain=74<72'), ev('A', 5, '300.0', 'pid/0', 'fp=22222222'),
    ] });
    assert.deepEqual(s.flags.filter(f => f.type === 'table-suspect').map(f => [f.loader, f.seq, f.keys]), [['pid', 3, ['p0.yaw_p_gain']]]);
    // an adjustment of module sp that the table says refreshes nothing (9, roll rc rate) does not explain an fp.sp change
    const rate = [ev('R', 1, 'p', 'fp.sp=33333333'), ev('C', 2, '100.0', 's=a.9', 'n=1', 'r0.roll_rc_rate=130<120'), ev('R', 3, '100.0~104.0', 'fp.sp=44444444')];
    assert.deepEqual(build({ events: rate }).flags.filter(f => f.type === 'unexplained-runtime').map(f => [f.module, f.seq]), [['sp', 3]]);
    // with fix c4 the rate setter applies the sp loader; a gain setter (18) refreshes a pid field
    assert.equal(build({ events: rate, fixes: ['c4'] }).flags.filter(f => f.type === 'unexplained-runtime').length, 0);
    const gain = [ev('R', 1, 'p', 'fp.pid=33333333'), ev('C', 2, '100.0', 's=a.18', 'n=1', 'p0.roll_p_gain=60<50'), ev('R', 3, '100.0~104.0', 'fp.pid=44444444')];
    assert.equal(build({ events: gain }).flags.filter(f => f.type === 'unexplained-runtime').length, 0);
});

test('a lost record after the last A of a loader: the running value is unknown (lost) until the next A of that loader (2.6.5)', () => {
    // seq 3 was the A that applied 72: the running value is 72 (pending), not 70 (exact)
    const t = build({ h: { body: NO_BOOT }, events: [ev('A', 1, '50.0', 'pid/0'), ev('C', 2, '100.0', 's=m.202', 'n=1', 'p0.yaw_p_gain=72<70'),
        ev('C', 4, '300.0', 's=m.202', 'n=1', 'p0.yaw_p_gain=70<72'), ev('A', 5, '600.0', 'pid/0')] });
    const v = t.valueAt('p0.yaw_p_gain', 400);
    assert.deepEqual([v.stored, v.running, v.status, v.flags], ['70', null, 'unknown', ['lost']]);
    assert.equal(t.valueAt('p0.yaw_p_gain', 99).running, '70', 'before the earliest point of the lost record');
    assert.deepEqual([t.valueAt('p0.yaw_p_gain', 650).running, t.valueAt('p0.yaw_p_gain', 650).status], ['70', 'exact'], 'the next A after the loss');
    assert.ok(t.epochs.find(e => e.i0 <= 400 && e.i1 > 400).reasons.includes('lost'));
    // no A before the loss: not assumed at T0
    const noA = build({ h: { body: NO_BOOT }, events: [ev('C', 1, '100.0', 's=m.202', 'n=1', 'p0.yaw_p_gain=72<70'), ev('C', 3, '300.0', 's=m.202', 'n=1', 'p0.yaw_p_gain=70<72')] });
    assert.deepEqual([noA.valueAt('p0.yaw_p_gain', 400).running, noA.valueAt('p0.yaw_p_gain', 400).status], [null, 'unknown']);
    // a boot key that an adjustment refreshes (76: gov_idle_throttle): a lost record can be that adjustment
    const gov = build({ h: { body: NO_BOOT.concat([['set.gov_idle_throttle', '25'], ['set.gov_auto_throttle', '10']]) },
        events: [ev('C', 1, '100.0', 's=m.1', 'n=1', 'deadband=3<2'), ev('C', 3, '300.0', 's=m.1', 'n=1', 'gov_idle_throttle=30<25')] });
    assert.deepEqual([gov.valueAt('gov_idle_throttle', 400).running, gov.valueAt('gov_idle_throttle', 400).flags], [null, ['lost']]);
    assert.equal(gov.valueAt('gov_mode', 400).status, 'unknown');
    assert.equal(gov.valueAt('debug_mode', 400).status, 'unknown', 'stored unknown after the loss (no later C item)');
    // an L lists bytes only: a lost A record uses its SEQ (firmware recBegin), so an L does not hide one
    const l = build({ h: { body: NO_BOOT }, events: [ev('C', 1, '50.0', 's=m.202', 'n=1', 'p0.yaw_p_gain=71<70'), ev('A', 2, '50.0', 'pid/0'),
        ev('L', 3, '100.0', 'pgs=14'), ev('C', 4, '100.0~120.0', 's=y', 'n=1', 'p0.yaw_p_gain=75<71')] });
    assert.deepEqual([l.valueAt('p0.roll_p_gain', 200).running, l.valueAt('p0.roll_p_gain', 200).status], ['50', 'exact']);
});

test('an A before T0, then a C before T0 of a key that it reads: the A read the old value of that C, not the snapshot line', () => {
    const events = [ev('A', 1, 'p', 'pid/0'), ev('C', 2, 'p', 's=m.202', 'n=1', 'p0.yaw_p_gain=80<70')];
    for (const line of ['80|||80||', '70|||80||']) {   // the snapshot line printed after or before the change (2.2)
        const t = build({ h: { body: NO_BOOT.map(([k, v]) => k === 'set@p.yaw_p_gain' ? [k, line] : [k, v]) }, events, f: { seq: () => 2 } });
        const v = t.valueAt('p0.yaw_p_gain', 100);
        assert.deepEqual([v.stored, v.running, v.status], ['80', '70', 'pending'], line);
    }
});

test('pre-T0 records u after m with no A: the running value is apply-unknown for any u, v or y record before T0, not only the first', () => {
    for (const events of [[ev('C', 1, 'p', 's=m.202', 'n=1', 'p0.yaw_p_gain=72<70'), ev('C', 2, 'p', 's=u', 'n=1', 'p0.yaw_p_gain=74<72')],
        [ev('C', 1, 'p', 's=u', 'n=1', 'p0.yaw_p_gain=72<70'), ev('C', 2, 'p', 's=m.202', 'n=1', 'p0.yaw_p_gain=74<72')]]) {
        const v = build({ h: { body: NO_BOOT }, events }).valueAt('p0.yaw_p_gain', 100);
        assert.deepEqual([v.stored, v.running, v.status, v.flags], ['74', null, 'uncertain', ['apply-unknown']]);
    }
});

test('an interval with a loss or an L point inside: uncertain from its start, then unknown from the loss, exact at its end (2.5, 2.6.5)', () => {
    // seq 2 is lost (unknown from the point of seq 1), the u record of seq 3 started before it
    const t = build({ h: { body: NO_BOOT }, events: [ev('C', 1, '200.0', 's=m.1', 'n=1', 'yaw_deadband=4<3'), ev('C', 3, '100.0~300.0', 's=u', 'n=1', 'deadband=3<2')] });
    assert.deepEqual([t.valueAt('deadband', 99).status, t.valueAt('deadband', 99).stored], ['exact', '2']);
    for (const i of [100, 150, 199]) assert.deepEqual([t.valueAt('deadband', i).status, t.valueAt('deadband', i).old, t.valueAt('deadband', i).new], ['uncertain', '2', '3'], `frame ${i}`);
    assert.equal(t.valueAt('deadband', 250).status, 'unknown');
    assert.equal(t.valueAt('deadband', 300).stored, '3');
    // an L of the deadband PG inside a y interval
    const y = build({ h: { body: NO_BOOT }, events: [ev('C', 1, '50.0', 's=m.1', 'n=1', 'deadband=3<2'), ev('L', 2, '200.0', 'pgs=25'), ev('C', 3, '150.0~300.0', 's=y', 'n=1', 'deadband=4<3')] });
    assert.equal(y.valueAt('deadband', 140).stored, '3');
    for (const i of [160, 199]) assert.deepEqual([y.valueAt('deadband', i).status, y.valueAt('deadband', i).old, y.valueAt('deadband', i).new], ['uncertain', '3', '4'], `frame ${i}`);
    assert.equal(y.valueAt('deadband', 250).status, 'unknown');
    assert.deepEqual([y.valueAt('deadband', 300).stored, y.valueAt('deadband', 300).status], ['4', 'pending'], 'stored exact, the act loader did not run');
});

test('a change at c > 0 to a slot that is not in force: frame N is not mixed; an A of the slot in force is', () => {
    const t = build({ h: { body: NO_BOOT }, events: [ev('C', 1, '500.1', 's=m.202', 'n=1', 'p3.yaw_p_gain=72<80'), ev('A', 2, '500.1', 'pid/3')] });
    assert.equal(t.valueAt('p3.yaw_p_gain', 500).inForce, false);
    const e = t.epochs.find(x => x.i0 === 500);
    assert.deepEqual([e.i1, e.reasons, e.mixed], [501, [], []]);
    assert.deepEqual([...t.mixedKeys.get(500)], ['p3.yaw_p_gain']);
    const active = build({ h: { body: NO_BOOT }, events: [ev('A', 1, '500.1', 'pid/0')] });
    assert.ok(active.epochs.find(x => x.i0 === 500).reasons.includes('mixed'), 'the running values of the slot in force can change during the frame');
    const own = build({ h: { body: NO_BOOT }, events: [ev('C', 1, '500.1', 's=m.202', 'n=1', 'p0.yaw_p_gain=72<70'), ev('A', 2, '500.1', 'pid/0')] });
    assert.deepEqual(own.epochs.find(x => x.i0 === 500).mixed, ['p0.yaw_p_gain']);
});

// ---- classic keys (4.4) ---------------------------------------------------------------------------------------------------

const CLASSIC_BODY = BODY.concat([
    ['set@p.pitch_p_gain', '40|||||'], ['set@p.pitch_i_gain', '90|||||'], ['set@p.pitch_d_gain', '5|||||'], ['set@p.pitch_f_gain', '15|||||'], ['set@p.pitch_b_gain', '0|||||'],
    ['set@p.gov_i_gain', '50|||||'], ['set@p.gov_d_gain', '0|||||'], ['set@p.gov_f_gain', '10|||||'], ['set@p.gov_gain', '100|||||'],
    ['set@p.roll_gyro_cutoff', '200|||||'], ['set@p.roll_d_cutoff', '15|||||'], ['set@p.roll_b_cutoff', '15|||||'],
    ['set.min_throttle', '1070'], ['set.max_throttle', '2000'],
]);
const CLASSIC_LINES = [['rollPID', '50,100,10,20,0'], ['pitchPID', '40,90,5,15,0'], ['govPID', '40,50,0,10,100'], ['rollBW', '200,15,15'],
    ['rates_type', '6'], ['rc_rates', '120,120,200'], ['deadband', '2'], ['yaw_deadband', '3'], ['gyro_lpf1_type', '3'], ['gyro_lpf1_static_hz', '100'],
    ['acc_lpf_hz', '1000'], ['collectiveRange', '-200,200'], ['features', '8'], ['debug_mode', '0'], ['debug_axis', '0'], ['pid_process_denom', '2'],
    ['filter_process_denom', '1'], ['looptime', '125'], ['iterm_relax_cutoff', '10,10,15'], ['minthrottle', '1070'], ['maxthrottle', '2000']];

test('classic(): the classic header keys from the journal equal the classic header lines (self-test), and follow the records', () => {
    const t = build({ h: { body: CLASSIC_BODY }, events: [ev('C', 1, '500.0', 's=m.202', 'n=1', 'p0.roll_p_gain=60<50'), ev('A', 2, '500.0', 'pid/0')] });
    const st = PL.selfTest(t, CLASSIC_LINES);
    assert.equal(st.ok, true, JSON.stringify(st.mismatches));
    assert.equal(st.compared, CLASSIC_LINES.length);
    const later = t.classic(600);
    assert.equal(later.rollPID, '60,100,10,20,0');
    assert.equal(t.classic(100).rollPID, '50,100,10,20,0');
    assert.equal(later.rates_type, '6');
    // looptime: the classic line is the sample looptime, param_rt looptime is pid_denom times it (firmware header: pid_denom=2, looptime=250)
    assert.equal(t.header.rt.looptime, 250);
    assert.equal(t.classicAtHeader().looptime, '125');
    assert.equal(PL.selfTest(t, [['looptime', '125'], ['pid_process_denom', '2']]).ok, true);
    assert.equal(build({ h: { body: CLASSIC_BODY, denom: 4 } }).classicAtHeader().looptime, '125');
    // a wrong classic line is found
    const wrong = PL.selfTest(t, CLASSIC_LINES.map(([k, v]) => [k, k === 'deadband' ? '5' : v]));
    assert.deepEqual(wrong.mismatches.map(m => [m.key, m.explained]), [['deadband', false]]);
    assert.equal(wrong.ok, false);
    // a record before T0 explains a mismatch: the classic line came before the change, the snapshot line after it
    const pre = build({ h: { body: CLASSIC_BODY.map(([k, v]) => k === 'set.deadband' ? [k, '4'] : [k, v]) }, events: [ev('C', 1, 'p', 's=m.1', 'n=1', 'deadband=4<2')] });
    const ex = PL.selfTest(pre, CLASSIC_LINES);
    assert.deepEqual(ex.mismatches.map(m => [m.key, m.explained]), [['deadband', true]]);
    assert.equal(ex.ok, true);
    // the slot of the frame: the S-frame PID profile
    const slot = build({ h: { body: CLASSIC_BODY }, f: { pid: (i) => i < 500 ? 0 : 3 } });
    assert.equal(slot.classic(600).rollPID, '53,100,10,20,0', 'PID profile 4 has roll_p_gain 53');
    assert.equal(slot.classic(100).rollPID, '50,100,10,20,0');
});

test('classicFromSysConfig maps the renamed and split keys of the decoder', () => {
    const sc = Object.create({ inherited: 1 });
    Object.assign(sc, { rollPID: [50, 100, 10, 20, 0], gyro_soft_type: 3, vbatmincellvoltage: 330, vbatwarningcellvoltage: 350, vbatmaxcellvoltage: 430, currentMeterOffset: 0, currentMeterScale: 400, features: 8 });
    const c = PL.classicFromSysConfig(sc);
    assert.deepEqual([c.rollPID, c.gyro_lpf1_type, c.vbatcellvoltage, c.currentSensor, c.features], ['50,100,10,20,0', '3', '330,350,430', '0,400', '8']);
    assert.equal(c.inherited, undefined);
});

// ---- epochs and param_epochs (4.2, 4.5) -----------------------------------------------------------------------------------

test('epochs: boundaries at records, profile and arm changes and LOGGING_RESUME; param_epochs gives 1-based profiles, arms and the C records', () => {
    const events = [ev('R', 1, 'p', 'fp.pid=aaaa0001'), ev('C', 2, '500.0', 's=a.2', 'n=1', 'pid_profile=1<0'), ev('A', 3, '500.0', 'pid/1', 'fp=aaaa0002'),
        ev('C', 4, '700.0', 's=m.202', 'n=1', 'p1.yaw_p_gain=75<70'), ev('A', 5, '700.0', 'pid/1', 'fp=aaaa0003')];
    const f = frames(1000, { pid: (i) => i < 500 ? 0 : 1, armed: (i) => i >= 100 && i < 900 ? 1 : 0, seq: (i) => i < 500 ? 1 : i < 700 ? 3 : 5 });
    const t = PL.buildTimeline({ header: headerLines({ body: NO_BOOT }), records: PL.assemble(events), frames: f, semantics: SEM(), resumes: [800] });
    assert.deepEqual(t.epochs.map(e => [e.i0, e.i1]), [[0, 100], [100, 500], [500, 700], [700, 800], [800, 900], [900, 1000]]);
    assert.deepEqual(t.epochs.map(e => e.reasons.join()), ['', '', '', '', 'resume', 'resume']);
    assert.deepEqual(t.epochs.map(e => e.records), [[], [], [2], [4], [], []]);
    const frameS = Float64Array.from(f.time, x => (x - f.time[0]) / 1e6);
    const spans = PE.paramEpochs({ timeline: t, frameS });
    assert.deepEqual(spans.map(s => [s.t0, s.t1, s.arm, s.armed, s.pidProfile, s.rateProfile, s.fresh, s.check]), [
        [0, 0.1, 0, false, 1, 1, true, 'journal'], [0.1, 0.5, 0, true, 1, 1, true, 'journal'], [0.5, 0.7, 0, true, 2, 1, true, 'journal'],
        [0.7, 0.8, 0, true, 2, 1, true, 'journal'], [0.8, 0.9, 0, true, 2, 1, false, 'journal'], [0.9, 0.999, 0, false, 2, 1, false, 'journal']]);
    assert.deepEqual(spans[3].adjust.map(a => [a.seq, a.src, a.items[0].key, a.func, a.name, a.value]), [[4, 'm', 'p1.yaw_p_gain', null, 'p1.yaw_p_gain', '75']]);
    assert.deepEqual(spans[2].adjust.map(a => [a.func, a.name, a.value]), [[2, 'pid_profile', '1']], 'src a: func is the adjustment function');
    assert.deepEqual(Object.keys(spans[0].keys), ['unknown', 'pending', 'uncertain', 'mixed']);
    assert.deepEqual(spans[4].reasons, ['resume']);
    assert.deepEqual(Object.keys(spans[0]).sort(), ['adjust', 'arm', 'armed', 'check', 'fresh', 'keys', 'pidProfile', 'rateProfile', 'reasons', 'seq', 'status', 't0', 't1']);
    // a second arm
    const two = PL.buildTimeline({ header: headerLines(), records: PL.assemble([]), frames: frames(300, { armed: (i) => i < 100 || i >= 200 ? 1 : 0 }), semantics: SEM() });
    assert.deepEqual(PE.paramEpochs({ timeline: two }).map(s => [s.arm, s.armed]), [[0, true], [0, false], [1, true]]);
});

test('CHANGES mode and an incomplete snapshot: snapshot-incomplete in each epoch; a key with no line is unknown until a record sets it (2.6.3)', () => {
    const ch = build({ h: { mode: 'CHANGES' }, events: [ev('C', 1, '100.0', 's=m.202', 'n=1', 'p0.yaw_p_gain=72<70'), ev('A', 2, '100.0', 'pid/0')] });
    assert.equal(ch.mode, 'CHANGES');
    assert.ok(ch.epochs.every(e => e.reasons.includes('snapshot-incomplete')));
    const before = ch.valueAt('p0.yaw_p_gain', 50);
    assert.deepEqual([before.stored, before.status, before.verified], [null, 'unknown', false], 'not exact from T0 with the old value of a mid-log record');
    assert.deepEqual(ch.unknown.filter(u => u.key === 'p0.yaw_p_gain').map(u => [u.i0, u.i1, u.reason]), [[0, 100, 'snapshot']]);
    assert.deepEqual([ch.valueAt('p0.yaw_p_gain', 150).stored, ch.valueAt('p0.yaw_p_gain', 150).status], ['72', 'exact']);
    // a record before T0 sets the key for every frame
    const pre = build({ h: { mode: 'CHANGES' }, events: [ev('C', 1, 'p', 's=m.202', 'n=1', 'p0.yaw_p_gain=72<70')] });
    assert.deepEqual([pre.valueAt('p0.yaw_p_gain', 0).stored, pre.valueAt('p0.yaw_p_gain', 0).status], ['72', 'pending']);
    assert.equal(pre.valueAt('p0.yaw_p_gain', 0).running, '70');
    assert.equal(ch.valueAt('deadband', 50).status, 'unknown');
    assert.equal(ch.complete, false);
    // the classic header gives a hint, "header, not verified"
    const sc = { paramHeader: headerLines({ mode: 'CHANGES' }), deadband: 2, 'Firmware revision': 'Rotorflight 4.6.0 (118e912) STM32G47X' };
    const hinted = PL.buildTimeline({ sysConfig: sc, records: PL.assemble([ev('C', 1, '100.0', 's=m.1', 'n=1', 'yaw_deadband=4<3')]), frames: frames(200) });
    assert.equal(hinted.valueAt('deadband', 50).hint, '2');
    assert.equal(hinted.valueAt('deadband', 50).status, 'unknown');
    const bad = build({ h: { endHash: 1 } });
    assert.equal(bad.header.complete, false);
    assert.equal(bad.valueAt('deadband', 50).verified, false);
    assert.ok(bad.epochs.every(e => e.reasons.includes('snapshot-incomplete')));
});

test('the stock fallback: no timeline for a stock log, and param_epochs without a timeline is unchanged', () => {
    assert.equal(PL.buildTimeline({ header: [], frames: frames(10) }), null);
    assert.equal(PL.buildTimeline({ sysConfig: { unknownHeaders: [] }, frames: frames(10) }), null);
    const spans = PE.paramEpochs({ events: [], frameS: Float64Array.from({ length: 101 }, (_, i) => i / 10), profileAtStart: 1 });
    assert.deepEqual(spans.map(s => [s.t0, s.t1, s.check, s.fresh]), [[0, 10, null, true]]);
});

// ---- the decoder (spec 4.1) ------------------------------------------------------------------------------------------------

function decoder() {
    const lib = require(path.resolve(__dirname, '../tools/autotune/lib.cjs'));
    return lib.loadApp();
}
function decode(app, bytes) {
    app.__bytes = bytes;
    const log = vm.runInContext('new FlightLog(__bytes)', app);
    assert.ok(log.openLog(0));
    const frames = [], events = [], gaps = [];
    for (const c of log.getChunksInTimeRange(log.getMinTime(), log.getMaxTime())) {
        for (const k in c.gapStartsHere) gaps.push(frames.length + (+k));
        for (const f of c.frames) frames.push([f[0], f[1]]);
        for (const e of c.events) events.push(e);
    }
    return { log, sc: log.getSysConfig(), frames, events, gaps };
}
// the offset of the first byte after the header lines ("H ...\n")
function headerEnd(bytes) { let i = 0; while (bytes[i] === 0x48 && bytes[i + 1] === 0x20) { while (bytes[i] !== 0x0a) i++; i++; } return i; }

test('decoder: the parameter header lines go to sysConfig.paramHeader in order, not to unknownHeaders', () => {
    const enc = require(path.resolve(__dirname, 'helpers/bbl_encode.cjs'));
    const sim = enc.simulateFlight({ seconds: 1, airborne: null });
    const lines = headerLines({ mode: 'CHANGES', extra: [['future_key', '7']] });
    sim.header = Object.assign({}, sim.header, { 'set.before': '1' }, Object.fromEntries(lines), { unknown_after: 'x' });
    const app = decoder(), d = decode(app, enc.encode([sim]).bytes);
    assert.deepEqual(JSON.parse(JSON.stringify(d.sc.paramHeader)), [['set.before', '1']].concat(lines));
    assert.ok(!(d.sc.unknownHeaders || []).some(u => /^(?:Param log|param_|set\.|future_key)/.test(u.name)));
    assert.ok((d.sc.unknownHeaders || []).some(u => u.name === 'unknown_after'), 'a key after param_end is an unknown header again');
    const h = PL.parseParamHeader(d.sc.paramHeader);
    assert.equal(h.complete, true, 'the hash agrees over the decoded lines');
    assert.equal(PL.isParamLog(d.sc), true);
    // a second log of the file has its own array
    const stock = enc.simulateFlight({ seconds: 1, airborne: null });
    app.__bytes = enc.encode([sim, stock]).bytes;
    const two = vm.runInContext('new FlightLog(__bytes)', app);
    assert.ok(two.openLog(1));
    assert.equal(two.getSysConfig().paramHeader, undefined);
});

test('decoder: events before the first I-frame are kept in chunk 0 with the time of the first frame; frames, times and gaps do not change', () => {
    const enc = require(path.resolve(__dirname, 'helpers/bbl_encode.cjs'));
    const sim = enc.simulateFlight({ seconds: 2, airborne: null });
    const plain = enc.encode([sim]).bytes, at = headerEnd(plain);
    // SYNC_BEEP (0) with its own time, GOVERNOR_STATE (50) = 3 and an event-101 string, before the S-frame and the first I-frame
    const text = ev('R', 1, 'p', 'fp.pid=aaaa0001');
    const extra = [0x45, 0, 0xc0, 0x84, 0x3d, 0x45, 50, 3, 0x45, 101, text.length, ...Buffer.from(text, 'latin1')];
    const bytes = new Uint8Array(plain.length + extra.length);
    bytes.set(plain.subarray(0, at)); bytes.set(extra, at); bytes.set(plain.subarray(at), at + extra.length);
    const app = decoder(), a = decode(app, plain), b = decode(app, bytes);
    assert.deepEqual(b.frames, a.frames);
    assert.deepEqual(b.gaps, a.gaps);
    assert.deepEqual([b.log.getMinTime(), b.log.getMaxTime()], [a.log.getMinTime(), a.log.getMaxTime()]);
    const first = b.events.slice(0, 3);
    assert.deepEqual(first.map(e => e.event), [0, 50, 101]);
    assert.ok(first.every(e => e.time === b.frames[0][1]), 'the time of the first frame');
    assert.equal(first[0].data.time, 1000000, 'the beep keeps its own time in data.time');
    assert.equal(first[1].data.govState, 3);
    assert.equal(first[2].data.string, text);
    assert.deepEqual(b.events.slice(3).map(e => [e.event, e.time]), a.events.map(e => [e.event, e.time]));
    assert.equal(b.log.getActivitySummary().hasEvent[0], true);
    // collect() reads the string for the journal
    const got = PL.collect(b.log);
    assert.deepEqual(got.strings.map(s => s.text), [text]);
    assert.equal(got.frames.iter.length, b.frames.length);
});

// ---- the viewer: graph markers (js/grapher.js) and the header dialog (js/header_dialog.js) -----------------------------------

function viewerScript(file, extra) {
    const context = vm.createContext(Object.assign({}, extra || {}));
    const fs = require('node:fs'), full = path.resolve(__dirname, '..', file);
    vm.runInContext(fs.readFileSync(full, 'utf8'), context, { filename: full });
    return context;
}

test('graph markers: the grapher reads a record as good only when param_log.cjs does (the same grammar, AT and CRC)', () => {
    const G = viewerScript('js/grapher.js', { FlightLogEvent: { CUSTOM_STRING: 101 } }).ParamJournalMarks;
    const withCrc = (body) => `${body}*${crc(body).toString(16).toUpperCase().padStart(2, '0')}`;
    const strings = [ev('C', 0x1a, '48211.1', 's=m.202', 'n=1', 'p0.yaw_p_gain=72<70'), ev('+', 5, '100.1', 'p0.roll_d_gain=12<10'),
        ev('A', 2, '100.0', 'pid/0', 'fp=9C3A11F0'), ev('C', 3, '83000.0~83022.0', 's=u', 'n=1', 'r0.cyclic_ring=150<140'), ev('C', 4, 'p', 's=v', 'n=1', 'deadband=3<2'),
        withCrc('PC1 x s=m n=1 a=1<0'), withCrc('PC1 1.0.0 s=m n=1 a=1<0'), withCrc('PC1  s=m n=1 a=1<0'), withCrc('PC1 ~1.0 s=m n=1 a=1<0'),
        'PC1 100.0 s=m n=1 x=1<0', 'PC1 100.0 s=m n=1 x=1<0*zz', ev('C', 6, '1.0', 's=m.1', 'n=1', 'deadband=3<2').toLowerCase(),
        ev('C', 7, '1.0', 's=m.1', 'n=1', 'deadband=3<2').replace('3<2', '4<2'), 'Hello world', 'PX1 100.0*00', 'P*'];
    for (const text of strings) {
        const a = PL.parseRecord(text), b = G.parse(text);
        assert.equal(b === null, a === null, text);
        if (!a) continue;
        assert.deepEqual([b.type, b.seq, b.crcOk], [a.type, a.seq, a.crcOk], text);
        if (a.crcOk) assert.deepEqual(JSON.parse(JSON.stringify(b.items)), a.items.map(it => [it.key, it.value, it.old]), text);
    }
    assert.equal(G.parse(withCrc('PC1 x s=m n=1 a=1<0')).crcOk, false, 'a bad AT with a correct CRC');
    assert.equal(G.crc8('123456789'), 0xBC);
});

test('graph markers: labels and groups of C records at the same point', () => {
    const G = viewerScript('js/grapher.js', { FlightLogEvent: { CUSTOM_STRING: 101 } }).ParamJournalMarks;
    const E = (text) => ({ event: 101, data: { string: text } });
    const label = (text) => G.label(G.parse(text));
    assert.equal(label(ev('C', 1, '100.0', 's=m.202', 'n=1', 'p0.yaw_p_gain=72<70')), 'PID profile 1: "yaw_p_gain" 70 to 72');
    assert.equal(label(ev('C', 1, '100.0', 's=a.2', 'n=1', 'pid_profile=1<0')), 'PID profile 1 to PID profile 2');
    assert.equal(label(ev('C', 1, '100.0', 's=a.1', 'n=1', 'rate_profile=2<0')), 'Rate profile 1 to rate profile 3');
    assert.equal(label(ev('C', 1, '100.0', 's=m.1', 'n=1', 'gov_mode=DIRECT<ELECTRIC')), '"gov_mode" "ELECTRIC" to "DIRECT"');
    assert.equal(label(ev('C', 1, '100.0~120.0', 's=u', 'n=1', 'r5.roll_rc_rate=130<120')), 'Rate profile 6: "roll_rc_rate" 120 to 130 (time in an interval)');
    assert.equal(label(ev('C', 1, '100.0', 's=m.1', 'n=3', 'deadband=3<2')), '"deadband" 2 to 3 (and 2 more)');
    assert.equal(label(ev('C', 1, '100.0', 's=m.1', 'n=1', 'deadband=3<2').replace('3<2', '4<2')), 'Parameter record with a CRC error');
    // a group: C records at the same point with only journal records between them; the A is not drawn
    const events = [E(ev('C', 1, '100.0', 's=m.202', 'n=2', 'p0.roll_p_gain=60<50', 'p0.roll_i_gain=110<100')), E(ev('A', 2, '100.0', 'pid/0')),
        E(ev('C', 3, '100.0', 's=m.202', 'n=1', 'p0.roll_d_gain=12<10')), E(ev('C', 4, '200.0', 's=m.1', 'n=1', 'deadband=3<2')),
        { event: 13, data: {} }, E('not a record')];
    G.group(events);
    const recs = events.map(e => G.recordOf(e));
    assert.deepEqual(JSON.parse(JSON.stringify(recs.map(r => r && [r.type, !!r.grouped]))), [['C', false], ['A', false], ['C', true], ['C', false], null, null]);
    assert.equal(G.label(recs[0]), 'PID profile 1: "roll_p_gain" 50 to 60 (and 2 more)');
    assert.equal(G.label(recs[3]), '"deadband" 2 to 3');
    assert.equal(events[0].paramRecord, recs[0], 'kept on the event');
});

test('header dialog: names and values from the log are escaped before they go into HTML', () => {
    const H = viewerScript('js/header_dialog.js');
    assert.equal(H.escapeHeaderText(`<b a="x">&'`), '&lt;b a=&quot;x&quot;&gt;&amp;&#39;');
    assert.equal(H.escapeHeaderText(5), '5');
    const html = H.paramHeaderHtml([['set.x<y>', '<script>alert(1)</script>'], ['Param log', '1']]);
    assert.ok(!/<script>|<y>/.test(html), html);
    assert.ok(html.includes('<code>set.x&lt;y&gt;</code>') && html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(html.includes('Header lines of the parameter log (2)'));
});

test('round trip: bbl_encode writes the parameter section, the 4 S fields and event-101 records; collect + buildTimeline read them', () => {
    const enc = require(path.resolve(__dirname, 'helpers/bbl_encode.cjs'));
    const sim = enc.simulateFlight({ seconds: 1, airborne: null }), n = sim.w.n;
    const z = new Uint8Array(n), one = new Uint8Array(n).fill(1), seq = new Uint8Array(n);
    for (let i = 300; i < n; i++) seq[i] = 2;
    sim.slow = Object.assign({}, sim.slow, { pidProfile: z, rateProfile: z, armed: one, paramSeq: seq });
    sim.header = Object.assign({}, sim.header, Object.fromEntries(headerLines({ body: NO_BOOT })));
    // roll P of PID profile 1 (p0) from 50 to 100 at frame 300 (loopIteration 300), applied by the pid loader at once
    sim.events = [[300, enc.EV.CUSTOM_STRING, { string: ev('C', 1, '300.0', 's=m.202', 'n=1', 'p0.roll_p_gain=100<50') }],
        [300, enc.EV.CUSTOM_STRING, { string: ev('A', 2, '300.0', 'pid/0') }]];
    const d = decode(decoder(), enc.encode([sim]).bytes);
    assert.ok(PL.isParamLog(d.sc));
    const got = PL.collect(d.log), journal = PL.assemble(got.strings);
    assert.equal(got.strings.length, 2);
    assert.deepEqual([journal.records.size, journal.gaps.length, journal.crcErrors.length], [2, 0, 0]);
    assert.ok(got.frames.paramSeq && got.frames.armed, 'the 4 S fields reach the frames');
    const tl = PL.buildTimeline({ sysConfig: d.sc, records: journal, frames: got.frames, resumes: got.resumes });
    assert.equal(tl.complete, true);
    assert.equal(tl.valueAt('p0.roll_p_gain', 299).stored, '50');
    assert.equal(tl.valueAt('p0.roll_p_gain', 300).stored, '100');
    assert.equal(tl.valueAt('p0.roll_p_gain', 301).running, '100');
});
