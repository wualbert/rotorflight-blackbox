'use strict';
// Governor twin: identification and validation on the dev data (docs/GOVERNOR_AUTOTUNE.md sections 4 and 9).
//   node analysis/governor-twin/dev.cjs <fireball|gaui> [--no-current] [--cli <dump>] [--no-cli] [--boot n] [--params <result.json>] [--out <dir>]
//        [--test-logs 5,13] [--fixed qs,as1] [--zero qs] [--no-voltage] [--sensitivity]
// Loads analysis/governor-20261014/data/<craft> (gov_data.load, with the DISARM events of out/disarm_<craft>.json), recovers the
// configuration (gov_params.recover with the bench runs as evidence + gov_sim.configOf), identifies the twin on the training flights
// (gov_fit.identify), validates it on the test flights (open loop, horizon curve, closed loop with the native governor from the arm,
// events: spool-up exit throttle and overshoot, saturated time, FALLBACK droop and recovery) and writes out/<craft>[-nocurrent]/result.json:
// the parameters with p5-p95, the validation metrics, the status by the
// gov_fit RULES and the plot data (plot.py). --no-current drops Ibat (the Gaui pair shows that current is optional). --params reuses
// the parameters of an earlier result (no identification: validation only). --no-voltage drops Vbat and Ibat (a craft without a voltage sensor). The Fireball uses its CLI dump by default (logs 10-15).
// --test-logs: other test logs (0-based; the default split is every third flight log); with --out, a rotated split as held-out evidence.
// --fixed: also hold these parameters at their start values (ablation: qs 0 needs --zero qs), --zero: set them to 0 first.
// --sensitivity: validate changed twins on the same data (kv ± 10 %, loads ± 30 %, tm × 2 and × 0.5, beta × 2): the power of the gate.
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const GD = require(path.join(ROOT, 'tools/autotune/gov_data.cjs')), GP = require(path.join(ROOT, 'tools/autotune/gov_params.cjs'));
const GS = require(path.join(ROOT, 'tools/autotune/gov_sim.cjs')), GF = require(path.join(ROOT, 'tools/autotune/gov_fit.cjs')), GT = require(path.join(ROOT, 'tools/autotune/gov_twin.cjs'));
const FIREBALL_CLI = '/Users/albertwu/My Drive (albert.mh.wu@gmail.com)/RC/SAB/Fireball - Havok/RTFL_cli_SAB_Fireball_20261013_184504.txt';

const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; }, flag = (k) => { const i = args.indexOf(k); if (i >= 0) args.splice(i, 1); return i >= 0; };
const sensitivity = flag('--sensitivity'), noVoltage = flag('--no-voltage'), noCurrent = flag('--no-current') || noVoltage, noCli = flag('--no-cli'), boot = opt('--boot'), paramsFile = opt('--params'), outOpt = opt('--out'), testLogs = opt('--test-logs'), fixedOpt = opt('--fixed'), zeroOpt = opt('--zero');
let cliFile = opt('--cli');
const craft = args[0];
if (!craft) { console.error('usage: dev.cjs <fireball|gaui> [--no-current] [--cli <dump>] [--no-cli] [--boot n] [--params <result.json>] [--out <dir>]'); process.exit(2); }
if (!cliFile && !noCli && craft === 'fireball' && fs.existsSync(FIREBALL_CLI)) cliFile = FIREBALL_CLI;
const DIR = path.join(ROOT, 'analysis/governor-20261014/data', craft), OUT = outOpt || path.join(__dirname, 'out', craft + (noVoltage ? '-novoltage' : noCurrent ? '-nocurrent' : ''));
const r = (x, d = 4) => x == null || !Number.isFinite(x) ? null : +x.toPrecision(d);
const STATES = GS.STATES;

// the DISARM events of the flash dump (parity.cjs cache): t in s on the item time (fromS + time)
function eventsOf(meta) {
    const f = path.join(__dirname, 'out', 'disarm_' + craft + '.json'), ev = {};
    if (!fs.existsSync(f)) { console.log('no DISARM events: the closed loop stays armed to the log end'); return ev; }
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const s of meta.segments) ev[s.log] = (d.us[s.log] || []).map(us => ({ t: (us - s.timeStartUs) / 1e6 + (s.fromS || 0), name: 'DISARM' }));
    return ev;
}

