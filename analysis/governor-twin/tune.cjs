'use strict';
// Governor autotune on the dev data (docs/GOVERNOR_AUTOTUNE.md sections 5, 7 and 9): gov_tune.autotune (recover, configOf, identify,
// validate, scenarios, search, rows) on analysis/governor-20261014/data/<craft>, as the worker command governorTune runs it on a file.
//   node analysis/governor-twin/tune.cjs <fireball|gaui> [--cli <dump>] [--no-current] [--bench] [--budget ms] [--out <dir>]
// The runs are the flight logs only, as in the worker (--bench: the bench runs too, as configuration evidence of gov_params). DISARM events
// from out/disarm_<craft>.json (dev.cjs). --no-current drops Ibat. Writes <out>/tune.json (the result, JSON) and <out>/tune.md (every row:
// name, PID profile, value at this time and its source, status, recommended value, evidence with its interval, rule; the recommendations and
// the CLI file of advice.exportScript with the check of each recommendation). Default out: out/<craft>[-nocurrent][-nocli for the Fireball
// without a dump].
const fs = require('fs'), path = require('path');
const ROOT = path.resolve(__dirname, '../..');
const GD = require(path.join(ROOT, 'tools/autotune/gov_data.cjs')), GTU = require(path.join(ROOT, 'tools/autotune/gov_tune.cjs')), ADV = require(path.join(ROOT, 'tools/autotune/advice.cjs'));

const args = process.argv.slice(2), opt = (k) => { const i = args.indexOf(k); return i >= 0 ? args.splice(i, 2)[1] : null; }, flag = (k) => { const i = args.indexOf(k); if (i >= 0) args.splice(i, 1); return i >= 0; };
const cliFile = opt('--cli'), outOpt = opt('--out'), budget = opt('--budget'), noCurrent = flag('--no-current'), bench = flag('--bench'), craft = args[0];
if (!craft) { console.error('usage: tune.cjs <fireball|gaui> [--cli <dump>] [--no-current] [--bench] [--budget ms] [--out <dir>]'); process.exit(2); }
const DIR = path.join(ROOT, 'analysis/governor-20261014/data', craft);
const OUT = outOpt || path.join(__dirname, 'out', craft + (noCurrent ? '-nocurrent' : '') + (craft === 'fireball' && !cliFile ? '-nocli' : ''));

