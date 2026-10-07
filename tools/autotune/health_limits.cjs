'use strict';

/**
 * Control outputs at their limits (new ids), in all phases of a flight log, rescue included, with no guard time:
 *
 *   L1  throttle: motor[0] at its maximum (gov_max_throttle of the CLI dump for the PID profile, else a maximum that the
 *       data shows, else the firmware maximum of 100 %)
 *   L2  collective: mixer[3] at the collective limit of the log header (collectiveRange, the limits of the mixer input SC)
 *   L7  collective stick: rcCommand[3] at the end of its range (+-500, rc.c: the deflection -1..1 x 500), in flight and in a
 *       rescue only: on the ground the pilot keeps the collective stick at its minimum on purpose
 *   L3  cyclic: mixer[0] and mixer[1] at their limits, and the swash ring (|mixer[0], mixer[1]|) at its limit
 *   L4  tail: mixer[2] at its CW or CCW limit (the limits of check T8)
 *   L5  servos: servo[N] at the limits of that servo (the CLI dump only: the log header does not give them, and the extreme
 *       of a servo in the data is the position of the stick at its end, not a limit: Gaui X4 #50 servo[0] 1349 us)
 *   L6  I-term: axisI at its limit (SCALE.I x I gain x error_limit, as check C1)
 *   curves(w, ctx, metrics)  the share of time at a limit for each channel, in 0.1 s bins, for the UI
 *
 * The firmware has no separate limit of the PID sum (pid.c, release/4.6.0): the output limit of each axis is the limit of its
 * mixer input (mixer.c mixerApplyInputLimit), which L3 and L4 examine.
 *
 * Limits (the limit of THIS log; a channel with no known limit gets "limit unknown" with the reason, never an assumed value):
 *   - the log header gives only collectiveRange (blackbox.c header, mixerInputs(MIXER_IN_STABILIZED_COLLECTIVE) min, max);
 *   - from the data: an extreme that the channel reaches RULE.pile.samples times or more (within RULE.pile.tol of it), and
 *     not fewer times than the band RULE.pile.band under it: the clamp rule of checks C2 and T8 (health_loop limitOf), in the
 *     samples of the flight phase and of the rescue when the phases are known. A limit from the data is a limit of this log;
 *   - the CLI dump: `mixer input SR|SP|SY|SC <min> <max> <rate>`, `servo <n> <mid> <min> <max> ...` (the limits are mid + min
 *     and mid + max, servos.c limitTravel), gov_max_throttle and the I gain and error_limit of each PID profile. A CLI dump can
 *     be older than the log: its values come after the values of the log;
 *   - the throttle: the governor clamps the throttle at gov_max_throttle (governor.c govPIDControl, constrainf to
 *     maxThrottle), and the motor output is 0 to 1 (motor[0] 0 to 1000, 0.1 % units, the firmware maximum).
 *
 * A period at the limit: samples within RULE.tol (0.5 %) of the limit, with gaps of less than RULE.joinS joined. For each
 * period: start and end (index time t, t1 and frame seconds tS, t1S), duration, phase, PID profile, rescue state, the other
 * channels at their limits at the same time, the headspeed error against the target (as check G19), the rate error of each
 * axis and the governor states, from the start to RULE.postS after the end.
 *
 * Module contract as health_loop.cjs: analyse measures with the parameters in RULE, judge decides with DEFAULT_RULES. Finding
 * texts are ASD-STE100 (docs/STE_GLOSSARY.md); code reads the fields, never the text. Units: the units of the log (motor[0]
 * 0.1 %, mixer permille, servo us, axisI permille).
 */

const lib = require('./lib.cjs');
const optional = (name) => { try { return require(name); } catch (e) { return null; } };
const RESCUE = require('./health_rescue.cjs');
const SETUP = optional('./health_setup.cjs'), GOV = optional('./health_gov.cjs'), LOOP = optional('./health_loop.cjs'), TRACK = optional('./health_track.cjs');

const RULE = {
    tol: 0.005,                 // at the limit: within 0.5 % of it
    joinS: 0.05,                // two periods with a gap of less than 50 ms are one
    pile: { samples: 20, band: 0.02, tol: 0.005 }, // a limit from the data (health_loop RULE.limitSamples, limitBand; tol as RULE.tol)
    throttleMax: 1000,          // motor[0] at 100 %
    stickEnd: 500,              // L7: rcCommand[3] at +-500 is the collective stick at its end (rc.c)
    cliCeiling: 2,              // L1: a CLI gov_max_throttle is not used when motor[0] is more than 2 counts over it (health_gov RULE.cliCheck.ceilingCounts)
    linked: 0.8,                // two channels at the limit for the same samples (80 % of the larger time) are one output
    linkedR: 0.9,               // or two channels whose values have a correlation of 0.9 or more (the tail servo and mixer[2])
    postS: 0.2,                 // the errors of a period: from its start to 0.2 s after its end
    trackSp: 5,                 // deg/s: under this rms setpoint the tracking ratio of a period is not used (health_track RULE.track gate)
    track: { padS: 0.5, delayS: [0, 0.15, 0.01] }, // the tracking ratio of a period: 0.5 s before to 0.5 s after it, at the best time delay of 0-150 ms (check C12)
    beforeRescueS: 2,           // a period that ends less than this before a rescue start is "before the rescue"
    binS: 0.1,                  // curves time step
    maxPeriods: 50,             // periods kept for each channel and PID profile, the longest first
};

