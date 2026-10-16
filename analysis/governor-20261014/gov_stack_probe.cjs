'use strict';
// Probe of the existing governor checks on selected logs of one dump (read-only use of tools/autotune).
//   node gov_stack_probe.cjs <out.json> <dump.bbl> <first log> <last log> [--cli <dump.txt>]
// Logs are 0-based (as lib.segments and the tests count them). Runs health_gov, health_power, health_phase, health_rescue
// (G19/G20) and health_limits (L1) with the toolkit context of health.cjs, then the judges, and adds raw numbers that
// the governor twin design needs (throttle at the ceiling, Vbat/Ibat statistics, the motor[0]/govSum ratio).
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const ROOT = path.resolve(__dirname, '../..');
const lib = require(path.join(ROOT, 'tools/autotune/lib.cjs'));
const H = require(path.join(ROOT, 'tools/autotune/health.cjs'));
const GOV = require(path.join(ROOT, 'tools/autotune/health_gov.cjs'));
const POW = require(path.join(ROOT, 'tools/autotune/health_power.cjs'));
const PH = require(path.join(ROOT, 'tools/autotune/health_phase.cjs'));
const RES = require(path.join(ROOT, 'tools/autotune/health_rescue.cjs'));
const LIM = require(path.join(ROOT, 'tools/autotune/health_limits.cjs'));
const SETUP = require(path.join(ROOT, 'tools/autotune/health_setup.cjs'));

const args = process.argv.slice(2), ci = args.indexOf('--cli'), cliFile = ci >= 0 ? args.splice(ci, 2)[1] : null;
const [OUT, FILE, A, B] = args;
const cli = cliFile ? fs.readFileSync(cliFile, 'utf8') : null, cliParsed = cli ? SETUP.parseCli(cli) : null;
const EXTRA = [...new Set([].concat(GOV.EXTRA, POW.EXTRA, PH.EXTRA, RES.EXTRA, LIM.EXTRA, ['govTarget', 'Ibat', 'Tesc', 'rcCommand[4]', 'time']))];
const app = lib.loadApp(), buf = fs.readFileSync(FILE), MARKER = Buffer.from('H Product:Blackbox flight data recorder by Nicholas Sherlock');
const at0 = []; for (let i = buf.indexOf(MARKER); i >= 0; i = buf.indexOf(MARKER, i + 1)) at0.push(i);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'govprobe-')), r = (v, d = 4) => typeof v === 'number' && isFinite(v) ? +v.toFixed(d) : null;
const gov = [], pow = [], phs = [], res = [], lim = [], raw = [];
for (let li = +A; li <= +B && li < at0.length; li++) {
    const f = path.join(tmp, `log${li}.bbl`); fs.writeFileSync(f, buf.subarray(at0[li], li + 1 < at0.length ? at0[li + 1] : buf.length));
    let seg = 0;
    for (const w of lib.segments(app, f, { whole: true, extra: EXTRA })) {
        if (w.skipped) { raw.push({ log: li, skipped: w.skipped }); continue; }
        const fl = w.flight, rate = fl.actualRate, x = w.extra, target = x.govTarget || w.hs;
        const { p: profile } = lib.profilesOf(w, target, H.RULE.flight.headspeed);
        const fm = H.flightMask(w, rate), ctx = H.buildCtx(w, fl, { flying: fm.flying, profile, cli, cliParsed, app });
        let ph = null; try { ph = PH.phases(w, Object.assign({}, ctx)); } catch (e) { ph = null; }
        const pctx = Object.assign({}, ctx, ph ? { phases: ph } : {});
        const one = (M, list, c) => { try { list.push({ log: li, segment: seg, header: fl.header, metrics: JSON.parse(JSON.stringify(M.analyse(w, c), (k, v) => ArrayBuffer.isView(v) ? undefined : v)) }); } catch (e) { raw.push({ log: li, module: M === GOV ? 'gov' : '?', error: String(e.message) }); } };
        if (fm.flown) one(GOV, gov, Object.assign({}, ctx));
        one(POW, pow, Object.assign({}, pctx));
        one(PH, phs, Object.assign({}, pctx));
        one(RES, res, Object.assign({}, pctx));
        one(LIM, lim, Object.assign({}, pctx));
        // raw numbers for the twin design
        const mot = x['motor[0]'], vb = x.Vbat, ib = x.Ibat, sum = x.govSum, gs = w.govStateAt, n = w.n;
        let act = 0, ceil = 0, vMin = Infinity, vMax = -Infinity, iMax = 0, iNz = 0, ratio = [], motAct = [];
        for (let i = 0; i < n; i++) {
            if (vb) { if (vb[i] > 100) { vMin = Math.min(vMin, vb[i]); vMax = Math.max(vMax, vb[i]); } }
            if (ib && ib[i] > 0) { iNz++; iMax = Math.max(iMax, ib[i]); }
            if (gs && gs[i] === 4 && mot) { act++; motAct.push(mot[i]); if (mot[i] >= 995) ceil++; if (sum && sum[i] > 100 && mot[i] < 980) ratio.push(mot[i] / sum[i]); }
        }
        motAct.sort((a, b) => a - b); ratio.sort((a, b) => a - b);
        const states = {}; if (gs) for (let i = 0; i < n; i++) states[GOV.STATES[gs[i]]] = (states[GOV.STATES[gs[i]]] || 0) + 1 / rate;
        raw.push({ log: li, segment: seg, seconds: r(n / rate, 1), rate: r(rate, 1), flown: fm.flown, flyingS: r(fm.up / rate, 1), govStateLogged: !!gs,
            states: Object.fromEntries(Object.entries(states).map(([k, v]) => [k, r(v, 1)])), activeS: r(act / rate, 1), atCeilingActiveS: r(ceil / rate, 2),
            motorActive: motAct.length ? { p50: motAct[motAct.length >> 1] / 10, p95: motAct[Math.floor(0.95 * motAct.length)] / 10, max: motAct[motAct.length - 1] / 10 } : null,
            motorOverGovSum: ratio.length ? { p5: r(ratio[Math.floor(0.05 * ratio.length)]), p50: r(ratio[ratio.length >> 1]), p95: r(ratio[Math.floor(0.95 * ratio.length)]), n: ratio.length } : null,
            vbat: vb ? { min: r(vMin / 100, 2), max: r(vMax / 100, 2) } : null, ibatNonZeroS: ib ? r(iNz / rate, 2) : null, ibatMaxA: ib ? r(iMax / 100, 1) : null,
            tescLogged: !!x.Tesc, govPID: fl.header && fl.header.govPID });
        seg++;
    }
}
fs.rmSync(tmp, { recursive: true, force: true });
const pick = (F, ids) => F.filter(f => ids.includes(f.id)).map(f => ({ id: f.id, severity: f.severity, log: f.log, profile: f.profile, value: f.value, se: f.se, n: f.n, text: String(f.text || '').slice(0, 900),
    throttleLimit: f.throttleLimit, governorResponse: f.governorResponse ? { all: f.governorResponse.all, unsaturated: f.governorResponse.unsaturated, saturated: f.governorResponse.saturated, feedforward: f.governorResponse.feedforward, lowF: f.governorResponse.lowF } : undefined,
    impliedSpoolupTime: f.impliedSpoolupTime, throttlePctPerS: f.throttlePctPerS, seconds: f.seconds, settleS: f.settleS, severe: f.severe, minCell: f.minCell, overloads: f.overloads, signals: f.signals, longestS: f.longestS }));