function eventsOf(meta) {
    const f = path.join(__dirname, 'out', `disarm_${craft}.json`), ev = {};
    if (!fs.existsSync(f)) return ev;
    const d = JSON.parse(fs.readFileSync(f, 'utf8'));
    for (const s of meta.segments) ev[s.log] = (d.us[s.log] || []).map(us => ({ t: (us - s.timeStartUs) / 1e6 + (s.fromS || 0), name: 'DISARM' }));
    return ev;
}
const show = (v) => v === null || v === undefined ? '' : Array.isArray(v) ? v.join(',') : String(v);
const num = (v, d = 4) => typeof v === 'number' && isFinite(v) ? String(+v.toPrecision(d)) : '';
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
function evidenceText(e) {
    const u = e.unit ? ` ${e.unit}` : '', iv = num(e.lo) !== '' || num(e.hi) !== '' ? ` (${num(e.lo) || '…'} to ${num(e.hi) || '…'})` : '', se = num(e.se) ? ` ± ${num(e.se)}` : '', n = e.n ? `, n ${e.n}` : '';
    const where = Number.isInteger(e.log) ? ` [log ${e.log + 1}${typeof e.t0 === 'number' ? ` ${e.t0.toFixed(1)} s` : ''}]` : '';
    return `${e.text || ''} **${num(e.value) || show(e.value)}${se}${u}${iv}${n}**${where}`;
}
// each recommendation with CLI text (with the other changes of its group: advice.cjs group, all or none), and all changes together,
// through advice.exportScript: every CLI line in the file, no refusal; a value that the CLI file calls unknown must be unknown in the rows
function exportCheck(recs, rows) {
    const out = [], withCli = recs.filter(x => x.cli && x.cli.length), members = (x) => x.group ? recs.filter(q => q.group === x.group).map(q => q.id) : [x.id];
    for (const x of withCli) {
        const s = ADV.exportScript(recs, members(x), {}), missing = x.cli.filter(l => !s.includes(l));
        out.push({ id: x.id, severity: x.severity, optIn: !!x.optIn, group: x.group || null, cli: x.cli, ok: !missing.length && !/Not in the file/.test(s), missing, refusal: (s.match(/# Not in the file:[^\n]*(\n#[^\n]*)*/) || [null])[0] });
    }
    const all = ADV.exportScript(recs, recs.filter(x => x.severity === 'action').map(x => x.id), {}), every = ADV.exportScript(recs, withCli.map(x => x.id), {});
    const known = (name, p) => rows.some(r => r.name === name && (p === null || r.profile === p) && r.current && r.current.value !== null && r.current.value !== undefined);
    const unknown = [...new Set([...(all + every).matchAll(/The value of `(\w+)`(?: \(PID profile (\d)\))? is unknown/g)].map(m => `${m[1]}|${m[2] || ''}`))].map(k => k.split('|'))
        .filter(([n, p]) => known(n, p ? +p : null)).map(([n, p]) => p ? `${n} (PID profile ${p})` : n);
    return { each: out, script: all, unknownKnown: unknown, allOk: !unknown.length && !/Not in the file/.test(all) && recs.filter(x => x.severity === 'action' && x.cli.length).every(x => x.cli.every(l => all.includes(l))) };
}
function markdown(res, meta, ex) {
    const L = [], prof = (r) => r.profile === null || r.profile === undefined ? 'all' : r.profile > 0 ? `PID profile ${r.profile}` : 'unknown';
    L.push(`# Governor autotune: ${craft}${noCurrent ? ' without current' : ''}${cliFile ? `, CLI dump ${path.basename(cliFile)}` : ', log only'}`, '');
    L.push(`Generated ${new Date().toISOString()} by \`analysis/governor-twin/tune.cjs\` (gov_tune.autotune). Data: \`${meta.file || DIR}\`, ${res.logs.length} flight logs (0-based: ${res.logs.join(', ')}).`, '');
    L.push(`**Status: ${res.status}.** ${res.reasons.join(' ')}`, '');
    L.push(`Time: ${Object.entries(res.timing).map(([k, v]) => `${k} ${v}`).join(', ')}.`, '');
    if (res.twin) { const v = res.twin.validation || {}; L.push('## Twin', '', `Href ${res.twin.Href} rpm, split ${JSON.stringify(res.twin.split)}.`, '');
        L.push('| check | value | limit | pass |', '|---|---|---|---|', ...(v.checks || []).map(c => `| ${c.rule} | ${num(c.value)} | ${c.limit} | ${c.pass ? 'yes' : 'NO'} |`), '');
        L.push('| parameter | value | p5 | p95 | unit |', '|---|---|---|---|---|', ...Object.entries(res.twin.params).map(([k, x]) => { const u = res.twin.uncertainty[k] || {}; return `| ${k} | ${num(x, 5)} | ${num(u.p5, 5)} | ${num(u.p95, 5)} | ${u.unit || ''} |`; }), ''); }
    L.push('## Limitations', '', ...res.limitations.map(t => `- ${t}`), '');
    const recs = res.recommendations.filter(x => x.severity === 'action' || x.optIn);
    L.push('## Changes (CLI)', '', '| id | severity | group | from | to | CLI | export |', '|---|---|---|---|---|---|---|');
    for (const x of recs) { const c = ex.each.find(q => q.id === x.id); L.push(`| ${cell(x.id)} | ${x.severity}${x.optIn ? ' (opt-in)' : ''} | ${x.group ? `${x.group} (${x.groupSize})` : ''} | ${cell(show(x.from))} | ${cell(show(x.to))} | \`${cell(x.cli.join('; '))}\` | ${c ? c.ok ? 'ok' : `REFUSED ${cell(c.refusal || c.missing.join(', '))}` : 'no CLI'} |`); }
    L.push('', `All changes together: ${ex.allOk ? 'every CLI line is in the file, no refusal' : 'REFUSAL or missing line'}.${ex.unknownKnown.length ? ` The CLI file calls known values unknown: ${ex.unknownKnown.join(', ')}.` : ''}`, '', '```', ex.script, '```', '');
    L.push('## Rows', '', `${res.rows.length} rows; coverage ${res.coverage.covered}/${res.coverage.names} names, missing ${res.coverage.missing.length}. Status counts: ${Object.entries(res.rows.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {})).map(([k, v]) => `${k} ${v}`).join(', ')}.`, '');
    L.push('| name | PID profile | value at this time (source) | status | to | rule | text and evidence |', '|---|---|---|---|---|---|---|');
    const R = res.rules || {};
    for (const r of res.rows) {
        const c = r.current || {}, cur = `${show(c.value) || (c.candidates ? c.candidates.join(' or ') : c.lo !== null && c.lo !== undefined ? `≥ ${c.lo}` : 'unknown')} (${c.source || 'unknown'})`;
        const ev = (r.evidence || []).slice(0, 10).map(evidenceText), more = (r.evidence || []).length > 10 ? [`(+${r.evidence.length - 10} more evidence rows)`] : [];
        const st = r.stale ? [`*Stale: ${r.stale.text}*`] : [];
        L.push(`| ${r.name} | ${prof(r)} | ${cell(cur)} | ${r.status} | ${cell(show(r.to))} | ${R[r.rule] ? R[r.rule].id : r.rule} | ${cell([r.text].concat(ev, more, st).filter(Boolean).join('<br>'))} |`);
    }
    L.push('', '## Notes', '', ...res.notes.map(t => `- ${t}`), '');
    return L.join('\n');
}

(async () => {
    const t0 = Date.now(), meta = JSON.parse(fs.readFileSync(path.join(DIR, 'meta.json'), 'utf8'));
    let runs = GD.load(DIR, { bench: true, events: eventsOf(meta) });
    if (!bench) runs = runs.filter(q => q.class === 'flight');
    if (noCurrent) for (const q of runs) { q.ibat = null; q.hasCurrent = false; }
    const cli = cliFile ? fs.readFileSync(cliFile, 'utf8') : null, tl = Date.now();
    let last = '';
    const res = await GTU.autotune(runs, { cli, budgetMs: budget ? +budget : undefined, progress: (text, f) => { const s = `${(100 * f).toFixed(0)} % ${text}`; if (s !== last) process.stderr.write(`\r${s}`.padEnd(110)); last = s; } });
    process.stderr.write('\n');
    res.logs = [...new Set(runs.filter(q => q.class === 'flight').map(q => q.log))];
    res.timing.loadS = (tl - t0) / 1000;
    const ex = exportCheck(res.recommendations, res.rows);
    res.exportCheck = { allOk: ex.allOk, each: ex.each, unknownKnown: ex.unknownKnown };
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'tune.json'), JSON.stringify(res));
    fs.writeFileSync(path.join(OUT, 'tune.md'), markdown(res, meta, ex));
    const n = res.rows.reduce((a, r) => (a[r.status] = (a[r.status] || 0) + 1, a), {});
    console.log(`${craft}: status ${res.status}; rows ${res.rows.length} (${Object.entries(n).map(([k, v]) => `${k} ${v}`).join(', ')}); coverage ${res.coverage.covered}/${res.coverage.names}, missing ${res.coverage.missing.length}; time ${JSON.stringify(res.timing)}`);
    for (const x of res.recommendations.filter(q => q.severity === 'action' || q.optIn)) console.log(`  ${x.severity.padEnd(6)} ${x.optIn ? 'opt-in ' : ''}${x.id}: ${show(x.from)} -> ${show(x.to)}  ${x.cli.join('; ')}`);
    console.log(`export: ${ex.allOk ? 'ok' : 'REFUSAL'}; each: ${ex.each.filter(q => q.ok).length}/${ex.each.length} ok${ex.unknownKnown.length ? `; known values called unknown: ${ex.unknownKnown.join(', ')}` : ''}`);
    for (const q of ex.each.filter(q => !q.ok)) console.log(`  REFUSED ${q.id}: ${q.refusal || q.missing.join(', ')}`);
    console.log(`wrote ${path.join(OUT, 'tune.json')} and tune.md`);
})().catch((e) => { console.error(e); process.exit(1); });