// zoom windows of one test log (closed loop again at the PID rate, every sample recorded, plotted at Z.points per window: about 50-100 Hz,
// plotHz): the largest load step (collective rise in ACTIVE, not saturated) and the longest saturation (u >= 0.995 in ACTIVE), Z.padS around each
const Z = { padS: 3, satU: 0.995, stepS: 0.5, points: 600 };
async function zooms(run, cfg, params) {
    const res = await GS.run(run, cfg, { plant: 'twin', twin: params, record: { points: 1e9 } });
    if (!res.trace) return [];
    const tr = res.trace, n = run.n, st = run.state, rate = run.rate, out = [];
    // saturation: the longest run of u >= satU in logged ACTIVE
    let best = null;
    for (let i = 0; i < n;) {
        if (!(st[i] === 4 && run.u[i] >= Z.satU)) { i++; continue; }
        let j = i; while (j < n && st[j] === 4 && run.u[j] >= Z.satU - 0.01) j++;
        if (!best || j - i > best[1] - best[0]) best = [i, j];
        i = j;
    }
    // load step: the largest rise of the collective over stepS in ACTIVE with u < satU in the 2 s after it, away from the saturation
    const w = Math.round(Z.stepS * rate);
    let step = null;
    for (let i = 0; i + w < n; i += 10) {
        if (st[i] !== 4 || st[i + w] !== 4) continue;
        const dc = run.coll[i + w] - run.coll[i];
        let sat = false; for (let j = i; j < Math.min(n, i + 2 * rate) && !sat; j += 10) sat = run.u[j] >= Z.satU || st[j] !== 4;
        if (sat || best && Math.abs(i - best[0]) < 10 * rate) continue;
        if (!step || dc > step.dc) step = { i, dc };
    }
    const cut = (kind, i0, i1, extra) => {
        const a = Math.max(0, i0 - Math.round(Z.padS * rate)), b = Math.min(n, i1 + Math.round(Z.padS * rate)), stp = Math.max(1, Math.ceil((b - a) / Z.points)), ks = [];
        for (let k = a; k < b; k += stp) ks.push(k);
        const pick = (arr, d = 4) => arr ? ks.map(k => r(arr[k], d)) : null;
        return Object.assign({ kind, log: run.log, plotHz: r(rate / stp, 3), fromS: r(run.time[a], 6), toS: r(run.time[b - 1], 6), time: ks.map(k => r(run.time[k], 7)), hs: pick(run.hs), hsClosed: pick(tr.hs), target: pick(run.target),
            targetClosed: pick(tr.target), u: pick(run.u), uClosed: pick(tr.u), state: ks.map(k => st[k]), stateClosed: ks.map(k => tr.state[k]), coll: pick(run.coll), vbat: pick(run.vbat), vbatClosed: pick(tr.vbat),
            ibat: pick(run.ibat), ibatClosed: pick(tr.ibat) }, extra);
    };
    if (step) out.push(cut('load step', step.i, step.i + w, { collRise: r(step.dc, 3) }));
    if (best) out.push(cut('saturation', best[0], best[1], { satS: r((best[1] - best[0]) / rate, 3) }));
    return out;
}

