'use strict';

/**
 * A flight-test proposal from the existing quantitative tuning rules. This is
 * deliberately not a replay of a changed closed loop: its actuator and plant
 * are absent. No recorded check becomes cleared by making a proposal.
 *
 * tune({ analysis: TuningResult, configuration: id, step }) is pure. It takes
 * the first eligible atomic recommendation in advice's tuning order, retaining
 * the exact CLI, evidence, uncertainty, prerequisites and freshness flags.
 */
const advice = require('./advice.cjs');
const RULES = Object.freeze({ groupsPerTest: 1, maxRelativeStep: 0.20,
    source: 'Pipeline choice: test one atomic change before proposing the next step.' });
const PARAMETERS = {
    governor: /^gov_(?:[pidf]_gain|gain)$/,
    cyclic: /^(?:roll|pitch)_[pidfbo]_gain$/,
    tail: /^yaw_[pidfb]_gain$/,
    cycomp: /^(?:pitch_collective_ff_gain|cyclic_cross_coupling_gain|cyclic_cross_coupling_ratio)$/,
    tailcomp: /^(?:yaw_(?:cw_stop_gain|ccw_stop_gain|collective_ff_gain|cyclic_ff_gain|inertia_precomp_gain)|gov_tta_gain)$/
};
const finite = v => typeof v === 'number' && Number.isFinite(v);
const own = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
const nodeOf = r => r.node || r.area;
const LIMITATION = 'The actuator is not in the loop during autotune. The app cannot measure the new control response from this log. A flight test is necessary.';

