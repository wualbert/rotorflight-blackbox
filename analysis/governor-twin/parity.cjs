'use strict';
// Open-loop parity of the native governor (firmware_controller.govCreate, rf_gov_step) on the RECORDED headspeed
// (docs/GOVERNOR_AUTOTUNE.md 6.7): inputs are the logged stick throttle rcCommand[4], mixer[0..3], headspeed, Vbat and the
// PID profile changes; outputs are compared with govStateAt, motor[0] and govP/I/D/F/Target.
//   node analysis/governor-twin/parity.cjs [fireball|gaui ...] [--logs 10,11] [--cli <Fireball dump>] [--off ...] [--out <file>] [--trace a:b]
// Writes analysis/governor-twin/out/parity.json. Conventions (critique.md): logs 0-based, index time = frame / rate.
const fs = require('fs'), path = require('path');
const F = require('../../tools/autotune/firmware_controller.cjs'), SETUP = require('../../tools/autotune/health_setup.cjs');
const DATA = path.join(__dirname, '../governor-20261014'), OUT = path.join(__dirname, 'out');
const GATE = { state: 0.995, thrRms: 2 };                       // SPEC 6.7
const ST = ['OFF', 'IDLE', 'SPOOLUP', 'RECOVERY', 'ACTIVE', 'HOLD', 'FALLBACK', 'AUTOROTATION', 'BAILOUT', 'BYPASS'];
const EVENT_STATES = [2, 3, 6, 7, 8], MATCH = 200;               // entry match window, frames
const COLS = ['profileAt', 'govStateAt', 'hs', 'time', 'govP', 'govI', 'govD', 'govF', 'govTarget', 'govRequest', 'motor[0]', 'Vbat', 'rcCommand[4]', 'mixer[0]', 'mixer[1]', 'mixer[2]', 'mixer[3]'];
const CLI = '/Users/albertwu/My Drive (albert.mh.wu@gmail.com)/RC/SAB/Fireball - Havok/RTFL_cli_SAB_Fireball_20261013_184504.txt';
const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; };
const onlyLogs = (opt('--logs') || '').split(',').filter(Boolean).map(Number), cliFile = opt('--cli') || CLI;
const trace = (opt('--trace') || '').split(':').map(Number);   // --trace <from frame>:<to frame>: print the frames (debug)
// --off chain,disarm,preroll,yaw,timing,force: leave out one reconstruction (ablation); --out <file> (default out/parity.json)
const off = new Set((opt('--off') || '').split(',').filter(Boolean)), outFile = opt('--out');
const crafts = args.length ? args : ['fireball', 'gaui'];
const r = (x, d = 3) => x == null || !isFinite(x) ? null : +x.toFixed(d);
// govCreate.profile() takes all governor values of the PID profile and refuses a change of a global value: pass only these
const PROFILE_FIELDS = F.SCHEMA.filter((f) => f.member.startsWith('profile.governor.')).map((f) => f.name);
const profileValues = (v) => Object.fromEntries(PROFILE_FIELDS.map((n) => [n, v[n]]));