// error contributions of the closed loop (diagnosis): HS and u error by logged state and by saturation
function breakdown(run, cfg, res, testFrom, Href) {
    const tr = res.trace, st = run.state, n = run.n, acc = {};
    const add = (k, eh, eu) => { const a = acc[k] || (acc[k] = { n: 0, h2: 0, u2: 0, hb: 0, ub: 0 }); a.n++; a.h2 += eh * eh; a.u2 += eu * eu; a.hb += eh; a.ub += eu; };
    for (let i = testFrom; i < n; i++) {
        if (st[i] !== 4) continue;
        const t = run.target && run.target[i] > 0.5 * Href ? run.target[i] : Href, eh = 100 * (tr.hs[i] - run.hs[i]) / t, eu = tr.u[i] - run.u[i];
        const sat = run.u[i] >= Z.satU || tr.u[i] >= Z.satU, fb = (i => { for (let j = Math.max(0, i - 5 * run.rate); j <= i; j += 5) if (st[j] === 6 || st[j] === 3) return true; return false; })(i);
        add('all', eh, eu); add(fb ? 'after FALLBACK/RECOVERY (5 s)' : sat ? 'saturated (log or twin)' : 'not saturated', eh, eu);
        if (tr.state[i] !== 4) add('twin state not ACTIVE', eh, eu);
    }
    const out = {}, all = acc.all ? acc.all.n : 1;
    for (const [k, a] of Object.entries(acc)) out[k] = { share: r(a.n / all, 3), hsRms: r(Math.sqrt(a.h2 / a.n), 3), hsBias: r(a.hb / a.n, 3), uRms: r(Math.sqrt(a.u2 / a.n), 3), uBias: r(a.ub / a.n, 3),
        hsSqShare: r(a.h2 / (acc.all.h2 || 1), 3) };
    return out;
}