const EXTRA = ['motor[0]', 'mixer[3]', 'rcCommand[3]', 'govTarget', 'govRequest', 'flightModeFlags', 'time', 'servo[0]', 'servo[1]', 'servo[2]', 'servo[3]', 'servo[4]', 'servo[5]', 'servo[6]', 'servo[7]'];

// limits of the related checks, read from their modules
const num = (v) => typeof v === 'number' && isFinite(v) ? v : null;
const G3_FLAG = num(GOV && GOV.DEFAULT_RULES && GOV.DEFAULT_RULES.G3 && GOV.DEFAULT_RULES.G3.flag) ?? 0.05;
const T6_KICK = num(LOOP && LOOP.DEFAULT_RULES && LOOP.DEFAULT_RULES.T6 && LOOP.DEFAULT_RULES.T6.kick) ?? 30;
const C12_FLAG = num(TRACK && TRACK.DEFAULT_RULES && TRACK.DEFAULT_RULES.C12 && TRACK.DEFAULT_RULES.C12.flag) ?? 0.45;
const T11_FLAG = num(TRACK && TRACK.DEFAULT_RULES && TRACK.DEFAULT_RULES.T11 && TRACK.DEFAULT_RULES.T11.flag) ?? 0.45;
const P = 'pipeline, unvalidated';
const STATUS = 'a period at the limit is "Monitor"; a period of 100 ms or more, an error more than the limit of the related check, or two or more outputs at their limits at the same time is a problem';
const DEFAULT_RULES = {
    longS: 0.1, combined: 2,
    L1: { error: 'headspeed', limit: G3_FLAG, source: `${P}; ${STATUS}. Related check G3 (${G3_FLAG * 100} % headspeed decrease). Limit: gov_max_throttle (CLI), else the data, else the firmware maximum of 100 %` },
    L2: { error: 'headspeed', limit: G3_FLAG, source: `${P}; ${STATUS}. Related check G3 (${G3_FLAG * 100} % headspeed decrease). Limit: collectiveRange of the log header (the mixer input SC), else the mixer input SC of an optional CLI dump` },
    L7: { error: 'headspeed', limit: G3_FLAG, source: `${P}; ${STATUS}. Related check G3 (${G3_FLAG * 100} % headspeed decrease). Limit: the end of the stick range, rcCommand[3] +-500 of the firmware, in flight and in a rescue` },
    L3: { error: 'tracking', limit: C12_FLAG, source: `${P}; ${STATUS}. Related check C12 (tracking error ${C12_FLAG * 100} % of the setpoint). Limit: the data (the clamp rule of check C2), else the mixer input SR and SP of an optional CLI dump` },
    L4: { error: 'yaw', limit: T6_KICK, source: `${P}; ${STATUS}. Related check T6 (yaw error ${T6_KICK} deg/s). Limit: the limits of check T8, else the data, else the mixer input SY of an optional CLI dump` },
    L5: { error: 'tracking', limit: C12_FLAG, yawLimit: T6_KICK, source: `${P}; ${STATUS}. Related checks T6 (the tail servo: the servo that follows mixer[2] with a correlation of 0.9 or more) and C12 (the other servos). Limit: the servo values of an optional CLI dump (mid + min, mid + max). The log header does not record the servo limits` },
    L6: { error: 'tracking', limit: C12_FLAG, yawLimit: T11_FLAG, source: `${P}; ${STATUS}. Related checks C12 and T11. Limit: SCALE.I x I gain x error_limit (pid.c, as check C1), from an optional CLI dump for each PID profile, else the log header for the PID profile at the start of the log` },
};
const UNITS = { L1: 's', L2: 's', L3: 's', L4: 's', L5: 's', L6: 's', L7: 's' };
const AXES = ['roll', 'pitch', 'yaw'];
const SCALE_I = (lib.SCALE && lib.SCALE.I) || [2e-4, 2e-4, 5e-4];

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

const cap = (x) => x ? x.charAt(0).toUpperCase() + x.slice(1) : x;
const r = (v, d = 3) => (typeof v === 'number' && isFinite(v)) ? +v.toFixed(d) : null;
const median = (list) => { const s = Float64Array.from(list).sort(); return s.length ? s[s.length >> 1] : null; };
function runs(n, pred) { const out = []; let s = -1; for (let i = 0; i <= n; i++) { const on = i < n && pred(i); if (on && s < 0) s = i; else if (!on && s >= 0) { out.push([s, i]); s = -1; } } return out; }
const PHASES = ['idle', 'spoolup', 'ground', 'flight', 'spooldown'];
const GOVERNED = new Set([3, 4, 6, 8]);
const STATES = ['OFF', 'IDLE', 'SPOOLUP', 'RECOVERY', 'ACTIVE', 'HOLD', 'FALLBACK', 'AUTOROTATION', 'BAILOUT', 'BYPASS'];
const statesOf = (h) => { const v = String((h && h.firmwareVersion) || '').split('.').map(Number); return v[0] === 4 && v[1] < 6 ? STATES.slice(0, 5).concat(['LOST_THROTTLE', 'LOST_HEADSPEED'], STATES.slice(7)) : STATES; };
const list = (v) => Array.isArray(v) ? v.map(Number) : typeof v === 'string' ? v.split(',').map(Number) : typeof v === 'number' ? [v] : null;

// the correlation of two columns (every 10th sample)
function corr(a, b) {
    let n = 0, ma = 0, mb = 0; for (let i = 0; i < a.length; i += 10) { ma += a[i]; mb += b[i]; n++; } if (n < 3) return 0; ma /= n; mb /= n;
    let sab = 0, saa = 0, sbb = 0; for (let i = 0; i < a.length; i += 10) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
    return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : 0;
}