// ---- configurations: global values of each log, values of each PID profile by its headspeed (govRequest) ----
// Fireball: CLI dump 2026-10-13 (the values of logs 10-15). Logs 5-9 had other timing values: critique V4 (index-time ramp
// slopes); gov_recovery_time is not seen in 5-9, the dump value 20 is used.
const FIREBALL_TIMING = { 5: [200, 100, 100], 6: [200, 100, 75], 8: [200, 100, 75], 9: [100, 80, 50] };
function fireballConfig() {
    const cli = SETUP.parseCli(fs.readFileSync(cliFile, 'utf8')), profiles = {};
    const global = F.fromHeader({}, cli.global).values;
    for (const [p, vals] of Object.entries(cli.profiles)) {
        const v = F.fromHeader({}, { ...cli.global, ...vals }).values, hs = v.gov_headspeed;
        profiles[hs] = hs in profiles ? null : { values: v, label: 'CLI profile ' + p };  // a headspeed in two or more PID profiles is ambiguous
    }
    return (log) => {
        const t = off.has('timing') ? null : FIREBALL_TIMING[log], timing = t ? { gov_startup_time: t[0], gov_spoolup_time: t[1], gov_spooldown_time: t[2] } : {};
        return { base: { ...global, ...timing }, profileOf: (hs) => profiles[hs] && { ...profiles[hs], values: { ...profiles[hs].values, ...timing } },
            gear: [global['main_rotor_gear_ratio[0]'], global['main_rotor_gear_ratio[1]']], voltageSource: global.voltage_meter,
            source: 'CLI dump ' + path.basename(cliFile) + (t ? ' with the timing of log ' + log + ' from the ramp slopes (critique V4)' : '') };
    };
}
// Gaui (no dump): params_gaui.json (header govPID 40,50,0,10,40 and release defaults), ELECTRIC + FUNCTION, startup 250,
// spool-up 200 (logs 38-45) / 150 (46-49), spool-down 30 (firmware_parameters.md 11.3); yaw FF weight per log and
// headspeed from critique C1 (collective 50, cyclic 10, curve 20 fixed). Gear ratio unknown: 1:1 (SPEC 6.3). The log does not
// record tail_rotor_mode and main_rotor_dir: the release defaults VARIABLE and CW (no TTA; the yaw FF fits support VARIABLE).
const GAUI_YAW = { 2300: (l) => l <= 38 ? 10 : l === 39 ? 30 : l <= 45 ? 40 : l === 46 ? 60 : 80, 2500: (l) => l <= 46 ? 10 : 80, 2700: (l) => l <= 38 ? 10 : 80 };
function gauiConfig(meta) {
    const P = JSON.parse(fs.readFileSync(path.join(DATA, 'params_gaui.json'), 'utf8'));
    return (log) => {
        const seg = meta.segments.find((s) => s.log === log), header = F.fromHeader({ govPID: seg.header.govPID }).values;
        const base = { ...F.defaults(), gov_mode: 3, gov_throttle_type: 2, gov_startup_time: 250, gov_spoolup_time: log >= 46 ? 150 : 200, gov_spooldown_time: 30,
            gov_rpm_filter: P.rpm_filter, gov_ff_filter: P.ff_filter, gov_d_filter: P.d_filter, gov_flags: 0, ...header };
        for (const n of ['main_rotor_gear_ratio[0]', 'main_rotor_gear_ratio[1]', 'battery_cell_count', 'voltage_meter', 'gov_pwr_filter']) delete base[n];
        const profileOf = (hs) => {
            if (!P.profiles[hs] || !GAUI_YAW[hs]) return null;
            const v = { ...base, ...Object.fromEntries(Object.entries(P.profiles[hs]).map(([k, x]) => ['gov_' + k, x])), ...header, gov_headspeed: +hs, gov_yaw_weight: off.has('yaw') ? 10 : GAUI_YAW[hs](log) };
            return { values: v, label: hs + ' rpm, yaw weight ' + v.gov_yaw_weight };
        };
        return { base, profileOf, gear: null, voltageSource: null, source: 'params_gaui.json, header govPID, log ramps (firmware_parameters.md 11.3), yaw weights critique C1' };
    };
}

// ---- arming: the log starts at arm; DISARM events from the flash dump (the extracted columns do not have them). A re-arm
// inside the log (blackbox_grace_period) has no event: armed again at the first logged governor state after OFF. ----
const BBL_DIR = { fireball: '/Users/albertwu/My Drive (albert.mh.wu@gmail.com)/RC/SAB/Fireball - Havok/Blackbox logs', gaui: '/Users/albertwu/My Drive (albert.mh.wu@gmail.com)/RC/Gaui/X4 ii/Blackbox logs' };
function disarmsOf(craft, meta) {
    const cache = path.join(OUT, 'disarm_' + craft + '.json');
    if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
    const file = path.join(BBL_DIR[craft] || '', meta.file);
    if (!fs.existsSync(file)) return null;
    const lib = require('../../tools/autotune/lib.cjs'), app = lib.loadApp(), out = { file: meta.file, us: {} };
    app.__bytes = new Uint8Array(fs.readFileSync(file));
    const log = require('vm').runInContext('new FlightLog(__bytes)', app);
    for (const seg of meta.segments) {
        if (!log.openLog(seg.log)) continue;
        const t = []; for (const c of log.getChunksInTimeRange(log.getMinTime(), log.getMaxTime())) for (const e of c.events) if (e.event === 15) t.push(e.time);
        out.us[seg.log] = t;
    }
    fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(cache, JSON.stringify(out));
    return out;
}
function armedOf(seg, X, disarms) {
    const n = seg.n, armed = new Uint8Array(n).fill(1), st = X.govStateAt, at = [];
    for (const us of (disarms && disarms.us[seg.log]) || []) {
        const rel = (us - seg.timeStartUs) / 1e6; let k = 0; while (k < n && X.time[k] < rel) k++;
        const d = k; at.push(k);
        for (; k < n && ((st && st[k] !== 0 && k < d + 50) || !st || st[k] === 0); k++) armed[k] = 0;
    }
    return { armed, disarmAt: at, rearms: at.filter((d) => armed.indexOf(1, d) >= 0).length };
}