// Maneuver types follow Rotorflight 2.3 tuning documentation. Counts and pauses
// are collection targets for this toolkit, not physical limits or proof of a tune.
// https://rotorflight.org/docs/Tuning/Tune-Governor
// https://rotorflight.org/docs/Tuning/Tuning-description
// https://rotorflight.org/docs/Tuning/Tune-Feedforward
function flightPlan(recommendations) {
    const maneuvers = new Map(), selected = (recommendations || []).filter(r => r.severity === 'action' &&
        r.scope === 'profile' && Number.isInteger(r.profile) && r.profile >= 1 && r.profile <= 6 &&
        (r.cli || []).length && !(r.blockedBy || []).length && !(r.causes || []).some(c => c.holds !== false) &&
        PARAMETERS[nodeOf(r)] && PARAMETERS[nodeOf(r)].test(r.parameter || '') && r.from !== r.to);
    function add(r, kind, title, purpose, instructions) {
        const key = r.profile + ':' + kind;
        if (!maneuvers.has(key)) maneuvers.set(key, { key, profile: r.profile, title, purpose, instructions,
            parameters: [], configurations: [], recommendations: [] });
        const item = maneuvers.get(key);
        if (!item.parameters.includes(r.parameter)) item.parameters.push(r.parameter);
        if (r.dataset && !item.configurations.includes(r.dataset)) item.configurations.push(r.dataset);
        item.recommendations.push(r.id);
    }
    for (const r of selected) {
        const p = r.parameter, axis = r.axis || (/^roll_/.test(p) ? 'roll' : /^pitch_/.test(p) ? 'pitch' : 'yaw');
        if (/^gov_(?:[pidf]_gain|gain)$/.test(p) || /collective_ff_gain$/.test(p)) {
            add(r, 'collective', 'Collective steps', 'This test measures headspeed error and pitch or yaw movement after a load change.', [
                'At a safe altitude, make a short positive collective step from a stable hover.',
                'Start with a small collective input.',
                'If headspeed and tail control stay stable, do the step again with full positive collective.',
                'After each step, move the collective stick back to the hover position.',
                'Keep the other sticks as stable as possible.',
                'Wait a minimum of 3 seconds between steps.',
                'Do the step a minimum of 3 times.'
            ]);
        } else if (p === 'yaw_inertia_precomp_gain') {
            add(r, 'headspeed', 'Headspeed changes', 'This test measures yaw movement during a governor headspeed change.', [
                'In a stable hover, select the next usual headspeed.',
                'Keep yaw and collective inputs as stable as possible.',
                'Before the next change, wait until the headspeed is stable.',
                'Do the headspeed change a minimum of 3 times.',
                'Record the PID profile used before and after each change.'
            ]);
        } else if (p === 'gov_tta_gain') {
            add(r, 'tail-load', 'Tail load', 'This test measures headspeed and tail control during a constant yaw input.', [
                'From a stable hover, apply a moderate yaw stick input.',
                'Hold the yaw input for about 2 seconds.',
                'Move the yaw stick to center.',
                'Do the maneuver again in the opposite direction.',
                'Keep collective as stable as possible.',
                'Do the maneuver in each direction a minimum of 3 times.'
            ]);
        } else {
            const axes = /cyclic_(?:cross_coupling|ff)/.test(p) ? ['roll', 'pitch'] : [axis];
            for (const ax of axes) {
                const ff = /_(?:f)_gain$/.test(p) && ax !== 'yaw';
                add(r, ax + (ff ? '-rate' : '-steps'), ff ? (ax === 'roll' ? 'Constant-rate rolls' : 'Constant-rate flips') : `${ax[0].toUpperCase() + ax.slice(1)} steps and stops`,
                    ff ? 'This test measures feedforward error at a constant rate.' : 'This test measures tracking error, time delay and oscillation after the stick moves to center.',
                    ff ? [
                        `If you cannot keep full control in a ${ax === 'roll' ? 'roll' : 'flip'}, do not do this test.`,
                        'Fly at a safe altitude.',
                        `During a ${ax === 'roll' ? 'roll' : 'flip'}, apply 70 % ${ax} stick or more.`,
                        'Keep the input constant for a minimum of 0.5 seconds.',
                        `Move the ${ax} stick to center to stop the movement.`,
                        'Do the maneuver in each direction a minimum of 3 times.'
                    ] : [
                        `At a safe altitude, make a short ${ax} stick input.`,
                        'Start with a small input.',
                        `Move the ${ax} stick to center to stop the movement.`,
                        'Keep the other sticks as stable as possible.',
                        'Wait a minimum of 3 seconds between inputs.',
                        'Do the maneuver in each direction a minimum of 3 times.'
                    ]);
            }
        }
    }
    return { limitation: LIMITATION, preparation: selected.length ? [
        'Set the Blackbox log rate to 1 kHz or more.',
        'Record setpoint, gyro, PID terms, mixer output, headspeed and throttle.',
        'Keep the same PID profile and headspeed during each stick test.',
        'Start with a short hover test.',
        'If oscillation increases or the helicopter does not follow your inputs, land the helicopter.',
        'If you stop the test because of a control problem, set the previous values again before the next flight.'
    ] : [], maneuvers: [...maneuvers.values()], followup: selected.length ? [
        'Save the flight log and the parameter values after landing.',
        'Record a minimum of 3 flight logs with the same values.',
        'The app uses these logs to calculate the uncertainty between flights.',
        'Load the new log.',
        'Before the next change, compare the recorded configurations.'
    ] : [] };
}

function inConfiguration(x, d) {
    const profile = own(x, 'pidProfile') ? x.pidProfile : x.profile;
    if (x.dataset) return x.dataset === d.id && (!profile || profile === d.pidProfile);
    // Unscoped results cannot distinguish two configurations of one profile.
    return false;
}

function stepLimit(name, from, to) {
    if (name === 'pitch_collective_ff_gain' && from === 0 && to > 0) return advice.RULES.compensationStart;
    const absolute = { gov_f_gain: advice.RULES.govSteps.F, gov_i_gain: advice.RULES.govSteps.I,
        gov_p_gain: advice.RULES.govSteps.P, yaw_d_gain: advice.RULES.tailDStep, gov_tta_gain: advice.RULES.ttaStep };
    return to > from && absolute[name] ? Math.max(Math.abs(from) * RULES.maxRelativeStep, absolute[name])
        : Math.max(1, Math.abs(from) * RULES.maxRelativeStep); // one integer unit, as advice.change
}

const held = r => (r.blockedBy || []).length > 0 || (r.causes || []).some(c => c.holds !== false);