// the pilot's CLI dump: { text, parsed } or null (ctx.cliParsed, else ctx.cli parsed by health_setup)
function cliOf(ctx) {
    const text = ctx.cli && (typeof ctx.cli === 'string' ? ctx.cli : ctx.cli.text) || null;
    let parsed = ctx.cliParsed || null;
    if (!parsed && text && SETUP && typeof SETUP.parseCli === 'function') { if (!cliOf.last || cliOf.last.text !== text) cliOf.last = { text, parsed: SETUP.parseCli(text) }; parsed = cliOf.last.parsed; }
    return text || parsed ? { text, parsed } : null;
}
// `servo <n> <mid> <min> <max> ...` of the CLI dump: [{ lo, hi }] by servo index from 0 (the dump counts from 0 or from 1)
function cliServos(text) {
    if (!text) return null;
    const rows = []; for (const line of String(text).split(/\r?\n/)) { const m = /^\s*servo (\d+) (\d+) (-?\d+) (-?\d+)\b/.exec(line); if (m) rows.push([+m[1], +m[2], +m[3], +m[4]]); }
    if (!rows.length) return null;
    const base = Math.min(...rows.map(q => q[0])) === 0 ? 0 : 1, out = [];
    for (const [k, mid, mn, mx] of rows) out[k - base] = { lo: mid + mn, hi: mid + mx };
    return out;
}

// A limit from the data (the clamp rule of checks C2 and T8): { lo, hi } of the values v[i0..i1) (null for a side with no clamp)
function pileIn(v, ok) {
    const L = RULE.pile; let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < v.length; i++) if (!ok || ok[i]) { const x = v[i]; if (x < lo) lo = x; if (x > hi) hi = x; }
    if (!isFinite(lo)) return { lo: null, hi: null, min: null, max: null };
    const tl = (x) => Math.max(1, L.tol * Math.abs(x)), bd = (x) => Math.max(2, L.band * Math.abs(x));
    let atLo = 0, atHi = 0, nearLo = 0, nearHi = 0;
    for (let i = 0; i < v.length; i++) if (!ok || ok[i]) { const x = v[i];
        if (x <= lo + tl(lo)) atLo++; else if (x <= lo + bd(lo)) nearLo++;
        if (x >= hi - tl(hi)) atHi++; else if (x >= hi - bd(hi)) nearHi++; }
    return { lo: atLo >= L.samples && atLo >= nearLo && lo < 0 ? lo : null, hi: atHi >= L.samples && atHi >= nearHi && hi > 0 ? hi : null, min: lo, max: hi };
}

// ---------------------------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------------------------