// ---- data ----
function load(dir, seg) {
    const buf = fs.readFileSync(path.join(dir, seg.name + '.f32')), f = new Float32Array(buf.buffer, buf.byteOffset, buf.length >> 2), C = seg.columns.length, X = {};
    for (const k of COLS) { const j = seg.columns.indexOf(k); if (j < 0) { X[k] = null; continue; } const a = new Float32Array(seg.n); for (let i = 0; i < seg.n; i++) a[i] = f[i * C + j]; X[k] = a; }
    return X;
}
const stats = (a) => {
    if (!a.length) return { n: 0 };
    let q = 0, m = 0; for (const v of a) { q += v * v; m = Math.max(m, Math.abs(v)); }
    const s = Float64Array.from(a).sort();
    return { n: a.length, rms: r(Math.sqrt(q / a.length), 2), maxAbs: m, p01: s[Math.floor(s.length * 0.01)], p50: s[s.length >> 1], p99: s[Math.floor(s.length * 0.99)] };
};

// one log on runtime `gov` (a chained log keeps the governor state of the power cycle: Kmot, critique M12)
function replay(gov, seg, X, cfg, o) {
    const n = o.endFrame ? Math.min(seg.n, o.endFrame) : seg.n, L = Math.round(o.pidHz / seg.rate), t0 = seg.timeStartUs / 1e6, gearK = o.gear[1] / o.gear[0];
    const st = X.govStateAt, req = X.govRequest, prof = X.profileAt;
    // PID profile changes: the profileAt event, applied at the frame where govRequest changes (the frame of the firmware's
    // governorInitProfile), searched from 5 frames before to 50 after the event
    const events = [], offsets = [];
    for (let i = 1; i < n; i++) if (prof[i] !== prof[i - 1]) {
        let j = i; for (let q = Math.max(1, i - 5); q < Math.min(n, i + 50); q++) if (req[q] !== req[q - 1]) { j = q; break; }
        events.push({ k: j, hs: req[j] }); offsets.push(j - i);
    }
    const start = cfg.profileOf(req[0]);
    if (!start || events.some((e) => !cfg.profileOf(e.hs))) return { excluded: 'PID profile unknown: a headspeed of ' + [req[0], ...events.map((e) => e.hs)].filter((h) => !cfg.profileOf(h)).join(', ') + ' rpm has no PID profile values' };
    gov.profile(profileValues(start.values));
    const fallbackAt = new Set(); if (o.force && st) for (let k = 1; k < n; k++) if (st[k] === 6 && st[k - 1] !== 6) fallbackAt.add(k);
    const s = { rawMotorRpm: 0, batteryVoltage: 0, throttleCommand: 0, throttleOff: true, armed: true, mixer: [0, 0, 0, 0], timeS: 0, govFallback: false };
    const input = (k) => {
        const cmd = X['rcCommand[4]'][k];
        s.armed = !o.armed || o.armed.armed[k] === 1; s.rawMotorRpm = X.hs[k] * gearK; s.batteryVoltage = X.Vbat[k] / 100; s.throttleCommand = cmd / 1000; s.throttleOff = !(cmd > 0);
        for (let a = 0; a < 4; a++) s.mixer[a] = X['mixer[' + a + ']'][k] / 1000;
        return cmd;
    };
    // The firmware arms before the first logged frame (the log header takes time). A log that starts in IDLE with a
    // throttle above 0 is in its startup ramp: run the loops before frame 0 with the inputs of frame 0. The loops come from
    // the logged IDLE ramp below the handover throttle: motor = (loops before frame 0 + L (k + 1)) x the startup rate.
    let preRoll = 0;
    if (!off.has('preroll') && st && st[0] === 1 && X['motor[0]'][0] > 0) {
        const per = 10 / o.pidHz / gov.values.gov_startup_time, top = gov.values.gov_handover_throttle * 10 - 1; let sum = 0, m = 0;
        for (let k = 0; k < n && m < 2000 && st[k] === 1 && X['motor[0]'][k] < top; k++, m++) sum += X['motor[0]'][k] / 1000 / per - L * (k + 1);
        preRoll = m ? Math.max(0, Math.round(sum / m)) : 0;
        input(0); for (let q = 0; q < preRoll; q++) { s.timeS = t0 + X.time[0] - (preRoll + L - q) / o.pidHz; gov.step(s); }
    }
    const err = { thr: [], P: [], I: [], D: [], F: [], target: [] }, seen = {}, entries = {}, wEntries = {}, segs = [];
    let agree = 0, ev = 0, seg0 = { fromS: 0, hs: req[0], label: start.label, n: 0, agree: 0, thr: [] }, prevW = -1, prevT = t0 + X.time[0] - L / o.pidHz;
    for (const x of EVENT_STATES) { seen[x] = { logFrames: 0, agree: 0, thr: [] }; entries[x] = []; wEntries[x] = []; }
    const runs = []; let run = null;
    for (let k = 0; k < n; k++) {
        if (ev < events.length && events[ev].k === k) {
            const p = cfg.profileOf(events[ev].hs); gov.profile(profileValues(p.values));
            segs.push(seg0); seg0 = { fromS: r(k / seg.rate, 3), hs: events[ev].hs, label: p.label, n: 0, agree: 0, thr: [] }; ev++;
        }
        const cmd = input(k), tk = t0 + X.time[k];
        let g;
        for (let q = 0; q < L; q++) { s.timeS = prevT + (tk - prevT) * (q + 1) / L; s.govFallback = q === L - 1 && fallbackAt.has(k); g = gov.step(s); }
        prevT = tk;
        const w = g.state, l = st ? st[k] : null;
        seg0.n++;
        if (l !== null) {
            if (w === l) { agree++; seg0.agree++; }
            else { if (run && run.end === k - 1 && run.log === l && run.wasm === w) run.end = k; else runs.push(run = { start: k, end: k, log: l, wasm: w, hs: Math.round(X.hs[k]), cmd, req: req[k] }); }
            if (seen[l]) { seen[l].logFrames++; if (w === l) { seen[l].agree++; seen[l].thr.push(Math.round(g.throttle * 1000) - X['motor[0]'][k]); } }
            if (k > 0 && l !== st[k - 1] && entries[l]) entries[l].push(k);
            if (w !== prevW && wEntries[w]) wEntries[w].push(k);
            if (l === 4 && w === 4) {
                const dt = Math.round(g.throttle * 1000) - X['motor[0]'][k];
                err.thr.push(dt); seg0.thr.push(dt);
                err.P.push(Math.trunc(g.P * 1000) - X.govP[k]); err.I.push(Math.trunc(g.I * 1000) - X.govI[k]);
                err.D.push(Math.trunc(g.D * 1000) - X.govD[k]); err.F.push(Math.trunc(g.F * 1000) - X.govF[k]);
                err.target.push(Math.trunc(g.targetHS) - X.govTarget[k]);
            }
        }
        if (o.trace && trace.length === 2 && k >= trace[0] && k < trace[1]) console.log(k, (X.time[k]).toFixed(4), 'state', l, w, 'hs', X.hs[k], g.currentHeadSpeed.toFixed(1), 'tgt', X.govTarget[k], g.targetHS.toFixed(1),
            'motor', X['motor[0]'][k], (g.throttle * 1000).toFixed(2), 'P', X.govP[k], (g.P * 1000).toFixed(2), 'I', X.govI[k], (g.I * 1000).toFixed(2), 'F', X.govF[k], (g.F * 1000).toFixed(2), 'cmd', cmd, 'req', req[k]);
        prevW = w;
    }
    segs.push(seg0);
    const states = {};
    for (const x of EVENT_STATES) {
        const offs = entries[x].map((k) => { let best = null; for (const j of wEntries[x]) if (Math.abs(j - k) <= MATCH && (best === null || Math.abs(j - k) < Math.abs(best))) best = j - k; return best; });
        if (!seen[x].logFrames && !wEntries[x].length) continue;
        const t = stats(seen[x].thr);
        states[ST[x]] = { logFrames: seen[x].logFrames, agreement: seen[x].logFrames ? r(seen[x].agree / seen[x].logFrames, 5) : null, throttleRms: t.rms ?? null, throttleMax: t.maxAbs ?? null, logEntries: entries[x].length, replayEntries: wEntries[x].length,
            matched: offs.filter((v) => v !== null).length, entryOffsetFrames: offs, entriesAtS: entries[x].map((k) => r(k / seg.rate, 3)) };
    }
    const stateAgreement = st ? agree / n : null, thr = stats(err.thr);
    runs.sort((a, b) => (b.end - b.start) - (a.end - a.start));
    return {
        frames: n, seconds: r(n / seg.rate, 2), loopsPerFrame: L, profileChanges: events.length, profileOffsetFrames: [...new Set(offsets)],
        preRollLoops: preRoll, fallbackInjected: fallbackAt.size, disarmAt: o.armed ? o.armed.disarmAt.map((k) => r(k / seg.rate, 3)) : null, rearmsInferred: o.armed ? o.armed.rearms : null, stateAgreement: r(stateAgreement, 5),
        gate: { pass: stateAgreement >= GATE.state && thr.n > 0 && thr.rms <= GATE.thrRms, state: stateAgreement >= GATE.state, throttle: thr.n > 0 && thr.rms <= GATE.thrRms },
        active: { throttle: thr, P: stats(err.P), I: stats(err.I), D: stats(err.D), F: stats(err.F), target: stats(err.target) },
        states, segments: segs.map((q) => { const t = stats(q.thr); return { fromS: q.fromS, headspeed: q.hs, profile: q.label, frames: q.n, stateAgreement: r(q.agree / q.n, 5), activeFrames: t.n, throttleRms: t.rms ?? null, throttleMax: t.maxAbs ?? null }; }),
        mismatch: { runs: runs.length, frames: runs.reduce((a, q) => a + q.end - q.start + 1, 0),
            longest: runs.slice(0, 12).map((q) => ({ atS: r(q.start / seg.rate, 3), frames: q.end - q.start + 1, log: ST[q.log], replay: ST[q.wasm], hs: q.hs, throttleCommand: q.cmd, request: q.req })) },
    };
}

