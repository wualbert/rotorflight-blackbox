export const meta = {
  name: 'x4-new-dump',
  description: 'Interpret a new Gaui X4 II dump against the previous one from run_all.sh outputs, verify new decision-relevant findings, write FINDINGS',
  whenToUse: 'After analysis/gaui-x4/run_all.sh has produced <out>/ for a new flash dump. args: { out, baseline, previous_findings, notes, dump }. Returns { findings, markdown, changes }: save markdown as <out>/FINDINGS.md',
  phases: [
    { title: 'Interpret', detail: '5 grouped agents read summary.json files, compute only what is new' },
    { title: 'Verify', detail: 'one combined verifier per new or high-importance finding' },
    { title: 'Write', detail: 'writer, then one reviewer who fixes in place' },
  ],
}

// args.out: run_all.sh output dir of the new dump; args.baseline: run_all.sh output dir of the previous dump;
// args.previous_findings: FINDINGS.md of the previous dump; args.notes: what the pilot says changed; args.dump: .BBL path
const R = '/Users/albertwu/exp/rotorflight-blackbox'
const A = `${R}/analysis/gaui-x4`
const { out, baseline, previous_findings, notes, dump } = args

const CTX = `Gaui X4 II helicopter, Rotorflight 4.6.0, RDMS NEXUS F7. The pilot wants tuning recommendations from each new flash dump.
New dump: ${dump}. Its measurements are already computed (no agents) by ${A}/run_all.sh into ${out}/: toolkit reports ${out}/{health,tune,wag}/report.md and one ${out}/<area>/summary.json per area (areas roll_mode, roll_track, pitch, yaw_gains, tail_limit, yaw_precomp, governor, vibration, spoolup, cyclic, setup, rescue; each area's scripts and run.sh are in ${A}/<area>/). The same code ran on the previous dump into ${baseline}/. The previous dump's verified findings and recommendations: ${previous_findings} (and ${A}/verified.json).
What the pilot says changed: ${notes}
Decoded logs: python with sys.path.insert(0, '${A}/scripts'); import os; os.environ['X4_CACHE'] = open('${out}/cache_path.txt').read().strip() (set it BEFORE importing load); from load import load, FLOWN. The previous dump's cache path is in ${baseline}/cache_path.txt. Python: /Users/albertwu/miniconda3/envs/rs-bench/bin/python. Node needs: export PATH="$HOME/.nvm/versions/node/v22.17.0/bin:$PATH"; unset -f node npm npx nvm 2>/dev/null; export AUTOTUNE_FLIGHT_RPM=2000.
The pilot's standards: every claim is a computed number with uncertainty, n and its unit (the flight is usually the independent unit), and the rule it passed; compare at equal stick input; measurements are not facts about the hardware (causes are candidates with fingerprints and a physical test); measured vs predicted labelled; log numbers and log-clock times given; recommendations are CLI text for review, steps bounded to 20 %, "no recommendation" when evidence is thin; CLI profiles are 0-based and "profile N" changes the stored profile, so end multi-profile blocks with the boot profile before "save". Group boundaries come from the pilot, never from the data.`

const GROUPS = [
  { key: 'tail', areas: 'yaw_gains, tail_limit, yaw_precomp (and health T-checks, wag yaw sections)', focus: 'What the yaw gain changes did: gain sets per log and profile, tail hold, stops, margins, clamp time, precomp need, each compared at equal input and against the previous dump; whether the previous tail recommendations still hold; effect of the tail blade change on the tail loop.' },
  { key: 'cyclic', areas: 'roll_mode, roll_track, pitch, cyclic', focus: 'Whether the roll mode, roll/pitch tracking and trim changed; whether the previous no-change decisions still hold; any blade-change effect on cyclic.' },
  { key: 'power', areas: 'governor, setup (and health G/D checks)', focus: 'Governor behaviour with the new data, and above all what the ESC telemetry now shows: pack voltage and sag, current, ESC rpm against the governor headspeed, temperatures; voltage compensation; data validity.' },
  { key: 'vibration', areas: 'vibration (and wag section 6, health F-checks)', focus: 'Every rotor-locked line before and after the pilot-named tail blade change, at equal headspeed and per flight; what passes the filters; whether a filter change is now needed.' },
  { key: 'ops', areas: 'spoolup, rescue', focus: 'Spool-up/liftoff oscillation with the technique flown, ground events, rescue use; census of the dump.' },
]

