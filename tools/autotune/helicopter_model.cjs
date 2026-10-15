'use strict';

// Mass properties and the geometry prior of known helicopters (inertia and rotor spin inertia). The digital twin
// (heli_twin.cjs) uses craftPrior() for its inertia prior. See docs/HELICOPTER_SYSID_MODEL.md.
const finite = x => typeof x === 'number' && Number.isFinite(x);

// Body-aligned boxes and an azimuth-averaged pair of radial blades. Positions
// use forward/left/up metres from an arbitrary common origin. The tensor is
// recentered at the combined centre of mass, including its products of inertia.
function massProperties(components) {
    if (!Array.isArray(components) || !components.length) throw new Error('The mass components are missing.');
    const pieces = components.map(c => {
        if (!c || !finite(c.massKg) || c.massKg <= 0 || !Array.isArray(c.positionM) ||
            c.positionM.length !== 3 || !c.positionM.every(finite)) throw new Error('A mass component is invalid.');
        let diagonal, spin = 0;
        if (c.shape === 'box' && Array.isArray(c.dimensionsM) && c.dimensionsM.length === 3 &&
            c.dimensionsM.every(x => finite(x) && x > 0)) {
            diagonal = [0, 1, 2].map(axis => c.massKg / 12 * c.dimensionsM.reduce((sum, x, i) => sum + (axis === i ? 0 : x * x), 0));
        } else if (c.shape === 'radial-blade-pair' && finite(c.rootRadiusM) && finite(c.tipRadiusM) &&
            c.rootRadiusM >= 0 && c.tipRadiusM > c.rootRadiusM) {
            // Integral of radius squared for uniform radial mass density.
            spin = c.massKg * (c.tipRadiusM ** 2 + c.tipRadiusM * c.rootRadiusM + c.rootRadiusM ** 2) / 3;
            diagonal = [spin / 2, spin / 2, spin];
        } else throw new Error('A mass component shape is invalid.');
        return { component: c, diagonal, spin };
    });
    const massKg = pieces.reduce((sum, p) => sum + p.component.massKg, 0);
    const centreOfMassM = [0, 1, 2].map(axis => pieces.reduce((sum, p) => sum + p.component.massKg * p.component.positionM[axis], 0) / massKg);
    const tensor = Array.from({ length: 3 }, () => [0, 0, 0]);
    for (const p of pieces) {
        const offset = p.component.positionM.map((x, i) => x - centreOfMassM[i]);
        const squaredDistance = offset.reduce((sum, x) => sum + x * x, 0);
        for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
            tensor[i][j] += (i === j ? p.diagonal[i] : 0) + p.component.massKg * ((i === j ? squaredDistance : 0) - offset[i] * offset[j]);
    }
    return { massKg, centreOfMassM, tensor, diagonal: tensor.map((row, i) => row[i]),
        mainRotorSpinInertiaKgM2: pieces.reduce((sum, p) => sum + p.spin, 0) };
}

function craftPrior(craft = '') {
    const name = typeof craft === 'string' ? craft : craft.name || '';
    let source, mass, length, width, height, radius, canonical, components;
    const box = (name, massKg, positionM, dimensionsM) => ({ name, shape: 'box', massKg, positionM, dimensionsM, provenance: 'assumed' });
    const blades = (massKg, positionM, rootRadiusM, tipRadiusM) => ({ name: 'Main blades', shape: 'radial-blade-pair',
        massKg, positionM, rootRadiusM, tipRadiusM, provenance: 'assumed' });
    if (/fireball|havok/i.test(name)) {
        canonical = 'SAB Goblin Fireball 280'; mass = 0.95; length = 0.58; width = 0.12; height = 0.19; radius = 0.313;
        source = 'https://sabusa.com/pdf/GOBLIN_FIREBALL_280_MANUAL_RELEASE_1.0L.pdf';
        components = [box('Body, battery and equipment', 0.83, [0.02, 0, -0.04], [0.18, 0.08, 0.10]),
            box('Tail boom', 0.05, [-0.145, 0, 0], [0.29, 0.016, 0.016]),
            box('Tail assembly', 0.03, [-0.30, 0, 0], [0.05, 0.02, 0.04]),
            blades(0.04, [0, 0, 0.02], 0.033, radius)];
    } else if (/gaui.*x4|x4.*gaui|x4\s*ii/i.test(name)) {
        canonical = 'GAUI X4 II'; mass = 2.3; length = 0.90; width = 0.165; height = 0.32; radius = 0.505;
        source = 'https://nexrc.com/image/data/Brand/Gaui/X4%20II/GAUI%20X4%20II%20Instruction%20Manual.pdf';
        components = [box('Body, battery and equipment', 2.02, [0.03, 0, -0.065], [0.30, 0.12, 0.15]),
            box('Tail boom', 0.10, [-0.24, 0, 0], [0.46, 0.022, 0.022]),
            box('Tail assembly', 0.07, [-0.48, 0, 0], [0.08, 0.035, 0.065]),
            blades(0.11, [0, 0, 0.035], 0.08, radius)];
    } else return { craft: name || 'unknown', knownGeometry: false, inertia: null,
        kind: 'unavailable', identified: false, reason: 'The craft dimensions are unknown.' };
    const properties = massProperties(components), inertia = properties.diagonal;
    return { craft: canonical, knownGeometry: true, source, kind: 'component-geometry-assumption', priorVersion: 2, identified: false,
        massKg: mass, massRangeKg: [mass * 0.7, mass * 1.4], dimensionsM: { length, width, height, rotorRadius: radius },
        components, centreOfMassM: properties.centreOfMassM, axes: 'forward-left-up',
        inertia: { unit: 'kg m2', diagonal: inertia, tensor: properties.tensor,
            definition: 'combined-centre-of-mass-locked-rotor-azimuth-average', range: inertia.map(x => [x * 0.2, x * 3]),
            rangeKind: 'assumed-plausibility-range-not-statistical-confidence' },
        mainRotor: { spinInertiaKgM2: properties.mainRotorSpinInertiaKgM2,
            rangeKgM2: [properties.mainRotorSpinInertiaKgM2 * 0.2, properties.mainRotorSpinInertiaKgM2 * 3],
            alreadyIncludedInLockedInertia: true, identified: false },
        assumptions: ['The flight mass includes an assumed battery mass.',
            'All component masses, positions and dimensions are assumptions.',
            'The main blades have uniform radial mass and an average angular position.',
            'The inertia ranges are assumptions, not confidence intervals.',
            'The log does not identify inertia separately from control torque.'] };
}

module.exports = { massProperties, craftPrior };
if (require.main !== module) return;
