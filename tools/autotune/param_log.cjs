'use strict';

/**
 * The parameter journal of a Rotorflight blackbox log (RF-PARAM-1, Blackbox_Params_Spec.md sections 2 and 4.2):
 * for every frame of a log, the exact stored value of each tracked parameter, the value that the firmware used (with
 * param_semantics.cjs), or a flag that says why the value is not exact.
 *
 * What a param log carries (spec 2):
 *   header   "H Param log:1" ... "H param_end:<lines>,<fnv32>" (js/flightlog_parser.js puts them in
 *            sysConfig.paramHeader as [name, value]): loop and phase map, PG list, fixes, runtime values, profile indices,
 *            and in FULL mode a snapshot of every tracked byte (set.*, set@p*, set@r*, el.*, pg.*, boot.*)
 *   S-frame  pidProfile, rateProfile, armed, paramSeq (the seq of the last journal record created before the frame)
 *   events   event 101 strings "P" TYPE SEQ " " AT *(" " FIELD) "*" CRC: C change, A loader apply, R runtime, M marker,
 *            L ring overflow, Q end, + continuation
 *
 *   const PL = require('./param_log.cjs');
 *   if (PL.isParamLog(sysConfig)) {
 *       const got = PL.collect(flightLog);                      // frames (typed arrays) and event-101 strings of the open log
 *       const timeline = PL.buildTimeline({ sysConfig, records: PL.assemble(got.strings), frames: got.frames, resumes: got.resumes });
 *       timeline.valueAt('p0.yaw_p_gain', iter, 'pid')          // { stored, running, status, source, ... }
 *   }
 *
 * Points and frames (spec 2.5): a stamp N.c means the change came after ticks 0..c-1 of the PID cycle that frame N
 * records. A subtask at tick t of frame i used the new value when (i, t) >= (N, c). Positions here are i * tickSpan + t.
 * The stamp p (before T0) is the position -1: every frame used the new value.
 *
 * Fold (spec 2.6): records in SEQ order; losses (a missing SEQ, a trailing gap from the S-frame paramSeq, a Q with
 * unsent or lostrec, a CRC error, a record with fewer items than n) make every key unknown from the earliest possible
 * point until its next C item; an L record makes the keys of its PGs unknown until their y record; a C.old that differs
 * from the believed value is a chain-mismatch (the key is unknown back to its last record or to T0).
 *
 * Worker-loadable (js/tuning_worker.js CommonJS shim): no Node API at module load; module.exports, then the CLI.
 */

const PS = require('./param_semantics.cjs');

const RULES = {
    version: 1,          // the highest "Param log" version that this reader knows (2.1); a higher one is read as 1 and flagged
    eventMax: 128,       // chars of one event 101 (2.4); a longer record is kept and flagged long
    lineMax: 192,        // chars of one header line (2.2); a longer line is kept and listed in header.long
    tickSpan: 256,       // positions in one PID cycle: position = iteration * tickSpan + tick (pid_process_denom is 16 or less)
    // Tasks outside the PID loop see a change at their next run: the frames up to one period after the point are
    // transition frames for their keys (2.5, 4.3). fc/tasks.c:352 ACC 1000 Hz, :355 RX 33 Hz (the period of its fallback
    // schedule: the event-based RX task runs faster, so this is the longest wait)
    taskPeriodUs: { rx: 1e6 / 33, acc: 1e6 / 1000 },
    fnvOffsetBasis: 2166136261,  // common/crc.h:49-50 FNV_OFFSET_BASIS, FNV_PRIME
    fnvPrime: 16777619,
    crcPoly: 0xD5,               // common/crc.h:26 crc8_update with 0xD5 (crc8_dvb_s2), initial value 0
};

// The tick of each PID subtask for pid_process_denom 1-8 (fc/core.c:885-1056 of 4.6.0). param_phase gives it at runtime;
// this table is only for a header without param_phase.
const PHASE_OF_DENOM = {
    1: { pos: 0, sp: 0, pid: 0, mix: 0, mot: 0, fupd: 0, bb: 0, flush: 0 },
    2: { pos: 0, sp: 0, pid: 0, flush: 0, mix: 1, mot: 1, fupd: 1, bb: 1 },
    3: { pos: 0, sp: 0, pid: 0, mix: 0, mot: 1, bb: 1, fupd: 2, flush: 2 },
    4: { pos: 0, sp: 0, pid: 0, mix: 1, mot: 1, fupd: 2, bb: 2, flush: 3 },
    5: { pos: 0, sp: 0, pid: 0, mix: 1, mot: 2, fupd: 2, bb: 3, flush: 4 },
    6: { pos: 0, sp: 0, pid: 1, mix: 2, mot: 3, fupd: 3, bb: 4, flush: 5 },
    7: { pos: 0, sp: 0, pid: 1, mix: 2, mot: 3, fupd: 4, bb: 5, flush: 6 },
    8: { pos: 0, sp: 1, pid: 2, mix: 3, mot: 4, fupd: 5, bb: 6, flush: 7 },
};

const EV = { LOGGING_RESUME: 14, CUSTOM_STRING: 101 };   // js/flightlog_fielddefs.js FlightLogEvent
const PRE = -1;                                           // the position of the stamp p
const TYPES = 'CARMLQ+';
const PARAM_KEY = /^(?:Param log$|param_|set\.|set@p|set@r|el\.|pg\.|boot\.)/;

// ---------------------------------------------------------------------------------------------------------------------
// Hash and CRC, as the firmware computes them
// ---------------------------------------------------------------------------------------------------------------------

// FNV-1 as common/crc.c fnv_update (128-139): for each byte, hash *= FNV_PRIME, then hash ^= byte (32 bits)
function fnv1(text, hash) {
    let h = (hash === undefined ? RULES.fnvOffsetBasis : hash) >>> 0;
    for (let i = 0; i < text.length; i++) {
        h = Math.imul(h, RULES.fnvPrime) >>> 0;
        h = (h ^ (text.charCodeAt(i) & 0xFF)) >>> 0;
    }
    return h;
}

// CRC-8 as common/crc.c crc8_calc / crc8_update (MSB first, no reflection, no final xor), polynomial 0xD5, initial 0
function crc8(text, poly) {
    const p = poly === undefined ? RULES.crcPoly : poly;
    let crc = 0;
    for (let i = 0; i < text.length; i++) {
        crc ^= text.charCodeAt(i) & 0xFF;
        for (let k = 0; k < 8; k++) crc = (crc & 0x80) ? ((crc << 1) ^ p) & 0xFF : (crc << 1) & 0xFF;
    }
    return crc;
}