// The channels that the log records: { key, id, axis, field, label, v (values in the units of the log), limitAt(i) -> { lo, hi }
// | null, limits: { lo, hi, source } (one limit for the log) or byProfile, unknown: reason, related: 'headspeed' | 'yaw' | axis }
function channels(w, ctx, prof, air) {
    const n = w.n, X = w.extra || {}, H = ctx.header || (w.flight && w.flight.header) || {}, cli = cliOf(ctx), out = [];
    // a limit from the data comes from the samples in flight and in a rescue (air): on the ground the pilot holds the collective
    // at its minimum, and a servo stays at that position for many seconds with no limit (Gaui X4 #50: servo[0] at 1349 us)
    const pileOf = (v) => pileIn(v, air);
    const mix = [0, 1, 2].map(a => w.u[a] ? Float64Array.from(w.u[a], v => Math.round(v * 1000)) : null), mi = cli && cli.parsed && cli.parsed.mixerInputs || {};
    const fixed = (o, lo, hi, source) => Object.assign(o, { limits: { lo, hi, source }, limitAt: () => ({ lo, hi }) });
    const unknown = (o, why) => Object.assign(o, { limits: null, unknown: why, limitAt: () => null });
    // L1 throttle
    if (X['motor[0]']) { const v = X['motor[0]'], o = { key: 'throttle', id: 'L1', axis: null, field: 'motor[0]', label: 'motor[0]', v, related: 'headspeed' };
        // a CLI gov_max_throttle that this log contradicts (motor[0] more than RULE.cliCeiling over it in that PID profile, as
        // health_gov RULE.cliCheck) is older than the log: it is not used (Fireball 2026-09-29 #3: 60 % in the CLI, 100 % in the log)
        const mt0 = ctx.maxThrottle || null, mt = mt0 ? {} : null, over = new Set();
        if (mt0) { for (let i = 0; i < n; i++) { const p = prof ? prof[i] : 0; if (mt0[p] && v[i] > mt0[p] * 10 + RULE.cliCeiling) over.add(+p); }
            for (const [p, x] of Object.entries(mt0)) if (!over.has(+p)) mt[p] = x; }
        const pile = pileOf(v), cliP = mt ? Object.keys(mt).map(Number) : [];
        if (over.size) o.cliRejected = [...over];
        if (cliP.length) Object.assign(o, { limits: { lo: null, hi: null, source: 'cli', byProfile: Object.fromEntries(cliP.map(p => [p, Math.min(RULE.throttleMax, mt[p] * 10)])) },
            limitAt: (i) => { const p = prof ? prof[i] : 0; return mt[p] ? { lo: null, hi: Math.min(RULE.throttleMax, mt[p] * 10) } : pile.hi !== null ? { lo: null, hi: pile.hi } : { lo: null, hi: RULE.throttleMax }; } });
        else if (pile.hi !== null && pile.hi < RULE.throttleMax) fixed(o, null, pile.hi, 'data');
        else fixed(o, null, RULE.throttleMax, 'firmware');
        out.push(o); }
    // L2 collective output and command
    const m3 = X['mixer[3]'];
    if (m3) { const cr = list(H.collectiveRange), o = { key: 'collective', id: 'L2', axis: null, field: 'mixer[3]', label: 'mixer[3]', v: m3, related: 'headspeed' }, pile = pileOf(m3);
        // the header or the CLI dump only: the extreme of mixer[3] in the data is the collective stick at its end (L7), not a limit
        const sc = mi.SC ? [mi.SC[0], mi.SC[1]] : null, lim = cr && cr.length === 2 && cr[0] < cr[1] ? [cr[0], cr[1], 'header'] : sc ? [sc[0], sc[1], 'cli'] : null;
        if (lim) fixed(o, lim[0], lim[1], lim[2]); else unknown(o, `The log header does not record collectiveRange${cli ? ', and the CLI dump does not have the mixer input SC' : ''}.`);
        void pile;
        out.push(o);
    }
    // L7 the collective stick at the end of its range (rc.c: rcCommand = deflection x 500, the deflection -1..1)
    { const rc = X['rcCommand[3]'], o = { key: 'collectiveCommand', id: 'L7', axis: null, field: 'rcCommand[3]', label: 'collective stick', v: rc, related: 'headspeed', command: true };
        if (rc) out.push(fixed(o, -RULE.stickEnd, RULE.stickEnd, 'firmware')); }
    // L3 cyclic
    for (const a of [0, 1]) if (mix[a]) { const name = AXES[a], o = { key: name, id: 'L3', axis: name, field: `mixer[${a}]`, label: `mixer[${a}]`, v: mix[a], related: name }, pile = pileOf(mix[a]), c = mi[a ? 'SP' : 'SR'];
        if (pile.lo !== null || pile.hi !== null) fixed(o, pile.lo, pile.hi, 'data');
        else if (c) fixed(o, c[0], c[1], 'cli');
        else unknown(o, `The log header does not record the ${name} limits, and the data shows no ${name} limit.`);
        out.push(o); }
    if (mix[0] && mix[1]) { const ring = Float64Array.from(mix[0], (x, i) => Math.round(Math.hypot(x, mix[1][i]))), pile = pileOf(ring);
        // a ring that is the limit of one axis is that axis (C2 rule: a ring not explained by an axis clamp)
        if (pile.hi !== null && !out.some(o => o.id === 'L3' && o.limits && o.limits.source === 'data' && [o.limits.lo, o.limits.hi].some(x => x !== null && Math.abs(Math.abs(x) - pile.hi) <= RULE.tol * pile.hi)))
            out.push(fixed({ key: 'ring', id: 'L3', axis: null, field: 'mixer[0]', label: 'swash ring', v: ring, related: 'cyclic' }, null, pile.hi, 'data')); } // the plot shows mixer[0]; the limit is of |mixer[0], mixer[1]|
    // L4 tail
    if (mix[2]) { const o = { key: 'tail', id: 'L4', axis: 'yaw', field: 'mixer[2]', label: 'mixer[2]', v: mix[2], related: 'yaw' }, T8 = ctx.tailLimits, pile = pileOf(mix[2]), c = mi.SY;
        const t8 = T8 && (num(T8.lo) !== null || num(T8.hi) !== null) ? [num(T8.lo) === null ? null : Math.round(T8.lo * 1000), num(T8.hi) === null ? null : Math.round(T8.hi * 1000)] : null;
        if (t8) fixed(o, t8[0], t8[1], 'T8'); else if (pile.lo !== null || pile.hi !== null) fixed(o, pile.lo, pile.hi, 'data'); else if (c) fixed(o, c[0], c[1], 'cli');
        else unknown(o, 'The log header does not record the tail limits, and check T8 and the data show no tail limit.');
        out.push(o); }
    // L5 servos
    const cs = cli ? cliServos(cli.text) : null;
    for (let k = 0; k < 8; k++) { const v = X[`servo[${k}]`]; if (!v || v.every(x => x === v[0])) continue;
        // the tail servo follows mixer[2] (correlation RULE.linkedR or more); the other servos are cyclic servos
        const tailServo = !!mix[2] && Math.abs(corr(v, mix[2])) >= RULE.linkedR;
        const o = { key: `servo[${k}]`, id: 'L5', axis: tailServo ? 'yaw' : null, field: `servo[${k}]`, label: `servo[${k}]`, v, related: tailServo ? 'yaw' : 'cyclic' }, pile = pileOf(v), c = cs && cs[k];
        // a servo pulse is positive: its two limits are its lowest and highest values that pile up
        if (c) fixed(o, c.lo, c.hi, 'cli');
        else unknown(o, `The log header does not record the servo limits${cli ? ', and the CLI dump does not have the \`servo\` values' : ''}.`);
        void pile; out.push(o); }
    // L6 I-term: the limit of each PID profile (CLI section of the profile, else the header for the PID profile at the start)
    // a label of ctx.profile is a configuration of js/tuning_worker.js when ctx.pidProfileOf is given: its PID profile has the CLI section
    const pidOf = typeof ctx.pidProfileOf === 'function' ? ctx.pidProfileOf : (p) => p;
    const sec = (p) => { const q = pidOf(p); return cli && cli.parsed && q > 0 ? cli.parsed.profiles[String(q - 1)] || null : null; }, startP = prof ? prof[0] : 0, el0 = list(H.error_limit);
    for (const a of [0, 1, 2]) { const I = w.I && w.I[a]; if (!I) continue;
        const name = AXES[a], v = Float64Array.from(I, x => x * 1000), hp = list(H[`${name}PID`]), cache = new Map();
        const limitOfP = (p) => { if (cache.has(p)) return cache.get(p); let L = null, src = null; const s = sec(p);
            const ki = s && num(+s[`${name}_i_gain`]) !== null ? +s[`${name}_i_gain`] : null, el = s ? list(s.error_limit) : null;
            if (ki !== null && el && num(el[a]) !== null) { L = SCALE_I[a] * ki * el[a] * 1000; src = 'cli'; }
            else if ((p === 0 || p === startP) && hp && num(hp[1]) !== null && el0 && num(el0[a]) !== null) { L = SCALE_I[a] * hp[1] * el0[a] * 1000; src = 'header'; }
            const o = L !== null && L > 0 ? { lo: -L, hi: L, source: src } : null; cache.set(p, o); return o; };
        const o = { key: `iterm ${name}`, id: 'L6', axis: name, field: `axisI[${a}]`, label: `axisI[${a}]`, v, related: name, limitAt: (i) => limitOfP(prof ? prof[i] : 0), profileLimit: limitOfP };
        const ps = prof ? [...new Set(prof)] : [0], known = ps.filter(p => limitOfP(p));
        if (!known.length) unknown(o, `The I gain and error_limit of the ${name} axis are unknown for these PID profiles. The log header records them only for the PID profile at the start of the log.`);
        else o.limits = { lo: null, hi: null, source: known.map(p => limitOfP(p).source).join(','), byProfile: Object.fromEntries(known.map(p => [p, r(limitOfP(p).hi, 1)])), unknownProfiles: ps.filter(p => !limitOfP(p)) };
        out.push(o); }
    return out;
}

