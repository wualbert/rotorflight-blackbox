'use strict';

// The ASD-STE100 Issue 9 (Simplified Technical English) lint of the text that the app shows (CLAUDE.md, docs/STE_GLOSSARY.md).
// The words come from test/ste/vocabulary.json. The texts are found at run time, so this test follows the parts as they change,
// and a part that is missing or that throws is reported, not fatal for the other sources:
//   - catalog.cjs summaries for synthetic findings of every check id (with the D7, G15-G18 and C15 phase checks), and for the
//     real findings in analysis/ when present
//   - hierarchy.cjs titles, chips, edge texts, K rules, and the status reasons (also for each PID profile) for synthetic findings
//   - the finding texts of our modules (health_track, health_more, health_phase), advice() outputs, the comment lines of the
//     CLI scripts (advice script and exportScript), evidence and hierarchy outputs: the tests of those parts run again in
//     worker threads with the module exports wrapped, and every output is read
//   - the rendered Tuning view, the log lens and the Analysis verdict: the node:vm harnesses of their tests run again, and
//     every text that our DOM scripts (js/tuning_dialog.js, js/log_lens.js, js/*_view.js) write through $ or the DOM
//     stand-ins is read, with every TuningPlot spec
//   - the worker texts (notes, progress, the window observations of the derive command: the literals of js/tuning_worker.js),
//     the messages of js/tuning_snippet.js, the view shell (index.html, js/main.js) and the STE rules in CLAUDE.md
//   - with AUTOTUNE_REAL_LOG set: also the TuningResults of test/tuning_worker.test.cjs (slow), of AUTOTUNE_RESCUE_LOG too when set
// Not linted: <code>, <pre>, [data-ste="quoted"] (toolkit text that is not STE, log-derived strings, quotes), CLI text,
// the upstream Flight analysis text (js/flight_analysis*.js) and the text of the other session's modules (finding `text`).
//
//   node --test test/ste_text.test.cjs
//
// Failing checks: LEN SEMI CONTR LATIN DENY ING LIMIT GB TENSE THAT NOTEIMP MATH PARA CASE SAFE VOCAB GEAR (maps2/ste.md c).
// Report only: PASSIVE POS NOUN4 SYN.
// GEAR is the gear-ratio rule of the project (CLAUDE.md): the configured gear ratios are correct, and no text doubts them.

const fs = require('node:fs');
const path = require('node:path');
const WT = require('node:worker_threads');

const ROOT = path.join(__dirname, '..');
const VOCAB_FILE = path.join(__dirname, 'ste', 'vocabulary.json');
const FAILING = ['LEN', 'SEMI', 'CONTR', 'LATIN', 'DENY', 'ING', 'LIMIT', 'GB', 'TENSE', 'THAT', 'NOTEIMP', 'MATH', 'PARA', 'CASE', 'SAFE', 'VOCAB', 'GEAR'];
const REPORT_ONLY = ['PASSIVE', 'POS', 'NOUN4', 'SYN'];
const RULE_OF = { LEN: '5.1, 6.3', SEMI: '8.1', CONTR: '4.2', LATIN: 'GR-6', DENY: '1.1', ING: '3.5', LIMIT: '9.2', GB: '1.14',
    TENSE: '3.2-3.4, 3.6', THAT: 'GR-1', NOTEIMP: '5.5', MATH: '8.6', PARA: '6.6', CASE: '4.3, style', SAFE: '7.1-7.3', VOCAB: '1.1, 1.5, 1.12', GEAR: 'project, CLAUDE.md "Gear ratios"', PASSIVE: '3.6', POS: '1.2',
    NOUN4: '2.1', SYN: '1.11' };

// ---- vocabulary --------------------------------------------------------------------------------------------------------

// test/ste/vocabulary.json: approved { word: 'pos forms...' }, technicalNouns { term: 'category forms...' },
// technicalVerbs { verb: 'category forms...' }, deny { word: 'STE alternative' }, ingAllow, british { gb: us }, units
function loadVocabulary(V) {
    const words = (s) => String(s).trim().split(/\s+/);
    const approved = new Map(), nounOnly = new Set(), verbOnly = new Set(), verbs = new Set(), tnPhrases = new Map(), tnWords = new Set(), tvForms = new Set();
    for (const [head, spec] of Object.entries(V.approved)) {
        const [pos, ...forms] = words(spec), parts = pos.split('/');
        if (head.includes(' ')) { tnPhrases.set(norm(head), []); continue; } // "make sure", "out of": matched as one item
        // a form is a verb or adjective form, and also the plural of a noun (changes: the noun and the verb)
        for (const w of [head, ...forms]) { if (!approved.has(w)) approved.set(w, new Set()); for (const x of w === head || singulars(w).includes(head) ? parts : parts.filter((q) => q !== 'n')) approved.get(w).add(x); }
        if (parts.includes('v')) verbs.add(head);
    }
    for (const [w, pos] of approved) { if (pos.size === 1 && pos.has('n')) nounOnly.add(w); if (pos.size === 1 && pos.has('v')) verbOnly.add(w); }
    for (const [term, spec] of Object.entries(V.technicalNouns)) {
        const [, ...forms] = words(spec), key = norm(term);
        if (key.includes(' ')) tnPhrases.set(key, forms.map(norm)); else { tnWords.add(key); forms.forEach((f) => tnWords.add(norm(f))); }
    }
    for (const [verb, spec] of Object.entries(V.technicalVerbs)) {
        const [, ...forms] = words(spec);
        verbs.add(verb);
        for (const f of [verb, ...forms, ...regularVerbForms(verb)]) tvForms.add(f);
    }
    const byFirst = new Map(); // first word of a multi-word technical noun -> [[words...]], longest first
    for (const key of tnPhrases.keys()) { const w = key.split(' '); if (!byFirst.has(w[0])) byFirst.set(w[0], []); byFirst.get(w[0]).push(w); }
    for (const l of byFirst.values()) l.sort((a, b) => b.length - a.length);
    return { V, approved, nounOnly, verbOnly, verbs, tnPhrases, tnWords, tvForms, byFirst, deny: new Map(Object.entries(V.deny)),
        ingAllow: new Set(V.ingAllow), british: new Map(Object.entries(V.british)), units: new Set(V.units) };
}
const norm = (s) => String(s).toLowerCase().replace(/-/g, ' ').replace(/\s+/g, ' ').trim();
function regularVerbForms(v) {
    const e = v.endsWith('e'), y = /[^aeiou]y$/.test(v);
    return [y ? v.slice(0, -1) + 'ies' : /(s|x|z|ch|sh)$/.test(v) ? v + 'es' : v + 's', y ? v.slice(0, -1) + 'ied' : e ? v + 'd' : v + 'ed', /[^aeiou][aeiou][bdgmnprt]$/.test(v) ? v + v.slice(-1) + 'ed' : null].filter(Boolean);
}
const singulars = (w) => [w.endsWith('s') && w.slice(0, -1), w.endsWith('es') && w.slice(0, -2), w.endsWith('ies') && w.slice(0, -3) + 'y'].filter(Boolean);
const stems = (w) => [w, ...singulars(w), w.endsWith('ed') && w.slice(0, -2), w.endsWith('ed') && w.slice(0, -1), w.endsWith('ied') && w.slice(0, -3) + 'y',
    /(.)\1ed$/.test(w) && w.slice(0, -3), w.endsWith('ing') && w.slice(0, -3), w.endsWith('ing') && w.slice(0, -3) + 'e', /(.)\1ing$/.test(w) && w.slice(0, -4)].filter(Boolean);

// ---- tokens and sentences (Rules 8.4-8.7) ------------------------------------------------------------------------------

const Q0 = '\u0001', Q1 = '\u0002', P0 = '\u0003';
const NUM = /^[+\-−±~≈<>≤≥]*\d[\d.,]*(?:e[+\-]?\d+)?(?:[\-–/]\d[\d.,]*)*%?$/i;
const ID = /^(?:[A-Z]{1,6}\d+[A-Za-z]?(?::[\w\-]+)*(?:\/[A-Z]{1,6}\d+[A-Za-z]?)*|#\d+)$/;          // C12, F5, D4:cli, C12/T11, P1, #50
const PARAM = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;                                                 // yaw_p_gain
const FIELD = /^(?:[a-z]+[A-Z][A-Za-z0-9]*|\w+)\[\d+\]$|^[a-z]+[A-Z][A-Za-z0-9]*$/;                // mixer[2], gyroADC, govTarget
const FILE = /^[\w\-]+(?:\.[\w\-]+)*\.(?:cjs|mjs|js|md|json|bbl|txt|css|html|c|h|py|sh|csv|png|svg)$/i;
const ABBR = /^(?:[A-Z][A-Z0-9]{1,7}s?|[A-Z])$/;                                                   // SE, CLI, MIXS, P, D
const URL = /^(?:https?:\/\/|www\.)\S+$/;
const SYMBOL = /^[|=<>≤≥√×÷^+\-−±→←~≈·•–—\/&*]+$/;
const LATIN = /\b(?:e\.\s?g\.|i\.\s?e\.|etc\.?|vs\.?|cf\.|viz\.|et al\.?)(?=\s|$|[,;:)])/i;
const NO_END = /\b(?:No|a\.m|p\.m|e\.g|i\.e|vs|etc|Fig|approx)\.$/;