// The value text of the header and the records (2.2): %XX is a byte. Display only: comparisons use the text.
const unescapeValue = (text) => String(text).replace(/%([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));

// ---------------------------------------------------------------------------------------------------------------------
// Header (2.2)
// ---------------------------------------------------------------------------------------------------------------------

function isParamLog(sysConfig) {
    return !!sysConfig && Array.isArray(sysConfig.paramHeader) && sysConfig.paramHeader.some(l => Array.isArray(l) && l[0] === 'Param log');
}

// 'el.servo.0-3' -> ['el.servo.0', ..., 'el.servo.3']; 'el.feature' -> ['el.feature']
function expandRun(key) {
    const m = /^(el\.[a-z]+)\.(\d+)(?:-(\d+))?$/.exec(key);
    if (!m) return [key];
    const a = +m[2], b = m[3] === undefined ? a : +m[3], out = [];
    for (let i = a; i <= b && i - a < 256; i++) out.push(`${m[1]}.${i}`);
    return out;
}
// 'pg.18+4' with 'a0b1' -> [['pg.18+4', 'a0'], ['pg.18+5', 'b1']]: the raw bytes are keys of one byte each
function rawBytes(key, hex) {
    const m = /^pg\.(\d+)\+(\d+)$/.exec(key), out = [];
    if (!m || !/^(?:[0-9A-Fa-f]{2})*$/.test(hex)) return null;
    for (let j = 0; j < hex.length / 2; j++) out.push([`pg.${m[1]}+${+m[2] + j}`, hex.slice(2 * j, 2 * j + 2).toLowerCase()]);
    return out;
}
const intOr = (s, d = null) => /^-?\d+$/.test(String(s).trim()) ? parseInt(s, 10) : d;
function kvList(text) {
    const o = {};
    for (const part of String(text).split(',')) { const eq = part.indexOf('='); if (eq > 0) o[part.slice(0, eq).trim()] = part.slice(eq + 1).trim(); }
    return o;
}

/**
 * paramHeader ([name, value] in log order, sysConfig.paramHeader) ->
 *   { version, mode, loop: { pidDenom, filterDenom, pInterval, scanBytes }, phase: { pos, sp, ... }, pgs: [{ pgn, ver, size }],
 *     fixes: [], rt: { gov_mode, features, pid_denom, ... }, pid0, rate0, master: Map(name -> text), pid: Map(name -> text[6]),
 *     rate: Map(name -> text[6]), el: Map(key -> text), raw: Map('pg.<pgn>+<off>' -> hex byte), boot: Map(key -> text),
 *     end: { lines, hash } | null, complete, lines, hash, long: [names], extra: [[name, value]] }
 * complete: param_end is there, and its line count and its FNV-1 hash agree with the lines from "Param log" to the line
 * before param_end (the bytes "H <name>:<value>\n"). Keys and fields that this reader does not know go to extra.
 */
function parseParamHeader(paramHeader) {
    const h = { version: null, mode: null, loop: null, phase: null, pgs: [], fixes: [], rt: {}, pid0: null, rate0: null,
        master: new Map(), pid: new Map(), rate: new Map(), el: new Map(), raw: new Map(), boot: new Map(),
        end: null, complete: false, lines: 0, hash: null, long: [], extra: [], newerVersion: false };
    if (!Array.isArray(paramHeader)) return h;
    let hash = RULES.fnvOffsetBasis, count = 0, inSection = false, ended = false;
    const profile = (map, name, k, v) => { if (!map.has(name)) map.set(name, new Array(6).fill(undefined)); map.get(name)[k] = v; };
    for (const line of paramHeader) {
        if (!Array.isArray(line)) continue;
        const name = String(line[0]), value = String(line[1] === undefined ? '' : line[1]);
        if (name === 'Param log' && !inSection && !ended) inSection = true;
        if (name === 'param_end') {
            if (inSection && !ended) {
                const m = /^(\d+),([0-9A-Fa-f]{1,8})$/.exec(value.trim());
                h.end = m ? { lines: +m[1], hash: parseInt(m[2], 16) >>> 0 } : { lines: null, hash: null, text: value };
                ended = true; inSection = false;
            }
            continue;
        }
        if (inSection && !ended) { hash = fnv1(`H ${name}:${value}\n`, hash); count++; }
        if (`H ${name}:${value}`.length > RULES.lineMax) h.long.push(name);
        let m;
        if (name === 'Param log') { h.version = intOr(value); if (h.version > RULES.version) h.newerVersion = true; }
        else if (name === 'param_mode') h.mode = value.trim();
        else if (name === 'param_loop') { const a = value.split(',').map(s => intOr(s)); h.loop = { pidDenom: a[0], filterDenom: a[1], pInterval: a[2], scanBytes: a[3] }; }
        else if (name === 'param_phase') { const o = kvList(value); h.phase = {}; for (const k in o) { const v = intOr(o[k]); if (v !== null) h.phase[k] = v; } }
        // param_pgs, continued in param_pgs.1, param_pgs.2, ... when the list is longer than one line (firmware
        // blackbox_params_format.c HDR_PGS)
        else if (/^param_pgs(?:\.\d+)?$/.test(name)) {
            for (const part of value.split(',')) if ((m = /^(\d+)\.(\d+)\/(\d+)$/.exec(part.trim()))) h.pgs.push({ pgn: +m[1], ver: +m[2], size: +m[3] });
        }
        else if (name === 'param_fixes') h.fixes = value.trim() === '-' ? [] : value.split(',').map(s => s.trim()).filter(Boolean);
        else if (name === 'param_rt') {
            const o = kvList(value);
            for (const k in o) h.rt[k] = k === 'features' ? (/^[0-9A-Fa-f]+$/.test(o[k]) ? parseInt(o[k], 16) >>> 0 : null) : intOr(o[k], o[k]);
        }
        else if (name === 'param_pid_profile') h.pid0 = intOr(value);
        else if (name === 'param_rate_profile') h.rate0 = intOr(value);
        else if ((m = /^set\.(.+)$/.exec(name))) h.master.set(m[1], value);
        else if ((m = /^set@([pr])\.(.+)$/.exec(name))) {
            // v0|v1|...|v5; an empty field is the text of the previous profile
            const map = m[1] === 'p' ? h.pid : h.rate, parts = value.split('|');
            let prev;
            for (let k = 0; k < 6; k++) {
                const v = parts[k];
                if (v === undefined) break;
                prev = (v === '' && k > 0) ? prev : v;
                profile(map, m[2], k, prev);
            }
        }
        else if ((m = /^set@([pr])([0-5])\.(.+)$/.exec(name))) profile(m[1] === 'p' ? h.pid : h.rate, m[3], +m[2], value);
        else if (/^el\./.test(name)) for (const k of expandRun(name)) h.el.set(k, value);
        else if (/^pg\./.test(name)) { const bytes = rawBytes(name, value.trim()); if (bytes) for (const [k, v] of bytes) h.raw.set(k, v); else h.extra.push([name, value]); }
        else if ((m = /^boot\.(.+)$/.exec(name))) {
            const key = m[1];
            if (/^set\./.test(key)) h.boot.set(key.slice(4), value);
            else if (/^el\./.test(key)) for (const k of expandRun(key)) h.boot.set(k, value);
            else if (/^pg\./.test(key)) { const bytes = rawBytes(key, value.trim()); if (bytes) for (const [k, v] of bytes) h.boot.set(k, v); }
            else h.boot.set(key, value);
        }
        else h.extra.push([name, value]);
    }
    h.lines = count;
    h.hash = count ? hash >>> 0 : null;
    h.complete = !!h.end && h.end.lines === count && h.end.hash === h.hash;
    return h;
}

// The stored state of the snapshot (FULL): Map(key -> text) with the record key names (2.4)
function snapshotState(h) {
    const s = new Map();
    for (const [k, v] of h.master) s.set(k, v);
    for (const [name, list] of h.pid) list.forEach((v, k) => { if (v !== undefined) s.set(`p${k}.${name}`, v); });
    for (const [name, list] of h.rate) list.forEach((v, k) => { if (v !== undefined) s.set(`r${k}.${name}`, v); });
    for (const [k, v] of h.el) s.set(k, v);
    for (const [k, v] of h.raw) s.set(k, v);
    return s;
}

// ---------------------------------------------------------------------------------------------------------------------
// Records (2.4)
// ---------------------------------------------------------------------------------------------------------------------

const HEAD = /^P([CARMLQ+])([0-9a-f]{1,8}) /;

function parsePoint(text) {
    let m;
    if (text === 'p') return { pre: true };
    if ((m = /^(\d+)\.(\d+)$/.exec(text))) return { n: +m[1], c: +m[2] };
    if ((m = /^(\d+)\.(\d+)~(\d+)\.(\d+)$/.exec(text))) return { n0: +m[1], c0: +m[2], n1: +m[3], c1: +m[4] };
    return null;
}
const pointText = (at) => !at ? '?' : at.pre ? 'p' : at.n !== undefined ? `${at.n}.${at.c}` : `${at.n0}.${at.c0}~${at.n1}.${at.c1}`;

/**
 * One event-101 string -> null (not a journal record) | { type, seq, at: { pre } | { n, c } | { n0, c0, n1, c1 }, src, arg,
 *   n, items: [{ key, value, old }], crcOk, fields, words, ... }. A: loader, slot, fp. R: values. M: marker. L: pgs.
 *   Q: unsent, lostrec. A string that starts like a record but has no valid "*CC" end or point is malformed (crcOk false).
 *   Fields and words that this reader does not know stay in fields and words (2.1).
 */
function parseRecord(text) {
    if (typeof text !== 'string') return null;
    const m = HEAD.exec(text);
    if (!m) return null;
    const rec = { type: m[1], seq: parseInt(m[2], 16), at: null, src: null, arg: null, n: null, items: [], fields: {}, words: [], crcOk: false, text };
    if (text.length > RULES.eventMax) rec.long = true;
    const star = text.lastIndexOf('*'), crcText = star >= 0 ? text.slice(star + 1) : '';
    if (star < m[0].length || !/^[0-9A-F]{2}$/.test(crcText)) { rec.malformed = true; return rec; }
    rec.crc = parseInt(crcText, 16);
    rec.crcOk = crc8(text.slice(0, star)) === rec.crc;
    const tokens = text.slice(m[0].length, star).split(' ').filter(t => t.length);
    rec.at = parsePoint(tokens[0] || '');
    if (!rec.at) { rec.malformed = true; rec.crcOk = false; return rec; }
    for (const tok of tokens.slice(1)) {
        const eq = tok.indexOf('=');
        if (eq <= 0) { rec.words.push(tok); continue; }
        const name = tok.slice(0, eq), value = tok.slice(eq + 1), lt = value.indexOf('<');
        if (lt >= 0 && (rec.type === 'C' || rec.type === '+')) rec.items.push({ key: name, value: value.slice(0, lt), old: value.slice(lt + 1) });
        else rec.fields[name] = value;
    }
    if (rec.type === 'C' || rec.type === '+') {
        if (rec.fields.s !== undefined) {
            const s = rec.fields.s, dot = s.indexOf('.'), arg = dot < 0 ? null : s.slice(dot + 1);
            rec.src = dot < 0 ? s : s.slice(0, dot);
            rec.arg = arg === null ? null : /^\d+$/.test(arg) ? +arg : arg;
        }
        if (rec.fields.n !== undefined && /^\d+$/.test(rec.fields.n)) rec.n = +rec.fields.n;
    } else if (rec.type === 'A') {
        const w = rec.words[0] || '', sl = w.indexOf('/');
        rec.loader = sl < 0 ? w : w.slice(0, sl);
        rec.slot = sl < 0 ? null : intOr(w.slice(sl + 1));
        rec.fp = rec.fields.fp !== undefined ? rec.fields.fp.toLowerCase() : null;
    } else if (rec.type === 'R') rec.values = Object.assign({}, rec.fields);
    else if (rec.type === 'M') rec.marker = rec.words[0] || null;
    else if (rec.type === 'L') rec.pgs = String(rec.fields.pgs || '').split(',').map(s => intOr(s)).filter(v => v !== null);
    else if (rec.type === 'Q') { rec.unsent = intOr(rec.fields.unsent, 0) || 0; rec.lostrec = intOr(rec.fields.lostrec, 0) || 0; }
    return rec;
}

function gapsOf(seqs) {
    const gaps = [];
    let expected = 1, prev = 0;
    for (const s of [...seqs].sort((a, b) => a - b)) {
        if (s > expected) gaps.push({ from: expected, to: s - 1, after: prev, before: s });
        if (s >= expected) expected = s + 1;
        prev = s;
    }
    return gaps;
}

/**
 * The records of a log from its event-101 strings (log order): strings or { text, time } (time: the event time, µs).
 * -> { records: Map(seq -> record, in SEQ order), gaps: [{ from, to, after, before }], crcErrors: [{ index, text, type, seq }],
 *      incomplete: [seq], orphans: [seq], duplicates: [seq], maxSeq, count }
 * The + events join their record (same SEQ); items of all its events; n is checked. A string with a bad CRC is lost:
 * its SEQ is a gap, or its record is incomplete. A + with no head makes a record with headLost and incomplete.
 */
function assemble(strings) {
    const out = { records: new Map(), gaps: [], crcErrors: [], incomplete: [], orphans: [], duplicates: [], maxSeq: 0, count: 0 };
    const heads = new Map(), conts = new Map();
    (strings || []).forEach((s, index) => {
        const text = typeof s === 'string' ? s : s && (s.text !== undefined ? s.text : s.string);
        const rec = parseRecord(text);
        if (!rec) return;
        out.count++;
        rec.index = index;
        if (s && typeof s === 'object' && s.time !== undefined) rec.time = s.time;
        if (!rec.crcOk) { out.crcErrors.push({ index, text, type: rec.type, seq: rec.seq }); return; }
        if (rec.type === '+') { if (!conts.has(rec.seq)) conts.set(rec.seq, []); conts.get(rec.seq).push(rec); return; }
        if (heads.has(rec.seq)) { out.duplicates.push(rec.seq); return; }
        heads.set(rec.seq, rec);
    });
    const badPlus = new Set(out.crcErrors.filter(e => e.type === '+').map(e => e.seq));
    for (const [seq, list] of conts) if (!heads.has(seq)) {
        const first = list[0];
        heads.set(seq, { type: 'C', seq, at: first.at, src: null, arg: null, n: null, items: [], fields: {}, words: [], crcOk: true, headLost: true, index: first.index, time: first.time });
        out.orphans.push(seq);
    }
    for (const seq of [...heads.keys()].sort((a, b) => a - b)) {
        const rec = heads.get(seq), more = conts.get(seq) || [];
        for (const c of more) {
            if (pointText(c.at) !== pointText(rec.at)) rec.atMismatch = true;
            rec.items = rec.items.concat(c.items);
        }
        rec.parts = 1 + more.length;
        if (rec.type === 'C' && (rec.headLost || (rec.n !== null && rec.items.length !== rec.n) || badPlus.has(seq))) { rec.incomplete = true; out.incomplete.push(seq); }
        out.records.set(seq, rec);
        if (seq > out.maxSeq) out.maxSeq = seq;
    }
    out.gaps = gapsOf(out.records.keys());
    return out;
}

// ---------------------------------------------------------------------------------------------------------------------
// Timeline (2.5, 2.6, 4.2)
// ---------------------------------------------------------------------------------------------------------------------

function lowerBound(arr, v) { let lo = 0, hi = arr.length; while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m] < v) lo = m + 1; else hi = m; } return lo; }