// ---------------------------------------------------------------------------------------------
// analyse
// ---------------------------------------------------------------------------------------------

function analyse(w, ctx = {}) {
    const n = w.n, rate = ctx.rate || w.rate, X = w.extra || {}, H = ctx.header || (w.flight && w.flight.header) || {}, C = RESCUE.clocks(w, rate), { F, at, t } = C;
    const prof = ctx.profile || w.profileAt, gov = ctx.govState !== undefined ? ctx.govState : w.govStateAt || null, names = statesOf(H), code = ctx.phases && ctx.phases.code && ctx.phases.code.length === n ? ctx.phases.code : null;
    const out = { module: 'health_limits', rule: RULE, rate: r(rate, 2), fromS: r(w.fromS, 3), seconds: r(n / rate, 1), frameClock: C.frame, channels: [], notes: [] };
    // the rescues (health_rescue) and the reference headspeed (govTarget; govRequest where the governor starts from the headspeed)
    const resc = RESCUE.rescueRuns(w, ctx, rate).list, tg = X.govTarget, rq = X.govRequest, ref = tg ? new Float64Array(n) : null;
    if (tg) { let last = null; for (let i = 0; i < n; i++) { const g = gov ? gov[i] : 4; if (g === 4 && tg[i] > 0) last = tg[i]; ref[i] = gov && (g === 2 || g === 3 || g === 8) ? (rq && rq[i] > 0 ? rq[i] : last || tg[i]) : tg[i]; } }
    // the headspeed error only where the governor holds a headspeed (RECOVERY, ACTIVE, FALLBACK, BAILOUT; without GOVSTATE: the
    // headspeed at half of the target or more): at OFF, IDLE and in the spool-up the headspeed is under the target by design
    const governed = (i) => gov ? GOVERNED.has(gov[i]) : ref && w.hs[i] >= 0.5 * ref[i];
    // the collective command: only in flight or in a rescue (without phases: the governor holds the headspeed). On the ground the
    // pilot keeps the collective at its minimum on purpose, which is not a limit of the control
    const rescueMask = new Uint8Array(n); for (const q of resc) rescueMask.fill(1, q.i0, q.i1);
    const airborne = (i) => rescueMask[i] || (code ? code[i] === 3 : governed(i));
    const airMask = code ? Uint8Array.from(code, (c, i) => c === 3 || rescueMask[i] ? 1 : 0) : null;
    const chans = channels(w, ctx, prof, airMask && airMask.some(x => x) ? airMask : null), masks = new Map(), join = Math.max(1, Math.round(RULE.joinS * rate)), post = Math.round(RULE.postS * rate);
    for (const c of chans) {
        if (!c.limitAt || (!c.limits && c.unknown)) continue;
        const m = new Uint8Array(n), v = c.v;
        for (let i = 0; i < n; i++) { const L = c.limitAt(i); if (!L || (c.command && !airborne(i))) continue; const x = v[i];
            if (L.hi !== null && L.hi !== undefined && x >= L.hi - RULE.tol * Math.abs(L.hi)) m[i] = 2;
            else if (L.lo !== null && L.lo !== undefined && x <= L.lo + RULE.tol * Math.abs(L.lo)) m[i] = 1; }
        // join gaps of less than RULE.joinS
        const rs = runs(n, i => m[i] > 0), joined = [];
        for (const [s, e] of rs) { const last = joined[joined.length - 1]; if (last && s - last[1] < join && m[s] === m[last[1] - 1]) last[1] = e; else joined.push([s, e]); }
        masks.set(c, { m, periods: joined });
    }
    // two channels whose times at the limit are almost the same (RULE.linked of the larger time) are one output (a servo that
    // follows its mixer input to the same limit): they do not count as two outputs at their limits at the same time
    const counts = new Map([...masks].map(([c, M]) => [c, M.m.reduce((k, x) => k + (x ? 1 : 0), 0)])), linked = new Map();
    for (const [c, A] of masks) for (const [d, B] of masks) { if (c === d || !counts.get(c) || !counts.get(d)) continue; let both = 0; for (let i = 0; i < n; i++) if (A.m[i] && B.m[i]) both++;
        if (both >= RULE.linked * Math.max(counts.get(c), counts.get(d)) || Math.abs(corr(c.v, d.v)) >= RULE.linkedR) { if (!linked.has(c)) linked.set(c, []); linked.get(c).push(d.key); } }
    // the errors of [s, e): the lowest headspeed error, the largest |rate error| of each axis, the tracking ratio of each axis
    const errors = (s, e) => { const b = Math.min(n, e + post), o = { headspeed: null, rate: {}, ratio: {}, states: [] };
        if (ref) { const k = Math.max(1, Math.round(0.1 * rate)), step = Math.max(1, Math.round(0.005 * rate)); let lo = Infinity;
            for (let i = s; i < b; i += step) { if (!(ref[i] > 0) || !governed(i)) continue; const hm = median(w.hs.subarray(Math.max(0, i - k), Math.min(n, i + k + 1))), q = (hm - ref[i]) / ref[i]; if (q < lo) lo = q; }
            o.headspeed = isFinite(lo) ? r(lo, 4) : null; }
        // the tracking ratio as check C12 measures it: rms(gyro(t + tau) - setpoint) / rms(setpoint) at the best time delay tau
        // in RULE.track.delayS, over RULE.track.padS before the period to RULE.track.padS after it (a short period alone is no
        // measure of the tracking: the gyro follows the setpoint with a time delay)
        const T = RULE.track, w0 = Math.max(0, s - Math.round(T.padS * rate)), w1 = Math.min(n, e + Math.round(T.padS * rate)), dmax = Math.round(T.delayS[1] * rate), dstep = Math.max(1, Math.round(T.delayS[2] * rate));
        for (let a = 0; a < 3; a++) { let pk = 0; for (let i = s; i < b; i++) { const d = Math.abs(w.gyro[a][i] - w.sp[a][i]); if (d > pk) pk = d; }
            o.rate[AXES[a]] = r(pk, 1);
            let ss = 0; for (let i = w0; i < w1; i++) ss += w.sp[a][i] ** 2; const rs = Math.sqrt(ss / Math.max(1, w1 - w0));
            if (rs < RULE.trackSp) { o.ratio[AXES[a]] = null; continue; }
            let best = Infinity; for (let d = 0; d <= dmax; d += dstep) { let ee = 0, k = 0; for (let i = w0; i < w1 && i + d < n; i++) { const q = w.gyro[a][i + d] - w.sp[a][i]; ee += q * q; k++; } if (k) best = Math.min(best, Math.sqrt(ee / k) / rs); }
            o.ratio[AXES[a]] = isFinite(best) ? r(best, 3) : null; }
        if (gov) { const seen = []; for (let i = s; i < b; i++) if (!seen.includes(gov[i])) seen.push(gov[i]); o.states = seen.map(g => names[g] || String(g)); }
        return o; };
    const rescueOf = (s, e) => { for (const q of resc) { if (s < q.i1 && e > q.i0) return 'rescue'; } for (const q of resc) { if (e <= q.i0 && F(q.i0) - F(e) <= RULE.beforeRescueS) return 'before rescue'; } return null; };
    for (const c of chans) {
        const o = { key: c.key, id: c.id, axis: c.axis, field: c.field, label: c.label, command: !!c.command, related: c.related, limits: c.limits || null, unknown: c.unknown || null, periods: [], max: null, min: null, linked: linked.get(c) || [], cliRejected: c.cliRejected || null };
        let mx = -Infinity, mn = Infinity; for (let i = 0; i < n; i++) { const x = c.v[i]; if (x > mx) mx = x; if (x < mn) mn = x; } o.max = r(mx, 1); o.min = r(mn, 1);
        const M = masks.get(c);
        if (M) for (const [s, e] of M.periods) {
            const side = M.m[s] === 2 ? 'hi' : 'lo', L = c.limitAt(s), lim = L ? L[side] : null, ph = code ? [...new Set(Array.from(code.subarray(s, e)))].map(k => PHASES[k]) : null;
            const others = [], same = []; for (const [d, N] of masks) if (d !== c && !(d.key === 'collectiveCommand' && c.key === 'collective') && !(c.key === 'collectiveCommand' && d.key === 'collective')) {
                for (let i = s; i < e; i++) if (N.m[i]) { ((linked.get(c) || []).includes(d.key) ? same : others).push(d.key); break; } }
            o.periods.push({ t: t(s), t1: t(e), tS: r(F(s), 3), t1S: r(F(e), 3), seconds: r(F(e) - F(s), 3), samples: e - s, side, limit: r(lim, 1), phase: code ? PHASES[code[s]] : null, phases: ph, profile: prof ? prof[s] : null,
                rescue: rescueOf(s, e), with: others, same, errors: errors(s, e) });
        }
        out.channels.push(o);
    }
    out.rescues = resc.map(q => ({ tS: r(F(q.i0), 3), t1S: r(F(q.i1), 3) }));
    return out;
}

