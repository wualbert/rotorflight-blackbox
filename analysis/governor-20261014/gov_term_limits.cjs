'use strict';
// Governor term clamps and throttle saturation against battery voltage, per log (read-only use of tools/autotune).
//   node gov_term_limits.cjs <out.json> <dump.bbl> <first log> <last log> [pLimit iLimit dLimit fLimit (%)]
// govP/I/D/F are logged in 0.1 % of full throttle (health_gov.cjs:10); a clamp at limit L % is |value| = 10 x L.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const ROOT = path.resolve(__dirname, '../..');
const lib = require(path.join(ROOT, 'tools/autotune/lib.cjs'));
const [OUT, FILE, A, B, ...lims] = process.argv.slice(2);
const LIM = lims.length === 4 ? lims.map(Number) : null;
const EXTRA = ['govP', 'govI', 'govD', 'govF', 'govSum', 'govTarget', 'motor[0]', 'Vbat', 'Ibat', 'mixer[3]'];
const app = lib.loadApp(), buf = fs.readFileSync(FILE), MARKER = Buffer.from('H Product:Blackbox flight data recorder by Nicholas Sherlock');
const at0 = []; for (let i = buf.indexOf(MARKER); i >= 0; i = buf.indexOf(MARKER, i + 1)) at0.push(i);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'govlim-')), r = (v, d = 3) => typeof v === 'number' && isFinite(v) ? +v.toFixed(d) : null;
const q = (s, p) => s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null;
const rows = [];
for (let li = +A; li <= +B && li < at0.length; li++) {
    const f = path.join(tmp, `log${li}.bbl`); fs.writeFileSync(f, buf.subarray(at0[li], li + 1 < at0.length ? at0[li + 1] : buf.length));
    for (const w of lib.segments(app, f, { whole: true, extra: EXTRA })) {
        if (w.skipped || !w.govStateAt) continue;
        const x = w.extra, gs = w.govStateAt, n = w.n, rate = w.flight.actualRate;
        const act = []; for (let i = 0; i < n; i++) if (gs[i] === 4) act.push(i);
        if (act.length < rate * 5) continue;
        const term = {};
        for (const [k, key] of [['P', 'govP'], ['I', 'govI'], ['D', 'govD'], ['F', 'govF']]) {
            const v = x[key]; if (!v) continue;
            const s = act.map(i => v[i]).sort((a, b) => a - b), absMax = Math.max(Math.abs(s[0]), Math.abs(s[s.length - 1]));
            const lim = LIM ? 10 * LIM['PIDF'.indexOf(k)] : null;
            let at = 0; if (lim !== null) for (const i of act) if (Math.abs(v[i]) >= lim - 1) at++;
            term[k] = { p1: s[Math.floor(0.01 * s.length)], p50: q(s, 0.5), p99: q(s, 0.99), absMax, limit: lim, atLimitS: lim === null ? null : r(at / rate, 2), atLimitShare: lim === null ? null : r(at / act.length, 4) };
        }
        const mot = x['motor[0]'], vb = x.Vbat, ib = x.Ibat, sat = [], free = [];
        for (const i of act) (mot[i] >= 995 ? sat : free).push(i);
        const vAt = (list) => vb ? list.map(i => vb[i] / 100).filter(v => v > 1).sort((a, b) => a - b) : [];
        const vs = vAt(sat), vf = vAt(free), firstAct = act[0], lastAct = act[act.length - 1];
        const when = sat.map(i => (i - firstAct) / Math.max(1, lastAct - firstAct)).sort((a, b) => a - b);
        // pack sag proxy: Vbat in the first and last 10 % of ACTIVE time
        const head = vAt(act.slice(0, Math.floor(act.length / 10))), tail = vAt(act.slice(-Math.floor(act.length / 10)));
        const iAct = ib ? act.map(i => ib[i] / 100).filter(v => v > 0).sort((a, b) => a - b) : [];
        rows.push({ log: li, activeS: r(act.length / rate, 1), terms: term, saturationS: r(sat.length / rate, 2),
            vbatAtSaturation: vs.length ? { p10: q(vs, 0.1), p50: q(vs, 0.5), p90: q(vs, 0.9) } : null, vbatUnsaturated: vf.length ? { p10: q(vf, 0.1), p50: q(vf, 0.5), p90: q(vf, 0.9) } : null,
            saturationWhenInPack: when.length ? { p10: r(q(when, 0.1)), p50: r(q(when, 0.5)), p90: r(q(when, 0.9)) } : null,
            vbatFirst10pct: head.length ? q(head, 0.5) : null, vbatLast10pct: tail.length ? q(tail, 0.5) : null,
            ibatActive: iAct.length ? { p50: r(q(iAct, 0.5), 1), p99: r(q(iAct, 0.99), 1), max: r(iAct[iAct.length - 1], 1) } : null });
    }
}
fs.rmSync(tmp, { recursive: true, force: true });
fs.writeFileSync(OUT, JSON.stringify({ file: path.basename(FILE), logs: [+A, +B], limitsPct: LIM, rows }, null, 1));
console.error(`${OUT}: ${rows.length} logs`);