function framesOf(f) {
    const n = f && f.iter ? f.iter.length : 0;
    const col = (a) => a && a.length === n ? a : null;
    return { n, iter: n ? f.iter : [], time: col(f && f.time), pidProfile: col(f && f.pidProfile), rateProfile: col(f && f.rateProfile), armed: col(f && f.armed), paramSeq: col(f && f.paramSeq) };
}

// The classic header keys of js/flightlog_parser.js sysConfig as text (for the self-test): name -> 'a,b,c'
function classicFromSysConfig(sysConfig, table) {
    const t = table || PS.forFirmware('Rotorflight 4.6.0', []), out = {};
    if (!sysConfig) return out;
    const own = (k) => Object.prototype.hasOwnProperty.call(sysConfig, k) ? sysConfig[k] : undefined;
    const text = (v) => v === undefined || v === null ? null : Array.isArray(v) ? (v.some(x => x === null || x === undefined) ? null : v.join(',')) : String(v);
    for (const [key] of t.classic) {
        const alias = t.classicSysConfig[key];
        const v = Array.isArray(alias) ? text(alias.map(own).some(x => x === undefined) ? undefined : alias.map(own)) : text(own(alias || key));
        if (v !== null) out[key] = v;
    }
    return out;
}

/**
 * The timeline of one param log.
 *   input  { header: parseParamHeader() | paramHeader lines | sysConfig, sysConfig (optional: the revision and the classic
 *            hints), records: assemble() | strings, frames: { iter, time, pidProfile, rateProfile, armed, paramSeq } (typed
 *            arrays, one entry per frame, from getChunksInTimeRange), resumes: [frame index of each LOGGING_RESUME],
 *            semantics: param_semantics forFirmware() (default: from the revision line and param_fixes) }
 * -> null for a stock log, else the Timeline of spec 4.2 (see the object at the end), with these additions:
 *   uncertain    [{ key, i0, i1, reason, seq }]: reason 'transition' for the transition frames of the RX and ACC keys (2.5)
 *   transitions  [{ key, consumer: 'rx'|'acc', i0, i1, seq }]: the same transition frames
 *   unknown      [{ key, i0, i1, reason, seq }]: stored values that are unknown (reason 'snapshot': a key with no line)
 *   mixedKeys    Map(iter -> Set(key)): the keys that changed at c > 0 in that frame (mixed is the Set of the frames)
 *   epochs[].uncertain, .mixed  the keys in force of each kind in the epoch (with .pending and .unknown). A consumer that
 *                removes frames "for the keys involved" (4.6) uses these lists; the epoch status covers all of them,
 *                also the running values (apply-unknown, order-unknown, lost) that the frame ranges do not list.
 */