// ---------------------------------------------------------------------------------------------
// judge
// ---------------------------------------------------------------------------------------------

// the error of a period that the related check compares: { kind, value, limit, over }
function errorOf(c, p, R) {
    const e = p.errors || {};
    if (c.related === 'headspeed') { const v = num(e.headspeed); return { kind: 'headspeed', value: v, limit: R.limit, over: v !== null && v < -R.limit }; }
    if (c.related === 'yaw' && c.id !== 'L6') { const v = num(e.rate && e.rate.yaw); const lim = c.id === 'L5' ? R.yawLimit : R.limit; return { kind: 'yaw', value: v, limit: lim, over: v !== null && v > lim }; }
    const axes = c.related === 'cyclic' ? ['roll', 'pitch'] : [c.related], vals = axes.map(a => num(e.ratio && e.ratio[a])).filter(v => v !== null), v = vals.length ? Math.max(...vals) : null;
    const lim = c.related === 'yaw' ? (num(R.yawLimit) ?? R.limit) : R.limit;
    return { kind: 'tracking', value: v, limit: lim, over: v !== null && v > lim, axis: c.related === 'cyclic' ? null : c.related };
}

const LABEL = { throttle: 'The throttle (motor[0])', collective: 'The collective output (mixer[3])', collectiveCommand: 'The collective stick (rcCommand[3])', roll: 'The roll output (mixer[0])', pitch: 'The pitch output (mixer[1])',
    ring: 'The swash ring (mixer[0] and mixer[1])', tail: 'The tail output (mixer[2])' };