function eligibility(r, d, step, conditional = false) {
    if (r.severity !== 'action') return 'This result does not give a parameter change.';
    if (r.scope !== 'profile' || r.profile !== d.pidProfile || !inConfiguration(r, d)) return 'The PID profile or configuration does not agree.';
    if (!conditional && held(r)) return 'Correct the cause or the previous tuning step first.';
    if (!PARAMETERS[step].test(r.parameter || '')) return 'A different check is necessary for this parameter.';
    if (!finite(r.from) || !Number.isInteger(r.to) || !own(d.values, r.parameter) || d.values[r.parameter] !== r.from)
        return 'The recorded value is unknown or does not agree with this change.';
    const range = advice.RANGE[r.parameter];
    if (!range || r.to < range[0] || r.to > range[1] || r.to === r.from) return 'The new value is out of the parameter range or is the same as before.';
    if (Math.abs(r.to - r.from) > stepLimit(r.parameter, r.from, r.to) + 1e-8) return 'The change is more than the step limit.';
    if (!r.rule || !(r.evidence || []).some(e => finite(e.value))) return 'The change has no measured value and rule.';
    const lines = (r.cli || []).map(s => String(s).trim());
    // A prerequisite suppresses CLI generation, not the measured proposal.
    // Other invalid/missing commands are never repaired here.
    if (conditional && held(r) && lines.length === 0) return null;
    if (lines.length !== 2 || lines[0] !== `profile ${d.pidProfile - 1}` || lines[1] !== `set ${r.parameter} = ${r.to}`)
        return 'The CLI text does not agree with this change.';
    return null;
}

function rowOf(r, d) {
    return { name: r.parameter, from: r.from, to: r.to, delta: r.to - r.from,
        percent: r.from === 0 ? null : 100 * (r.to - r.from) / Math.abs(r.from), profile: d.pidProfile,
        source: r.fromSource || d.sources && d.sources[r.parameter] || 'unknown', stale: r.stale || null,
        rule: r.rule, evidence: r.evidence, recommendation: r.id };
}

// Show a prediction only for the complete C7 candidate that actually produced
// it. Rule-based changes have no predicted response. Do not rescale a recorded
// waveform, or relabel measured error as the predicted error of the new gains.
function predictionOf(analysis, d, selected) {
    if (!selected.length || selected.some(r => r.confidence !== 'predicted')) return null;
    const evidence = selected[0].evidence || [], ids = new Set(evidence.filter(e => e.id === 'C7').map(e => e.fid));
    const decision = (analysis.decisions || []).find(q => q.dataset === d.id && ids.has(q.fid) && q.change);
    if (!decision || !decision.gates || ['V1','V2a','V2b','V3'].some(k => !decision.gates[k] || !decision.gates[k].pass)) return null;
    const changes = decision.changes || [];
    if (changes.length !== selected.length || changes.some(c => !selected.some(r =>
        r.parameter === `${decision.axis}_${String(c.gain).toLowerCase()}_gain` && r.from === c.from && r.to === c.to))) return null;
    if (!Array.isArray(decision.tracking) || decision.tracking.length !== 2 || !decision.tracking.every(finite) ||
        !finite(decision.dTrack) || !finite(decision.seTrack) || decision.seTrack < 0) return null;
    return { axis: decision.axis, tracking: decision.tracking.slice(), delta: -decision.dTrack, se: decision.seTrack,
        band: decision.validBand || [], flights: decision.flights, verifiedInFlight: false };
}