function buildTimeline(input) {
    const o = input || {};
    const sysConfig = o.sysConfig || (o.header && !Array.isArray(o.header) && Array.isArray(o.header.paramHeader) ? o.header : null);
    let header = o.header;
    if (Array.isArray(header)) header = parseParamHeader(header);
    else if (header && !(header.master instanceof Map)) header = Array.isArray(header.paramHeader) ? parseParamHeader(header.paramHeader) : null;
    if (!header && sysConfig) header = parseParamHeader(sysConfig.paramHeader);
    if (!header || !header.version) return null;
    const sem = o.semantics !== undefined ? o.semantics : PS.forFirmware(sysConfig && sysConfig['Firmware revision'], header.fixes);
    let journal = o.records;
    if (Array.isArray(journal)) journal = assemble(journal);
    else if (journal instanceof Map) journal = { records: journal, gaps: gapsOf(journal.keys()), crcErrors: [], incomplete: [], orphans: [], duplicates: [], maxSeq: Math.max(0, ...journal.keys()) };
    if (!journal || !(journal.records instanceof Map)) journal = assemble([]);
    const F = framesOf(o.frames || {});
    const resumes = (o.resumes || []).filter(i => Number.isInteger(i) && i >= 0 && i < F.n).sort((a, b) => a - b);

    // ---- the PID cycle (2.5) ----
    const TS = RULES.tickSpan;
    const D = Math.max(1, (header.loop && header.loop.pidDenom) || header.rt.pid_denom || 1);
    const FD = Math.max(1, (header.loop && header.loop.filterDenom) || header.rt.filter_denom || 1);
    const phase = header.phase && header.phase.bb !== undefined ? header.phase : PHASE_OF_DENOM[Math.min(D, 8)];
    const b = phase.bb === undefined ? D - 1 : phase.bb;
    const posOf = (n, c) => n * TS + c;
    const spanOf = (at) => at.pre ? [PRE, PRE] : at.n !== undefined ? [posOf(at.n, at.c), posOf(at.n, at.c)] : [posOf(at.n0, at.c0), posOf(at.n1, at.c1)];
    const ALL_TICKS = Array.from({ length: D }, (_, k) => k);
    const ticksOf = (consumer) => {
        if (consumer === undefined || consumer === null) return ALL_TICKS;
        if (phase[consumer] !== undefined) return [phase[consumer]];
        if (consumer === 'filter') return ALL_TICKS.filter(k => k % FD === 0);
        if (consumer === 'sp-ring') return [phase.sp !== undefined ? phase.sp : 0];
        if (consumer === 'rx' || consumer === 'acc') return [0];
        return ALL_TICKS;
    };
    // frames: the first frame with a tick at or after pos, and the first frame that starts at or after pos
    const firstTouching = (pos) => pos < 0 ? 0 : lowerBound(F.iter, Math.ceil((pos - (D - 1)) / TS));
    const firstFrom = (pos) => pos < 0 ? 0 : lowerBound(F.iter, Math.ceil(pos / TS));
    const timeOfPos = (pos) => { const f = firstTouching(pos); return F.time && f < F.n ? F.time[f] : null; };
    const frameOf = (iter) => { const f = lowerBound(F.iter, iter); return f < F.n && F.iter[f] === iter ? f : Math.max(0, f - 1); };

    // ---- base state ----
    const full = header.mode === 'FULL';
    const verified = full && header.complete;
    const snap = full ? snapshotState(header) : new Map();
    if (header.pid0 !== null) snap.set('pid_profile', String(header.pid0));
    if (header.rate0 !== null) snap.set('rate_profile', String(header.rate0));
    const hints = classicHints(sysConfig, header, sem);
    const keys = new Map();       // key -> { key, base: { value, known, source, verified, hint }, bps: [] }
    for (const [k, v] of snap) keys.set(k, { key: k, base: { value: v, known: true, source: 'header', verified: verified || (header.complete && /^(?:pid|rate)_profile$/.test(k)), hint: null }, bps: [] });

    const losses = [];            // { seq, pos, reason, pgs?, trailing? } in SEQ order
    const flags = [];             // { type, ... }
    const applies = [];           // A records { seq, pos, at, loader, slot, fp }
    const adjusts = [];           // C records of adjustments { seq, pos, fn, itemKey }
    const items = [];             // every applied C item { seq, pos, p1, key, value, old, src, arg, pre }
    const runtime = {};           // R fields -> [{ seq, at, p0, p1, value }]
    const markers = [], ends = [];
    const mixed = new Set(), mixedKeys = new Map(), mixedApplies = new Map();   // iter -> keys / [{ loader, slot }] changed at c > 0
    const pendingL = new Map();   // pgn -> { seq, pos }

    const lossApplies = (L, key) => !L.pgs || L.pgs.includes(sem && sem.pgOf ? sem.pgOf(key) : PS.pgOfKey(key)) || (sem && sem.pgOf ? sem.pgOf(key) : PS.pgOfKey(key)) === null;
    function setUnknown(K, pos, seq, reason, extra) {
        const cur = endState(K);
        K.bps = K.bps.filter(x => x.pos <= pos);
        K.bps.push(Object.assign({ pos, seq, status: 'unknown', value: null, reason, record: false, restore: cur.known ? cur.value : null }, extra || {}));
    }
    function ensureKey(key, seq) {
        let K = keys.get(key);
        if (!K) {
            K = { key, base: { value: null, known: false, source: null, verified: false, hint: hints.get(key) || null }, bps: [] };
            keys.set(key, K);
            for (const L of losses) if (L.seq < seq && lossApplies(L, key)) setUnknown(K, L.pos, L.seq, L.reason, L.pgs ? { lseq: L.seq } : null);
        }
        return K;
    }
    // the state after all bps so far: { known, value, status }
    function endState(K) {
        const last = K.bps[K.bps.length - 1];
        if (!last) return { known: K.base.known, value: K.base.value, status: K.base.known ? 'exact' : 'unknown' };
        if (last.status === 'unknown') return { known: false, value: null, status: 'unknown' };
        return { known: true, value: last.value, status: last.status };
    }
    function lastRecordBp(K) { for (let i = K.bps.length - 1; i >= 0; i--) if (K.bps[i].record) return K.bps[i]; return null; }

    // ---- the events in SEQ order: records, and the losses between them ----
    const recs = journal.records;
    const evs = [];
    for (const [seq, r] of recs) {
        evs.push({ seq, rec: r });
        if (r.incomplete) evs.push({ seq: seq - 0.1, loss: { reason: 'lost', pos: r.at ? spanOf(r.at)[0] : PRE, seqs: [seq], why: r.headLost ? 'head' : 'items' } });
    }
    const startOf = (seq) => { const r = recs.get(seq); return r && r.at ? spanOf(r.at)[0] : PRE; };
    for (const g of journal.gaps || []) evs.push({ seq: g.from - 0.5, loss: { reason: 'lost', pos: g.after ? startOf(g.after) : PRE, seqs: [g.from, g.to], why: 'gap' } });
    // a trailing gap: frames whose paramSeq is above the highest SEQ received
    const maxSeq = journal.maxSeq || 0;
    let trailing = null;
    if (F.paramSeq) {
        let fb = -1, top = maxSeq;
        for (let f = 0; f < F.n; f++) if (F.paramSeq[f] > maxSeq) { if (fb < 0) fb = f; if (F.paramSeq[f] > top) top = F.paramSeq[f]; }
        if (fb >= 0) {
            const pos = fb > 0 ? posOf(F.iter[fb - 1] + 1, 0) : PRE;
            trailing = { from: maxSeq + 1, to: top, frame: fb, pos };
            evs.push({ seq: maxSeq + 0.5, loss: { reason: 'lost', pos, seqs: [maxSeq + 1, top], why: 'trailing', frame: fb } });
        }
    }
    for (const [seq, r] of recs) if (r.type === 'Q' && (r.unsent > 0 || r.lostrec > 0)) {
        let prev = 0; for (const s of recs.keys()) if (s < seq && s > prev) prev = s;
        evs.push({ seq: seq - 0.25, loss: { reason: 'lost', pos: prev ? startOf(prev) : PRE, why: 'Q', unsent: r.unsent, lostrec: r.lostrec } });
    }
    for (const e of journal.crcErrors || []) flags.push({ type: 'crc', seq: e.seq, text: e.text });
    evs.sort((a, c) => a.seq - c.seq);

    const lossesBefore = (seq) => losses.some(L => L.seq < seq && !L.pgs);
    for (const ev of evs) {
        if (ev.loss) {
            const L = Object.assign({ seq: ev.seq }, ev.loss);
            losses.push(L);
            flags.push(Object.assign({ type: 'lost' }, L));
            for (const K of keys.values()) setUnknown(K, L.pos, L.seq, 'lost');
            continue;
        }
        const r = ev.rec;
        if (!r.at) continue;
        const [p0, p1] = spanOf(r.at);
        if (r.type === 'C') applyC(r, p0, p1);
        else if (r.type === 'A') {
            applies.push({ seq: r.seq, pos: p1, at: r.at, loader: r.loader, slot: r.slot, fp: r.fp });
            if (r.at.n !== undefined && r.at.c > 0) {
                mixed.add(r.at.n);
                if (!mixedApplies.has(r.at.n)) mixedApplies.set(r.at.n, []);
                mixedApplies.get(r.at.n).push({ loader: r.loader, slot: r.slot });
            }
        } else if (r.type === 'R') {
            for (const f in r.values) { if (!runtime[f]) runtime[f] = []; runtime[f].push({ seq: r.seq, at: r.at, p0, p1, value: r.values[f] }); }
        } else if (r.type === 'M') markers.push({ seq: r.seq, at: r.at, pos: p1, marker: r.marker, fields: r.fields });
        else if (r.type === 'L') {
            const L = { seq: r.seq, pos: p0, reason: 'L', pgs: r.pgs };
            losses.push(L);
            flags.push({ type: 'L', seq: r.seq, pos: p0, pgs: r.pgs });
            for (const K of keys.values()) if (lossApplies(L, K.key)) setUnknown(K, p0, r.seq, 'L', { lseq: r.seq });
            for (const pg of r.pgs) pendingL.set(pg, { seq: r.seq, pos: p0 });
        } else if (r.type === 'Q') ends.push({ seq: r.seq, at: r.at, unsent: r.unsent, lostrec: r.lostrec });
    }

    function applyC(r, p0, p1) {
        const pre = !!r.at.pre, interval = p1 > p0;
        if (r.at.n !== undefined && r.at.c > 0) {
            mixed.add(r.at.n);
            if (r.at.c > b) flags.push({ type: 'phase', seq: r.seq, at: pointText(r.at), detail: `tick ${r.at.c} after the blackbox tick ${b}` });
        }
        if (r.src === 'a' && typeof r.arg === 'number') adjusts.push({ seq: r.seq, pos: p1, fn: r.arg, itemKey: r.items.length ? r.items[0].key : null });
        const touched = [];
        for (const it of expandItems(r.items)) {
            const K = ensureKey(it.base, r.seq);
            if (!pre && !interval && r.at.c > 0) { if (!mixedKeys.has(r.at.n)) mixedKeys.set(r.at.n, new Set()); mixedKeys.get(r.at.n).add(it.base); }
            // A key that has no snapshot line is unknown until a record sets it (2.6.3), from that record's point. Only a
            // record before T0 sets it for every frame: its old value is then the value before the log (no loss before it).
            if (pre && !K.base.known && !K.bps.length && it.index === null && !lossesBefore(r.seq)) K.base = { value: it.old, known: true, source: 'record', verified: true, hint: K.base.hint };
            const now = endState(K);
            let believed = now.known ? now.value : null, newText = null, oldText = null;
            if (it.index === null) { newText = it.value; oldText = it.old; }
            else if (now.known) {
                const parts = String(now.value).split(','); believed = parts[it.index];
                oldText = now.value; parts[it.index] = it.value; newText = parts.join(',');
            }
            // chain check (2.6.4): not for records before T0 (a header line can come after a change)
            if (!pre && now.known && now.status === 'exact' && believed !== it.old) {
                const last = lastRecordBp(K), from = last ? last.pos + 1 : PRE;
                flags.push({ type: 'chain-mismatch', key: it.base, seq: r.seq, expected: believed, found: it.old, from, to: p0 });
                const keep = K.bps.filter(x => x.pos < from);
                K.bps = keep.concat([{ pos: from, seq: r.seq, status: 'unknown', value: null, reason: 'chain-mismatch', record: false }]);
            }
            if (interval) {
                let start = p0;
                const last = lastRecordBp(K);
                if (last && last.pos >= start) start = last.pos + 1;
                // the state at the interval start, not at the end of the fold so far: a loss or an L point inside the
                // interval keeps its unknown bp after the uncertain one (uncertain, then unknown, then exact at p1)
                const atStart = start < p1 ? evalAt(K, start) : null;
                if (atStart && atStart.status !== 'unknown') {
                    let at = K.bps.length;
                    while (at > 0 && K.bps[at - 1].pos > start) at--;
                    const before = atStart.status === 'uncertain' ? atStart.old : atStart.value;
                    K.bps.splice(at, 0, { pos: start, seq: r.seq, status: 'uncertain', value: newText, old: oldText === null ? before : oldText, record: true, rec: r, src: r.src, arg: r.arg });
                }
            }
            K.bps = K.bps.filter(x => x.pos <= p1);
            // an element of a key that an open L loss made unknown: the other elements keep their value from before the L
            // when the loss ends without them (2.6.5), so the value before the L, with this element, is kept for that
            let lossRestore = null;
            const prev = K.bps[K.bps.length - 1];
            if (newText === null && prev && prev.lseq !== undefined && prev.restore !== null && prev.restore !== undefined) {
                const L = pendingL.get((sem && sem.pgOf ? sem.pgOf : PS.pgOfKey)(it.base));
                if (L && L.seq === prev.lseq) {
                    const parts = String(prev.restore).split(',');
                    if (it.index < parts.length) { parts[it.index] = it.value; lossRestore = { lseq: prev.lseq, restore: parts.join(',') }; }
                }
            }
            K.bps.push(newText === null
                ? Object.assign({ pos: p1, seq: r.seq, status: 'unknown', value: null, reason: 'element', element: { index: it.index, value: it.value }, record: true, rec: r }, lossRestore || {})
                : { pos: p1, seq: r.seq, status: 'exact', value: newText, old: oldText, record: true, rec: r, src: r.src, arg: r.arg, interval: interval ? p0 : null });
            items.push({ seq: r.seq, pos: p1, p0, key: it.base, element: it.index, value: it.value, old: it.old, src: r.src, arg: r.arg, pre });
            touched.push(it.base);
        }
        // a y record ends the L loss of its PGs: the keys of the PG that no y record of the loss set keep the value before
        // the L. Its PG is its pgs field (a y record without items has only that). A y record with part=1 does not
        // complete its PG: the loss goes on (2.6.5).
        if (r.src === 'y' && r.fields.part !== '1') {
            const pgOf = sem && sem.pgOf ? sem.pgOf : PS.pgOfKey;
            const pgs = new Set(touched.map(k => pgOf(k)).filter(v => v !== null));
            if (intOr(r.fields.pgs) !== null) pgs.add(intOr(r.fields.pgs));
            for (const pg of pgs) {
                const L = pendingL.get(pg);
                if (!L) continue;
                pendingL.delete(pg);
                for (const K of keys.values()) {
                    if (pgOf(K.key) !== pg) continue;
                    const last = K.bps[K.bps.length - 1];
                    if (last && (last.reason === 'L' || last.reason === 'element') && last.lseq === L.seq && last.restore !== null && last.restore !== undefined)
                        K.bps.push({ pos: p1, seq: r.seq, status: 'exact', value: last.restore, old: null, record: false, resync: true });
                }
            }
        }
    }

    // ---- after the fold ----
    applies.sort((a, c) => a.pos - c.pos || a.seq - c.seq);
    adjusts.sort((a, c) => a.pos - c.pos || a.seq - c.seq);
    for (const [pg, L] of pendingL) flags.push({ type: 'L-open', pgn: pg, seq: L.seq });

    // order-unknown (3.6): a C with the same point after an A whose loader reads the key
    const orderUnknown = new Set();
    for (const A of applies) {
        if (A.pos === PRE) continue;
        for (const it of items) if (it.seq > A.seq && it.pos === A.pos && it.p0 === A.pos && sem && sem.readsRegion && sem.readsRegion(A.loader, it.key, A.slot)) {
            orderUnknown.add(`${A.seq}|${it.key}`);
            flags.push({ type: 'order-unknown', key: it.key, seq: it.seq, applySeq: A.seq, loader: A.loader });
        }
    }

    // ---- stored value of a key at a position ----
    function bpAt(K, pos, seq) {   // the last bp at or before pos (at pos: only seq below the limit, when given)
        let lo = 0, hi = K.bps.length;
        while (lo < hi) { const m = (lo + hi) >> 1; if (K.bps[m].pos <= pos) lo = m + 1; else hi = m; }
        for (let i = lo - 1; i >= 0; i--) if (seq === undefined || K.bps[i].pos < pos || K.bps[i].seq < seq) return K.bps[i];
        return null;
    }
    function evalAt(K, pos, seq) {
        const bp = bpAt(K, pos, seq);
        // before T0 with a seq limit (an A record before T0): the snapshot line can already hold a later change (2.2), so
        // the value that the A read is the old value of the first record of K at or after the limit
        if (!bp && pos === PRE && seq !== undefined) {
            const later = K.bps.find(x => x.pos === PRE && x.record && x.seq >= seq);
            if (later) return later.old !== null && later.old !== undefined ? { status: 'exact', value: later.old, source: 'record', verified: true, bp: later }
                : { status: 'unknown', value: null, source: null, verified: false, reason: 'element', bp: later, hint: K.base.hint };
        }
        if (!bp) return K.base.known ? { status: 'exact', value: K.base.value, source: K.base.source, verified: K.base.verified }
            : { status: 'unknown', value: null, source: null, verified: false, reason: 'snapshot', hint: K.base.hint };
        if (bp.status === 'exact') return { status: 'exact', value: bp.value, source: bp.record ? 'record' : bp.resync ? 'record' : 'header', verified: true, bp };
        if (bp.status === 'uncertain') return { status: 'uncertain', value: null, old: bp.old, new: bp.value, source: 'record', verified: true, bp };
        return { status: 'unknown', value: null, source: null, verified: false, reason: bp.reason, bp, hint: K.base.hint };
    }
    // the value in force before the log for a loader key: before the first change of the header window, else the base
    function initialRunning(K) {
        const firstPre = K.bps.find(x => x.pos === PRE && x.record);
        if (firstPre) return firstPre.old !== null && firstPre.old !== undefined ? { known: true, value: firstPre.old } : { known: false, value: null };
        if (K.base.known) return { known: true, value: K.base.value };
        const first = K.bps.find(x => x.record && x.old !== null && x.old !== undefined);
        return first ? { known: true, value: first.old } : { known: false, value: null };
    }
    function bootValueOf(K) {
        if (header.boot.has(K.key)) return { known: true, value: header.boot.get(K.key), source: 'boot' };
        if (K.base.known && K.base.source === 'header') return { known: true, value: K.base.value, source: 'header' };
        const r = initialRunning(K);
        return r.known ? { known: true, value: r.value, source: 'record' } : { known: false, value: null, source: null };
    }
    const slotOf = (key) => sem && sem.slotOf ? sem.slotOf(key) : PS.slotOfKey(key);
    // the last apply of the key before pos: an A of the loader (or of a loader in also) with the slot of the key, or
    // an adjustment record that refreshes it (or that applies the loader, fix c4)
    function lastApply(K, use, pos) {
        const loaders = [use.loader].concat(use.also || []), s = slotOf(K.key);
        let best = null;
        for (let i = applies.length - 1; i >= 0; i--) {
            const A = applies[i];
            if (A.pos > pos) continue;
            if (!loaders.includes(A.loader)) continue;
            if (s && A.slot !== null && A.slot !== undefined && A.slot !== s.slot) continue;
            best = { pos: A.pos, seq: A.seq, recSeq: A.seq, kind: 'A', loader: A.loader, apply: A }; break;
        }
        const adj = lastRefresh(K, pos, use.loader);
        if (adj && (!best || adj.pos > best.pos || (adj.pos === best.pos && adj.seq > best.seq))) best = adj;
        return best;
    }
    function lastRefresh(K, pos, loader) {
        if (!sem || !sem.adjustments) return null;
        for (let i = adjusts.length - 1; i >= 0; i--) {
            const e = adjusts[i];
            if (e.pos > pos) continue;
            const a = sem.adjustments[e.fn];
            if (!a) continue;
            const s = slotOf(K.key), si = e.itemKey ? slotOf(e.itemKey) : null;
            if (loader && a.applies === loader && (!s || !si || s.slot === si.slot)) return { pos: e.pos, seq: e.seq + 0.5, recSeq: e.seq, kind: 'adjustment', fn: e.fn };
            if (sem.adjustmentRefreshes(e.fn, K.key, e.itemKey)) return { pos: e.pos, seq: e.seq + 0.5, recSeq: e.seq, kind: 'adjustment', fn: e.fn };
        }
        return null;
    }
    // A loss that can hold a lost A record or a lost refreshing adjustment (2.6.5): it comes after the record with SEQ
    // afterSeq (0: no record) and its earliest point is at or before pos. A lost A record uses its SEQ (firmware recBegin),
    // so it is a missing SEQ, a trailing gap or a Q loss, never an L (an L lists only bytes). An incomplete record can
    // hold an adjustment only when its head is lost (its source is not known).
    function hidingLoss(afterSeq, pos) {
        for (const L of losses) {
            if (L.reason === 'L' || L.seq <= afterSeq || L.pos > pos) continue;
            if (L.why === 'items') continue;
            return L;
        }
        return null;
    }
    const refreshable = new Map();   // key -> an adjustment of the table refreshes it
    function canRefresh(K) {
        if (!refreshable.has(K.key)) refreshable.set(K.key, !!(sem && sem.adjustments && sem.adjustmentRefreshes
            && Object.keys(sem.adjustments).some(fn => sem.adjustmentRefreshes(+fn, K.key, null))));
        return refreshable.get(K.key);
    }
    const LOST_RUN = () => ({ value: null, status: 'unknown', source: null, flags: ['lost'] });
    function runUse(K, use, iter, consumer, stored) {
        const pos = posOf(iter, ticksOf(consumer || use.consumer)[0]);
        if (use.by === 'live') return { value: stored.value, status: stored.status, source: stored.source, flags: [] };
        if (use.by === 'boot') {
            let run = bootValueOf(K), source = run.source;
            const ref = lastRefresh(K, pos);
            // a lost record after the last refresh can be a refreshing adjustment
            if (canRefresh(K) && hidingLoss(ref ? ref.recSeq : 0, pos)) return LOST_RUN();
            if (ref) { const e = evalAt(K, ref.pos, ref.seq); run = { known: e.status === 'exact', value: e.value }; source = 'record'; }
            if (!run.known) return { value: null, status: 'unknown', source, flags: [] };
            return { value: run.value, status: stored.status === 'exact' && stored.value !== run.value ? 'pending' : stored.status, source, flags: [] };
        }
        if (use.by === 'loader') {
            const ap = lastApply(K, use, pos), fl = [];
            // a lost record after the last apply can be an A of the loader: unknown until the next A received (2.6.5)
            if (hidingLoss(ap ? ap.recSeq : 0, pos)) return LOST_RUN();
            let run, source;
            if (ap) { const e = evalAt(K, ap.pos, ap.seq); run = { known: e.status === 'exact', value: e.value }; source = 'record'; }
            else {
                // No A record of the loader in the log before the point. A change between logs (v), or one that no
                // hook saw (u, y), before T0 (any record of K before T0, not only the first): the log does not show
                // whether a loader ran after it, so the value in force is the old or the new value (spec 4.3 has no
                // rule for this case). Else the value at T0 is in force, as the loader read it before the log
                // ('assumed-at-t0').
                const pres = K.bps.filter(x => x.pos === PRE && x.record);
                if (pres.some(x => x.rec && (x.rec.src === 'v' || x.rec.src === 'u' || x.rec.src === 'y'))) {
                    fl.push('apply-unknown');
                    return { value: null, status: 'uncertain', source: 'record', flags: fl, old: pres[0].old, new: stored.value };
                }
                run = initialRunning(K); source = K.base.known ? 'header' : 'record';
                fl.push('assumed-at-t0');
            }
            if (!run.known) return { value: null, status: 'unknown', source, flags: fl };
            if (ap && ap.kind === 'A' && orderUnknown.has(`${ap.seq}|${K.key}`)) { fl.push('order-unknown'); return { value: run.value, status: 'uncertain', source, flags: fl }; }
            return { value: run.value, status: stored.status === 'exact' && stored.value !== run.value ? 'pending' : stored.status, source, flags: fl };
        }
        return { value: stored.value, status: 'effect-unknown', source: stored.source, flags: [] };
    }
    const RANK = { unknown: 5, uncertain: 4, mixed: 3, pending: 2, 'effect-unknown': 1, exact: 0 };
    const worst = (a, c) => (RANK[c] || 0) > (RANK[a] || 0) ? c : a;

    /**
     * valueAt(key, iter, consumer) -> { stored, running, status, source, verified, flags, old, new, hint, inForce }
     *   key       a record key ('p0.yaw_p_gain', 'gov_mode', 'el.servo.1', 'pg.18+4', 'p0.error_limit[1]')
     *   iter      the loopIteration of a frame
     *   consumer  a subtask of param_phase (pos, sp, pid, mix, mot, fupd, bb, flush), 'filter', 'sp-ring', 'rx', 'acc', or
     *             none (all ticks of the frame: a change between them makes the frame mixed)
     *   status    'exact' | 'mixed' | 'uncertain' | 'unknown' | 'pending' (stored differs from running) | 'effect-unknown'
     *   source    'header' (snapshot line), 'record' (journal), 'boot' (boot.* line)
     *   flags     'transition', 'apply-unknown', 'assumed-at-t0', 'order-unknown', 'lost' (a lost record after the last A of
     *             the loader, or after the last refresh of a boot key, can be that A or refresh: running null, status unknown)
     */
    function valueAt(key, iter, consumer) {
        const ref = /^(.*)\[(\d+)\]$/.exec(key), base = ref ? ref[1] : key, index = ref ? +ref[2] : null;
        const K = keys.get(base);
        if (!K) return { stored: null, running: null, status: 'unknown', source: null, verified: false, flags: ['no-key'], hint: hints.get(base) || null };
        const flagsOut = [];
        const res = ticksOf(consumer).map(t => evalAt(K, posOf(iter, t)));
        let st = res[0];
        if (res.some(x => x.status === 'unknown')) st = res.find(x => x.status === 'unknown');
        else if (res.some(x => x.status === 'uncertain')) st = res.find(x => x.status === 'uncertain');
        else if (res.some(x => x.value !== res[0].value)) st = { status: 'mixed', value: null, old: res[0].value, new: res[res.length - 1].value, source: 'record', verified: true };
        st = Object.assign({}, st);
        // transition frames of tasks outside the PID loop (2.5)
        if ((consumer === 'rx' || consumer === 'acc') && st.status === 'exact' && F.time) {
            const f = frameOf(iter), t = F.time[f], period = RULES.taskPeriodUs[consumer];
            if (K.bps.some(x => x.record && x.pos >= 0 && x.pos <= posOf(iter, D - 1) && timeOfPos(x.pos) > t - period)) { st.status = 'uncertain'; flagsOut.push('transition'); }
        }
        const rule = sem && sem.classify ? sem.classify(base) : null;
        let run;
        if (!rule) run = { value: st.value, status: 'effect-unknown', source: st.source, flags: [] };
        else {
            const use = (consumer && rule.use.find(u => u.consumer === consumer)) || rule.use[0];
            run = runUse(K, use, iter, consumer, st);
            if (rule.fields && run.value !== null) {
                const parts = String(run.value).split(',');
                for (const fi in rule.fields) {
                    const fr = runUse(K, rule.fields[fi], iter, consumer, st);
                    if (fr.value === null) { run = { value: null, status: 'unknown', source: fr.source, flags: run.flags }; break; }
                    parts[+fi] = String(fr.value).split(',')[+fi];
                    if ((RANK[fr.status] || 0) > (RANK[run.status] || 0)) run.status = fr.status;
                }
                if (run.value !== null) run.value = parts.join(',');
            }
        }
        let status = st.status;
        if (status === 'exact' || run.status === 'unknown') status = run.status === 'unknown' ? 'unknown' : run.status;
        const pick = (v) => v === null || v === undefined || index === null ? v : String(v).split(',')[index];
        const s = slotOf(base);
        let inForce = true;
        if (s && F.n) { const f = frameOf(iter), col = s.kind === 'pid' ? F.pidProfile : F.rateProfile; if (col) inForce = col[f] === s.slot; }
        return { stored: pick(st.value), running: pick(run.value), status, source: st.source, runningSource: run.source, verified: !!st.verified,
            flags: flagsOut.concat(run.flags || []), old: pick(st.old), new: pick(st.new), hint: st.hint || null, inForce };
    }

    // ---- frames: mixed, uncertain and unknown ranges ----
    const uncertain = [], unknownRanges = [], transitions = [];
    if (F.n) for (const K of keys.values()) {
        // a key with no snapshot line: unknown until its first bp (2.6.3)
        if (!K.base.known && K.bps.length && K.bps[0].pos >= 0) { const i1 = firstFrom(K.bps[0].pos); if (i1 > 0) unknownRanges.push({ key: K.key, i0: 0, i1, reason: 'snapshot', seq: null }); }
        for (let i = 0; i < K.bps.length; i++) {
            const x = K.bps[i], next = K.bps[i + 1], end = next ? next.pos : Infinity;
            if (x.status !== 'uncertain' && x.status !== 'unknown') continue;
            const i0 = firstTouching(x.pos), i1 = end === Infinity ? F.n : firstFrom(end);
            if (i1 <= i0) continue;
            (x.status === 'uncertain' ? uncertain : unknownRanges).push({ key: K.key, i0, i1, reason: x.reason || null, seq: x.seq });
        }
    }
    // transition frames (2.5): a live key of the RX or ACC task, from the frame of each record point to one task period
    // after it. They are in uncertain too (reason 'transition'), and the epochs that they cover are uncertain.
    if (F.n && F.time && sem && sem.classify) for (const K of keys.values()) {
        const rule = sem.classify(K.key), task = rule && rule.use.find(u => u.by === 'live' && (u.consumer === 'rx' || u.consumer === 'acc'));
        if (!task) continue;
        for (const x of K.bps) {
            if (!x.record || x.pos < 0) continue;
            const t = timeOfPos(x.pos), i0 = firstTouching(x.pos);
            if (t === null) continue;
            const i1 = Math.max(i0 + 1, lowerBound(F.time, t + RULES.taskPeriodUs[task.consumer]));
            const range = { key: K.key, consumer: task.consumer, i0, i1, reason: 'transition', seq: x.seq };
            transitions.push(range);
            uncertain.push(range);
        }
    }

    // ---- profile index of a frame (2.6.8): the S-frame, checked against pid_profile / rate_profile ----
    const profileRanges = [];
    for (const [key, col] of [['pid_profile', F.pidProfile], ['rate_profile', F.rateProfile]]) {
        const K = keys.get(key);
        if (!K || !col) continue;
        let open = null;
        for (let f = 0; f <= F.n; f++) {
            let bad = false;
            if (f < F.n) { const e = evalAt(K, posOf(F.iter[f], b)); bad = e.status === 'exact' && intOr(e.value) !== col[f]; if (bad && !open) open = { key, i0: f, stored: e.value, frame: col[f] }; }
            if (!bad && open) { open.i1 = f; profileRanges.push(open); flags.push(Object.assign({ type: 'chain-mismatch' }, open)); open = null; }
        }
    }

    // ---- fingerprint checks (4.3 step 6) ----
    const unexplained = [];
    for (const X of Object.keys(PS.FINGERPRINT_LOADER)) {
        const list = (runtime[`fp.${X}`] || []).slice().sort((a, c) => a.seq - c.seq);
        for (let k = 1; k < list.length; k++) {
            if (String(list[k].value).toLowerCase() === String(list[k - 1].value).toLowerCase() || list[k].at.pre) continue;
            const { p0, p1 } = list[k];
            const byA = applies.some(A => A.loader === PS.FINGERPRINT_LOADER[X] && A.pos >= p0 && A.pos <= p1);
            // only an adjustment that refreshes a runtime field of module X (or applies its loader, fix c4) explains it: a
            // setter that the table says refreshes nothing must not hide a table error
            const byAdj = adjusts.some(e => {
                const a = e.pos >= p0 && e.pos <= p1 && sem && sem.adjustments ? sem.adjustments[e.fn] : null;
                return !!a && a.module === X && ((a.refresh && a.refresh.length > 0) || a.applies === PS.FINGERPRINT_LOADER[X]);
            });
            if (byA || byAdj) continue;
            const nextA = applies.find(A => A.loader === PS.FINGERPRINT_LOADER[X] && A.pos > p1);
            const range = { module: X, seq: list[k].seq, p0, p1, i0: firstTouching(p0), i1: nextA ? firstTouching(nextA.pos) : F.n };
            unexplained.push(range);
            flags.push(Object.assign({ type: 'unexplained-runtime' }, range));
        }
    }
    for (let i = 0; i < applies.length; i++) {
        const A = applies[i];
        if (!A.fp || !PS.FINGERPRINT_LOADER[A.loader]) continue;
        let prev = null;
        for (let j = i - 1; j >= 0; j--) if (applies[j].loader === A.loader && applies[j].fp && applies[j].slot === A.slot) { prev = applies[j]; break; }
        if (!prev || prev.fp !== A.fp) continue;
        const changed = items.filter(it => it.seq > prev.seq && it.seq < A.seq && it.value !== it.old && sem && sem.appliedBy && sem.appliedBy(A.loader, it.key)
            && (!slotOf(it.key) || A.slot === null || slotOf(it.key).slot === A.slot));
        if (changed.length) flags.push({ type: 'table-suspect', loader: A.loader, seq: A.seq, slot: A.slot, keys: [...new Set(changed.map(it => it.key))] });
    }

    // ---- epochs (4.2) ----
    const bounds = new Set([0]);
    const addExact = (at) => {
        const p = posOf(at.n, at.c), f = firstTouching(p);
        if (f >= F.n) return;
        if (at.c > 0 && F.iter[f] === at.n) { bounds.add(f); bounds.add(f + 1); } else bounds.add(firstFrom(p));
    };
    for (const r of recs.values()) {
        if (!r.at || r.at.pre || !(r.type === 'C' || r.type === 'A' || r.type === 'R')) continue;
        if (r.at.n !== undefined) addExact(r.at);
        else { bounds.add(firstTouching(posOf(r.at.n0, r.at.c0))); bounds.add(firstFrom(posOf(r.at.n1, r.at.c1))); }
    }
    for (const L of losses) if (L.pos >= 0) bounds.add(firstTouching(L.pos));
    for (const x of unknownRanges.concat(uncertain)) { bounds.add(x.i0); bounds.add(x.i1); }   // with the transition frames
    for (const x of unexplained.concat(profileRanges)) { bounds.add(x.i0); bounds.add(x.i1); }
    for (let f = 1; f < F.n; f++) {
        if ((F.pidProfile && F.pidProfile[f] !== F.pidProfile[f - 1]) || (F.rateProfile && F.rateProfile[f] !== F.rateProfile[f - 1]) || (F.armed && F.armed[f] !== F.armed[f - 1])) bounds.add(f);
    }
    for (const f of resumes) bounds.add(f);
    const cuts = [...bounds].filter(f => f >= 0 && f < F.n).sort((a, c) => a - c);
    const changedBy = (key, pos) => K_CHANGED.has(key) && K_CHANGED.get(key) <= pos;
    const K_CHANGED = new Map(); for (const it of items) if (!K_CHANGED.has(it.key) || K_CHANGED.get(it.key) > it.pos) K_CHANGED.set(it.key, it.pos);
    // keys that never change and have no loss: their status is the same in each epoch
    const dynamic = [], staticPending = [];
    for (const K of keys.values()) {
        if (K.bps.length) { dynamic.push(K.key); continue; }
        if (!K.base.known) continue;
        const rule = sem && sem.classify ? sem.classify(K.key) : null;
        if (rule && rule.use.concat(Object.values(rule.fields || {})).some(u => u.by === 'boot') && header.boot.has(K.key) && header.boot.get(K.key) !== K.base.value) staticPending.push(K.key);
    }
    const inForceAt = (key, pid, rate) => { const s = slotOf(key); return !s || (s.kind === 'pid' ? s.slot === pid : s.slot === rate); };
    const epochs = [];
    for (let k = 0; k < cuts.length; k++) {
        const i0 = cuts[k], i1 = k + 1 < cuts.length ? cuts[k + 1] : F.n, iter = F.iter[i0];
        const pid = F.pidProfile ? F.pidProfile[i0] : intOr(evalAt(keys.get('pid_profile') || { bps: [], base: {} }, posOf(iter, b)).value);
        const rate = F.rateProfile ? F.rateProfile[i0] : intOr(evalAt(keys.get('rate_profile') || { bps: [], base: {} }, posOf(iter, b)).value);
        const reasons = new Set(), pending = [], unknown = [], uncertainKeys = [], mixedList = [];
        if (!verified) reasons.add('snapshot-incomplete');
        for (const key of staticPending) if (inForceAt(key, pid, rate)) pending.push(key);
        for (const key of dynamic) {
            if (!inForceAt(key, pid, rate)) continue;
            const v = valueAt(key, iter);
            if (v.status === 'unknown') {
                unknown.push(key); reasons.add('unknown');
                const bp = bpAt(keys.get(key), posOf(iter, D - 1));
                if ((bp && (bp.reason === 'lost' || bp.reason === 'L')) || v.flags.includes('lost')) reasons.add('lost');
                if (bp && bp.reason === 'chain-mismatch') reasons.add('chain-mismatch');
            } else if (v.status === 'uncertain') { uncertainKeys.push(key); reasons.add('uncertain'); if (v.flags.includes('order-unknown')) reasons.add('order-unknown'); }
            else if (transitions.some(x => x.key === key && x.i0 < i1 && x.i1 > i0)) { uncertainKeys.push(key); reasons.add('uncertain'); }
            else if (v.status === 'mixed') { mixedList.push(key); reasons.add('mixed'); }
            else if (v.status === 'pending') pending.push(key);
            else if (v.status === 'effect-unknown' && changedBy(key, posOf(iter, D - 1))) reasons.add('effect-unknown');
        }
        if (pending.length) reasons.add('pending');
        // a one-frame epoch with a change at c > 0: mixed only for a key in force, or an A record of the frame's slot (its
        // running values changed during the frame)
        if (i1 - i0 === 1 && mixed.has(iter)) {
            for (const key of mixedKeys.get(iter) || []) if (inForceAt(key, pid, rate) && !mixedList.includes(key)) mixedList.push(key);
            const slotA = (mixedApplies.get(iter) || []).some(a => {
                const L = (sem && sem.loaders) ? sem.loaders[a.loader] : PS.LOADERS[a.loader], kind = L ? L.slot : null;
                return !kind || a.slot === null || a.slot === undefined || a.slot === (kind === 'pid' ? pid : rate);
            });
            if (mixedList.length || slotA) reasons.add('mixed');
        }
        if (unexplained.some(x => x.i0 < i1 && x.i1 > i0)) reasons.add('unexplained-runtime');
        if (profileRanges.some(x => x.i0 < i1 && x.i1 > i0)) reasons.add('chain-mismatch');
        if (resumes.some(f => f <= i0)) reasons.add('resume');
        const order = ['mixed', 'uncertain', 'pending', 'unknown', 'effect-unknown', 'lost', 'snapshot-incomplete', 'chain-mismatch', 'order-unknown', 'unexplained-runtime', 'resume'];
        const list = order.filter(x => reasons.has(x));
        let status = 'exact';
        for (const x of list) status = worst(status, x === 'lost' || x === 'chain-mismatch' || x === 'snapshot-incomplete' ? 'unknown'
            : x === 'order-unknown' || x === 'unexplained-runtime' ? 'uncertain' : x === 'resume' ? 'exact' : x);
        const lastPos = i1 < F.n ? posOf(F.iter[i1], 0) : Infinity, firstPos = i0 === 0 ? -Infinity : posOf(iter, 0);
        const recsIn = [...recs.values()].filter(r => r.type === 'C' && r.at && !r.at.pre && spanOf(r.at)[1] >= firstPos && spanOf(r.at)[1] < lastPos).map(r => r.seq);
        epochs.push({ i0, i1, t0: F.time ? F.time[i0] : null, t1: F.time ? F.time[Math.min(i1, F.n - 1)] : null, iter0: iter, iter1: i1 < F.n ? F.iter[i1] : null,
            pidProfile: pid, rateProfile: rate, armed: F.armed ? F.armed[i0] : null, seq: F.paramSeq ? F.paramSeq[i0] : null,
            status, pending, unknown, uncertain: uncertainKeys, mixed: mixedList, reasons: list, records: recsIn });
    }

    // ---- state, classic keys (4.4) ----
    function stateAt(iter) {
        const out = new Map(), running = new Map(), status = new Map();
        for (const key of keys.keys()) {
            const v = valueAt(key, iter);
            if (v.stored !== null && v.stored !== undefined) out.set(key, v.stored);
            if (v.running !== null && v.running !== undefined) running.set(key, v.running);
            status.set(key, v.status);
        }
        out.running = running; out.status = status;
        return out;
    }
    const t0State = new Map();
    for (const K of keys.values()) { const e = evalAt(K, PRE); if (e.status === 'exact') t0State.set(K.key, e.value); }

    function lookupIndex(text, table) {
        let m;
        if (text === null || text === undefined) return null;
        if ((m = /^\?(\d+)$/.exec(text))) return m[1];
        if (/^-?\d+$/.test(text)) return text;
        const i = table ? table.indexOf(text) : -1;
        return i < 0 ? null : String(i);
    }
    function classicWith(get, pid, rate) {
        const out = {};
        if (!sem || !sem.classic) return out;
        for (const [name, sources] of sem.classic) {
            const parts = [];
            for (const s of sources) {
                let v = null;
                if (s.p !== undefined) v = pid === null || pid === undefined ? null : get(`p${pid}.${s.p}`);
                else if (s.r !== undefined) v = rate === null || rate === undefined ? null : get(`r${rate}.${s.r}`);
                else if (s.m !== undefined) v = get(s.m);
                else if (s.rt !== undefined) {
                    v = header.rt[s.rt] === undefined || header.rt[s.rt] === null ? null : String(header.rt[s.rt]);
                    // div: integer division by another param_rt field (classic looptime = targetLooptime / pid_denom)
                    if (v !== null && s.div !== undefined) { const d = header.rt[s.div]; v = /^\d+$/.test(v) && Number.isInteger(d) && d > 0 ? String(Math.floor(+v / d)) : null; }
                }
                else if (s.boot !== undefined) { const K = keys.get(s.boot); v = K ? (bootValueOf(K).known ? bootValueOf(K).value : null) : null; }
                else if (s.el !== undefined) { const t = get(s.el); v = t === null ? null : (String(t).split(',')[s.field] === undefined ? null : String(t).split(',')[s.field]); }
                else if (s.feature) { const t = get('el.feature'); v = t !== null && /^[0-9A-Fa-f]+$/.test(t) ? String(parseInt(t, 16) >>> 0) : null; }
                if (v !== null && s.lookup) v = lookupIndex(v, sem.lookups[s.lookup]);
                if (v !== null && s.scale) v = /^-?\d+$/.test(v) ? String(+v * s.scale) : null;
                if (v === null) { parts.length = 0; parts.push(null); break; }
                parts.push(v);
            }
            if (parts.length && parts[0] !== null) out[name] = parts.join(',');
        }
        return out;
    }
    // classic(iter): the classic header keys at a frame, for its PID and rate slot (S-frame, else the journal)
    function classic(iter) {
        const f = frameOf(iter);
        const pid = F.pidProfile && F.n ? F.pidProfile[f] : intOr(valueAt('pid_profile', iter).stored);
        const rate = F.rateProfile && F.n ? F.rateProfile[f] : intOr(valueAt('rate_profile', iter).stored);
        return classicWith((key) => { const v = valueAt(key, iter, 'bb'); return v.status === 'exact' || v.status === 'pending' || v.status === 'effect-unknown' ? v.stored : null; }, pid, rate);
    }
    // the classic keys where the firmware wrote the classic lines: the snapshot lines, before the records of the header window
    function classicAtHeader() {
        return classicWith((key) => { const K = keys.get(key); return K && K.base.known ? K.base.value : null; }, header.pid0, header.rate0);
    }

    const complete = full && header.complete && !losses.length && !(journal.crcErrors || []).length && !flags.some(x => x.type === 'chain-mismatch');
    return {
        version: header.version, mode: header.mode, complete, header, semantics: sem, journal, trailing,
        t0State, epochs, mixed, mixedKeys, uncertain, transitions, unknown: unknownRanges, losses, flags, applies, runtime, markers, ends, items,
        phase, pidDenom: D, filterDenom: FD, bbTick: b,
        keys: () => [...keys.keys()],
        valueAt, stateAt, classic, classicAtHeader, frameOf,
    };
}