// `...`, "...", “...” become one quoted token (Rule 8.6); the spans come back for display only
function protect(text) {
    const spans = [];
    const t = String(text).replace(/`[^`]*`|"[^"\n]*"|“[^”\n]*”/g, (m) => { spans.push(m); return ` ${Q0}${spans.length - 1}${Q1} `; });
    return { t, spans };
}
// Rule 8.5: text in parentheses is one word of the sentence, and a sentence of its own
function pullParens(t) {
    const inner = [];
    let out = '', depth = 0, buf = '';
    for (const ch of t) {
        if (ch === '(') { if (depth++ > 0) buf += ch; else buf = ''; continue; }
        if (ch === ')' && depth > 0) { if (--depth === 0) { inner.push(buf); out += ` ${P0} `; } else buf += ch; continue; }
        if (depth > 0) buf += ch; else out += ch;
    }
    if (depth > 0) out += '(' + buf;
    return { out, inner };
}
// A sentence ends at . ! ? before a space and an upper-case letter, a digit, a quote or a parenthesis, or at the end
function splitSentences(t) {
    const out = [], re = new RegExp(`[.!?](?=\\s+[A-Z0-9"“(${Q0}${P0}±−]|\\s*$)`, 'g');
    let start = 0, m;
    while ((m = re.exec(t))) {
        const head = t.slice(start, m.index + 1);
        if (NO_END.test(head.trim())) continue;
        if (head.trim()) out.push(head.trim());
        start = m.index + 1;
    }
    if (t.slice(start).trim()) out.push(t.slice(start).trim());
    return out;
}
function tokensOf(sentence, L) {
    const raw = sentence.split(/\s+/).filter(Boolean), toks = [];
    for (let i = 0; i < raw.length; i++) {
        const w = raw[i];
        if (w.includes(Q0)) { toks.push({ w, type: 'quoted' }); continue; }
        if (w === P0) { toks.push({ w: '(...)', type: 'paren' }); continue; }
        const core = w.replace(/^[\[“"'(]+|[,.;:!?)”"'\]]+$/g, '');
        if (!core) continue;
        let type = URL.test(core) ? 'url' : NUM.test(core) ? 'number' : SYMBOL.test(core) ? 'symbol' : ID.test(core) && /\d/.test(core) ? 'id'
            : PARAM.test(core) ? 'param' : FIELD.test(core) ? 'field' : FILE.test(core) ? 'file' : ABBR.test(core) ? 'abbr'
            : /^[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+$/.test(core) ? 'hyphenated' : /^[A-Za-z]+(?:'s|s')?$/.test(core) ? 'word' : 'other';
        toks.push({ w: core, type, lc: core.toLowerCase().replace(/'s$|'$/, ''), punct: /[,;:)\]]$/.test(w) });
    }
    // a number and its unit, and n ± m unit or a range, are one token (Rule 8.6)
    const merged = [];
    for (let i = 0; i < toks.length; i++) {
        const t = toks[i];
        if (t.type === 'number') {
            while (toks[i + 2] && toks[i + 1].type === 'symbol' && /^[±\-–\/]$/.test(toks[i + 1].w) && toks[i + 2].type === 'number') { t.w += ' ' + toks[i + 1].w + ' ' + toks[i + 2].w; i += 2; }
            if (toks[i + 1] && L.units.has(toks[i + 1].w)) { t.w += ' ' + toks[i + 1].w; i += 1; }
        }
        merged.push(t);
    }
    // text in upper case is quoted text (Rule 8.6): a run of upper-case words is one word (GOVERNOR MODE), and one word in
    // upper case that is not an abbreviation is quoted text as well (AUTOROTATION, MOTORIZED, WARNING)
    const out = [];
    for (const t of merged) {
        const up = /^[A-Z][A-Z0-9_\-]+$/.test(t.w) && t.type !== 'id';
        const prev = out[out.length - 1];
        if (up && prev && prev.up) { prev.w += ' ' + t.w; prev.type = 'quoted'; continue; }
        if (up && ['word', 'hyphenated', 'other'].includes(t.type)) t.type = 'quoted';
        out.push(Object.assign(t, { up }));
    }
    return out;
}
const wordCount = (toks) => toks.filter((t) => t.type !== 'symbol').length;

// The sentences of a text: the outer text, then the text of each parenthesis (Rule 8.5)
function sentencesOf(text) {
    const { t } = protect(text);
    const { out, inner } = pullParens(t);
    return [...splitSentences(out).map((s) => ({ s, paren: false })), ...inner.flatMap((p) => splitSentences(p).map((s) => ({ s, paren: true })))];
}

// ---- checks ------------------------------------------------------------------------------------------------------------

const CONDITION = /^(?:if|when|before|after|while|until|unless|for|during|in|at|on|with|without|to|then|thus|also|next|first|as a result)\b[^,]*,\s*/i;
const SAFETY_MARK = /^\s*(?:WARNING|CAUTION)\b\s*:?\s*/, NOTE_MARK = /^\s*NOTE\b\s*:?\s*/;
// An instruction starts with a verb (Rule 5.3), after a condition and a comma (Rule 5.4)
function isInstruction(s, L) {
    const raw = (s.replace(CONDITION, '').split(/\s+/)[0] || '').replace(/[^A-Za-z]/g, '');
    return !/^[A-Z]{2,}$/.test(raw) && L.verbs.has(raw.toLowerCase()); // a word in upper case is quoted text (TUNE, a page code)
}
const EN = '(?:been|seen|taken|given|shown|known|driven|written|chosen|broken|hidden|proven|frozen|fallen|risen|spoken|done|made|found|held|kept|left|lost|read|sent|set|cut|put|run|told|built|got)';
const NOT_ED = /^(?:speed|need|feed|seed|bed|red|shed|embed|breed|bleed|proceed|exceed|succeed|indeed)$/i;
const PERFECT = new RegExp(`\\b(?:has|have|had)\\s+(?:not\\s+)?([a-z]+ed|${EN})\\b`, 'i');
// Rule 9.2: above and below are positions. For a value, write more than or less than
const LIMIT = /\b(?:above|below|over|under)\s+(?:[+\-−±~]?\d|zero\b|(?:the|its|a|an)\s+(?:[a-z\-]+\s+){0,3}?(?:limit|target|threshold|ceiling|floor|minimum|maximum|value|cutoff|rate|setpoint)s?\b)/i;
const PROGRESSIVE = /\b(?:is|are|was|were|be|been)\s+(?:not\s+)?([a-z]{3,}ing)\b/i;
// The gear-ratio rule (CLAUDE.md, SPEC2 section 6): the words that name the drive train, the words that doubt a value or ask
// the pilot to test it, the conditions that make "correct" a doubt ("accurate only with the correct gear ratio"), and the
// statement that the rule asks for ("The gear ratios in the configuration are correct.")
const GEAR_TERM = /\b(?:[Gg]ear[\s-]*ratios?|[Gg]ear\s+trains?|[Gg]earing|[Gg]ears?|[Pp]ulleys?|[Tt]ooth|[Tt]eeth|[Tt]ooth\s+(?:counts?|ratios?)|[Pp]inions?|(?:[Mm]ain|[Pp]rimary)\s+drive)\b/; // not GEAR (a check id)
const GEAR_DOUBT = /\b(?:incorrect|wrong|not\s+correct|errors?|mistakes?|examine|inspect|make\s+sure|measure|test|compare|verify|confirm|check(?!\s+[A-Z]{1,6}\d)|change|replace|mismatch\w*|do(?:es)?\s+not\s+agree|suspect\w*|possibl[ey])\b/i;
const GEAR_IF = /\bcorrect\s+(?:gear|pulley|tooth|teeth|pinion)|\b(?:only|if|unless|when|without)\b[^,;:]*\bgear[\s-]*ratios?\s+(?:is|are)\s+correct\b/i;
const PASSIVE_RE = new RegExp(`\\b(?:is|are|was|were|be|been)\\s+(?:not\\s+)?(?:[a-z]+ly\\s+)?([a-z]+ed|${EN})\\b(\\s+by\\b(?!\\s*[+\\-−±]?\\d))?`, 'gi');

// The words of a sentence that are part of a technical noun of more than one word: the longest match at each word,
// the last word can be plural (Rule 1.5)
function markTechnicalNouns(toks, L) {
    const parts = [];
    toks.forEach((t, i) => {
        if (t.type === 'word' || t.type === 'abbr') parts.push([i, t.lc]);
        else if (t.type === 'hyphenated') t.lc.split('-').forEach((p) => parts.push([i, p]));
        else parts.push([i, null]);
    });
    const used = new Set(), starts = new Set();
    for (let k = 0; k < parts.length; k++) {
        const cands = parts[k][1] && L.byFirst.get(parts[k][1]);
        if (!cands) continue;
        const hit = cands.find((phrase) => phrase.every((w, j) => {
            const p = parts[k + j] && parts[k + j][1];
            if (!p) return false;
            if (p === w) return true;
            const last = j === phrase.length - 1;
            return last && (singulars(p).includes(w) || L.tnPhrases.get(phrase.join(' ')).some((f) => f.split(' ').pop() === p));
        }));
        if (hit) { starts.add(parts[k][0]); for (let j = 0; j < hit.length; j++) used.add(parts[k + j][0]); k += hit.length - 1; }
    }
    used.starts = starts;
    return used;
}
// One word: null when it is STE, else [check, detail]
function wordStatus(w, L) {
    if (L.british.has(w)) return ['GB', `${w} -> ${L.british.get(w)}`];
    if (L.deny.has(w)) return ['DENY', `${w} -> ${L.deny.get(w)}`];
    if (L.approved.has(w) || L.tnWords.has(w) || L.tvForms.has(w)) return null;
    for (const s of singulars(w)) if ((L.approved.has(s) && L.approved.get(s).has('n')) || L.tnWords.has(s)) return null;
    for (const s of stems(w).slice(1)) if (L.deny.has(s)) return ['DENY', `${w} -> ${L.deny.get(s)}`];
    if (/^[a-z]{3,}ing$/.test(w) && !L.ingAllow.has(w)) return ['ING', w];
    if (/^[a-z]$/.test(w)) return null; // the article a, or a letter that names a thing (x)
    if (/^(?:null|undefined|nan|object)$/.test(w)) return ['VOCAB', `${w}: a value of the code in the text (a missing value, or an object as text)`];
    return ['VOCAB', w];
}
// The words of a token to look up: a word, or the parts of a hyphenated word that are not numbers or abbreviations
function lookupWords(t, L) {
    if (L.units.has(t.w)) return [];
    if (t.type === 'word') return [t.lc];
    if (t.type !== 'hyphenated' || L.tnWords.has(t.lc) || L.approved.has(t.lc)) return [];
    return t.w.split('-').filter((p) => !/^\d/.test(p) && !ABBR.test(p)).map((p) => p.toLowerCase());
}

// Lint one text of one kind:
//   label    a button, tab, heading, legend, chip, plot title or axis label: no CASE
//   message  a description or a note: each sentence starts with an upper-case letter, and the text ends with . ! ? or :
//   warning  as message, 20 words in each sentence (Section 7)
//   item     a list item: starts with an upper-case letter, no comma or semicolon at the end (Rule 4.3)
//   block    rendered text of an unknown role: a message if it has more than one sentence, else a label
// Returns [{ check, detail, sentence }]
function lintText(text, kind, L) {
    const hits = [], add = (check, detail, sentence) => hits.push({ check, detail: String(detail).slice(0, 120), sentence: String(sentence || '').slice(0, 200) });
    const src = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!/[A-Za-z]/.test(src)) return hits;
    const flat = protect(src).t.replace(/\S*(?:https?:\/\/|www\.)\S+/g, ' ').replace(new RegExp(`${Q0}\\d+${Q1}`, 'g'), ' Q ');
    if (!/[A-Za-z]/.test(flat.replace(/\bQ\b/g, ' '))) return hits; // only quoted text (Rule 8.6)
    let m;
    if (flat.includes(';')) add('SEMI', ';', src);
    if ((m = /\b\w+n't\b|\b(?:it|that|there|what|here|let|he|she|who)'s\b|\b\w+'(?:re|ve|ll|d|m)\b/i.exec(flat))) add('CONTR', m[0], src);
    if ((m = LATIN.exec(flat))) add('LATIN', m[0], src);
    if ((m = /\+-|>=|<=|!=|->|→|≈|[<>≤≥~]\s?[+\-−]?\d|(?:^|\s)=(?:\s|$)|\w=\w|\|[^|\s][^|]{0,24}\|/.exec(flat))) add('MATH', m[0], src);
    if ((m = LIMIT.exec(flat))) add('LIMIT', m[0], src);
    if ((m = /\bmake sure\b(?!\s+that\b)/i.exec(flat))) add('THAT', m[0], src);
    if ((m = PERFECT.exec(flat)) && !NOT_ED.test(m[1])) add('TENSE', m[0], src);
    if ((m = PROGRESSIVE.exec(flat)) && !L.ingAllow.has(m[1].toLowerCase()) && !L.tnWords.has(m[1].toLowerCase())) add('TENSE', m[0], src);
    for (const p of flat.matchAll(PASSIVE_RE)) {
        if (NOT_ED.test(p[1])) continue;
        add(p[2] ? 'TENSE' : 'PASSIVE', p[0], src); // with "by" and the agent: Rule 3.6 says to use the active voice
    }
    // the gear-ratio rule (CLAUDE.md): a sentence that names a gear ratio, a pulley or a tooth count, with its parentheses,
    // must not doubt it or tell the pilot to examine, measure, compare or change it
    for (const s of splitSentences(protect(src).t)) {
        const term = GEAR_TERM.exec(s);
        if (!term || /^\s*Do not (?:write|tell|show|give|recommend)\b/.test(s)) continue; // the rule itself: "Do not tell the pilot that ..."
        const doubt = GEAR_DOUBT.exec(s) || GEAR_IF.exec(s);
        if (doubt) add('GEAR', `"${term[0]}" with "${doubt[0]}": the gear ratios in the configuration are correct`, s);
    }

    // a text that starts with WARNING or CAUTION is a warning (Section 7), one that starts with NOTE is a note (Rule 5.5)
    if (SAFETY_MARK.test(src)) kind = 'warning'; else if (NOTE_MARK.test(src)) kind = 'note';
    const sentences = sentencesOf(src), outer = sentences.filter((x) => !x.paren);
    const prose = kind === 'message' || kind === 'warning' || kind === 'note' || (kind === 'block' && outer.length > 1);
    if (prose && outer.length > 6) add('PARA', `${outer.length} sentences in one paragraph, more than 6`, src);
    if (kind === 'warning') {
        const first = outer.length ? outer[0].s.replace(SAFETY_MARK, '') : '';
        if (outer.length < 2) add('SAFE', 'a warning or a caution has 2 sentences or more: the command or the condition, then the risk', src);
        if (first && !isInstruction(first, L) && !/^(?:If|When|Before|After|While|Until|Unless|During)\b/.test(first)) add('SAFE', 'the first sentence of a warning or a caution is a command or a condition', first);
    }
    sentences.forEach(({ s, paren }, i) => {
        const toks = tokensOf(s, L);
        if (!toks.length) return;
        const body = !paren && i === 0 ? s.replace(SAFETY_MARK, '').replace(NOTE_MARK, '') : s;
        const n = wordCount(toks), instruction = isInstruction(body, L), limit = instruction || kind === 'warning' ? 20 : 25;
        if (kind === 'note' && !paren && instruction) add('NOTEIMP', 'an instruction in a note: a note gives information only', s);
        // a label, or a row of labels (a legend, a status bar), is not a sentence: a sentence ends with . ! ? or :
        const sentence = !(kind === 'label' || kind === 'block') || /[.!?:]["”')\]]*$/.test(s);
        if (n > limit && sentence) add('LEN', `${n} words, more than ${limit} (${instruction ? 'instruction' : kind === 'warning' ? 'warning' : 'description'})`, s);
        if (!paren && (prose || (kind === 'item' && i === 0)) && toks[0].type === 'word' && /^[a-z]/.test(toks[0].w)) add('CASE', `starts in lower case: ${toks[0].w}`, s);
        const used = markTechnicalNouns(toks, L), seen = new Set();
        let run = [];
        toks.forEach((t, k) => {
            // a noun cluster (Rule 2.1): nouns, technical nouns (one item each), abbreviations and unknown words in a row;
            // an adjective does not count; any other word, a number or a comma ends the cluster
            const pos = t.type === 'word' ? L.approved.get(t.lc) : null, noun = used.has(k) ? used.starts.has(k)
                : t.type === 'abbr' || L.tnWords.has(t.lc) || ((t.type === 'word' || t.type === 'hyphenated') && (!pos || pos.has('n')));
            if (noun) run.push(t.w); else if (!(used.has(k) || (pos && pos.has('adj')))) run = [];
            if (run.length === 4) add('NOUN4', run.join(' '), s);
            if (t.punct) run = [];
            if (used.has(k)) return;
            for (const w of lookupWords(t, L)) {
                const st = wordStatus(w, L);
                if (st && !seen.has(st[0] + w)) { seen.add(st[0] + w); add(st[0], st[1], s); }
            }
            // an approved noun used as a verb (Check the tail), or an approved verb used as a noun (the use of), Rule 1.2
            const prev = k === 0 ? '^' : toks[k - 1].lc || toks[k - 1].w, next = toks[k + 1] && toks[k + 1].lc;
            if (t.type === 'word' && L.nounOnly.has(t.lc) && !L.tnWords.has(t.lc) && /^(?:\^|to|must|can|cannot|will|and|or|then|please)$/.test(prev)
                && /^(?:the|a|an|this|these|that|those|all|each|its|their|it|them)$/.test(next || '')) add('POS', `${t.w} as a verb`, s);
            if (t.type === 'word' && L.verbOnly.has(t.lc) && !L.tnWords.has(t.lc) && /^(?:the|a|an|this|its|their|each)$/.test(prev)) add('POS', `${t.w} as a noun`, s);
        });
    });
    if (prose && !/[.!?:]["”')\]]*$/.test(src)) add('CASE', 'no period at the end', src);
    if (kind === 'item' && /[,;]$/.test(src)) add('CASE', 'a list item ends with a comma or a semicolon', src);
    return hits;
}

// ---- rendered HTML to texts --------------------------------------------------------------------------------------------

const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'button', 'canvas', 'caption', 'dd', 'desc', 'details', 'dialog', 'div', 'dl', 'dt', 'fieldset',
    'figcaption', 'figure', 'footer', 'form', 'g', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'img', 'input', 'label', 'legend', 'li', 'main', 'nav', 'ol', 'optgroup',
    'option', 'p', 'section', 'select', 'summary', 'svg', 'table', 'tbody', 'td', 'text', 'tfoot', 'th', 'thead', 'title', 'tr', 'ul']);
const LABEL_TAGS = new Set(['button', 'caption', 'desc', 'dt', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'label', 'legend', 'optgroup', 'option', 'summary', 'text', 'th', 'title']);
const SKIP_TAGS = new Set(['code', 'kbd', 'pre', 'samp', 'script', 'style', 'textarea']);
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr']);
const ENTITY = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', times: '×', plusmn: '±', minus: '−', ndash: '–', mdash: '—', hellip: '…', rarr: '→', larr: '←',
    uarr: '↑', darr: '↓', middot: '·', deg: '°', micro: 'µ', permil: '‰', le: '≤', ge: '≥', asymp: '≈', bull: '•', thinsp: ' ', ensp: ' ', emsp: ' ' };
const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : +e.slice(1)) : ENTITY[e.toLowerCase()] || m);

// The texts of an HTML string: one for each block element, and the title, placeholder, aria-label and alt attributes.
// <code>, <pre> and [data-ste="quoted"] are left out (Rule 8.6: quoted text)
function htmlTexts(html) {
    const out = [], stack = [];
    let buf = '';
    const skipped = () => { for (let i = stack.length - 1; i >= 0; i--) { if (stack[i].unskip) return false; if (stack[i].skip) return true; } return false; };
    const kindNow = () => { for (let i = stack.length - 1; i >= 0; i--) if (BLOCK.has(stack[i].tag)) return LABEL_TAGS.has(stack[i].tag) ? 'label' : stack[i].tag === 'li' ? 'item' : 'block'; return 'block'; };
    const flush = () => { const t = buf.replace(/\s+/g, ' ').trim(); if (t) out.push({ text: t, kind: kindNow() }); buf = ''; };
    const re = /<!--[\s\S]*?-->|<\/?([A-Za-z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g;
    let m;
    while ((m = re.exec(String(html)))) {
        const tok = m[0];
        if (tok.startsWith('<!--')) continue;
        if (!m[1]) { if (!skipped()) buf += decode(tok); continue; }
        const tag = m[1].toLowerCase(), closing = tok[1] === '/', attrs = m[2] || '';
        if (buf && !/\s$/.test(buf)) buf += ' ';
        if (closing) {
            if (BLOCK.has(tag) && !skipped()) flush();
            const at = stack.map((x) => x.tag).lastIndexOf(tag);
            if (at >= 0) stack.splice(at);
            continue;
        }
        const quoted = /\bdata-ste\s*=\s*["']?quoted/i.test(attrs), selfClosing = /\/\s*$/.test(attrs) || VOID.has(tag);
        // the summary of a quoted disclosure is our label: "Toolkit text (not STE)"
        const unskip = tag === 'summary' && stack.length > 0 && stack[stack.length - 1].tag === 'details' && stack[stack.length - 1].quoted;
        if (BLOCK.has(tag) && !skipped()) flush();
        if (!(skipped() && !unskip) && !quoted) for (const a of attrs.matchAll(/\s(title|placeholder|aria-label|alt)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
            const v = decode(a[2] !== undefined ? a[2] : a[3]).trim();
            if (v) out.push({ text: v, kind: 'label' });
        }
        if (selfClosing) continue;
        stack.push({ tag, quoted, skip: quoted || SKIP_TAGS.has(tag), unskip });
    }
    if (!skipped()) flush();
    return out;
}

// ---- string literals of a script ---------------------------------------------------------------------------------------

// The string and template literals of a JavaScript source, with their position. An interpolation ${...} becomes the
// longest string inside it (the text of a ternary), else a quoted token for an error message, else the number 7
function literalsOf(src) {
    const out = [], n = src.length;
    let i = 0, prev = '', word = '';
    const quoteEnd = (j, q) => { for (j++; j < n && src[j] !== q; j++) if (src[j] === '\\') j++; return j; };
    const regexEnd = (j) => { let cls = false; for (j++; j < n; j++) { const c = src[j]; if (c === '\\') { j++; continue; } if (c === '[') cls = true; else if (c === ']') cls = false; else if (c === '/' && !cls) break; else if (c === '\n') break; } return j; };
    function template(j) { // j at the backtick; returns [end, text, inner literal texts]
        let text = '';
        for (j++; j < n && src[j] !== '`'; j++) {
            if (src[j] === '\\') { text += src[j + 1] === 'n' ? '\n' : src[j + 1]; j++; continue; }
            if (src[j] === '$' && src[j + 1] === '{') {
                let depth = 1, k = j + 2; const inner = [];
                while (k < n && depth) {
                    const c = src[k];
                    if (c === "'" || c === '"') { const e = quoteEnd(k, c); inner.push(src.slice(k + 1, e)); k = e + 1; continue; }
                    if (c === '`') { const [e, t] = template(k); inner.push(t); k = e + 1; continue; }
                    if (c === '{') depth++; else if (c === '}') depth--;
                    k++;
                }
                const expr = src.slice(j + 2, k - 1).trim(), words = inner.filter((s) => /[A-Za-z]{2,}/.test(s)).sort((a, b) => b.length - a.length);
                text += words.length ? words[0] : /message\(|\.stack|\.message|String\(e/.test(expr) ? '"error"' : /^[A-Za-z_$][\w$]*$/.test(expr) ? resolve(expr) : '7';
                j = k - 1; continue;
            }
            text += src[j];
        }
        return [j, text];
    }
    // a bare identifier: the longest text of the literals of its const, let or var initializer, else a number (nothing
    // after the end of a sentence)
    function resolve(id) {
        const m = new RegExp(`\\b(?:const|let|var)\\s+${id.replace(/\$/g, '\\$')}\\s*=\\s*([^;\\n]*)`).exec(src);
        const lits = m ? literalsOf(m[1]).map((l) => l.text).filter((t) => /[A-Za-z]{2,}/.test(t)).sort((a, b) => b.length - a.length) : [];
        return lits.length ? lits[0] : '\u0004';
    }
    while (i < n) {
        const c = src[i], d = src[i + 1];
        if (c === '/' && d === '/') { const e = src.indexOf('\n', i); i = e < 0 ? n : e; continue; }
        if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
        if (c === "'" || c === '"') { const e = quoteEnd(i, c); out.push({ at: i, end: e, text: src.slice(i + 1, e).replace(/\\(.)/g, '$1') }); i = e + 1; prev = 'a'; word = ''; continue; }
        if (c === '`') { const [e, t] = template(i); out.push({ at: i, end: e, text: t.replace(/([.!?:])\s*\u0004\s*$/, '$1').replace(/\u0004/g, '7') }); i = e + 1; prev = 'a'; word = ''; continue; }
        if (c === '/' && (/^[(,=:[!&|?{};+\-*%<>~^]?$/.test(prev) || /^(?:return|typeof|case|in|of|new|delete|void|throw|else|do)$/.test(word))) { i = regexEnd(i) + 1; prev = 'a'; word = ''; continue; }
        if (/[A-Za-z_$0-9]/.test(c)) word = /[A-Za-z_$0-9]/.test(prev) ? word + c : c;
        if (!/\s/.test(c)) prev = c;
        i++;
    }
    return out;
}
// The text of each call to one of `callees` (a regular expression for the text before the parenthesis): the literals of
// its arguments, joined (an expression between two literals becomes 7)
function callTexts(src, callee) {
    const lits = literalsOf(src), out = [];
    for (let k = 0; k < lits.length; k++) {
        const before = src.slice(Math.max(0, lits[k].at - 60), lits[k].at);
        if (!callee.test(before)) continue;
        let text = lits[k].text, j = k;
        while (lits[j + 1] && /^\s*\+[^;,]*?\+?\s*$/.test(src.slice(lits[j].end + 1, lits[j + 1].at)) && !/[;,)]/.test(src.slice(lits[j].end + 1, lits[j + 1].at).replace(/\([^()]*\)/g, ''))) {
            const gap = src.slice(lits[j].end + 1, lits[j + 1].at);
            text += /^\s*\+\s*$/.test(gap) ? lits[j + 1].text : ' 7 ' + lits[j + 1].text;
            j++;
        }
        out.push({ at: lits[k].at, text });
        k = j;
    }
    return out;
}
const lineOf = (src, at) => src.slice(0, at).split('\n').length;

// ---- texts of the toolkit outputs --------------------------------------------------------------------------------------

// add(text, kind, where): one text that the app shows
// The comment lines of a CLI script (advice script, exportScript, the CLI text of a recommendation): the pilot reads them.
// The commands are CLI text, and a comment line is a label or a sentence (kind block)
function scriptTexts(text, add, where) {
    for (const line of String(text == null ? '' : text).split('\n')) {
        const m = /^\s*#+\s?(.*)$/.exec(line);
        if (m && /[A-Za-z]{2}/.test(m[1])) add(m[1], 'block', where);
    }
}
function recommendationTexts(recs, add) {
    for (const r of Array.isArray(recs) ? recs : []) {
        if (!r || typeof r !== 'object') continue;
        const where = r.id || 'recommendation';
        add(r.title, 'label', `${where} title`);
        add(r.text, 'message', `${where} text`);
        add(r.rule, 'message', `${where} rule`);
        for (const c of [].concat(r.caveats || [])) add(c, 'note', `${where} caveat`);
        for (const b of [].concat(r.blockedBy || [])) add(typeof b === 'string' ? b : b && (b.text || b.why), 'message', `${where} blockedBy`);
        for (const c of [].concat(r.causes || [])) if (c) { add(c.name, 'label', `${where} cause`); for (const s of [].concat(c.first || [])) add(s, 'message', `${where} cause step`); }
        for (const q of [].concat(r.ab || [])) if (q) add(q.text, 'message', `${where} A/B`);   // round 3 M1: the A/B of the configurations
        if (r.slope && typeof r.slope === 'object') add(r.slope.text, 'message', `${where} slope`);
        // the evidence rows hold the finding's own summary (catalog.cjs, linted there) and text (the toolkit's, not STE): not read here
        scriptTexts([].concat(r.cli || []).join('\n'), add, `${where} CLI comment`);
    }
}
function adviceTexts(out, add) {
    if (!out || typeof out !== 'object') return;
    recommendationTexts(out.recommendations, add);
    for (const n of [].concat(out.notes || [])) add(typeof n === 'string' ? n : n && n.text, 'note', 'advice note');
    for (const c of [].concat(out.coverage || [])) if (c) { add(c.group, 'label', 'coverage group'); add(c.detail, 'message', `coverage ${c.group || ''}`); }
}
function evidenceTexts(ev, add) {
    if (!ev || typeof ev !== 'object') return;
    const where = `evidence ${ev.id || ''}`;
    add(ev.expected, 'message', `${where} expected`);
    add(ev.summary, 'message', `${where} summary`);
    for (const s of [].concat(ev.spans || [])) if (s) add(s.label, 'label', `${where} span`);
    for (const c of [].concat(ev.context || [])) if (c) add(c.label, 'label', `${where} context`);
    for (const r of [].concat((ev.plot && ev.plot.reference) || [])) if (r) add(r.label, 'label', `${where} plot`);
    if (ev.view) { add(ev.view.title, 'label', `${where} view`); add(ev.view.text, 'message', `${where} view`); }
}
// hierarchy.status: { nodes: { [id]: { reason, possible } } }, and the same for each PID profile (SPEC2 D12) wherever it
// is in the result (profiles: { [p]: status } or [status])
function statusTexts(st, add, depth = 0) {
    if (!st || typeof st !== 'object' || depth > 3) return;
    if (st.nodes && typeof st.nodes === 'object') for (const [id, n] of Object.entries(st.nodes)) if (n) {
        add(n.reason, 'message', `node ${id} reason`);
        for (const p of [].concat(n.possible || [])) if (p) add(p.name, 'label', `node ${id} possible`);
    }
    for (const k of ['profiles', 'byProfile', 'perProfile']) if (st[k] && typeof st[k] === 'object') for (const x of Object.values(st[k])) statusTexts(x, add, depth + 1);
}
function causesTexts(list, add) { for (const c of [].concat(list || [])) if (c) { add(c.name, 'label', `cause ${c.rule}`); for (const s of [].concat(c.first || [])) add(s, 'message', `cause ${c.rule} step`); } }
// our modules (SPEC2 3.4, section 6): the finding text is ours, so it must be STE. The text of the other session's modules is not
const OUR_MODULES = ['track', 'more', 'phase', 'rescue', 'limits', 'config', 'power'];
function findingTexts(F, add, module) {
    for (const f of [].concat(F || [])) {
        if (!f || typeof f !== 'object') continue;
        if (typeof f.summary === 'string') add(f.summary, 'message', `${f.id} summary`);
        if (OUR_MODULES.includes(f.module || module)) add(f.text, 'message', `${f.id} text (${f.module || module})`);
        if (f.evidence) evidenceTexts(f.evidence, add);
    }
}
// round 3 M1: datasets.cjs datasets() (labels, notes, summaries, titles, reasons) and the A/B comparisons of advice.cjs
function datasetTexts(ds, add) {
    if (!ds || typeof ds !== 'object') return;
    for (const d of [].concat(ds.datasets || [])) if (d) { add(d.label, 'label', `configuration ${d.id}`); add(d.summary, 'message', `configuration ${d.id} summary`); }
    for (const n of [].concat(ds.notes || [])) add(n, 'note', 'configurations note');
    for (const x of [].concat(ds.diff || [], ds.info || [])) if (x) add(x.title, 'label', `configurations ${x.name}`);
    comparisonTexts(ds.comparisons, add);
}
function comparisonTexts(list, add) { for (const c of [].concat(list || [])) if (c) { add(c.text, 'message', `A/B ${c.a} ${c.b}`); for (const x of [].concat(c.results || [])) if (x) add(x.text, 'message', `A/B ${c.a} ${c.b} ${x.check}`); } }
// round 3 M3: the issues of the Analysis overview (catalog.cjs issues)
function issueTexts(out, add) { for (const x of [].concat(out && out.issues || out || [])) if (x && typeof x === 'object') { add(x.title, 'label', `issue ${x.key}`); add(x.summary, 'message', `issue ${x.key}`); } }
// round 3 M2: the filter search (filter_tune.cjs texts, the filterTuned result of the worker)
function filterTexts(t, add) {
    if (!t || typeof t !== 'object') return;
    for (const k of ['summary', 'parity', 'recommendation', 'delay', 'validation']) add(t[k], 'message', `filter search ${k}`);
    for (const w of [].concat(t.why || [])) add(w, 'message', 'filter search reason');
    for (const r of [].concat(t.rows || [])) if (r) add(r.text, 'message', `filter search ${r.name}`);
}
function filterResultTexts(r, add) { if (!r || typeof r !== 'object') return; filterTexts(r.text, add); recommendationTexts(r.recommendations, add); for (const n of [].concat(r.notes || [])) add(n, 'note', 'filter search note'); }
// The values that are possibly not current (CLAUDE.md, 2026-10-06): the spans of result.epochs and result.freshness, the
// stale flag of each finding, limits period, recommendation, issue and gains decision, and the conflicts of result.cliStatus
// (a CLI dump that does not agree with the log)
function staleTexts(r, add) {
    const flag = (s, where) => { if (s && typeof s === 'object') { add(s.text, 'message', `${where} stale`); add(s.source, 'message', `${where} stale source`); } };
    for (const e of [].concat(r.epochs || [])) if (e && typeof e === 'object') for (const s of [].concat(e.spans || [])) if (s) add(s.text, 'message', `epoch of log ${e.log}`);
    if (r.freshness && typeof r.freshness === 'object') { add(r.freshness.caveat, 'message', 'freshness caveat'); for (const [k, v] of Object.entries(r.freshness.reasons || {})) add(v, 'message', `freshness ${k}`); }
    for (const f of [].concat(r.findings || [])) if (f && typeof f === 'object') { flag(f.stale, f.id); for (const e of [].concat(f.events || [])) if (e && typeof e === 'object') flag(e.stale, `${f.id} period`); }
    for (const x of [].concat(r.advice && r.advice.recommendations || [])) if (x && typeof x === 'object') flag(x.stale, x.id);
    for (const x of [].concat(r.issues && r.issues.issues || r.issues || [])) if (x && typeof x === 'object') flag(x.stale, `issue ${x.key}`);
    for (const d of [].concat(r.decisions || [])) if (d && typeof d === 'object') flag(d.stale, 'gains decision');
    if (r.cliStatus && typeof r.cliStatus === 'object') for (const c of [].concat(r.cliStatus.conflicts || [])) if (c && typeof c === 'object') add(c.text, 'message', `CLI dump conflict ${c.what}`);
}
function resultTexts(r, add) { // a TuningResult of js/tuning_worker.js
    if (!r || typeof r !== 'object') return;
    findingTexts(r.findings, add);
    staleTexts(r, add);
    datasetTexts(r.datasets, add);
    issueTexts(r.issues, add);
    adviceTexts(r.advice, add);
    if (r.advice && typeof r.advice.script === 'string') scriptTexts(r.advice.script, add, 'CLI script comment');
    statusTexts(r.hierarchy, add);
    for (const n of [].concat(r.notes || [])) add(typeof n === 'string' ? n : n && n.text, 'note', 'worker note');
    for (const fl of [].concat(r.flights || [])) if (fl && typeof fl === 'object') add(fl.label || fl.text, 'label', 'flight');
}
// The exports of our toolkit modules whose outputs are texts, and how to read them. add(text, kind, where, source): source
// is the group of the table (the module when it is not given)
const READERS = {
    'tools/autotune/catalog.cjs': { summary: (out, add, args) => add(out, 'message', `summary ${args[0] && args[0].id}`), issues: (out, add) => issueTexts(out, add) },
    'tools/autotune/datasets.cjs': { datasets: (out, add) => datasetTexts(out, add) },
    'tools/autotune/filter_tune.cjs': { texts: (out, add) => filterTexts(out, add) },
    'tools/autotune/hierarchy.cjs': { status: (out, add) => statusTexts(out, add), causesOf: (out, add) => causesTexts(out, add) },
    'tools/autotune/evidence.cjs': { forFinding: (out, add) => evidenceTexts(out, add), forDecision: (out, add) => evidenceTexts(out, add) },
    'tools/autotune/health_track.cjs': { judge: (out, add) => findingTexts(out, add, 'track') },
    'tools/autotune/health_more.cjs': { judge: (out, add) => findingTexts(out, add, 'more') },
    'tools/autotune/health_phase.cjs': { judge: (out, add) => findingTexts(out, add, 'phase') },
    'tools/autotune/health_rescue.cjs': { judge: (out, add) => findingTexts(out, add, 'rescue') },
    'tools/autotune/health_limits.cjs': { judge: (out, add) => findingTexts(out, add, 'limits') },
    'tools/autotune/health_config.cjs': { judge: (out, add) => findingTexts(out, add, 'config') },
    'tools/autotune/health_power.cjs': { judge: (out, add) => findingTexts(out, add, 'power') },
    'tools/autotune/advice.cjs': {
        advise: (out, add) => adviceTexts(out, add),
        comparisons: (out, add) => comparisonTexts(out, add),
        filterRecommendations: (out, add) => recommendationTexts(out, add),
        script: (out, add) => scriptTexts(out, (t, k, w) => add(t, k, w, SCRIPT_SOURCE), 'advice script'),
        exportScript: (out, add) => scriptTexts(out, (t, k, w) => add(t, k, w, SCRIPT_SOURCE), 'exportScript'),
    },
};
const SCRIPT_SOURCE = 'tools/autotune/advice.cjs (comment lines of the CLI scripts)';
const DATA_ARGS = { 'tools/autotune/advice.cjs': ['script', 'exportScript'] };

// ---- harvest: the tests of the other parts run again in a worker thread, and their texts are read ---------------------

// The app scripts: any js/<name>.js in a file name or a stack frame. Our DOM scripts (their text is ours, so it must be STE):
// the Tuning view, the log lens and every js/*_view.js (the Analysis verdict), with the globals that they declare. The
// upstream Flight analysis scripts are not ours (SPEC2 D7)
const APP_SCRIPTS = /\bjs\/([a-z][a-z0-9_]*)\.js\b/;
const UPSTREAM_SCRIPTS = new Set(['js/flight_analysis.js', 'js/flight_analysis_dialog.js']);
const DOM_SCRIPTS = new Set(['js/tuning_dialog.js', 'js/log_lens.js', ...(() => { try { return fs.readdirSync(path.join(ROOT, 'js')).filter((f) => /^[a-z][a-z0-9_]*_view\.js$/.test(f)).map((f) => `js/${f}`); } catch (e) { return []; } })()]
    .filter((f) => fs.existsSync(path.join(ROOT, f)) && !UPSTREAM_SCRIPTS.has(f)));
const GLOBALS_OF = new Map([...DOM_SCRIPTS].map((f) => [f, [...fs.readFileSync(path.join(ROOT, f), 'utf8').matchAll(/^(?:var|let|const)\s+([A-Z][A-Za-z0-9_$]*)\s*=/gm)].map((m) => m[1])]));
const scriptName = (opts, code) => {
    const f = typeof opts === 'string' ? opts : opts && opts.filename;
    const m = APP_SCRIPTS.exec(String(f || ''));
    if (m) return `js/${m[1]}.js`;
    for (const [file, globals] of GLOBALS_OF) if (globals.some((g) => new RegExp(`^(?:var|let|const)\\s+${g.replace(/\$/g, '\\$')}\\s*=`, 'm').test(String(code)))) return file;
    return /\bvar TuningWorker\b|\bself\.onmessage\b/.test(String(code)) ? 'js/tuning_worker.js' : null;
};
// The app script that made a call: the innermost frame of an app script in the stack, else the owner of the context
function callerScript(owner) {
    const stack = String(new Error().stack).split('\n').slice(2);
    for (const line of stack) { const m = APP_SCRIPTS.exec(line); if (m) return `js/${m[1]}.js`; }
    return owner;
}

// Our toolkit modules are wrapped when they load (lazily: a test sets AUTOTUNE_FLIGHT_RPM before lib.cjs loads)
function wrapExports(rel, mod, add) {
    const read = READERS[rel];
    for (const [name, fn] of Object.entries(mod || {})) {
        if (typeof fn !== 'function' || !read[name] || fn.steWrapped) continue;
        const wrapped = function (...args) {
            const out = fn.apply(this, args);
            try {
                // the strings of the arguments of a CLI script (the titles of the recommendations, the craft name, the file
                // name) are data: they are linted where they are made
                let data;
                if ((DATA_ARGS[rel] || []).includes(name)) { const D = dataSet(); D.collect(args); data = D.data; }
                read[name](out, (t, k, w, src) => add(src || rel, t, k, w, data), args);
            } catch (e) { /* a reader never breaks the test it reads */ }
            return out;
        };
        Object.assign(wrapped, fn, { steWrapped: true });
        try { mod[name] = wrapped; } catch (e) { /* frozen exports */ }
    }
}
function installSpies(add) {
    Error.stackTraceLimit = 40;
    const vm = require('node:vm'), run = vm.runInContext, runNew = vm.runInNewContext, Script = vm.Script;
    const owners = new WeakMap();
    const before = (ctx, name) => { if (ctx && name && DOM_SCRIPTS.has(name) && !owners.has(ctx)) { owners.set(ctx, name); instrument(ctx, name, add); } };
    const after = (ctx, name) => { if (ctx) afterScript(ctx, name || owners.get(ctx), add); };
    vm.runInContext = function (code, ctx, opts) { const name = scriptName(opts, code); before(ctx, name); const r = run.apply(this, arguments); after(ctx, name); return r; };
    vm.runInNewContext = function (code, ctx, opts) { const name = scriptName(opts, code); if (ctx && typeof ctx === 'object') before(ctx, name); const r = runNew.apply(this, arguments); if (ctx && typeof ctx === 'object') after(ctx, name); return r; };
    vm.Script = class extends Script {
        constructor(code, opts) { super(code, opts); this.steName = scriptName(opts, String(code)); }
        runInContext(ctx, o) { before(ctx, this.steName); const r = super.runInContext(ctx, o); after(ctx, this.steName); return r; }
    };
}
// Read what the app scripts write: $ (the jQuery stand-in), document (the DOM stand-in), TuningPlot specs
const TEXT_METHODS = { html: 'html', append: 'html', prepend: 'html', after: 'html', before: 'html', replaceWith: 'html', text: 'text' };
const TEXT_PROPS = { innerHTML: 'html', outerHTML: 'html', textContent: 'text', innerText: 'text', title: 'text', placeholder: 'text', label: 'text', alt: 'text' };
const DOM_RESULTS = /^(?:getElementById|querySelector|createElement|closest|cloneNode|appendChild|insertBefore|item)$/;
// The data that the harness gives the app (a TuningResult, notes, titles): its strings are read as data, not as the
// text of the app, and they are linted where the toolkit makes them
function dataSet() {
    const data = new Set(), seen = new WeakSet();
    const collect = (v, d = 0) => {
        if (typeof v === 'string') { if (v.length >= 8 && v.includes(' ') && /[A-Za-z]{2}/.test(v)) data.add(v); return; }
        if (!v || typeof v !== 'object' || d > 12 || ArrayBuffer.isView(v) || seen.has(v)) return;
        seen.add(v);
        try { for (const x of Array.isArray(v) ? v : Object.values(v)) collect(x, d + 1); } catch (e) { /* a getter that throws */ }
    };
    return { data, collect };
}
function instrument(ctx, owner, add) {
    const D = dataSet();
    const sink = (kind, value) => { const who = callerScript(owner); if (who && DOM_SCRIPTS.has(who)) add(who, value, kind === 'html' ? 'html' : 'block', kind, D.data); };
    const cache = new WeakMap();
    const wrapJq = (o) => {
        if (!o || typeof o !== 'object' || o.then) return o;
        if (cache.has(o)) return cache.get(o);
        const p = new Proxy(o, {
            get(t, k) {
                const v = Reflect.get(t, k);
                if (typeof k === 'string' && /^\d+$/.test(k)) return wrapDom(v);
                if (typeof v !== 'function') return v;
                return function (...args) {
                    if (TEXT_METHODS[k] && typeof args[0] === 'string') sink(TEXT_METHODS[k], args[0]);
                    if ((k === 'attr' || k === 'prop') && /^(?:title|placeholder|aria-label|alt)$/.test(args[0]) && typeof args[1] === 'string') sink('text', args[1]);
                    const r = v.apply(this === p ? t : this, args);
                    return r === t ? p : wrapJq(r);
                };
            },
        });
        cache.set(o, p);
        return p;
    };
    const wrapDom = (o) => {
        if (!o || typeof o !== 'object') return o;
        if (cache.has(o)) return cache.get(o);
        const p = new Proxy(o, {
            set(t, k, v) { if (typeof v === 'string' && TEXT_PROPS[k]) sink(TEXT_PROPS[k], v); return Reflect.set(t, k, v); },
            get(t, k) {
                const v = Reflect.get(t, k);
                if (typeof v === 'function') return function (...args) {
                    if (k === 'setAttribute' && /^(?:title|placeholder|aria-label|alt)$/.test(args[0]) && typeof args[1] === 'string') sink('text', args[1]);
                    if (k === 'insertAdjacentHTML' && typeof args[1] === 'string') sink('html', args[1]);
                    const r = v.apply(this === p ? t : this, args);
                    return DOM_RESULTS.test(k) ? wrapDom(r) : r;
                };
                return /^(?:parentNode|parentElement|firstChild|lastChild|firstElementChild|lastElementChild|nextSibling|previousSibling|body|documentElement)$/.test(k) ? wrapDom(v) : v;
            },
        });
        cache.set(o, p);
        return p;
    };
    if (typeof ctx.$ === 'function') {
        const $ = ctx.$;
        ctx.$ = new Proxy($, { apply(t, self, args) { if (typeof args[0] === 'string' && /^\s*</.test(args[0])) sink('html', args[0]); return wrapJq(Reflect.apply(t, self, args)); } });
        ctx.jQuery = ctx.jQuery === $ ? ctx.$ : ctx.jQuery;
    }
    if (ctx.document && typeof ctx.document === 'object') ctx.document = wrapDom(ctx.document);
    if (typeof ctx.Worker === 'function') { // the worker stand-in: what its messages bring to the app is data
        const W = ctx.Worker;
        ctx.Worker = new Proxy(W, { construct(t, args, nt) {
            const w = Reflect.construct(t, args, nt), wrapFn = (fn) => function (e) { D.collect(e && e.data); return fn.apply(this, arguments); };
            return new Proxy(w, { set(o, k, v) { return Reflect.set(o, k, k === 'onmessage' && typeof v === 'function' ? wrapFn(v) : v); },
                get(o, k) { const v = Reflect.get(o, k); return k === 'addEventListener' ? (type, fn, ...r) => v.call(o, type, typeof fn === 'function' ? wrapFn(fn) : fn, ...r) : typeof v === 'function' ? v.bind(o) : v; } });
        } });
    }
    instrumented.set(ctx, { wrapJq, wrapDom, D });
}
const instrumented = new WeakMap();
function specTexts(spec, add, who) {
    if (!spec || typeof spec !== 'object') return;
    const where = `plot ${String(spec.title || '').slice(0, 40)}`;
    add(`plots of ${who}`, spec.title, 'label', where);
    add(`plots of ${who}`, spec.na, 'message', where);
    for (const a of ['x', 'y', 'y2']) if (spec[a]) add(`plots of ${who}`, spec[a].label, 'label', where);
    for (const k of ['series', 'bands', 'vlines', 'hlines', 'markers']) for (const e of [].concat(spec[k] || [])) if (e) { add(`plots of ${who}`, e.name, 'label', where); add(`plots of ${who}`, e.label, 'label', where); }
}
function afterScript(ctx, name, add) {
    const tools = instrumented.get(ctx);
    const plot = ctx.TuningPlot;
    if (plot && typeof plot.attach === 'function' && !plot.attach.steWrapped) {
        const attach = plot.attach;
        const wrapped = function (canvas, spec) {
            const who = callerScript(name), D = tools && tools.D && tools.D.data, put = (src, t, k, w) => add(src, t, k, w, D);
            if (DOM_SCRIPTS.has(who)) specTexts(spec, put, who);
            const h = attach.apply(this, arguments);
            if (h && typeof h.update === 'function' && DOM_SCRIPTS.has(who)) { const up = h.update; h.update = function (s) { specTexts(s, put, who); return up.apply(this, arguments); }; }
            return h;
        };
        wrapped.steWrapped = true;
        try { plot.attach = wrapped; } catch (e) { /* frozen */ }
    }
    if (tools) for (const G of [...new Set([].concat(...GLOBALS_OF.values()))]) { // the container the harness passes in is read as well
        const C = ctx[G];
        if (typeof C !== 'function' || C.steWrapped) continue;
        const P = new Proxy(C, { construct(t, args, nt) {
            if (args[0] && typeof args[0].find === 'function') args[0] = tools.wrapJq(args[0]); else if (args[0] && typeof args[0] === 'object') args[0] = tools.wrapDom(args[0]);
            const hooks = args[1]; // what the hooks return (a result, a file name) is data
            if (hooks && typeof hooks === 'object') args[1] = new Proxy(hooks, { get(o, k) { const v = Reflect.get(o, k); return typeof v === 'function' ? function () { const r = v.apply(o, arguments); tools.D.collect(r); return r; } : v; } });
            const inst = Reflect.construct(t, args, nt);
            for (const k of ['show', 'setResult', 'render']) if (inst && typeof inst[k] === 'function') { const f = inst[k]; inst[k] = function () { for (const a of arguments) tools.D.collect(a); return f.apply(this, arguments); }; }
            return inst;
        }, get(t, k) { return k === 'steWrapped' ? true : Reflect.get(t, k); } });
        ctx[G] = P;
    }
    if (name === 'js/tuning_worker.js' && typeof ctx.postMessage === 'function' && !ctx.postMessage.steWrapped) {
        const post = ctx.postMessage;
        // the results of the real logs only (AUTOTUNE_REAL_LOG, and AUTOTUNE_RESCUE_LOG when it is set too: the Fireball dump has
        // rescues, PID profile changes at a rescue and 6 flight logs that the Gaui X4 dump does not have): the other results of the
        // worker tests come from simulated logs, some with stand-in modules that the tests inject, and our modules give their texts
        // in their own harvests
        const reals = [process.env.AUTOTUNE_REAL_LOG, process.env.AUTOTUNE_RESCUE_LOG].filter(Boolean).map((f) => path.basename(f));
        const isReal = (r) => !reals.length || reals.includes(r.fileName);
        const wrapped = function (m) {
            try { if (m && m.type === 'result' && m.result && isReal(m.result)) resultTexts(m.result, (t, k, w) => add('TuningResult', t, k, w));
                if (m && m.type === 'filterTuned' && m.result && isReal(m.result)) filterResultTexts(m.result, (t, k, w) => add('TuningResult', t, k, w)); } catch (e) { /* reader */ }
            return post.apply(this, arguments);
        };
        wrapped.steWrapped = true;
        ctx.postMessage = wrapped;
    }
}

// node:test as the harvested file sees it: test() registers, the harvest runs the bodies
function testStub(registered, hooks) {
    const reg = (extra) => (name, o, fn) => { if (typeof o === 'function') { fn = o; o = {}; } if (typeof name === 'function') { fn = name; name = fn.name || 'test'; } registered.push({ name: String(name), opts: Object.assign({}, o, extra), fn }); };
    const test = reg({});
    const suite = (name, o, fn) => { if (typeof o === 'function') fn = o; if (typeof name === 'function') fn = name; if (fn && !(o && o.skip)) fn({}); };
    const hook = (list) => (fn) => list.push(fn);
    let realMock = null;
    Object.assign(test, { test, it: test, skip: reg({ skip: true }), todo: reg({ todo: true }), only: test, describe: suite, suite, before: hook(hooks.before), after: hook(hooks.after),
        beforeEach: hook(hooks.beforeEach), afterEach: hook(hooks.afterEach) });
    Object.defineProperty(test, 'mock', { get() { return realMock || (realMock = hooks.load('node:test').mock); } });
    suite.skip = () => {}; suite.only = suite;
    return test;
}
async function runBody(t, stats, errors, hooks) {
    if (!t.fn || t.opts.skip || t.opts.todo) { stats.skipped++; return; }
    const nested = [];
    const ctx = { name: t.name, skip() {}, todo() {}, diagnostic() {}, plan() {}, after(fn) { hooks.afterOne.push(fn); }, before() {}, beforeEach() {}, afterEach() {}, signal: new AbortController().signal,
        get mock() { return hooks.load('node:test').mock; }, assert: require('node:assert'), test: (name, o, fn) => { if (typeof o === 'function') { fn = o; o = {}; } const p = runBody({ name: `${t.name} > ${name}`, opts: o || {}, fn }, stats, errors, hooks); nested.push(p); return p; } };
    try {
        for (const h of hooks.beforeEach) await h();
        if (t.fn.length >= 2) await new Promise((res, rej) => t.fn(ctx, (err) => (err ? rej(err) : res()))); else await t.fn(ctx);
        await Promise.all(nested);
        stats.passed++;
    } catch (e) { stats.failed++; errors.push(`${t.name}: ${String(e && e.message || e).split('\n')[0].slice(0, 200)}`); }
    for (const h of hooks.afterEach.concat(hooks.afterOne.splice(0))) { try { await h(); } catch (e) { /* cleanup */ } }
}
// The strings of the data, as they come in a rendered text: as is, and escaped for HTML
const escapes = (s) => { const a = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); return [...new Set([a.replace(/"/g, '&quot;').replace(/'/g, '&#39;'), a.replace(/"/g, '&quot;').replace(/'/g, '&#x27;'), a, s, s.replace(/\s+/g, ' ').trim()])]; }; // also with the white space made one space (a title in a comment line)
// An item without the data in it: each string of the data becomes X (one word, Rule 8.6), and is kept for the data source
function withoutData(item, found) {
    if (!item.data || !item.data.size) return item;
    let t = item.text;
    for (const d of [...item.data].sort((a, b) => b.length - a.length)) for (const f of escapes(d)) if (t.includes(f)) { t = t.split(f).join(' X '); found.add(d); }
    return Object.assign({}, item, { text: t, data: undefined });
}
async function harvestFile(file) {
    const items = new Map(), add = (source, text, kind, where, data) => {
        if (typeof text !== 'string' || !/[A-Za-z]/.test(text)) return;
        const k = `${source}\u0000${kind}\u0000${text}`;
        if (!items.has(k)) items.set(k, { source, text, kind, where: where || '', via: file, data });
    };
    installSpies(add);
    const Module = require('node:module'), load = Module._load.bind(Module);
    const registered = [], hooks = { before: [], after: [], beforeEach: [], afterEach: [], afterOne: [], load }, stub = testStub(registered, hooks);
    Module._load = function (request, parent) {
        if (request === 'node:test' || request === 'test') return stub;
        const mod = load.apply(null, arguments);
        if (/autotune/.test(request)) {
            let rel = null;
            try { rel = path.relative(ROOT, Module._resolveFilename(request, parent)).split(path.sep).join('/'); } catch (e) { /* not a file */ }
            if (rel && READERS[rel]) wrapExports(rel, mod, add);
        }
        return mod;
    };
    const stats = { passed: 0, failed: 0, skipped: 0 }, errors = [];
    try { require(path.join(ROOT, file)); } catch (e) { errors.push(`load: ${String(e && e.message || e).split('\n')[0]}`); }
    for (const h of hooks.before) { try { await h(); } catch (e) { errors.push(`before: ${e.message}`); } }
    for (const t of registered) await runBody(t, stats, errors, hooks);
    for (const h of hooks.after) { try { await h(); } catch (e) { /* cleanup */ } }
    const out = [], found = new Map();
    for (const it of items.values()) {
        if (!it.data) { out.push(it); continue; }
        const f = found.get(it.source) || new Set(); found.set(it.source, f);
        out.push(withoutData(it, f));
    }
    for (const [source, f] of found) for (const d of f) out.push({ source: `data given to ${source.replace(/^plots of /, '')}`, text: d, kind: 'message', where: 'test data', via: file });
    return { items: out, stats, errors };
}
// Run one harvest in a worker thread: { items, stats, errors }
function harvest(file, { timeoutS = 300, heapMb = 4096 } = {}) {
    return new Promise((resolve) => {
        const w = new WT.Worker(__filename, { workerData: { steHarvest: file }, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: heapMb }, stdout: true, stderr: true });
        const timer = setTimeout(() => { w.terminate(); resolve({ items: [], stats: null, errors: [`timeout after ${timeoutS} s`] }); }, timeoutS * 1000);
        w.stdout.resume(); w.stderr.resume();
        w.once('message', (m) => { clearTimeout(timer); resolve(m); w.terminate(); });
        w.once('error', (e) => { clearTimeout(timer); resolve({ items: [], stats: null, errors: [`thread: ${e && e.message}`] }); });
        w.once('exit', () => { clearTimeout(timer); resolve({ items: [], stats: null, errors: ['the thread stopped with no result'] }); });
    });
}

// ---- texts read directly -----------------------------------------------------------------------------------------------

const CHECK_IDS = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'H', 'SETUP', ...[...Array(11)].map((_, i) => `F${i + 1}`), ...[...Array(15)].map((_, i) => `G${i}`),
    ...[...Array(14)].map((_, i) => `C${i + 1}`), ...[...Array(14)].map((_, i) => `T${i + 1}`), 'R1',
    'D7', 'G15', 'G16', 'G17', 'G18', 'C15',  // the phase checks of health_phase.cjs (SPEC2 section 6)
    'G19', 'T15', 'D8', 'G20', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7',  // health_rescue.cjs and health_limits.cjs
    'D9', 'P1', 'P2']; // health_config.cjs and health_power.cjs (SPEC3 A, I)
const moduleOf = (id) => /^(G19|T15|D8|G20)$/.test(id) ? 'rescue' : id === 'D9' ? 'config' : /^P[12]$/.test(id) ? 'power' : /^L\d$/.test(id) ? 'limits' : /^(D7|G1[5-8]|C15)$/.test(id) ? 'phase' : /^(D[1-4]|F[1-9]|H|SETUP)$/.test(id) ? 'setup' : /^(D5|G\d|G1[0-3])$/.test(id) ? 'gov'
    : /^(C5|C1[23]|T1|T1[12]|R1)$/.test(id) ? 'track' : /^(D6|F1[01]|T1[34]|C14|G14)$/.test(id) ? 'more' : id === 'C7' ? 'report' : /^(T3|T10|F7)$/.test(id) ? 'wag' : 'loop';
const tryRequire = (rel) => { const abs = path.join(ROOT, rel); if (!fs.existsSync(abs)) return { missing: rel }; try { return { mod: require(abs) }; } catch (e) { return { error: `${rel}: ${e.message}` } } };
const call = (fn, ...args) => { try { return typeof fn === 'function' ? fn(...args) : undefined; } catch (e) { return { steError: e }; } };
// The phase of a synthetic finding (SPEC2 D13): the phase checks in their phase, the governor checks in all phases, the
// header checks in none, the attitude-loop and filter checks in flight
const PHASE_OF = { G15: 'spoolup', G16: 'spoolup', G17: 'idle', G18: 'idle', C15: 'ground', D7: null };
const phaseOf = (id) => id in PHASE_OF ? PHASE_OF[id] : /^(G|D5)/.test(id) ? 'all' : /^(D[1-46]|H|SETUP|F[1-489])$/.test(id) ? null : 'flight';

function syntheticFindings(id, unit) {
    const header = /^(D1|D3|D4|F[1-489]|H|SETUP)$/.test(id), axes = /^T/.test(id) ? ['yaw'] : /^C/.test(id) ? ['roll', 'pitch'] : /^(F|R)/.test(id) ? ['roll', 'yaw'] : [null];
    const out = [];
    for (const axis of axes) {
        const base = { id, module: moduleOf(id), log: 0, profile: header ? null : 1, axis, n: 12, unit: unit === undefined ? null : unit, source: 'pipeline, unvalidated',
            text: 'toolkit text', times: [83.7], value: 0.348, se: 0.042, threshold: 0.45, phase: phaseOf(id) };
        const v = (o, k) => Object.assign({}, base, { fid: `synthetic|${id}|0|${base.profile}|${axis}|${k}` }, o);
        out.push(v({ severity: 'flag', value: 0.52 }, 1), v({ severity: 'flag', value: 0.52, threshold: '>= 3 events, |gain change| - 2 SE > max(15, 0.15 x header gain) = 15' }, 2),
            v({ severity: 'flag', value: 0.52, threshold: { note: 0.3, flag: 0.45, source: 'pipeline' } }, 3), v({ severity: 'note' }, 4),
            v({ severity: 'note', thin: true, value: null, se: null, n: 1, text: 'no finding: 1 blocks' }, 5), v({ severity: 'ok', value: 0.12, se: 0.03, times: [] }, 6),
            v({ severity: 'skipped', value: null, se: null, times: [], text: 'not run: gyroRAW[0] absent' }, 7), v({ severity: 'error', value: null, se: null, times: [], text: 'TypeError: x is not defined' }, 8),
            v({ severity: 'flag', value: '100,80', se: null, log: [0, 1], profile: 'start profile 1', threshold: null }, 9), v({ severity: 'note', value: 12, se: null, profile: 0, times: [] }, 10),
            // the PID profile before the first switch (SPEC2 D12: 'arm', 0 or inferred) and a bench run (D13)
            v({ severity: 'flag', value: 0.52, profile: 'arm' }, 11), v({ severity: 'note', value: 0.52, profile: 2, profileInferred: true }, 12),
            v({ severity: 'skipped', value: null, se: null, times: [], bench: true, phase: null, text: 'bench run' }, 13));
    }
    return out;
}
function catalogSource() {
    const r = tryRequire('tools/autotune/catalog.cjs');
    if (!r.mod) return r;
    const C = r.mod, items = [], add = (text, kind, where) => { if (typeof text === 'string') items.push({ text, kind, where }); };
    const errors = [];
    const ids = [...new Set([...CHECK_IDS, 'C7', ...Object.keys(C.CHECKS || {})])];
    for (const id of ids) {
        const spec = (C.CHECKS || {})[id];
        if (!spec) errors.push(`CHECKS has no ${id}`);
        else add(spec.noun, 'label', `${id} noun`);
        for (const f of syntheticFindings(id, call(C.unitOf, id))) {
            const s = call(C.summary, f);
            if (s && s.steError) { errors.push(`summary(${id} ${f.severity}): ${s.steError.message}`); continue; }
            add(s, 'message', `${id} ${f.severity}${f.thin ? ' thin' : ''}`);
            const e = spec && spec.evidence && spec.evidence.expected;
            if (typeof e === 'function') { const x = call(e, f, call(C.format, f) || {}); if (typeof x === 'string') add(x, 'message', `${id} expected`); }
        }
    }
    // real findings of the toolkit, when this checkout has the analysis outputs
    for (const rel of ['analysis/gaui-x4/health/results.json', 'analysis/fireball-0928/results.json']) {
        const abs = path.join(ROOT, rel);
        if (!fs.existsSync(abs)) continue;
        const seen = new Set();
        for (const f of JSON.parse(fs.readFileSync(abs, 'utf8')).findings || []) {
            const s = call(C.summary, f);
            if (typeof s !== 'string') continue;
            const k = s.replace(/[-+]?\d[\d.,]*/g, 'N');
            if (!seen.has(k)) { seen.add(k); add(s, 'message', `${f.id} ${f.severity} (${rel})`); }
        }
    }
    return { items, errors };
}
// Scenarios that give every status of hierarchy.status: problems with gates and causes, a log rate less than 1 kHz,
// steps that are not applicable, and checks that are satisfactory, thin, not measured or without advice
function hierarchyScenarios() {
    const F = (o) => Object.assign({ module: moduleOf(o.id), severity: 'flag', log: 0, profile: 1, axis: null, value: 1, se: 0.1, n: 10, threshold: 0.5, text: 'toolkit text', times: [10] }, o,
        { fid: `scenario|${o.id}|${o.log === undefined ? 0 : o.log}|${o.axis || ''}|${o.severity || 'flag'}` });
    const rec = (f, severity) => ({ id: `${f.id}${f.axis ? ':' + f.axis : ''}`, severity, axis: f.axis, profile: f.profile, area: 'x', title: 'x', text: 'x', cli: [],
        evidence: [{ fid: f.fid, id: f.id, module: f.module, log: f.log, profile: f.profile, axis: f.axis, text: f.text }] });
    const flags = [F({ id: 'F5', axis: 'roll' }), F({ id: 'G1' }), F({ id: 'T8', axis: 'yaw' }), F({ id: 'C12', axis: 'roll' }), F({ id: 'T1', axis: 'yaw' }), F({ id: 'C11', axis: 'roll' }),
        F({ id: 'G6' }), F({ id: 'G3' }), F({ id: 'T14', axis: 'yaw' }), F({ id: 'C5', axis: 'pitch' }), F({ id: 'R1', axis: 'roll' }), F({ id: 'D2' }), F({ id: 'C13', axis: 'pitch' })];
    const others = [F({ id: 'G2', severity: 'ok' }), F({ id: 'F11', severity: 'note', thin: true, value: null }), F({ id: 'C14', severity: 'skipped', value: null }),
        F({ id: 'T6', severity: 'note' }), F({ id: 'C9', severity: 'error', value: null }), F({ id: 'D6', severity: 'note' })];
    const lowRate = [F({ id: 'D1', log: 3 }), F({ id: 'F6', log: 3 }), F({ id: 'C11', log: 3, axis: 'pitch' }), F({ id: 'G9', log: 3 })];
    const coverage = [{ checks: ['G2'], status: 'not-in-log' }, { checks: ['F11'], status: 'needs-fields' }, { checks: ['C14'], status: 'needs-flights' }, { checks: ['T6'], status: 'no-check' },
        { checks: ['R1'], status: 'not-assessable' }];
    const all = flags.concat(others);
    return [
        [all, flags.map((f, i) => rec(f, i % 3 === 2 ? 'watch' : i % 2 ? 'check' : 'action')), { logs: [{ log: 0 }], coverage }],
        [all, null, {}],
        [others.concat(lowRate), lowRate.map((f) => rec(f, 'check')), { coverage }],
        [[F({ id: 'G0', severity: 'note', value: 0 }), F({ id: 'G2', severity: 'note' })], [], { cli: { global: { tail_rotor_mode: 'VARIABLE' }, profiles: { 0: { rescue_mode: 'OFF' } } } }],
        [[], [], {}],
    ];
}
function hierarchySource() {
    const r = tryRequire('tools/autotune/hierarchy.cjs');
    if (!r.mod) return r;
    const H = r.mod, items = [], errors = [], add = (text, kind, where) => { if (typeof text === 'string') items.push({ text, kind, where }); };
    for (const n of H.NODES || []) {
        add(n.title, 'label', `node ${n.id} title`);
        add(n.optional, 'message', `node ${n.id} optional`);
        add(n.note, 'message', `node ${n.id} note`);
        for (const c of n.chips || []) add(c && c.label, 'label', `node ${n.id} chip`);
        for (const s of n.substeps || []) add(s, 'label', `node ${n.id} chip`);
    }
    for (const e of H.EDGES || []) add(e.why, 'message', `edge ${e.from} to ${e.to}`);
    for (const k of H.RULES || []) { add(k.name, 'label', `${k.id} name`); for (const s of [].concat(k.first || [])) add(s, 'message', `${k.id} step`); }
    const out = (t, k, w) => add(t, k, w);
    for (const [F, R, o] of hierarchyScenarios()) {
        const st = call(H.status, F, R, o);
        if (st && st.steError) errors.push(`status: ${st.steError.message}`); else statusTexts(st, out);
        for (const f of F) { const c = call(H.causesOf, f, F); if (Array.isArray(c)) causesTexts(c, out); }
    }
    return { items, errors };
}
const NOTE_CALL = /(?:\bnotes\s*\.\s*(?:add|push|unshift)|\bnote)\s*\(\s*$|\bnotes\s*:\s*\[\s*$/, PROGRESS_CALL = /\bprogress\s*\(\s*$/;
// The literals of a script that are sentences or labels for the user: they start with an upper-case word, they have 4 words
// or more, and they are not markup or code. A sentence ends with . ! ? or : (kind message), else the text is a label or a
// part of a sentence (kind block)
function sentenceLiterals(src) {
    const out = [];
    for (const l of literalsOf(src)) {
        const t = l.text.replace(/\s+/g, ' ').trim();
        if (!/^[A-Z][a-z]|^[A-Z] [a-z]/.test(t) || t.split(' ').length < 4 || /<\/?[a-z][^>]*>|=>|\$\{|^[A-Z][a-z]+\s*\(|\b(?:function|return|var|const|let)\b/.test(t)) continue;
        out.push({ at: l.at, text: t, kind: /[.!?:]["”')\]]*$/.test(t) ? 'message' : 'block' });
    }
    return out;
}
// The worker writes notes, progress texts, error results and the window observations of the derive command (log lens)
function workerSource() {
    const rel = 'js/tuning_worker.js', abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return { missing: rel };
    const src = fs.readFileSync(abs, 'utf8'), seen = new Set(), items = [];
    for (const x of [...callTexts(src, NOTE_CALL).map((c) => Object.assign(c, { kind: 'note' })), ...callTexts(src, PROGRESS_CALL).map((c) => Object.assign(c, { kind: 'message' })),
        ...sentenceLiterals(src)]) {
        if (seen.has(x.text)) continue;
        seen.add(x.text);
        items.push({ text: x.text, kind: x.kind, where: `${rel}:${lineOf(src, x.at)}` });
    }
    return { items, errors: [] };
}
// The messages of the raw span reader (js/tuning_snippet.js): the Tuning view and the lens show them
function snippetSource() {
    const rel = 'js/tuning_snippet.js', abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return { missing: rel };
    const src = fs.readFileSync(abs, 'utf8');
    return { items: sentenceLiterals(src).map((x) => ({ text: x.text, kind: 'block', where: `${rel}:${lineOf(src, x.at)}` })), errors: [] };
}
// The markup of the views (index.html) and the strings of the "Show in the log" functions of js/main.js
function elementsOf(html, re) {
    const out = [];
    for (const m of html.matchAll(re)) {
        const tag = m[1].toLowerCase(), open = new RegExp(`<${tag}\\b|</${tag}\\s*>`, 'gi');
        open.lastIndex = m.index + 1;
        let depth = 1, e;
        while (depth && (e = open.exec(html))) depth += e[0][1] === '/' ? -1 : 1;
        out.push(html.slice(m.index, e ? e.index + e[0].length : html.length));
    }
    return out;
}
function functionBodies(src, names) {
    const lits = literalsOf(src), out = [];
    for (const m of src.matchAll(new RegExp(`function\\s+(${names})\\s*\\(`, 'g'))) {
        let i = src.indexOf('{', m.index), depth = 0, k = 0;
        for (; i < src.length; i++) {
            while (k < lits.length && lits[k].end < i) k++;
            if (lits[k] && lits[k].at <= i && i <= lits[k].end) { i = lits[k].end; continue; }
            if (src[i] === '{') depth++; else if (src[i] === '}' && --depth === 0) break;
        }
        out.push([src.indexOf('{', m.index), i]);
    }
    return out.map(([a, b]) => lits.filter((l) => l.at > a && l.end < b));
}
function shellSource() {
    const items = [], add = (text, kind, where) => { if (typeof text === 'string') items.push({ text, kind, where }); };
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const ours = elementsOf(html, /<(div|section)\b[^>]*class="(?:rf-view-tabs|log-evidence|rf-view\b)[^"]*"/g);
    for (const el of ours) for (const x of htmlTexts(el)) add(x.text, x.kind, 'index.html');
    const main = fs.readFileSync(path.join(ROOT, 'js/main.js'), 'utf8');
    for (const lits of functionBodies(main, 'showView|viewInLog|endEvidence|fitGraphToSpan|showAnalyserOf|evidenceBar'))
        for (const l of lits) if (/[a-z]{2,} [a-z]{2,}/i.test(l.text) && !/^[.#\[]|[{}<>=]/.test(l.text)) add(l.text, 'label', `js/main.js:${lineOf(main, l.at)}`);
    return { items, errors: [] };
}
// The project rules in CLAUDE.md that are written in STE: the writing rule and the rules for the gear ratios, the PID
// profiles, the phases and the export
const STE_RULES = ['Writing (ASD-STE100, Issue 9).', 'Gear ratios.', 'PID profiles.', 'Flights, phases and bench runs.', 'Export.'];
function ruleSource() {
    const md = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8'), items = [], errors = [];
    for (const title of STE_RULES) {
        const at = md.indexOf(`- **${title}**`);
        if (at < 0) { errors.push(`CLAUDE.md has no rule "${title}"`); continue; }
        const end = md.slice(at + 2).search(/\n- |\n#|\n\n/);
        const body = md.slice(at, end < 0 ? md.length : at + 2 + end).replace(/^- \*\*[^*]*\*\*\s*/, ''); // the bold title names the rule (Rule 8.6)
        // the lead text, then the items of its list (Rule 4.3)
        const [lead, ...list] = body.split(/\n\s+- /);
        items.push({ text: lead.replace(/\s+/g, ' ').trim(), kind: 'message', where: `CLAUDE.md "${title}"` });
        for (const it of list) items.push({ text: it.replace(/\s+/g, ' ').trim(), kind: 'item', where: `CLAUDE.md "${title}" list` });
    }
    return { items, errors };
}

// ---- lint sets of texts ------------------------------------------------------------------------------------------------

const LIST_ITEM = /^\s*(?:[-•*]|\d+[.)]|\([a-z0-9]\))\s+/;
// items: [{ text, kind, where }]; kind html is read as rendered blocks, other texts line by line (a line that starts with
// a list mark is a list item)
function lintItems(items, L) {
    const texts = new Map();
    const put = (text, kind, where) => { const k = `${kind}\u0000${text}`; if (!texts.has(k)) texts.set(k, where); };
    for (const it of items) {
        if (it.kind === 'html') { for (const b of htmlTexts(it.text)) put(b.text, b.kind, it.where); continue; }
        for (const line of String(it.text).split(/\n+/)) if (line.trim()) put(line.replace(LIST_ITEM, '').trim(), LIST_ITEM.test(line) ? 'item' : it.kind, it.where);
    }
    const hits = [];
    for (const [k, where] of texts) { const [kind, text] = k.split('\u0000'); for (const h of lintText(text, kind, L)) hits.push(Object.assign({ text, kind, where }, h)); }
    const all = [...texts.keys()].map((k) => k.split('\u0000')[1]).join('\n');
    for (const set of [['delay', 'lag', 'time delay'], ['finding', 'result'], ['threshold', 'limit'], ['authority', 'output range'], ['block', 'period']]) {
        const used = set.filter((w) => new RegExp(`\\b${w}s?\\b`, 'i').test(all));
        if (used.length > 1) hits.push({ check: 'SYN', detail: used.join(', '), text: '', kind: '', where: 'one view', sentence: '' });
    }
    return { count: texts.size, hits };
}
function countsOf(hits) { const c = {}; for (const h of hits) c[h.check] = (c[h.check] || 0) + 1; return c; }

// The tests that run again, and the sources that each one must give. The list follows the tree: a test that is not in the
// tree is reported as not found, and every js/*_view.js with its test is read as a DOM script
const HARVEST = [
    { file: 'test/tuning_dialog.test.cjs', expect: ['js/tuning_dialog.js', 'plots of js/tuning_dialog.js'] },
    { file: 'test/log_lens.test.cjs', expect: ['js/log_lens.js'] },
    ...[...DOM_SCRIPTS].filter((f) => /_view\.js$/.test(f)).map((f) => ({ file: `test/${path.basename(f, '.js')}.test.cjs`, expect: [f] })),
    { file: 'test/advice.test.cjs', expect: ['tools/autotune/advice.cjs', ...(adviceExports().includes('exportScript') ? [SCRIPT_SOURCE] : [])] },
    { file: 'test/health_track.test.cjs', expect: ['tools/autotune/health_track.cjs'] },
    { file: 'test/health_more.test.cjs', expect: ['tools/autotune/health_more.cjs'] },
    { file: 'test/health_phase.test.cjs', expect: fs.existsSync(path.join(ROOT, 'tools/autotune/health_phase.cjs')) ? ['tools/autotune/health_phase.cjs'] : [] },
    { file: 'test/health_rescue.test.cjs', expect: ['tools/autotune/health_rescue.cjs'] },
    { file: 'test/health_limits.test.cjs', expect: ['tools/autotune/health_limits.cjs'] },
    { file: 'test/health_config.test.cjs', expect: ['tools/autotune/health_config.cjs'] },
    { file: 'test/health_power.test.cjs', expect: ['tools/autotune/health_power.cjs'] },
    { file: 'test/catalog.test.cjs', expect: ['tools/autotune/catalog.cjs'] },
    { file: 'test/hierarchy.test.cjs', expect: [] },
    { file: 'test/evidence.test.cjs', expect: ['tools/autotune/evidence.cjs'] },
    { file: 'test/datasets.test.cjs', expect: ['tools/autotune/datasets.cjs'] },          // round 3 M1
    { file: 'test/filter_tune.test.cjs', expect: ['tools/autotune/filter_tune.cjs'] },    // round 3 M2
    { file: 'test/tuning_worker.test.cjs', expect: ['TuningResult'], env: 'AUTOTUNE_REAL_LOG', timeoutS: 3600, heapMb: 12000 },
];
// The names that advice.cjs exports (read from the source: the module is not loaded in the main thread for this)
function adviceExports() {
    try { const m = /module\.exports\s*=\s*\{([^}]*)\}/.exec(fs.readFileSync(path.join(ROOT, 'tools/autotune/advice.cjs'), 'utf8')); return m ? m[1].split(',').map((x) => x.split(':')[0].trim()) : []; } catch (e) { return []; }
}

// ---- tests ---------------------------------------------------------------------------------------------------------------

function mainThread() {
    const { test } = require('node:test');
    const assert = require('node:assert/strict');
    const L = loadVocabulary(JSON.parse(fs.readFileSync(VOCAB_FILE, 'utf8')));
    const failing = (text, kind = 'message') => [...new Set(lintText(text, kind, L).map((h) => h.check))].filter((c) => FAILING.includes(c)).sort();
    const why = (text, kind = 'message') => JSON.stringify(lintText(text, kind, L).filter((h) => FAILING.includes(h.check)).map((h) => `${h.check} ${h.detail}`));

    test('the word count follows Rules 8.5 to 8.7: a number with its unit, quoted text, a code and a parenthesis are one word', () => {
        const count = (s) => sentencesOf(s).map((x) => wordCount(tokensOf(x.s, L)));
        assert.deepEqual(count('Do the hover test 3 times at a minimum of 2300 rpm.'), [11]);
        assert.deepEqual(count('Set the GOVERNOR MODE switch to OFF.'), [6]);
        assert.deepEqual(count('Set yaw_p_gain to 72 in PID profile 2.'), [8]);
        assert.deepEqual(count('C12 shows a roll tracking error of 34.8 ± 4.2 % (36.2 deg/s rms).'), [9, 2]);
        assert.deepEqual(count('After you paste a CLI block, type `save`. The last command of this script is "save".'), [8, 8]);
        assert.deepEqual(count('The tail was at its output limit for 7.66 s in 3 log-profile pairs.'), [13]);
        assert.deepEqual(count('The notch filter at 0.5-3 Hz uses 10/20/40 deg/s and −303 ± 5 ‰ from gyroADC[0] in health_more.cjs.'), [13]);
        assert.equal(sentencesOf('Load the file health_more.cjs. Then do the test at 0.5 Hz. For example, log 50.').length, 3);
        assert.equal(sentencesOf('The yaw D gain is 12. The next step is the yaw P gain.').length, 2, 'a sentence can end with a letter that names a gain');
    });

    test('each check finds its error, and the STE text for the same information passes (maps2/ste.md audit)', () => {
        const CASES = [ // [our text before, kind, failing checks it must give, the STE text that must pass]
            ['Needs attention', 'label', ['DENY'], 'Problem'],
            ['Worth watching', 'label', ['DENY'], 'Monitor'],
            ['Not enough data', 'label', ['DENY'], 'Not sufficient data'],
            ['no CLI dump: CLI-only settings are unknown and profile values come from the log header, which holds only the arming profile.', 'message', ['CASE', 'DENY'],
                'The log header of each log gives only the values of the PID profile that was active at the start of that log.'],
            ['no finding: 1 blocks of 10 s with roll setpoint rms >= 20 deg/s, fewer than 4', 'message', ['CASE', 'DENY', 'MATH'],
                'The check has no result. The log has 1 period of 10 s with a roll setpoint of 20 deg/s rms or more. A minimum of 4 periods is necessary.'],
            ['% of the yaw span 1250', 'label', ['DENY'], '% of the yaw output range (1250)'], // round 2: 'authority' is a technical noun (SPEC3 B: the tail authority)
            ['Headspeed reads a wrong factor', 'label', ['DENY'], 'Incorrect headspeed (motor poles or RPM sensor)'],
            ['Incorrect headspeed (motor poles or gear ratio)', 'label', ['GEAR'], 'Incorrect headspeed (motor poles or RPM sensor)'],
            ['Paste the block: it sets the value; type save afterwards, or use the combined script at the end.', 'message', ['DENY', 'SEMI'],
                'After you paste a CLI block, type `save`. You can also use the CLI script at the end of this tab. The last command of this script is `save`.'],
            ['F5 may flag lines that the tail notch removes', 'message', ['CASE', 'DENY'], 'F5 can show a line that a tail notch filter removes.'],
            ['the yaw I term is -24.2 +- 0.4 % of the yaw authority (3 blocks); the hover tail pitch is -354 +- 5 permille, a normal value from the tail centre trim', 'message',
                ['CASE', 'DENY', 'GB', 'LEN', 'MATH', 'SEMI', 'VOCAB'],
                'In hover, the yaw I term is −24.2 ± 0.4 % of the yaw output range (3 periods, 11 s). The hover tail pitch is −354 ± 5 ‰, which is a usual value. Thus, the I term contains a constant trim. The cause is the tail center trim or the zero-pitch calibration (MIXS), not the gains.'],
            ['roll: 34.8 +- 4.2 % of the setpoint rms after removing the 32.8 ms delay; 40.5 % without', 'message', ['CASE', 'DENY', 'ING', 'MATH', 'SEMI'],
                'Check C12, roll: the tracking error is 34.8 ± 4.2 % of the setpoint (36.2 deg/s rms). The analysis removed a time delay of 32.8 ms first. Without this step, the error is 40.5 %.'],
            ['Analysing... the results appear here.', 'message', ['DENY', 'GB'], 'The analysis continues. The results will show here.'],
            ['nothing is sent to the flight controller', 'message', ['CASE', 'VOCAB'], 'This app does not send data to the flight controller.'],
            ['The loop has not absorbed the moment there.', 'message', ['TENSE'], 'At more than 0.2 Hz, the loop does not fully compensate for the moment. Thus, the check does not use this value.'],
            ['Yaw D is driven by noise above 30 Hz.', 'message', ['DENY', 'LIMIT', 'TENSE'], 'Most of the yaw D term comes from gyro noise of more than 30 Hz.'],
            ['Below 1 kHz rotor and tail harmonics alias, so vibration and D-term results are unreliable; log at 1 kHz.', 'message', ['DENY', 'LIMIT', 'SEMI', 'VOCAB'],
                'If the log rate is less than 1 kHz, aliasing changes the rotor and tail harmonics. Thus, the vibration, D-term and gain results are not accurate. Record the log at 1 kHz (refer to check D1).'],
            ['Set the flight rpm below the lowest governor target if this rotor flies slower.', 'message', ['LIMIT'],
                'If the rotor turns more slowly in flight, set the flight rpm to less than the lowest governor target.'],
            ['-303 +- 5 permille = -24.2 +- 0.4 %', 'message', ['CASE', 'MATH', 'VOCAB'], '−303 ± 5 ‰. This is −24.2 ± 0.4 % of the yaw output range.'],
            ['share at >= 20 deg/s 0.0 +- 0.0 %', 'message', ['CASE', 'DENY', 'MATH'], 'The error is 20 deg/s or more for 0.0 ± 0.0 % of the time.'],
            ['within 3 % of the rotor line by 2 SE', 'message', ['CASE', 'DENY'], 'The difference between the main-rotor line and `headspeed / 60` must be 3 % or less (2 SE test).'],
            ['e.g. log 50: rescue 10.6 s excluded', 'message', ['CASE', 'DENY', 'LATIN'], 'For example, log 50 shows 10.6 s of rescue. The analysis does not use this part of the flight.'],
            ["The check can't run.", 'message', ['CONTR', 'DENY'], 'The check cannot operate.'],
            ['Make sure the tail is not near its limit.', 'message', ['THAT'], 'Make sure that the tail is not near its output limit.'],
            ['The filters have decreased the gyro noise.', 'message', ['TENSE'], 'The filters decrease the gyro noise.'],
            ['The gyro is oscillating at 12 Hz.', 'message', ['ING', 'TENSE'], 'The gyro shows an oscillation at 12 Hz.'],
            ['The analysis uses the log of the flight and the log header of the flight to calculate the tracking error of each axis in each PID profile of the flight.', 'message', ['LEN'],
                'The analysis uses the log and the log header. It calculates the tracking error of each axis in each PID profile.'],
            ['Set the D gain of the tail to 10 and the P gain of the tail to 20 in the PID profile of the flight.', 'message', ['LEN'],
                'Set the yaw D gain to 10 in PID profile 2.'],
            ['examine the tail,', 'item', ['CASE'], 'Examine the tail linkage'],
            ['The governor gives a glorious headspeed.', 'message', ['VOCAB'], 'The governor keeps the headspeed stable.'],
            ['The main problem is the tail.', 'message', ['DENY'], 'The primary problem is the main rotor.'],
            ['The governor keeps the headspeed', 'message', ['CASE'], 'The governor keeps the headspeed stable.'],
            ['Type "SAVE; EXIT" in the CLI, and set `gyro_lpf1_static_hz >= 100`.', 'message', [], null],
            ['WARNING: The rotor blades can cause injury.', 'message', ['SAFE'], 'WARNING: Examine each change before you set it in the flight controller. The rotor blades can cause injury.'],
            ['CAUTION: Incorrect gains can cause oscillations. Do a hover test.', 'message', ['SAFE'], 'CAUTION: If the tail has an oscillation, land the helicopter. Incorrect gains can cause damage.'],
            ['NOTE: Record the log at 1 kHz.', 'message', ['NOTEIMP'], 'NOTE: This app does not send data to the flight controller.'],
            ['If the log records `gyroRAW`, the check can operate.', 'note', [], null],
            ['Arm the helicopter in PID profile 2.', 'note', ['NOTEIMP'], 'The log header records the values of PID profile 2 only when the pilot arms the helicopter in PID profile 2.'],
            ['TUNE puts the filters before the gains.', 'note', [], null],
            ['The gain is 10. The gain is 11. The gain is 12. The gain is 13. The gain is 14. The gain is 15. The gain is 16.', 'message', ['PARA'],
                'The gain is 10. The gain is 11. The gain is 12. The gain is 13. The gain is 14. The gain is 15.'],
        ];
        for (const [bad, kind, want, good] of CASES) {
            assert.deepEqual(failing(bad, kind), want, `"${bad}": ${why(bad, kind)}`);
            if (good) assert.deepEqual(failing(good, kind), [], `"${good}": ${why(good, kind)}`);
        }
    });

    test('the report-only checks: a noun as a verb, noun clusters of more than 3 items, the passive and two terms for one item', () => {
        const only = (text, kind = 'message') => [...new Set(lintText(text, kind, L).map((h) => h.check))].filter((c) => REPORT_ONLY.includes(c)).sort();
        assert.deepEqual(only('Check the tail linkage.'), ['POS']);
        assert.deepEqual(only('Check C12 shows a tracking error of 34 %.'), [], 'check C12 is a noun with its identifier');
        assert.deepEqual(only('Step 1', 'label'), []);
        assert.deepEqual(only('The roll setpoint rms block jackknife SE is 4 %.'), ['NOUN4']);
        assert.deepEqual(only('The lowest gyro low-pass filter cutoff is 120 Hz.'), [], 'gyro, low-pass filter and cutoff are 3 items');
        assert.deepEqual(only('The values come from the log header, PID profile 1 at the start.'), [], 'a comma ends a noun cluster');
        assert.deepEqual(only('The value is set in the CLI.'), ['PASSIVE']);
        const syn = lintItems([{ text: 'The time delay is 30 ms.', kind: 'message' }, { text: 'Use the lag.', kind: 'message' }], L).hits.filter((h) => h.check === 'SYN');
        assert.deepEqual(syn.map((h) => h.detail), ['delay, lag, time delay']);
    });

    test('the gear-ratio rule (GEAR): no text doubts a gear ratio, a pulley or a tooth count, or tells the pilot to examine one', () => {
        const gear = (text, kind = 'message') => lintText(text, kind, L).filter((h) => h.check === 'GEAR').length;
        for (const bad of ['Incorrect headspeed (motor poles or gear ratio)', 'Check G12 shows an incorrect headspeed: motor_poles or the gear ratio is not correct.',
            'Possibly, the notch filter is not on the line (examine the gear ratios), or its Q is too high.', 'Examine the battery and the gear ratio.',
            'Decrease the target headspeed, or change the gear ratio or the cell count.', 'Compare it with the tail gear ratio, or examine the belt, the pulleys and the bearings.',
            'The RPM filters are accurate only with the correct gear ratio.', 'Make sure that the tooth count of the pinion is correct.']) assert.equal(gear(bad), 1, bad);
        for (const good of ['The gear ratios in the configuration are correct.', 'Motor poles and gear ratios', 'Set the poles and gears',
            'The firmware calculates the rotor speed from the motor speed, the pole count and the gear ratio.',
            'The frequency of some notch filters is unknown, because the log header has no gear ratios.',
            'This line is not a rotor harmonic. Thus, it is a resonance. Examine the airframe for a mechanical vibration at 112 Hz.',
            'Check G12 compares the main rotor line with `main_rotor_gear_ratio` and the headspeed. Examine the `motor_poles` value and the RPM sensor.']) assert.equal(gear(good), 0, good);
    });

    test('text in upper case is quoted text, and the comment lines of a CLI script are read without the commands', () => {
        assert.deepEqual(failing('Set tail_rotor_mode to MOTORIZED and gov_mode to STANDARD.'), []);
        assert.deepEqual(failing('WARNING: Examine each change before you set it in the flight controller. The rotor blades can cause injury.', 'warning'), []);
        const got = []; scriptTexts('# Save `diff all` before you paste this.\nprofile 1\nset yaw_p_gain = 72\n#  PID profile 2\n# \nsave', (t, k) => got.push([t, k]));
        assert.deepEqual(got, [['Save `diff all` before you paste this.', 'block'], [' PID profile 2', 'block']]);
        const lits = sentenceLiterals("x('The app loads log ' + n + '.'); y(`The window has ${n} samples. A minimum of 16 samples is necessary.`); z('<p>Some text in markup</p>'); w('Short text');");
        assert.deepEqual(lits.map((l) => [l.text, l.kind]), [['The app loads log', 'block'], ['The window has 7 samples. A minimum of 16 samples is necessary.', 'message']]);
    });

    test('rendered HTML: block elements are texts, the attributes are labels, and code, pre and data-ste="quoted" are left out', () => {
        const got = htmlTexts('<div class="x" title="Show the &quot;Tuning&quot; view again"><h3>Recommendations</h3><p>The log header has these values:</p><ul><li>The D gain</li></ul>'
            + '<pre>set x = 1;</pre><p>Type <code>save; exit</code> in the CLI.</p><details data-ste="quoted"><summary>Toolkit text (not STE)</summary>ratio vs. target; e.g. 3</details>'
            + '<span data-ste="quoted">&lt;img src=x&gt;.bbl</span><button type="button" aria-label="Close">&times;</button><svg><text x="1">1 Set up</text></svg></div>');
        assert.deepEqual(got, [{ text: 'Show the "Tuning" view again', kind: 'label' }, { text: 'Recommendations', kind: 'label' }, { text: 'The log header has these values:', kind: 'block' },
            { text: 'The D gain', kind: 'item' }, { text: 'Type in the CLI.', kind: 'block' }, { text: 'Toolkit text (not STE)', kind: 'label' }, { text: 'Close', kind: 'label' }, { text: '×', kind: 'label' },
            { text: '1 Set up', kind: 'label' }]);
    });

    test('script literals: the worker notes are the texts of its notes calls, with an interpolation as a number, a quoted error or the text of a choice', () => {
        const src = "J.notes.add(`${n} s of normal flight` + (x ? ' (rescue)' : '')); const re = /a'b/; K.notes.push(`${file} not available: its checks${name === 'advice' ? ' and recommendations' : ''} are missing`);\n"
            + "return { notes: ['advice.cjs is not available'] }; J.notes.add(`advice failed: ${message(e)}`); // J.notes.add('a comment')";
        assert.deepEqual(callTexts(src, NOTE_CALL).map((x) => x.text), ['7 s of normal flight 7  (rescue)', '7 not available: its checks and recommendations are missing',
            'advice.cjs is not available', 'advice failed: "error"']);
    });

    test('the vocabulary holds only headwords and our classes, the alternatives are STE, and docs/STE_GLOSSARY.md agrees with it', () => {
        const V = L.V, deny = new Set(Object.keys(V.deny));
        for (const [w, s] of Object.entries(V.approved)) assert.match(s, /^(?:n|v|adj|adv|prep|conj|pron|art)(?:\/(?:n|v|adj|adv|prep|conj|pron|art))*(?: [a-z'\-]+)*$/, `approved ${w}: ${s}`);
        for (const [w, s] of Object.entries(V.technicalNouns)) assert.match(s, /^\d{1,2}(?: [a-z]+)*$/, `technical noun ${w}: ${s}`);
        for (const [w, s] of Object.entries(V.technicalVerbs)) assert.match(s, /^\d[a-f](?: [a-z]+)*$/, `technical verb ${w}: ${s}`);
        for (const w of [...Object.keys(V.approved), ...Object.keys(V.technicalNouns).map(norm), ...Object.keys(V.technicalVerbs)]) assert.ok(!deny.has(w), `${w} is in the denylist and in a word class`);
        const POS_NOTE = /\((?:n|v|adj|adv|prep|conj|pron)\)/g; // a part of speech after a word
        const notSte = (text) => lintText(text.replace(POS_NOTE, ''), 'label', L).filter((h) => ['DENY', 'VOCAB', 'GB', 'ING'].includes(h.check)).map((h) => h.detail);
        assert.deepEqual(Object.entries(V.deny).map(([w, alt]) => [w, alt, notSte(alt)]).filter((x) => x[2].length), [], 'every alternative in the denylist is STE');
        const md = fs.readFileSync(path.join(ROOT, 'docs/STE_GLOSSARY.md'), 'utf8');
        const section = (title) => { const m = new RegExp(`^## ${title}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, 'm').exec(md); assert.ok(m, `section "${title}"`); return m[1]; };
        const rows = (text, first) => text.split('\n').filter((l) => first.test(l)).map((l) => l.split('|').map((c) => c.trim()));
        const ticks = (cell) => [...cell.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
        const tn = new Map(); for (const r of rows(section('Technical nouns'), /^\|\s*\d{1,2}\s*\|/)) for (const w of ticks(r[3])) tn.set(w, r[1]);
        assert.deepEqual([...tn.keys()].sort(), Object.keys(V.technicalNouns).sort(), 'the glossary lists the technical nouns of the vocabulary');
        for (const [w, cat] of tn) assert.equal(V.technicalNouns[w].split(' ')[0], cat, `category of ${w}`);
        const tv = new Map(); for (const r of rows(section('Technical verbs'), /^\|\s*\d[a-f]\s*\|/)) for (const w of ticks(r[3])) tv.set(w, r[1]);
        assert.deepEqual([...tv.keys()].sort(), Object.keys(V.technicalVerbs).sort(), 'the glossary lists the technical verbs of the vocabulary');
        for (const r of rows(section('Substitutions'), /^\|\s*`/)) {
            for (const w of ticks(r[1])) assert.ok(deny.has(w.toLowerCase()) || stems(w.toLowerCase()).some((s) => deny.has(s)) || L.british.has(w.toLowerCase()), `substitution "${w}" is not in the denylist`);
            assert.deepEqual(notSte(r[2].replace(/`[^`]*`/g, 'X')), [], `the STE column "${r[2]}"`);
        }
        for (const r of rows(section('Status words'), /^\|\s*[A-Z]/)) if (r[1] !== 'Status word') assert.deepEqual(failing(r[1], 'label'), [], `status word "${r[1]}"`);
        // the gear-ratio wording that the texts can use as it is
        const gear = /\*\*Write this\.\*\*[\s\S]*?(?=\n- \*\*)/.exec(section('Gear ratios'));
        assert.ok(gear, 'the "Write this" list of the section "Gear ratios"');
        for (const m of gear[0].matchAll(/"([^"]+)"/g)) assert.deepEqual(failing(m[1]), [], `gear-ratio wording "${m[1]}": ${why(m[1])}`);
    });

    test('the text that the app shows passes the STE lint (counts for each check and source)', { timeout: 4 * 3600e3 }, async (t) => {
        const groups = new Map();
        const group = (name) => { if (!groups.has(name)) groups.set(name, { items: [], errors: [], via: new Set(), missing: null }); return groups.get(name); };
        const direct = [['tools/autotune/catalog.cjs (summary of every check id)', catalogSource], ['tools/autotune/hierarchy.cjs (titles, texts, status reasons)', hierarchySource],
            ['js/tuning_worker.js (notes, progress, window observations)', workerSource], ['js/tuning_snippet.js (messages)', snippetSource],
            ['view shell (index.html, js/main.js)', shellSource], ['CLAUDE.md (STE rules)', ruleSource]];
        for (const [name, fn] of direct) {
            const r = fn(), g = group(name);
            if (r.missing) g.missing = r.missing; else if (r.error) g.errors.push(r.error); else { g.items.push(...r.items); g.errors.push(...r.errors); }
        }
        const todo = HARVEST.map((h) => {
            if (!fs.existsSync(path.join(ROOT, h.file))) return Promise.resolve({ h, skip: `${h.file} not found` });
            if (h.env && !process.env[h.env]) return Promise.resolve({ h, skip: `${h.env} is not set` });
            return harvest(h.file, h).then((r) => ({ h, r }));
        });
        const harvested = await Promise.all(todo);
        for (const { h, r, skip } of harvested) {
            if (skip) { for (const s of h.expect) group(s).missing = group(s).missing || skip; continue; }
            for (const it of r.items) { const g = group(it.source); g.items.push(it); g.via.add(h.file); }
            for (const s of h.expect) { const g = group(s); if (!g.items.length && !g.missing) g.errors.push(`${h.file} gave no text from ${s}${r.errors.length ? `: ${r.errors.slice(0, 3).join(' / ')}` : ''}`); }
            t.diagnostic(`harvest ${h.file}: ${r.items.length} texts, tests ${r.stats ? `${r.stats.passed} passed, ${r.stats.failed} failed, ${r.stats.skipped} skipped` : 'not run'}${r.errors.length ? `, ${r.errors.length} errors (first: ${r.errors[0]})` : ''}`);
        }
        const table = [], dump = [];
        for (const [name, g] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
            await t.test(name, (st) => {
                if (g.missing && !g.items.length) { table.push([name, '-', 'not found: ' + g.missing]); st.skip(`not found: ${g.missing}`); return; }
                const { count, hits } = lintItems(g.items, L), c = countsOf(hits);
                const fail = hits.filter((x) => FAILING.includes(x.check));
                table.push([name, count, FAILING.map((k) => c[k] || 0).join(' '), REPORT_ONLY.map((k) => c[k] || 0).join(' ')]);
                dump.push(...hits.map((x) => Object.assign({ source: name }, x)));
                st.diagnostic(`${count} texts${g.via.size ? ` (from ${[...g.via].join(', ')})` : ''}. Failing: ${FAILING.map((k) => `${k} ${c[k] || 0}`).join(', ')}. Report only: ${REPORT_ONLY.map((k) => `${k} ${c[k] || 0}`).join(', ')}.`);
                const examples = fail.slice(0, 40).map((x) => `  ${x.check} (Rule ${RULE_OF[x.check]}) ${x.detail} | ${x.kind} | ${x.where} | "${(x.sentence || x.text).slice(0, 140)}"`);
                if (/^data given to /.test(name)) return; // the test data of a harness: linted where the toolkit makes it, reported here
                assert.deepEqual(g.errors, [], 'the source gave its texts');
                assert.equal(fail.length, 0, `${fail.length} STE errors in ${name}:\n${examples.join('\n')}${fail.length > 40 ? `\n  and ${fail.length - 40} more (STE_LINT_OUT=<file> writes all)` : ''}`);
            });
        }
        t.diagnostic(`source | texts | ${FAILING.join(' ')} | ${REPORT_ONLY.join(' ')}`);
        for (const r of table) t.diagnostic(r.join(' | '));
        if (process.env.STE_LINT_OUT) fs.writeFileSync(process.env.STE_LINT_OUT, JSON.stringify({ table, hits: dump }, null, 1));
    });
}

if (!WT.isMainThread && WT.workerData && WT.workerData.steHarvest) {
    harvestFile(WT.workerData.steHarvest).then((r) => WT.parentPort.postMessage(r), (e) => WT.parentPort.postMessage({ items: [], stats: null, errors: [String(e && e.stack || e)] }));
} else mainThread();