function tune(input) {
    const analysis = input.analysis || {}, step = input.step;
    if (!PARAMETERS[step]) throw new Error('This control tuning step is unknown.');
    const d = ((analysis.datasets || {}).datasets || []).find(q => q.id === input.configuration);
    const result = { version: 1, step, configuration: input.configuration, profile: d && d.pidProfile || null,
        status: 'no-change', verifiedInFlight: false, limitation: LIMITATION,
        recommendations: [], rows: [], proposals: [], prerequisites: [], experiments: [], guidance: [], deferred: [], prediction: null, reason: '', rules: RULES };
    if (!d) result.reason = 'Select one recorded configuration before autotune.';
    else if (!Number.isInteger(d.pidProfile) || d.pidProfile < 1 || d.pidProfile > 6) result.reason = 'The PID profile is unknown. No control change is available.';
    else if (d.analysed === false || !(d.analysedFlightSeconds > 0)) result.reason = 'This configuration has no flight data in the analysis.';
    else if (!analysis.advice || !own(analysis.advice.byDataset, d.id)) result.reason = 'This configuration has no control recommendations. Start the analysis again.';
    if (result.reason) return result;

    const all = analysis.advice.byDataset[d.id], mine = all.filter(r => nodeOf(r) === step), groups = new Map();
    for (const r of mine) {
        const key = r.group || r.id;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(r);
    }
    let selected = [];
    for (const list of groups.values()) {
        let reason = list.map(r => eligibility(r, d, step)).find(Boolean);
        if (!reason && list.some(r => r.group && r.groupSize !== list.length)) reason = 'All changes of this group are necessary for the model.';
        if (!reason && new Set(list.map(r => r.parameter)).size !== list.length) reason = 'Two changes give values for the same parameter.';
        if (!reason && selected.length) reason = 'Test the selected change before this change.';
        if (reason) {
            result.deferred.push({ ids: list.map(r => r.id), title: list[0].title, reason });
            if (list.some(held) && list.every(r => !eligibility(r, d, step, true)) &&
                list.every(r => !r.group || r.groupSize === list.length) && new Set(list.map(r => r.parameter)).size === list.length) {
                // Conditional proposals are display-only. They never enter the
                // draft, default selections, prediction or CLI export.
                result.proposals.push(...list.map(r => Object.assign({}, r, { cli: [], conditional: true,
                    row: rowOf(r, d), verifiedInFlight: false })));
            }
            continue;
        }
        selected = list;
    }
    result.recommendations = selected.map(r => Object.assign({}, r, { id: 'control:' + r.id, group: r.group ? 'control:' + r.group : null, controlTune: true, verifiedInFlight: false,
        caveats: (r.caveats || []).concat(LIMITATION), rule: r.rule + '\n' + LIMITATION }));
    result.rows = selected.map(r => rowOf(r, d));
    // Diagnostic problems can also have a concrete upstream remedy, even when
    // these measurements do not identify a control-gain target yet.
    const blocked = mine.filter(r => held(r) && ['action','check'].includes(r.severity));
    const upstream = new Set(blocked.flatMap(r => (r.holds || []).concat(r.gate && r.gate.held || [])));
    const causeIds = new Set(blocked.flatMap(r => (r.causes || []).filter(c => c.holds !== false).flatMap(c => c.ids || [])));
    for (const r of all) if ((r.evidence || []).some(e => causeIds.has(e.id))) upstream.add(nodeOf(r));
    result.prerequisites = all.filter(r => nodeOf(r) !== step && upstream.has(nodeOf(r)) && ['action','check'].includes(r.severity));
    // A smaller pilot input does not repair an output limit. Preserve each
    // diagnosis, including missing-data instructions, even beside a gain trial.
    // A proposed change must not hide an independent unresolved problem.
    result.guidance = mine.filter(r => ['check','watch'].includes(r.severity) && !selected.includes(r));
    result.prediction = predictionOf(analysis, d, selected);
    result.status = selected.length ? 'flight-test-required' : result.proposals.length || result.prerequisites.length ? 'prerequisites-required'
        : result.guidance.some(r => r.severity === 'check') ? 'diagnosis-required' : 'no-change';
    result.reason = selected.length ? 'Test this change before the next tuning step.'
        : result.proposals.length ? 'These parameter changes must wait. Complete the prerequisite checks. Then do the analysis of a new flight before you use them.'
        : result.prerequisites.length ? 'Complete the prerequisite checks. Then record a new flight to measure this control problem again.'
        : result.status === 'diagnosis-required' ? 'The problem is not corrected. These measurements do not identify a gain change. Examine the measurements and next steps below.'
        : result.guidance.length ? 'These measurements do not show a necessary gain change. The results to monitor and their limits are below.'
        : 'No measured control problem gives a parameter change for this configuration.';
    result.flightPlan = flightPlan(result.recommendations);
    return result;
}

module.exports = { RULES, LIMITATION, tune, predictionOf, eligibility, flightPlan };
if (require.main !== module) return;