// pg items -> bytes, '<key>[<i>]' -> base and index
function expandItems(list) {
    const out = [];
    for (const it of list || []) {
        const m = /^(.*)\[(\d+)\]$/.exec(it.key);
        if (/^pg\.\d+\+\d+$/.test(it.key)) {
            const nb = rawBytes(it.key, it.value), ob = rawBytes(it.key, it.old);
            if (nb && ob && nb.length === ob.length) { nb.forEach(([k, v], j) => out.push({ base: k, index: null, value: v, old: ob[j][1] })); continue; }
        }
        out.push(m ? { base: m[1], index: +m[2], value: it.value, old: it.old } : { base: it.key, index: null, value: it.value, old: it.old });
    }
    return out;
}

// Keys that the classic header gives for keys with no snapshot line (CHANGES mode, an incomplete snapshot): shown only as
// "header, not verified" (2.6.3). Map(key -> text)
function classicHints(sysConfig, header, sem) {
    const hints = new Map();
    if (!sysConfig || !sem || !sem.classic) return hints;
    const lines = classicFromSysConfig(sysConfig, sem), pid = header.pid0, rate = header.rate0;
    for (const [name, sources] of sem.classic) {
        if (lines[name] === undefined) continue;
        const parts = String(lines[name]).split(',');
        if (parts.length !== sources.length && !(sources.length === 1)) continue;
        sources.forEach((s, i) => {
            let key = null;
            if (s.p !== undefined && pid !== null) key = `p${pid}.${s.p}`;
            else if (s.r !== undefined && rate !== null) key = `r${rate}.${s.r}`;
            else if (s.m !== undefined) key = s.m;
            if (!key) return;
            let v = sources.length === 1 ? String(lines[name]) : parts[i];
            if (s.scale) v = /^-?\d+$/.test(v) ? String(+v / s.scale) : null;
            if (v !== null && s.lookup && /^\d+$/.test(v)) { const t = sem.lookups[s.lookup]; v = t && t[+v] !== undefined ? t[+v] : `?${v}`; }
            if (v !== null) hints.set(key, v);
        });
    }
    return hints;
}