(async () => {
    const t0 = Date.now(), meta = JSON.parse(fs.readFileSync(path.join(DIR, 'meta.json'), 'utf8'));
    const cli = cliFile ? fs.readFileSync(cliFile, 'utf8') : null;
    const all = GD.load(DIR, { bench: true, events: eventsOf(meta) });
    const flights = all.filter(q => q.class === 'flight');
    if (noCurrent) for (const q of flights) { q.ibat = null; q.hasCurrent = false; }
    if (noVoltage) for (const q of flights) { q.vbat = null; q.hasVoltage = false; }
    const tl = Date.now(), recovered = GP.recover(all, { cli }), configs = GS.configOf(all, recovered, { cli }), tc = Date.now();
    console.log(`${craft}: ${flights.length} flight logs (${flights.map(q => q.log).join(', ')}), ${all.length - flights.length} bench runs; load ${(tl - t0) / 1000} s, configuration ${(tc - tl) / 1000} s`);
    for (const q of flights) { const c = configs[GS.keyOf(q)]; console.log(`  log ${q.log}: ${c.excluded ? 'EXCLUDED ' + c.excluded : `PID profile ${c.start}, ${c.changes.length} changes, ${c.assumptions.length} assumptions, ${c.flags.length} flags`}`); }
    let model;
    if (paramsFile) {
        const prev = JSON.parse(fs.readFileSync(paramsFile, 'utf8')), P = GF.prepare(flights, {});
        model = Object.assign({}, prev.model, { status: 'identified', params: GT.copy(prev.model.params), rules: GF.RULES, Href: P.Href, has: P.has, split: P.split, samples: [] });
        console.log('parameters from', paramsFile);
    } else {
        const split = testLogs ? { mode: 'logs', testLogs: testLogs.split(',').map(Number) } : undefined, fixed = fixedOpt ? fixedOpt.split(',') : undefined;
        // --zero: an ablation of a model term (the term at 0 and held)
        if (zeroOpt) console.log('ablation: held at 0:', zeroOpt);
        model = GF.identify(flights, { bootstrap: boot != null ? +boot : undefined, split, fixed, zero: zeroOpt ? zeroOpt.split(',') : undefined, progress: (f, t) => process.stderr.write(`\r${t} ${(100 * f).toFixed(0)} %   `) });
    }
    process.stderr.write('\n');
    if (model.status !== 'identified') { console.log('identification failed:', model.reasons); process.exit(1); }
    const tv0 = Date.now(), val = await GF.validate(model, flights, { sim: GS, configs }), tv1 = Date.now(), plots = GF.plotData(model, flights, val), tp = Date.now();
    // zooms and the error breakdown of the closed loop on each test log
    const P = GF.prepare(flights, { Href: model.Href, split: model.split, has: model.has }), zoom = [], diag = {};
    for (const c of P.grids) {
        if (c.testFrom >= c.ng) continue;
        const cfg = configs[GS.keyOf(c.run)];
        if (!cfg || cfg.excluded) continue;
        zoom.push(...await zooms(c.run, cfg, model.params));
        const res = await GS.run(c.run, cfg, { plant: 'twin', twin: model.params, record: { points: 1e9 } });
        if (res.trace) diag[c.run.log] = breakdown(c.run, cfg, res, c.testFrom * c.stride, model.Href);
    }
    const tz = Date.now();
    // the power of the status gate: changed twins on the same data
    const sens = [];
    if (sensitivity) {
        const b = model.params, L = ['q0', 'qc', 'qx', 'qy', 'qf', 'qs'];
        const cases = { 'kv x0.9': { kv: b.kv * 0.9 }, 'kv x1.1': { kv: b.kv * 1.1 }, 'loads x1.3': Object.fromEntries(L.map(k => [k, b[k] * 1.3])), 'loads x0.7': Object.fromEntries(L.map(k => [k, b[k] * 0.7])),
            'tm x2': { tm: b.tm * 2 }, 'tm x0.5': { tm: b.tm * 0.5 }, 'beta x2': { beta: b.beta * 2 } };
        for (const [name, c] of Object.entries(cases)) {
            const v = await GF.validate(Object.assign({}, model, { params: GT.copy(b, c) }), flights, { sim: GS, configs });
            sens.push({ name, status: v.status, checks: v.checks.map(q => ({ rule: q.rule, value: r(q.value), pass: q.pass })) });
            console.log(`  sensitivity ${name.padEnd(10)} ${v.status.padEnd(9)} ` + v.checks.map(q => `${q.rule} ${r(q.value)}${q.pass ? '' : ' FAIL'}`).join(', '));
        }
    }
    const p = model.params, u = model.uncertainty || {};
    const params = {};
    for (const q of GT.PARAMS) if (GT.paramNames(model.has).includes(q.name)) {
        const x = u[q.name] || {};
        params[q.name] = { value: r(p[q.name], 5), unit: q.unit, free: (model.free || []).includes(q.name), informed: x.informed == null ? null : x.informed, p5: r(x.p5, 5), p50: r(x.p50, 5), p95: r(x.p95, 5),
            spread: ['ass', 'asr', 'as0', 'as1'].includes(q.name) ? 'single starts' : q.name === 'u0' ? 'start throttles' : q.name === 'vp' ? 'flights' : x.source || (x.p5 != null ? 'bootstrap' : null),
            bootstrap: x.bootstrap || null, flights: x.flights ? { lo: r(x.flights.lo, 5), hi: r(x.flights.hi, 5), n: x.flights.n } : null };
    }
    const ol = val.openLoop, cl = val.closedLoop;
    const result = {
        craft, generated: new Date().toISOString(), options: { current: !noCurrent, cli: cliFile ? path.basename(cliFile) : null, bootstrap: model.bootstrap ? model.bootstrap.n : 0 },
        options2: { testLogs: testLogs || null, fixed: fixedOpt || null, zero: zeroOpt || null },
        data: { file: meta.file, flights: flights.map(q => q.log), bench: all.filter(q => q.class === 'bench').map(q => q.log), has: model.has, Href: model.Href, split: model.split,
            trainS: model.fit ? r(model.fit.trainS) : null, testS: model.fit ? r(model.fit.testS) : null, reasons: model.reasons },
        config: Object.fromEntries(flights.map(q => { const c = configs[GS.keyOf(q)]; return [q.log, { excluded: c.excluded, start: c.start, changes: c.changes.length, assumptions: c.assumptions.map(a => `${a.name}${a.profile ? ' p' + a.profile : ''}=${a.value}`),
            flags: c.flags.length, voltageSource: c.voltageSource, cells: c.cells, profiles: c.cli.profiles }]; })),
        params, Href: model.Href, V0: p.V0, physical: model.physical || null, regression: model.regression, kappa: model.kappa, softStart: model.softStart || null, initial: model.initial,
        fit: model.fit ? Object.assign({}, model.fit, { history: model.fit.history.map(v => r(v, 6)) }) : null,
        samples: (model.samples || []).map(s => Object.fromEntries(GT.paramNames(model.has).map(k => [k, r(s[k], 6)]))),
        status: val.status, reasons: val.reasons,
        acceptance: val.checks.map(q => ({ rule: q.rule, value: r(q.value), limit: q.limit, pass: q.pass })),
        bootstrap: model.bootstrap || null,
        validation: {
            openLoop: ol, horizon: val.horizon,
            closedLoop: { available: cl.available, hsRms: cl.hsRms, uRms: cl.uRms, vbatRms: cl.vbatRms, stateAgreement: cl.stateAgreement, baseRms: cl.baseRms, skill: cl.skill, band: cl.band,
                worst: cl.worst, reasons: cl.reasons, forcedFallbacks: 'the closed loop enters FALLBACK at the logged entries (gov_sim forceFallback recorded); unforced: none forced',
                runs: cl.runs.map(q => Object.assign({}, q, { trace: undefined, metrics: undefined })), breakdown: diag },
            unforced: val.unforced, tmScan: val.tmScan, sensitivity: sens,
            events: val.events,
        },
        timing: { loadS: (tl - t0) / 1000, configS: (tc - tl) / 1000, identify: model.timing || null, validateS: (tv1 - tv0) / 1000, plotS: (tp - tv1) / 1000, zoomS: (tz - tp) / 1000, totalS: (Date.now() - t0) / 1000 },
        plots: Object.assign({}, plots, { zooms: zoom }),
        model: { params: p, Href: model.Href, has: model.has, split: model.split, free: model.free },
    };
    fs.mkdirSync(OUT, { recursive: true });
    const file = path.join(OUT, 'result.json');
    fs.writeFileSync(file, JSON.stringify(result, (k, v) => ArrayBuffer.isView(v) ? Array.from(v, x => r(x, 6)) : typeof v === 'number' && !Number.isInteger(v) ? r(v, 6) : v));
    // summary
    const f2 = (x, d = 2) => x == null ? '-' : x.toFixed(d);
    console.log(`status ${val.status}: ${val.reasons.join(' | ')}`);
    for (const q of result.acceptance) console.log(`  ${q.rule.padEnd(11)} ${String(q.value).padEnd(9)} limit ${q.limit}  ${q.pass ? 'pass' : 'FAIL'}`);
    console.log(`open loop (windows): hs median ${f2(ol.window.hs.medianAbs)} % RMS ${f2(ol.window.hs.rms)} %, Vbat RMS ${ol.window.vbat ? f2(ol.window.vbat.rms, 3) : '-'} V, Ibat RMS ${ol.window.ibat ? f2(ol.window.ibat.rms, 2) : '-'} A`);
    console.log(`open loop (stretches): hs median ${f2(ol.stretch.hs.medianAbs)} % RMS ${f2(ol.stretch.hs.rms)} %, Vbat RMS ${ol.stretch.vbat ? f2(ol.stretch.vbat.rms, 3) : '-'} V`);
    console.log(`closed loop (FALLBACK entries forced at the logged times): hs RMS ${f2(cl.hsRms)} % (logged tracking error ${f2(cl.baseRms)} %, ratio ${f2(cl.skill, 3)}; fast part ratio ${f2(cl.band, 3)}), u RMS ${f2(cl.uRms, 4)}, states ${f2(cl.stateAgreement, 4)}, Vbat RMS ${f2(cl.vbatRms, 3)} V`);
    for (const q of cl.runs) console.log(`  log ${q.log}: ${q.excluded ? 'EXCLUDED ' + q.excluded : `hs ${f2(q.hsRms)} % (logged tracking ${f2(q.baseRms)} %, fast ratio ${f2(q.band, 3)}), u ${f2(q.uRms, 4)}, states ${f2(q.stateAgreement, 4)}, Vbat ${f2(q.vbatRms, 3)} V, sat ${f2(q.satS)} s, forced FALLBACK ${q.forced}`}`);
    if (val.unforced) { const uf = val.unforced; console.log(`closed loop without forced FALLBACK: hs RMS ${f2(uf.hsRms)} %, u RMS ${f2(uf.uRms, 4)}, states ${f2(uf.stateAgreement, 4)}, Vbat ${f2(uf.vbatRms, 3)} V, fast ratio ${f2(uf.band, 3)}`);
        for (const q of uf.runs) console.log(`  log ${q.log}: ${q.excluded ? 'EXCLUDED' : `hs ${f2(q.hsRms)} %, u ${f2(q.uRms, 4)}, states ${f2(q.stateAgreement, 4)}, sat ${f2(q.satS)} s, own FALLBACK entries ${q.entries}`}`); }
    if (val.tmScan.length) {
        const all = [{ factor: 1, band: cl.band, hsRms: cl.hsRms, runs: cl.runs.filter(q => !q.excluded) }].concat(val.tmScan).sort((a, b) => a.factor - b.factor);
        console.log('tm scan (closed loop, fast ratio / hs RMS):', all.map(q => `x${q.factor}: ${f2(q.band, 3)} / ${f2(q.hsRms)}`).join(', '));
        console.log('  per log (fast ratio):', all.map(q => `x${q.factor}: ` + q.runs.map(x => `${x.log} ${f2(x.band, 3)}`).join(' ')).join(' | '));
    }
    for (const [l, d] of Object.entries(diag)) for (const [k, a] of Object.entries(d)) console.log(`    log ${l} ${k}: share ${a.share}, hs RMS ${a.hsRms} % (bias ${a.hsBias}, ${a.hsSqShare} of the squares), u RMS ${a.uRms} (bias ${a.uBias})`);
    const hz = val.horizon; console.log(`horizon (${hz.starts} starts; s, model / hold RMS %):`, hz.horizons.map((h, j) => `${h}: ${f2(hz.model[j].rms)}/${f2(hz.hold[j].rms)}`).join(', '));
    console.log('  in ACTIVE to the horizon (model / hold / logged target):', hz.horizons.map((h, j) => `${h}: ${f2(hz.inActive.model[j].rms)}/${f2(hz.inActive.hold[j].rms)}/${f2(hz.inActive.target[j].rms)} (n ${hz.inActive.model[j].n})`).join(', '));
    console.log('  crossing a state change (model / hold):', hz.horizons.map((h, j) => `${h}: ${f2(hz.crossing.model[j].rms)}/${f2(hz.crossing.hold[j].rms)} (n ${hz.crossing.model[j].n})`).join(', '));
    for (const e of val.events.spoolups) console.log(`  spool-up log ${e.log} at ${f2(e.atS, 1)} s: exit u log ${f2(e.exitThrottle.log, 3)} closed ${f2(e.exitThrottle.closed, 3)}; overshoot log ${f2(e.overshoot.log)} open ${f2(e.overshoot.open)} closed ${f2(e.overshoot.closed)} %`);
    for (const e of val.events.saturation) console.log(`  saturation log ${e.log}: log ${f2(e.logS)} s, closed ${f2(e.closedS)} s`);
    for (const e of val.events.fallbacks) console.log(`  FALLBACK log ${e.log} at ${f2(e.atS, 1)} s (${e.forced ? 'entry forced from the log' : 'own entry'}): lowest headspeed log ${f2(e.droop.log, 1)} % closed ${f2(e.droop.closed, 1)} %; recovery log ${f2(e.recoveryS.log)} s closed ${f2(e.recoveryS.closed)} s`);
    if (model.softStart) console.log(`soft start (${model.softStart.method}, ${model.softStart.starts} starts, RMS ${f2(model.softStart.rms, 0)} rpm): ass ${f2(p.ass, 0)} rpm/s, as1 ${f2(p.as1, 0)} rpm/s + asr ${f2(p.asr, 3)}/s x lim from as0 ${f2(p.as0, 0)} rpm, u0 ${f2(p.u0, 3)}`);
    console.log('params:', Object.entries(params).map(([k, v]) => `${k} ${v.value}${v.p5 != null ? ` (${v.p5}-${v.p95}${v.spread === 'flights' && v.bootstrap ? `; bootstrap ${r(v.bootstrap.p5)}-${r(v.bootstrap.p95)}` : ''})` : ''}`).join(', '));
    if (model.physical) console.log('physical:', JSON.stringify(model.physical.value));
    console.log(`timing: identify ${model.timing ? model.timing.totalS : '-'} s (fit ${model.timing ? model.timing.fitS : '-'}, bootstrap ${model.timing ? model.timing.bootstrapS : '-'}), validate ${result.timing.validateS} s, plot ${result.timing.plotS} s; wrote ${file}`);
})().catch((e) => { console.error(e); process.exit(1); });