const safe = (fn) => { try { return fn(); } catch (e) { return [{ error: String(e.message) }]; } };
const out = { file: path.basename(FILE), logs: [+A, +B], cli: cliFile ? path.basename(cliFile) : null, flightRpm: lib.FLIGHT_RPM,
    findings: { gov: safe(() => pick(GOV.judge(gov), ['D5', 'G0', 'G1', 'G2', 'G3', 'G4', 'G5', 'G6', 'G7', 'G8', 'G9', 'G10', 'G11', 'G12', 'G13'])),
        power: safe(() => pick(POW.judge(pow), ['P1', 'P2'])), phase: safe(() => pick(PH.judge(phs), ['D7', 'G15', 'G16', 'G17', 'G18'])),
        rescue: safe(() => pick(RES.judge(res), ['G19', 'G20'])), limits: safe(() => pick(LIM.judge(lim), ['L1'])) },
    govMeasures: gov.map(g => ({ log: g.log, fullHeadspeed: g.metrics.fullHeadspeed, G8: g.metrics.G8, G7: g.metrics.G7, gains: g.metrics.gains, units: g.metrics.units, G11: g.metrics.G11 && { perPack: g.metrics.G11.perPack, perPackSe: g.metrics.G11.perPackSe, perVolt: g.metrics.G11.perVolt, perVoltSe: g.metrics.G11.perVoltSe, blocks: g.metrics.G11.blocks },
        D5: g.metrics.D5 && { cells: g.metrics.D5.cells, cellsSource: g.metrics.D5.cellsSource, restingV: g.metrics.D5.restingV, minCellInFlight: g.metrics.D5.minCellInFlight }, states: g.metrics.states && { seconds: g.metrics.states.seconds, entries: g.metrics.states.entries.map(e => ({ t: e.t, state: e.state, from: e.from, value: e.value, flying: e.flying, motorBefore: e.motorBefore, headspeedAt: e.headspeedAt })) } })),
    raw };
fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
console.error(`${OUT}: gov ${gov.length}, power ${pow.length}, phase ${phs.length}, rescue ${res.length}, limits ${lim.length} segments`);