/**
 * Self-test of 4.4: classic() at the point where the classic lines were written must equal the classic H lines.
 *   classicLines  [[name, value]] or { name: value } (raw header text), or a sysConfig (classicFromSysConfig)
 * -> { ok, compared, mismatches: [{ key, header, journal, explained }] }. A key that a record before T0 changed is
 * explained (the classic line and the snapshot line can be on two sides of the change).
 */
function selfTest(timeline, classicLines) {
    let lines = classicLines;
    if (Array.isArray(lines)) lines = Object.fromEntries(lines.map(l => [String(l[0]), String(l[1])]));
    else if (lines && (lines.paramHeader || lines.firmwareType !== undefined)) lines = classicFromSysConfig(lines, timeline.semantics);
    const norm = (v) => String(v).split(',').map(s => s.trim()).map(s => /^-?\d+(?:\.\d+)?$/.test(s) ? String(+s) : s).join(',');
    const journal = timeline.classicAtHeader(), mismatches = [];
    const preKeys = new Set(timeline.items.filter(it => it.pre).map(it => it.key));
    let compared = 0;
    for (const key of Object.keys(journal)) {
        if (!lines || lines[key] === undefined) continue;
        compared++;
        if (norm(lines[key]) === norm(journal[key])) continue;
        const sources = ((timeline.semantics && timeline.semantics.classic.find(c => c[0] === key)) || [null, []])[1];
        const explained = sources.some(s => [...preKeys].some(k => k === s.m || (s.p && k.endsWith(`.${s.p}`)) || (s.r && k.endsWith(`.${s.r}`)) || k === s.el || (s.feature && k === 'el.feature')));
        mismatches.push({ key, header: lines[key], journal: journal[key], explained });
    }
    return { ok: mismatches.every(m => m.explained), compared, mismatches };
}