(async () => {
    const out = { generated: new Date().toISOString(), gate: GATE, artifactSha256: F.ARTIFACT, off: [...off], crafts: {} };
    for (const craft of crafts) {
        const dir = path.join(DATA, 'data', craft), meta = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')), phases = JSON.parse(fs.readFileSync(path.join(dir, 'phases.json'), 'utf8'));
        const configOf = craft === 'fireball' ? fireballConfig() : gauiConfig(meta), rows = [], disarms = off.has('disarm') ? null : disarmsOf(craft, meta);
        if (!disarms) console.log(craft + ': no DISARM events, so the replay stays armed to the log end');
        let prev = null;
        for (const seg of meta.segments.filter((s) => !onlyLogs.length || onlyLogs.includes(s.log))) {
            const X = load(dir, seg), armed = armedOf(seg, X, disarms), cfg = configOf(seg.log), h = seg.header, pidHz = 1e6 / (h.looptime * h.pid_process_denom);
            const restVoltage = X.Vbat[0] / 100, cells = { minCell: h.vbatcellvoltage[0] / 100, maxCell: h.vbatcellvoltage[2] / 100 };
            const start = cfg.profileOf(X.govRequest[0]);
            if (!start) { rows.push({ craft, log: seg.log, name: seg.name, excluded: 'PID profile unknown: no PID profile values for a headspeed of ' + X.govRequest[0] + ' rpm at the log start' }); prev = null; continue; }
            const options = { values: { ...cfg.base, ...start.values }, gear: cfg.gear, pidHz, voltageSource: cfg.voltageSource, restVoltage, ...cells };
            // a log that starts after the end of the previous one (time since boot) continues its power cycle (critique M12)
            const sameGlobals = prev && JSON.stringify(prev.base) === JSON.stringify(cfg.base);
            const chained = !off.has('chain') && prev && sameGlobals && seg.timeStartUs > prev.endUs;
            let gov;
            if (chained) {
                gov = prev.gov;
                // the firmware runs the governor while disarmed between the logs: motor stopped, filters to 0. Up to 1 s of
                // loops after the previous log, and 0.1 s before the new log for its pre-roll (the time must not go back)
                const z = { rawMotorRpm: 0, batteryVoltage: restVoltage, throttleCommand: 0, throttleOff: true, armed: false, mixer: [0, 0, 0, 0] };
                const b = seg.timeStartUs / 1e6 - 0.1, m = Math.max(0, Math.min(pidHz, Math.floor((b - prev.endUs / 1e6) * pidHz)));
                for (let q = 0; q < m; q++) gov.step({ ...z, timeS: b - (m - 1 - q) / pidHz });
            } else gov = await F.govCreate(options);
            const base = { craft, log: seg.log, name: seg.name, class: phases[seg.name] && phases[seg.name].class, pidHz, chainedFrom: chained ? prev.log : null, source: cfg.source,
                cells: gov.values.battery_cell_count, restVoltage: r(restVoltage, 2), assumed: gov.assumed, govNotes: gov.notes };
            const gear = [gov.values['main_rotor_gear_ratio[0]'], gov.values['main_rotor_gear_ratio[1]']], res = replay(gov, seg, X, cfg, { pidHz, gear, force: !off.has('force'), armed, trace: true });
            const row = { ...base, ...res };
            if (res.excluded) { rows.push(row); console.log(`${craft} log ${seg.log}: EXCLUDED, ${res.excluded}`); prev = null; continue; }
            // the FALLBACK entries without the injected forced fallback (critique M11): a fresh run of the same log
            if (res.fallbackInjected) {
                const g2 = await F.govCreate(options), r2 = replay(g2, seg, X, cfg, { pidHz, gear, force: false, armed });
                row.withoutInjection = { stateAgreement: r2.stateAgreement, throttleRms: r2.active.throttle.rms, states: r2.states, longest: r2.mismatch.longest.slice(0, 6), chained: !!chained };
            }
            if (craft === 'fireball' && seg.log === 10) {   // the earlier 27.5-s replay (critique V2): spool-up, AUTOROTATION, BAILOUT, ACTIVE at 100 %
                const g3 = await F.govCreate(options), r3 = replay(g3, seg, X, cfg, { pidHz, gear, force: true, endFrame: 27500, armed });
                row.first27s = { stateAgreement: r3.stateAgreement, throttle: r3.active.throttle, P: r3.active.P, I: r3.active.I, F: r3.active.F, target: r3.active.target, longest: r3.mismatch.longest.slice(0, 6) };
            }
            rows.push(row);
            const a = row.active.throttle;
            console.log(`${craft} log ${seg.log} (${row.class}${row.chainedFrom != null ? ', after log ' + row.chainedFrom : ''}): state ${row.stateAgreement}, ACTIVE throttle RMS ${a.rms} max ${a.maxAbs} n ${a.n}, P/I/F RMS ${row.active.P.rms}/${row.active.I.rms}/${row.active.F.rms}, ` +
                `pre-roll ${row.preRollLoops}, profiles ${row.profileChanges}, fallbacks ${row.fallbackInjected}${row.withoutInjection ? ' (without: ' + row.withoutInjection.stateAgreement + ')' : ''} -> ${row.gate.pass ? 'PASS' : 'MISS'}`);
            prev = { gov, base: cfg.base, log: seg.log, endUs: seg.timeStartUs + X.time[seg.n - 1] * 1e6 };
        }
        out.crafts[craft] = rows;
    }
    fs.mkdirSync(OUT, { recursive: true });
    const file = outFile || path.join(OUT, 'parity.json');
    let all = {}; try { all = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* first run */ }
    fs.writeFileSync(file, JSON.stringify({ ...all, ...out, crafts: { ...(all.crafts || {}), ...out.crafts } }, null, 1));
    console.log('wrote', file);
})().catch((e) => { console.error(e); process.exit(1); });
