# STE glossary (ASD-STE100, Issue 9)

All text that the app shows is written in ASD-STE100 Simplified Technical English, Issue 9 (2025-01-15), as the project
rule in `CLAUDE.md` says. The standard asks each project to keep its own list of technical nouns and technical verbs. This file
is that list, with the rules that we apply, our status words, labels and terms, the gear-ratio wording, and the substitutions
that we use most.

- **One source.** The words are in [`test/ste/vocabulary.json`](../test/ste/vocabulary.json). The lint test
  `test/ste_text.test.cjs` reads it, and it makes sure that the tables of technical nouns and technical verbs below are the
  same as the file, that every word of the substitution table is in its denylist, and that every status word and label
  passes the lint. Change the file first, then this page.
- **License.** The standard is free from [asd-ste100.org](https://www.asd-ste100.org), but its General introduction does not
  permit redistribution without the permission of the STE Maintenance Group. This repository holds no copy of the standard or
  of its dictionary. The vocabulary file holds only the headwords that our texts use, with the part of speech and the forms that
  the dictionary lists, and our own technical nouns, technical verbs and alternatives. It holds no definitions, no examples
  and no other text of the standard. The rules below are in our words. Read the standard for the full rules and for the
  approved meaning of each word.
- **Responsibility.** A checker cannot replace the standard, and the STEMG white paper on AI (June 2026) keeps the human
  author responsible for text that AI helps to write. Read each text again after the lint passes.

## Scope

| Text | STE | How the lint reads it |
|---|---|---|
| The Tuning view (with the tuning-order diagram, the PID profile menu and the "CLI file" export panel), the Analysis view (the verdict and the log lens), the view tabs and the "Show in the log" bar | Yes | The harnesses of their tests run again (`test/tuning_dialog.test.cjs`, `test/log_lens.test.cjs`, and `test/<name>_view.test.cjs` for each `js/<name>_view.js`), the markup in `index.html`, the strings of the view functions in `js/main.js` |
| Plot titles, axis labels, series names and line labels | Yes | Every `TuningPlot` spec that the views give |
| What `tools/autotune` writes for the app: `catalog.cjs` summaries, `hierarchy.cjs` titles and texts (also for each PID profile), `advice.cjs` recommendations, notes and coverage, `evidence.cjs` texts, the finding texts of `health_track.cjs`, `health_more.cjs` and `health_phase.cjs` | Yes | The modules, and their outputs in their own tests |
| The comment lines (`#`) of the CLI scripts: `advice.script`, `advice.exportScript` and the CLI text of each recommendation | Yes | The outputs in the tests of `advice.cjs`: each comment line is a label or a sentence. The commands are CLI text |
| The texts of `js/tuning_worker.js`: notes, progress, error results and the window observations of the `derive` command | Yes | The literals of its note and progress calls, and its literals that are sentences |
| The messages of `js/tuning_snippet.js` | Yes | Its literals that are sentences |
| The STE rules in `CLAUDE.md` (writing, gear ratios, PID profiles, phases, export) | Yes | The text of each rule |
| The finding texts of the other session's modules (`health_setup`, `health_gov`, `health_loop`, `report.cjs`, `wag*`) | No: we do not edit their text | Not read: the app shows the catalog summary and puts the toolkit text in `<details data-ste="quoted">` "Toolkit text (not STE)" |
| The upstream Flight analysis text (`js/flight_analysis*.js`) | No: upstream code | Not read |
| CLI text, code, field names, parameter names, file names, the craft name and other strings from the log | Quoted text (Rule 8.6) | Not read: put them in `<code>`, `<pre>`, backticks or an element with `data-ste="quoted"` |

## Rules that we apply

In our words. "Lint" names the check of `test/ste_text.test.cjs`. A check in *italics* only reports. "Review" is for a human.

| Rule | What we do | Lint |
|---|---|---|
| 1.1-1.4 | Use only approved words, our technical nouns and our technical verbs. Use an approved word only as its part of speech (*check*, *test*, *display* are nouns; *use*, *help* are verbs), with its approved meaning and in its listed forms | VOCAB, DENY, *POS*; meaning: review |
| 1.5-1.11 | A technical noun fits a category of Rule 1.5 (table below). A word that is not approved is permitted only in a technical noun (*main* in *main rotor*). Do not use a technical noun as a verb (*log at 1 kHz* is wrong: *record the log at 1 kHz*). Use one term for each item | VOCAB, *SYN*; the rest: review |
| 1.12-1.13 | A technical verb fits a category of Rule 1.12 (table below). Use it only as a verb. If an approved verb can say it, use the approved verb | VOCAB |
| 1.14 | American spelling. Quoted text keeps its spelling | GB |
| 2.1-2.2 | A noun cluster has three words or fewer. Write a longer technical noun in full one time | *NOUN4* |
| 3.1-3.4 | Use the infinitive, the imperative, the simple present, past and future, and the past participle as an adjective. No perfect and no progressive tenses | TENSE |
| 3.5 | An *-ing* word only as a technical noun or a part of one (*tracking error*, *damping*) | ING |
| 3.6-3.7 | Active voice. A description can use the passive only when the agent is not known. Use a verb for an action | TENSE (a passive with *by*), *PASSIVE* |
| 4.1-4.2 | Short, clear sentences. Do not omit articles, verbs or subjects. No contractions | CONTR; the rest: review |
| 4.3 | A vertical list for complex text: a colon before it, each item starts with an upper-case letter, no comma or semicolon at the end of an item | CASE |
| 4.4-4.5 | Connecting words (*and*, *but*, *then*, *thus*). An article, but not before a noun with an identifier (*check C12*, *log 50*) | Review |
| 5.1-5.4 | Instructions: 20 words or fewer in a sentence, one instruction in each sentence, the imperative, the condition first and then a comma | LEN (20); the rest: review |
| 5.5 | A note gives information only: no instruction in a note. A note is a text that starts with NOTE, an advice note, a caveat of a recommendation or a worker note | NOTEIMP |
| 6.1-6.6 | Descriptions: 25 words or fewer in a sentence, one topic in a paragraph, six sentences or fewer in a paragraph | LEN (25), PARA, CASE; the topic: review |
| 7.1-7.3 | WARNING (risk of injury or death) and CAUTION (risk of damage): two sentences or more, a command or a condition first, then the risk, 20 words or fewer in each sentence | SAFE, LEN (20); the risk: review |
| 8.1-8.3 | No semicolons. Hyphens connect related words. Parentheses only for references, identifiers, abbreviations and short explanations | SEMI |
| 8.4-8.7 | Word count: a colon before a list ends a sentence. A parenthesis is one word, and its text is a sentence of its own. A number with its unit, an identifier, a quoted text (also a word in upper case), a formula in code font and a hyphenated word are one word each | LEN |
| 9.1-9.4 | *above* and *below* are positions: for a value, write *more than* and *less than*. No phrasal verbs. The same words each time | LIMIT, *SYN*; phrasal verbs: review |
| GR-1, GR-6 | Write *make sure that*. No Latin abbreviations (*for example*, not *e.g.*) | THAT, LATIN |
| Project style | Numbers and units: SI symbols with a space (*120 ms*, *85 %*), "±" and never "+-", no `=`, `>=`, `->` or `|x|` in a sentence (put a formula in code font), the number and not *a few* | MATH, VOCAB |
| Project: gear ratios | The gear ratios in the configuration are correct. No text doubts a gear ratio, a pulley or a tooth count, or tells the pilot to examine, measure, compare or change one (section "Gear ratios" below) | GEAR |

A sentence is an instruction when its first word, after a condition and a comma, is a verb (*Set the yaw D gain to 10.*). Each
sentence of a message starts with an upper-case letter and the message ends with a period. A label (a button, a tab, a heading,
a chip, a plot title, an axis label) does not need a period.

## Status words

The status of a finding, a recommendation, a prerequisite and a tuning block. Use these words and no others.

| Status word | When |
|---|---|
| No problem found | A prerequisite: the checks that operated found no clearly measurable issue. The prerequisites are assumed to be correct |
| No data | A prerequisite: no check could operate on these logs (a log cannot show it). Never "Start here" |
| Problem | A check flags, and its recommendation is an action or a check. A block with a problem that waits for an item before it |
| Blocked | A block with a problem, and a problem in a prerequisite or a block before it on a gate line |
| Possible result | A block with a problem, and a problem before it on a cause line or a K rule |
| Start here | A block with a problem that is not blocked and not a possible result, and no block before it (filters, governor, its lane) has a problem |
| Satisfactory | The checks of the step measured, and none of them is a problem |
| Monitor | A note: near or more than its limit |
| Information | A note of a check that only reports, or a flag that a recommendation explains |
| Not sufficient data | A note with `thin: true`: the log has not enough data for a result |
| Not measured | The check did not operate, or no check of the app measures the step |
| Not applicable | The governor block in DIRECT or LIMIT mode |
| Not accurate (log rate) | All results of the step come from logs that record at less than 1 kHz (check D1) |
| Analysis error | A module of the toolkit stopped with an error |

A finding goes to a status as follows: flag to Problem, note to Monitor (or Information for a check that only reports), a note
with `thin: true` to Not sufficient data, ok to Satisfactory, skipped to Not measured, error to Analysis error. The diagram
gives these statuses for each PID profile.

Labels of the views:

| Label | Use |
|---|---|
| Log viewer | The tab of the log viewer |
| Analysis | The tab of the Analysis view: the verdict and the log lens |
| Tuning | The tab of the Tuning view |
| Show in the log | A link: the log viewer shows the part of the log that a result comes from, with its fields |
| Show the measurement | A link: a plot of the measurement behind one result against its limit, with a caption of one sentence that says what the curves are and where the limit is |
| Back to Tuning | The button of the bar in the log viewer after "Show in the log" from the Tuning view |
| Back to Analysis | The same button after "Show in the log" from the Analysis view |
| Toolkit text (not STE) | The disclosure with the finding text of the toolkit |
| Rotorflight page | A link to the page of the Rotorflight documentation for a prerequisite or a block |
| Before you tune | The band of the prerequisites above the tuning blocks: Blackbox log, RPM signal and motor poles, Battery and power, Mechanical parts, Rescue, Flight controller |
| Filters, Governor, Cyclic gains, Tail gains, Cyclic compensation, Tail compensation and authority | The tuning blocks. A block is a set of parameters, never a measurement |
| Open in the Tuning view | A link of the Analysis view: a result whose home is a tuning block (a parameter to tune) |
| Do first | The prerequisites and the blocks that come before a block in the tuning order |
| Possible result of | The upstream problems and the K rule of a possible result |
| Start the analysis | The button of the Analysis view (in the verdict, or in the log lens) when there is no result |
| In this time window | The panel of the log lens with the results and the values of the time window |
| PID profile 2 | A PID profile, with the number that the Configurator shows (1 to 6). The CLI text uses `profile 1` for it |
| PID profile unknown | The PID profile at arming is not known (profile 0 before the first switch). There is no CLI text and no export for it |
| All PID profiles | The item of the PID profile menu that shows each step with one status for each PID profile |
| Flight log | A log with one or more flights |
| Bench run (no analysis) | A log with no flight. The analysis does not use it |
| Idle | The flight phase with the helicopter armed and the governor OFF or IDLE |
| Spool-up | The flight phase from the start of the headspeed ramp to the governor ACTIVE condition |
| On the ground | The flight phase "ground": the governor ACTIVE before the liftoff or after the touchdown |
| Flight | The flight phase from the liftoff to the touchdown |
| Spool-down | The flight phase after the touchdown: the throttle cut, AUTOROTATION and OFF |
| Governor, ESC and power, Battery, Vibration and filters, Cyclic tracking error, Tail, Log and configuration | The areas of the Analysis verdict. Not "PID tracking", "Cyclic tracking" or "setup": *tracking* alone is an *-ing* word, and *setup* is not approved |
| CLI file | The tab of the export panel |
| Copy commands | The button that copies the CLI script to the clipboard |
| Save CLI file | The button that saves the CLI script as a text file |

## Terms

One term for each item (Rule 1.11).

| Write | For | Do not write |
|---|---|---|
| time delay | the time between the setpoint and the gyro, or the time that a filter adds | `lag`, `delay` alone |
| tracking error | the difference between the setpoint and the gyro, as a percentage of the setpoint | error alone, when you mean the tracking error |
| gyro noise | the vibration in the gyro signal | `noise` alone (STE *noise* is a sound) |
| notch filter, RPM notch filter, dynamic notch filter, static notch filter | a notch filter of the gyro | `notch` alone (STE *notch* is a V-shaped cut) |
| low-pass filter | a low-pass filter of the gyro or of the D-term | LPF in a sentence |
| spectrum, spectra | the power or the amplitude at each frequency | |
| D-term | the D part of the PID output | |
| configuration | one PID profile with one exact set of the values that change the flight (datasets.cjs). The views write "Configuration A" | dataset (a word of the code only) |
| filter values from the flight logs, the analysis of the filter values | the filter search of `filter_tune.cjs` (worker command `filterTune`). The button is "Find the best filter values" | search, filter calculation |
| item | one check and axis in the overview of the Analysis view (`catalog.issues`) | issue |
| PID profile | PID profile 2 (the number that the Configurator shows, 1 to 6). In CLI text only: `profile 1` (0 to 5) | `profile` alone, P2 |
| PID profile unknown | the PID profile before the first switch, when the log does not tell which PID profile was active at arming | profile 0, `arming` profile |
| rate profile | the profile of the rates | `profile` alone |
| headspeed | the speed of the main rotor in rpm | `gov` speed, rotor rpm |
| governor | the governor of the flight controller | `gov` |
| tail output limit | the limit of the tail output (mixer[2]) | |
| authority | the control force that a rotor can make. At its output limit, the tail does not have sufficient authority (SPEC3 B: never a calibration problem) | |
| tail torque assist | the help of the main motor for the tail (`gov_tta_gain`). Write it out, never TTA | TTA |
| voltage decrease for each 1 A | the battery voltage decrease for each 1 A of battery output, in mΩ (check P2) | sag, internal resistance |
| log | the noun only: the record of one flight in the blackbox | `log` as a verb: write *record* |
| flight log | a log with one or more flights | |
| bench run | a log with no flight. The analysis does not use it | test on the bench, `bench` log |
| flight | the time from the liftoff to the touchdown. A log can have more than one flight | `flight` for a log |
| liftoff, touchdown | the start and the end of a flight | `takeoff` |
| flight phase | one of the five parts of a flight log: idle, spool-up, ground, flight and spool-down. The names in the code are `idle`, `spoolup`, `ground`, `flight`, `spooldown` | phase alone in a text that also shows the phase of a signal |
| phase | the phase of a signal or of a frequency response, in deg | |
| handover | the change of the governor from SPOOLUP to ACTIVE | |
| motor kick | a sudden step of `motor[0]` or of the headspeed that the throttle does not cause | `uncommanded` step |
| yaw kick | the sudden yaw movement after a collective step (check T6) | |
| sync loss | a sudden decrease of the headspeed at a constant throttle: the ESC is not in step with the motor | `desync` |
| ground resonance | an oscillation of roll or pitch on the skids before the liftoff (check C15) | |
| export | the technical verb of the panel that writes the CLI script. The app writes a file or the clipboard, and it does not send data to the flight controller | |
| check | the noun only: check C12 | `check` as a verb: write *examine*, *make sure that*, *measure* |
| result | what a check finds | `finding` |
| period | a part of the flight | `block`, `span`, `episode`, `stretch` |
| period at the limit | the samples of a control output at 0.5 % of its limit or nearer (checks L1 to L7) | `saturation event`, `clamp` |
| collective command | the collective that the stick or the rescue commands (`mixer[3]`); its maximum is the largest value in flight that the collective stays at (check L7) | |
| rescue, pull-up | the rescue mode of the flight controller, and its first part (the firmware state PULLUP) | `bailout` for a rescue |
| large load | a load that the motor cannot hold at full throttle: the headspeed decreases with the throttle at its limit (checks G19, L1) | `overload`, `bog` |
| transmitter | the radio of the pilot, which sends the stick and switch commands | `radio`, `TX` |
| CLI dump | the text of `diff all` that the pilot saved before. An optional input: the log is the only necessary input (user rule 2026-10-06). No text tells the pilot to load a CLI dump, or to connect to the flight controller, for the analysis. A text about a CLI dump shows only when the pilot loaded one. The "CLI file" export, with its `diff all` step before the commands, is a different item | `diff` alone, configuration file |
| not recorded in the log | a value that the log header and the data do not record (the coverage status `not-in-log`): "The log does not record these values. Thus, the analysis cannot examine them." If a flight can record the value, the text says how: "The log header records the values of PID profile 2 only when the pilot arms the helicopter in PID profile 2." | "CLI dump necessary" |

## Gear ratios

The gear ratios in the configuration are correct (the project rule "Gear ratios" in `CLAUDE.md`). The texts
say so, and no text doubts them.

- **Write this.** These sentences pass the lint, and the texts can use them as they are:
  - "The gear ratios in the configuration are correct."
  - "This line is not a rotor harmonic. Thus, it is a resonance."
  - "Use a notch filter for this line: the dynamic notch filter, or a static notch filter at a constant frequency."
  - "Examine the airframe for a mechanical vibration at 112 Hz."
  - For check G12: "Examine the `motor_poles` value and the RPM sensor."
- **Do not write this.** Each of these fails the GEAR check:
  - a gear ratio, a pulley, a tooth count or the drive train together with *incorrect*, *not correct*, *error*, *examine*,
    *measure*, *compare*, *change*, *make sure* or *possibly* ("Examine the gear ratios", "Incorrect headspeed (motor poles or
    gear ratio)", "Compare the line with the tooth count")
  - a condition on a correct gear ratio ("The RPM filters are accurate only with the correct gear ratio")
- **What the lint cannot see.** A text that doubts a gear ratio without one of these words. Read the text again.

## Substitutions

The words that our texts used most before the STE pass, with the STE words that replace them. The full denylist, with an
alternative for each word, is `deny` in the vocabulary file. Source: RE is the list of recurring errors in the introduction of
Part 2, D a dictionary entry, R an example in a rule, Inf our choice by the method of Rule 1.2 (the word is not in the
dictionary), Project a term of this project (section "Terms"). The lint makes sure that each word in the first column is in the denylist and that the second column is STE.

| Do not write | Write | Source |
|---|---|---|
| `ensure`, `verify`, `confirm` | make sure that | RE, D |
| `correction` | change ("The full change is an increase of 62.") | Inf |
| `search` | analysis ("the analysis of the filter values") | Inf |
| `issue` | item ("the list of items for the overview") | Inf |
| check (as a verb) | make sure that, measure, examine, do a check | RE, D, R 3.7 |
| test (as a verb), `perform`, `utilize` | do a test, do, use | RE, D |
| about (for a number) | approximately (STE *about* is "concerned with") | D |
| `require`, `required`, `need` | necessary | RE, D |
| `indicate` | show, identify | RE, D |
| `may`, `would`, `could`, `might` | can, possibly | D, Inf |
| `should`, `shall` | must | RE, D |
| `exceed`, `beyond`, above (a value) | more than | D, R 9.2 |
| below (a value), `under` | less than | D, R 9.2 |
| `over` | more than (a value), during or in (a time) | D, Inf |
| `within`, `per`, `via`, `toward` | in, or less, for each, through, to | D |
| `few`, `fewer`, `several` | the number, less, some | D, RE, Inf |
| `both`, `any` | the two, (no word) | D, RE |
| `however`, `therefore`, `whether`, `now` | but, thus, if, at this time | RE, D |
| since (for a cause) | because | D |
| `avoid`, `allow`, `permit` | prevent, let | RE, D |
| `reduce`, `raise` | decrease, increase | D |
| lower (for a value) | decrease (STE *lower* is "move down") | D, R 9.2 |
| `compute`, `detect`, `exclude` | calculate, find, not include | D |
| estimate (as a verb) | make an estimate | D |
| `match`, `differ` | agree, be different | D |
| display (as a verb), view (as a verb) | show, see | D |
| `logged`, `logging` | record (v), the log | D |
| note (as a verb), `track` | record, monitor | D |
| `finding`, `findings` | result, results | D |
| `setting`, `settings` | value, parameter, adjustment | D |
| `state`, `status` | condition | D, Inf |
| `present`, `absent` | is (be), missing | D |
| `normal`, `steady`, `wrong`, `valid` | usual, stable, incorrect, correct | D |
| `significant`, `enough`, `probable` | important, sufficient, very possible | D |
| `appear`, `expect`, `assume` | show, possible, think | D |
| `suggest`, `likely`, `seem` | recommend, it is possible that, show | Inf |
| `say`, `means` | tell, show | Inf |
| `fix`, `describe`, `explain` | repair, give, tell | D |
| `reason`, `evidence`, `factor` | cause, indication, cause | D |
| `main` (not in a technical noun) | primary | RE |
| `further`, `repeat` | more, do again | RE |
| `analyze`, `analyse` | do the analysis | D, Inf |
| `skip`, `skipped`, `threshold` | do not do, not done, limit | Inf |
| e.g., i.e., etc., `vs` | for example, that is, a list, and or against | GR-6 |
| `delay`, `lag` | time delay | Project |
| `notch`, `noise` (alone) | notch filter, gyro noise | Project, D |
| `profile` (alone) | PID profile, rate profile | Project, D |
| `block`, `span` | period | Inf |
| `fixed`, `stability` | constant, stable | Inf, D |
| `takeoff`, `desync`, `uncommanded` | liftoff, sync loss, that the throttle does not cause | Project, Inf |
| `spoolup`, `spooldown` (in a text) | spool-up, spool-down | Project |
| `arming` | when the pilot arms the helicopter | D (ARM is a verb) |
| `governed` | with the governor in the ACTIVE condition | Inf |
| `global` (alone), `tick`, `selector` | global value, select, menu | Project, Inf |
| `restart`, `reboot`, `batch` | start again, start again, group | D, Inf |
| `confidence`, `medium`, `partly` | give the SE or the number of signals that agree, moderate, not fully | Inf, D |
| `configured` | in the configuration ("The gear ratios in the configuration are correct.") | Inf |
| `diff` | CLI dump (`diff all`) | Inf |
| `caveat`, `custom`, `relative`, `recovery` | note, that you set, a percentage of, increase to the target again | Inf |

UI element names are technical nouns of category 10 (quoted text) and category 19. Write each name as the screen shows it, in
quotation marks: click "Start the analysis". Use one name for each element, and a technical verb of category 2 for the action.

## Technical nouns

Our technical nouns, by the categories of Rule 1.5. A term of more than one word is one item: the lint matches it first, so
*main* is correct in *main rotor* and *notch* in *notch filter*. Add a term only if the item has no approved word, and use the
term that Rotorflight uses (Rule 1.8).

| Category | Name | Technical nouns |
|---|---|---|
| 1 | Parts | `accelerometer`, `actuator`, `antenna`, `arm switch`, `battery`, `battery pack`, `bearing`, `belt`, `blade`, `blade grip`, `cell`, `connector`, `damper`, `ESC`, `flight controller`, `gear`, `gyro`, `gyro sensor`, `linkage`, `motor`, `pack`, `pinion`, `pole`, `pulley`, `receiver`, `rotor blade`, `sensor`, `servo`, `shaft`, `skid`, `slider`, `stick`, `swash plate`, `swashplate`, `switch`, `tail blade`, `tail slider`, `tooth`, `transmitter`, `wire` |
| 2 | Machines and their parts | `airframe`, `helicopter`, `main rotor`, `rotor`, `tail`, `tail boom`, `tail rotor` |
| 3 | Tools and support equipment | `bench` |
| 6 | Systems, functions and configurations | `angle mode`, `autorotation`, `bailout`, `band-pass`, `band-pass filter`, `bank`, `board alignment`, `center trim`, `channel`, `collective`, `compensation`, `cross-coupling`, `cyclic`, `dynamic notch filter`, `failsafe`, `feedforward`, `filter`, `flight mode`, `governor`, `governor mode`, `gyro alignment`, `gyro filter`, `handover`, `high speed integral`, `high-pass`, `high-pass filter`, `horizon mode`, `I-term relax`, `inertia precompensation`, `level mode`, `loop stall`, `low-pass`, `low-pass filter`, `mixer`, `motor timing`, `motorized tail`, `notch filter`, `PID controller`, `PID loop`, `PID mode`, `pitch compensation`, `precompensation`, `rescue`, `rescue mode`, `RPM filter`, `RPM notch filter`, `setpoint`, `setpoint boost`, `static notch filter`, `stop gain`, `swash phase`, `swash ring`, `swash trim`, `tail center trim`, `tail output limit`, `tail precompensation`, `tail torque assist`, `telemetry`, `throttle`, `throttle hold`, `trainer mode`, `trim`, `voltage compensation` |
| 7 | Mathematics, science and engineering | `acceleration`, `alias`, `authority`, `aliasing`, `amplitude`, `angle`, `average`, `band`, `bandwidth`, `bin`, `blade tracking`, `center`, `center of gravity`, `coherence`, `configuration`, `correlation`, `cutoff`, `cutoff frequency`, `D-term`, `D-term noise`, `damping`, `deadband`, `decimation`, `deviation`, `disturbance`, `expo`, `F-term`, `feedback`, `formula`, `frequency`, `frequency response`, `gain`, `gear ratio`, `geometry`, `ground resonance`, `gyro noise`, `harmonic`, `headroom`, `headspeed`, `I-term`, `inertia`, `kick`, `line`, `load`, `margin`, `mean`, `measurement`, `median`, `model`, `moment`, `motor kick`, `motor speed`, `negative`, `Nyquist frequency`, `offset`, `oscillation`, `overshoot`, `P-term`, `peak`, `percentage`, `phase`, `pole count`, `positive`, `power`, `prominence`, `ramp`, `ratio`, `raw`, `raw gyro`, `reaction torque`, `regression`, `reserve`, `resonance`, `response`, `response time`, `rms`, `rotor order`, `rotor speed`, `saturation`, `scale`, `segment`, `sensitivity`, `settling time`, `signal`, `sine wave`, `spectrum`, `standard error`, `step response`, `target`, `term`, `thrust`, `time delay`, `torque`, `tracking error`, `transfer function`, `transmission`, `uncertainty`, `undershoot`, `voltage`, `window`, `yaw kick` |
| 8 | Navigation and flight | `air`, `altitude`, `attitude`, `axis`, `climb`, `flip`, `heading`, `hover`, `landing`, `liftoff`, `maneuver`, `pirouette`, `pitch`, `roll`, `stop`, `touchdown`, `yaw` |
| 9 | Numbers, units and time | `eight`, `five`, `four`, `half`, `hour`, `minute`, `nine`, `percent`, `rpm`, `second`, `seven`, `six`, `ten`, `three`, `two`, `zero` |
| 11 | Persons, organizations and products | `author`, `Configurator`, `FlyRotor`, `Gaui`, `pilot`, `Rotorflight` |
| 15 | Documents and parts of documents | `caution`, `chart`, `colon`, `column`, `comma`, `description`, `diagram`, `documentation`, `font`, `glossary`, `graph`, `hyphen`, `imperative`, `introduction`, `label`, `legend`, `list`, `marker`, `note`, `overview`, `page`, `parenthesis`, `plot`, `quotation mark`, `recommendation`, `reference`, `rule`, `section`, `semicolon`, `sentence`, `strip chart`, `summary`, `table`, `technical noun`, `technical verb`, `text`, `title`, `tooltip`, `warning`, `word` |
| 16 | Operational conditions | `bench run`, `flight phase`, `idle`, `spool-down`, `spool-up`, `sync loss` |
| 17 | Colors | `black`, `blue`, `gray`, `green`, `orange`, `red`, `white`, `yellow` |
| 19 | Computers and software | `autotune`, `replay`, `Alt`, `analysis`, `prerequisite`, `tuning block`, `app`, `bar`, `blackbox`, `box`, `button`, `canvas`, `CLI block`, `CLI dump`, `clipboard`, `clock`, `Cmd`, `command`, `comment`, `coverage`, `craft name`, `Ctrl`, `cursor`, `debug mode`, `default`, `dialog`, `dump`, `feature`, `field`, `file`, `firmware`, `flight log`, `frame`, `global value`, `header`, `icon`, `key`, `link`, `log`, `log event`, `log file`, `log header`, `log lens`, `log rate`, `log viewer`, `log-profile pair`, `Markdown`, `memory`, `menu`, `module`, `mouse`, `mouse wheel`, `panel`, `parameter`, `parser`, `PID profile`, `preset`, `rate profile`, `scope`, `screen`, `script`, `Shift`, `tab`, `time jump`, `timeline`, `token`, `toolbar`, `toolkit`, `tuning`, `version`, `viewer`, `wheel` |

## Technical verbs

Our technical verbs, by the categories of Rule 1.12.

| Category | Name | Technical verbs |
|---|---|---|
| 2a | Computer input and output | `click`, `enter`, `press`, `type` |
| 2b | User interface | `copy`, `delete`, `disable`, `drag`, `enable`, `export`, `filter`, `paste`, `save`, `scroll`, `sort`, `zoom` |
| 2c | System operations | `replay`, `commit`, `debug`, `decode`, `load`, `process`, `update` |
| 3a | Engineering | `compensate` |
| 3d | Navigation and flight | `fly`, `hover`, `land`, `trim` |

## The lint

```sh
node --test test/ste_text.test.cjs                      # about 30 s: it runs the tests of the other parts again to read their texts
STE_LINT_OUT=ste.json node --test test/ste_text.test.cjs   # also writes every hit
AUTOTUNE_REAL_LOG=<Gaui dump .BBL> node --test test/ste_text.test.cjs   # also the TuningResults of the real log (slow)
```

- **Failing checks:** LEN, SEMI, CONTR, LATIN, DENY, ING, LIMIT, GB, TENSE, THAT, NOTEIMP, MATH, PARA, CASE, SAFE, VOCAB and
  GEAR. **Report only:**
  PASSIVE, POS, NOUN4, SYN. The test prints the counts for each check and each source.
- **The sources follow the tree.** The lint finds our DOM scripts (`js/tuning_dialog.js`, `js/log_lens.js`, every
  `js/*_view.js`) and the globals that they declare, the check ids of `catalog.cjs`, the exports of `advice.cjs` and the tests of
  each part when it runs. A part that is missing, or a module that throws, is a line in the table, not a stop of the other
  sources. A test of an other part that fails in the harvest is a diagnostic: the lint reads the texts that the test made.
- **Data is not app text.** A string that the harness gives to a view (a TuningResult, a file name) is data. The lint reads it
  where the toolkit makes it, and it shows it in the "data given to" lines only as information.
- **A word that the lint does not know (VOCAB).** Find it in the standard. If it is approved, add the headword to `approved`
  with its part of speech and the forms that the dictionary lists. If it is not approved, use the STE alternative, and add the
  word to `deny` with that alternative. If it names an item that has no approved word, add it to `technicalNouns` (or
  `technicalVerbs`) with its category, and add it to the table above. Do not copy definitions or examples from the standard.
  A `null`, `undefined` or `NaN` in a text is a code error: a value is missing.
- **What the lint cannot check:** the approved meaning of a word (*noise*, *authority*, *about*), one instruction in each
  sentence, clear and concrete text, the sequence of the information and the topic of a paragraph, the choice of a technical
  noun, pronouns and *with*, most phrasal verbs, an instruction in a note that does not start with a verb, and a doubt about a
  gear ratio in words that the GEAR check does not know. Read the text again.