/**
 * The inputs of buildTimeline from an open FlightLog (js/flightlog.js), with getChunksInTimeRange (never the smoothed
 * variant): { frames: { iter, time, pidProfile, rateProfile, armed, paramSeq } (Float64Array; null where the log has no
 * such field), strings: [{ text, time }] (event 101 in log order), resumes: [frame index] }
 */
function collect(log) {
    const tMin = log.getMinTime(), tMax = log.getMaxTime(), idx = (n) => log.getMainFieldIndexByName(n);
    const cols = { pidProfile: idx('pidProfile'), rateProfile: idx('rateProfile'), armed: idx('armed'), paramSeq: idx('paramSeq') };
    const iter = [], time = [], data = { pidProfile: [], rateProfile: [], armed: [], paramSeq: [] }, strings = [], resumeTimes = [];
    for (const c of log.getChunksInTimeRange(tMin, tMax)) {
        for (const f of c.frames) {
            iter.push(f[0]); time.push(f[1]);
            for (const k in cols) if (cols[k] !== undefined) data[k].push(f[cols[k]]);
        }
        for (const e of c.events) {
            if (e.event === EV.CUSTOM_STRING && e.data && typeof e.data.string === 'string') strings.push({ text: e.data.string, time: e.time });
            else if (e.event === EV.LOGGING_RESUME) resumeTimes.push(e.time);
        }
    }
    const frames = { iter: Float64Array.from(iter), time: Float64Array.from(time) };
    for (const k in cols) frames[k] = cols[k] === undefined ? null : Float64Array.from(data[k]);
    const resumes = resumeTimes.filter(t => Number.isFinite(t)).map(t => lowerBound(frames.time, t)).filter(i => i < frames.iter.length);
    return { frames, strings, resumes };
}