const FINDINGS = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'under 200 words' },
    findings: { type: 'array', maxItems: 5, items: { type: 'object', properties: {
      id: { type: 'string' }, claim: { type: 'string' }, numbers: { type: 'string' }, where: { type: 'string' },
      method: { type: 'string', description: 'summary.json metric names or new script paths' },
      new_method: { type: 'boolean', description: 'true if any number comes from a script written now rather than the validated run.sh' },
      vs_previous: { type: 'string', description: 'what changed against the previous dump, with numbers' },
      recommendation: { type: 'string' }, prediction: { type: 'string' },
      importance: { type: 'string', enum: ['high', 'medium', 'low'] }, caveats: { type: 'string' },
    }, required: ['id', 'claim', 'numbers', 'where', 'method', 'new_method', 'vs_previous', 'recommendation', 'prediction', 'importance', 'caveats'] } },
    questions_for_pilot: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'findings', 'questions_for_pilot'],
}
const VERDICT = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['confirmed', 'corrected', 'refuted', 'unverifiable'] },
    corrected_claim: { type: 'string' }, corrected_numbers: { type: 'string' }, reasoning: { type: 'string' },
    recommendation_ok: { type: 'string', enum: ['yes', 'no', 'partly', 'n/a'] }, recommendation_note: { type: 'string' },
  },
  required: ['verdict', 'corrected_claim', 'corrected_numbers', 'reasoning', 'recommendation_ok', 'recommendation_note'],
}

const results = await pipeline(GROUPS,
  (g) => agent(`${CTX}\n\nYou interpret the areas ${g.areas} for the new dump. Focus: ${g.focus}\nStart from the summary.json files and reports (new and baseline); compute something new only where they do not answer the question, and put such scripts under ${out}/interpret/${g.key}/. Return at most 5 findings, decision-relevant first; mark new_method where a number does not come from the validated run.sh.`,
    { label: `interpret:${g.key}`, phase: 'Interpret', schema: FINDINGS, effort: 'high' }),
  async (res, g) => {
    if (!res) return null
    const checked = await parallel(res.findings.map(f => async () => {
      if (f.importance !== 'high' && !f.new_method) return Object.assign({}, f, { verdicts: [], survives: true, checked: 'validated script, not re-verified' })
      const v = await agent(`${CTX}\n\nAdversarially verify this finding. Recompute its key numbers with your own code from the cache, attack the inference (inputs flown, profiles, gain sets, blade groups, rescue/ground time, flights as the unit, thresholds), and check firmware/CLI semantics of the recommendation. Scripts under ${out}/verify/${f.id}/.\n\n${JSON.stringify(f, null, 1)}`,
        { label: `verify:${f.id}`, phase: 'Verify', schema: VERDICT })
      return Object.assign({}, f, { verdicts: v ? [v] : [], survives: !!v && (v.verdict === 'confirmed' || v.verdict === 'corrected'), checked: 'verified' })
    }))
    return { group: g.key, summary: res.summary, questions_for_pilot: res.questions_for_pilot, findings: checked }
  })

const all = results.filter(Boolean)
// subagents may not write report files here: the document travels as text and the caller saves it
const DOC = { type: 'object', properties: { markdown: { type: 'string', description: 'the full document' }, changes: { type: 'array', items: { type: 'string' } } }, required: ['markdown', 'changes'] }
phase('Write')
const draft = await agent(`${CTX}\n\nWrite the findings document for the new dump (returned as markdown text, not saved): what this dump shows, against the previous dump and its recommendations (${previous_findings}). Lead with "What to do" (ordered actions with CLI for review, prediction, pass criterion), then what changed and why (numbers), the effect of each pilot-named change (yaw gains, tail blades, ESC telemetry), no-change decisions that still hold or no longer hold, next flights, questions for the pilot, refuted items. Use corrected numbers; use only surviving findings for claims. Model the style on ${previous_findings}. Findings JSON:\n${JSON.stringify(all, null, 1)}`, { label: 'write', phase: 'Write', schema: DOC })
const review = draft && await agent(`${CTX}\n\nReview the draft below against the findings JSON and the summary.json files, and return the corrected full document: numbers without source or uncertainty, claims stronger than the verdicts, hardware stated as fact, wrong CLI (names, 0-based profiles, profile before save, rate vs PID profile), contradictory or unsafe advice, missing prediction/pass criterion, padding. List what you changed.\n\nFindings JSON:\n${JSON.stringify(all, null, 1)}\n\nDraft:\n${draft.markdown}`, { label: 'review', phase: 'Write', schema: DOC })
return { findings: all, markdown: (review || draft || {}).markdown, changes: review ? review.changes : [] }