const SHORT = { throttle: 'the throttle', collective: 'the collective output', collectiveCommand: 'the collective stick', roll: 'the roll output', pitch: 'the pitch output', ring: 'the swash ring', tail: 'the tail output' };
const shortOf = (k) => SHORT[k] || (/^servo/.test(k) ? `\`${k}\`` : /^iterm (\w+)/.test(k) ? `the ${/^iterm (\w+)/.exec(k)[1]} I-term` : `\`${k}\``);
const listOf = (a) => a.length > 1 ? `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}` : a.join('');
const labelOf = (c) => LABEL[c.key] || (/^servo/.test(c.key) ? `Servo output \`${c.key}\`` : /^iterm/.test(c.key) ? `The ${c.axis} I-term (${c.field})` : `\`${c.key}\``);
const SOURCE_WORD = { header: 'the log header', data: 'the data of this log', cli: 'the CLI dump', firmware: 'the firmware maximum', T8: 'check T8' };

// Finding texts follow ASD-STE100 (docs/STE_GLOSSARY.md): sentences of 25 words or less, joined by '\n' as paragraphs.
function judge(flights, RULES = DEFAULT_RULES) {
    const out = [], rule = (id) => Object.assign({ longS: RULES.longS ?? DEFAULT_RULES.longS, combined: RULES.combined ?? DEFAULT_RULES.combined }, DEFAULT_RULES[id], RULES[id] || {});
    const fmt = (v, d = 2) => typeof v === 'number' && isFinite(v) ? (Math.abs(v) < 0.5 * 10 ** -d ? 0 : v).toFixed(d) : 'unknown', many = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`, para = (...p) => p.filter(Boolean).join('\n');
    const PW = { idle: 'at IDLE', spoolup: 'during the spool-up', ground: 'on the ground', flight: 'in flight', spooldown: 'during the spool-down' };
    const prof = (p) => p > 0 ? `PID profile ${p}` : 'an unknown PID profile', where = (p) => [p.phase ? PW[p.phase] || null : null, p.rescue ? (p.rescue === 'rescue' ? 'in a rescue' : 'before a rescue') : null].filter(Boolean).join(', ');
    const limText = (c, p) => { const u = c.key === 'throttle' ? ` (${fmt(p.limit / 10, 1)} %)` : ''; return `${fmt(p.limit, 0)}${u}`; };
    const errText = (x) => x.value === null ? '' : x.kind === 'headspeed' ? `the headspeed is ${fmt(-100 * x.value, 1)} % less than the target` : x.kind === 'yaw' ? `the largest yaw error is ${fmt(x.value, 0)} deg/s`
        : `the tracking error is ${fmt(100 * x.value, 0)} % of the setpoint`;
    const add = (f, c, severity, profile, o) => out.push(Object.assign({ id: c.id, severity, log: f.log, profile: profile === undefined || profile === null ? null : +profile, axis: c.axis, channel: c.key, field: c.field, command: c.command,
        value: null, se: null, n: null, threshold: null, unit: UNITS[c.id], source: rule(c.id).source, phase: null, thin: false, limits: c.limits }, o));
    for (const f of flights) {
        const M = f.metrics; if (!M || M.skipped) continue;
        for (const c of M.channels) {
            const R = rule(c.id);
            if (!c.limits && c.unknown) { add(f, c, 'skipped', null, { limitUnknown: true, max: c.max, min: c.min, text: `${labelOf(c)}: the limit is unknown. ${c.unknown} The largest value is ${fmt(c.max, 0)}, and the smallest value is ${fmt(c.min, 0)}.` }); continue; }
            const src = c.limits ? String(c.limits.source).split(',').map(s => SOURCE_WORD[s] || s) : [], from = [...new Set(src)].join(' and ');
            // two sentences: with 3 PID profiles, one sentence has 26 words (STE Rule 6.3, the Fireball dump of 2026-09-04)
            const rej = c.cliRejected && c.cliRejected.length ? `The CLI dump gives gov_max_throttle for ${listOf(c.cliRejected.map(prof))}. ` +
                `For ${c.cliRejected.length > 1 ? 'these PID profiles' : 'this PID profile'}, the throttle in this log is more than that value. Thus, the app does not use it.` : '';
            if (!c.periods.length) { add(f, c, 'ok', null, { value: 0, n: 0, max: c.max, min: c.min,
                text: para(`${labelOf(c)} does not get to its limit in this log. The limit comes from ${from}.${c.limits && c.limits.unknownProfiles && c.limits.unknownProfiles.length ? ` The limit is unknown for ${c.limits.unknownProfiles.map(prof).join(', ')}.` : ''}`, rej) }); continue; }
            const byP = new Map(); for (const p of c.periods) { const k = p.profile === null ? 'null' : String(p.profile); if (!byP.has(k)) byP.set(k, []); byP.get(k).push(p); }
            for (const [k, ps] of byP) {
                const pp = k === 'null' ? null : +k, total = ps.reduce((s, p) => s + p.seconds, 0), longest = ps.reduce((a, b) => b.seconds > a.seconds ? b : a), errs = ps.map(p => errorOf(c, p, R));
                const worstE = errs.filter(x => x.value !== null).sort((x, y) => x.kind === 'headspeed' ? x.value - y.value : y.value - x.value)[0] || null, combined = ps.filter(p => p.with.length + 1 >= R.combined), over = errs.some(x => x.over), long = longest.seconds >= R.longS;
                const flag = long || over || combined.length > 0, why = [long ? `A period is ${fmt(longest.seconds, 3)} s long. This is ${R.longS} s or more.` : null, over ? 'During a period, the error is more than the limit of the related check.' : null,
                    combined.length ? `${cap(many(combined.length, 'period'))} ${combined.length === 1 ? 'comes' : 'come'} with other outputs at their limits.` : null].filter(Boolean);
                const sorted = ps.slice().sort((a, b) => b.seconds - a.seconds), top = sorted.slice(0, RULE.maxPeriods);
                const lines = sorted.slice(0, 3).map(p => { const x = errorOf(c, p, R); return `From ${fmt(p.tS, 2)} s to ${fmt(p.t1S, 2)} s (${fmt(p.seconds, 3)} s${where(p) ? `, ${where(p)}` : ''}), the value is at the ${p.side === 'hi' ? 'high' : 'low'} limit ${limText(c, p)}.`
                    + (p.with.length ? ` At the same time, ${listOf(p.with.map(shortOf))} ${p.with.length === 1 ? 'is' : 'are'} at ${p.with.length === 1 ? 'its limit' : 'their limits'}.` : '')
                    + (p.same && p.same.length ? ` ${cap(listOf(p.same.map(shortOf)))} ${p.same.length === 1 ? 'follows' : 'follow'} this output to ${p.same.length === 1 ? 'its' : 'their'} limit.` : '') + (errText(x) ? ` During this period, ${errText(x)}.` : '')
                    + (p.errors && p.errors.states && p.errors.states.length ? ` The governor is in ${listOf(p.errors.states)}.` : ''); });
                add(f, c, flag ? 'flag' : 'note', pp, { value: r(total, 3), n: ps.length, longestS: longest.seconds, longestT: longest.tS, combined: combined.length > 0, with: [...new Set(ps.flatMap(p => p.with))], rescueN: ps.filter(p => p.rescue).length,
                    worstError: worstE, errorOver: over, threshold: { longS: R.longS, combined: R.combined, error: R.limit }, phase: longest.phase, max: c.max, min: c.min,
                    events: top.map(p => ({ t: p.t, t1: p.t1, tS: p.tS, t1S: p.t1S, seconds: p.seconds, value: p.seconds, side: p.side, limit: p.limit, phase: p.phase, profile: p.profile, rescue: p.rescue, with: p.with, same: p.same || [], errors: p.errors })),
                    text: para(`In ${prof(pp)}, ${labelOf(c).charAt(0).toLowerCase() + labelOf(c).slice(1)} is at its limit in ${many(ps.length, 'period')}, for a total of ${fmt(total, 3)} s. The longest period is ${fmt(longest.seconds, 3)} s. The limit comes from ${from}.`,
                        ...lines, flag ? `This is a problem. ${why.join(' ')}` : `Each period is shorter than ${R.longS} s, and the errors are not more than the limit of the related check. No other output is at its limit at the same time. Examine these periods.`,
                        'These values are a count and times. Thus, they have no SE.', rej) });
            }
        }
    }
    return out;
}

// ---------------------------------------------------------------------------------------------
// curves
// ---------------------------------------------------------------------------------------------

// For the UI: the periods of each channel in frame seconds ({ key, id, axis, field, limits, periods: [{ t0, t1, side }] })
function curves(w, ctx, metrics) {
    const m = metrics || analyse(w, ctx);
    return { channels: (m.channels || []).filter(c => c.periods && c.periods.length).map(c => ({ key: c.key, id: c.id, axis: c.axis, field: c.field, limits: c.limits, periods: c.periods.map(p => ({ t0: p.tS, t1: p.t1S, side: p.side })) })) };
}

module.exports = { EXTRA, RULE, DEFAULT_RULES, analyse, judge, curves, channels, pileOf: pileIn };
if (require.main !== module) return;

// node tools/autotune/health_limits.cjs <log files...> [--cli <dump>]: the periods at a limit of every log
const fs = require('node:fs'), args = process.argv.slice(2), ci = args.indexOf('--cli'), cliText = ci >= 0 ? fs.readFileSync(args.splice(ci, 2)[1], 'utf8') : null;
const app = lib.loadApp();
for (const file of args) {
    const flights = [];
    for (const w of lib.segments(app, file, { whole: true, extra: [...new Set(EXTRA.concat(RESCUE.EXTRA))] })) {
        if (w.skipped) continue;
        const fl = w.flight; flights.push({ log: fl.log, metrics: analyse(w, { rate: fl.actualRate, header: fl.header, cli: cliText }) });
    }
    for (const f of judge(flights)) if (f.severity !== 'ok') console.log(`#${f.log + 1} ${f.id} ${f.channel} ${f.severity} p${f.profile} ${f.value} n${f.n}\n  ${String(f.text).replace(/\n/g, '\n  ')}`);
}