module.exports = { RULES, PHASE_OF_DENOM, PARAM_KEY, fnv1, crc8, unescapeValue, isParamLog, parseParamHeader, snapshotState, parsePoint, pointText,
    parseRecord, assemble, buildTimeline, selfTest, classicFromSysConfig, collect };
if (require.main !== module) return;

// node tools/autotune/param_log.cjs <log file>: the parameter journal of each log of the file
const lib = require('./lib.cjs');
const file = process.argv[2];
if (!file) { console.error('usage: node tools/autotune/param_log.cjs <log file>'); process.exit(1); }
const app = lib.loadApp(), FlightLog = app.FlightLog;
const flog = new FlightLog(require('fs').readFileSync(file));
for (let i = 0; i < flog.getLogCount(); i++) {
    if (flog.getLogError(i) || !flog.openLog(i)) { console.log(`log ${i + 1}: ${flog.getLogError(i)}`); continue; }
    const sc = flog.getSysConfig();
    if (!isParamLog(sc)) { console.log(`log ${i + 1}: stock log (no parameter journal)`); continue; }
    const got = collect(flog), journal = assemble(got.strings);
    const tl = buildTimeline({ sysConfig: sc, records: journal, frames: got.frames, resumes: got.resumes });
    const st = selfTest(tl, sc);
    console.log(`log ${i + 1}: Param log ${tl.version} ${tl.mode}, header ${tl.header.complete ? 'complete' : 'incomplete'}, ${journal.records.size} records, ` +
        `${journal.gaps.length} gaps, ${journal.crcErrors.length} CRC errors, ${tl.epochs.length} epochs, ${tl.flags.length} flags, self-test ${st.ok ? 'ok' : 'FAILED'} (${st.compared} keys)`);
    for (const e of tl.epochs) console.log(`  frames ${e.i0}-${e.i1} PID profile ${e.pidProfile + 1} rate profile ${e.rateProfile + 1} ${e.armed ? 'armed' : 'disarmed'} ${e.status} ${e.reasons.join(',')}`);
    for (const m of st.mismatches) console.log(`  self-test ${m.key}: header ${m.header} journal ${m.journal}${m.explained ? ' (explained)' : ''}`);
}
