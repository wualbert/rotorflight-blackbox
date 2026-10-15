'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { massProperties, craftPrior } = require('../tools/autotune/helicopter_model.cjs');
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-11 * Math.max(1, Math.abs(expected)), `${actual} != ${expected}`);
const box = (massKg, positionM, dimensionsM) => ({ shape: 'box', massKg, positionM, dimensionsM });

test('component inertia includes parallel-axis products and is invariant to the common origin', () => {
    const components = [box(1, [-1, 0, -1], [1, 1, 1]), box(1, [1, 0, 1], [1, 1, 1])];
    const p = massProperties(components);
    assert.deepEqual(p.centreOfMassM, [0, 0, 0]);
    near(p.tensor[0][0], 7 / 3); near(p.tensor[1][1], 13 / 3); near(p.tensor[2][2], 7 / 3);
    near(p.tensor[0][2], -2); near(p.tensor[2][0], -2);
    const shifted = massProperties(components.map(c => ({ ...c, positionM: c.positionM.map((x, i) => x + [13, -7, 5][i]) })));
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) near(shifted.tensor[i][j], p.tensor[i][j]);
});

test('a uniform blade pair has the radial second moment and equal azimuth-averaged transverse inertia', () => {
    const p = massProperties([{ shape: 'radial-blade-pair', massKg: 2, positionM: [0, 0, 0], rootRadiusM: 0, tipRadiusM: 3 }]);
    assert.deepEqual(p.diagonal, [3, 3, 6]);
    assert.equal(p.mainRotorSpinInertiaKgM2, 6);
    const annular = massProperties([{ shape: 'radial-blade-pair', massKg: 3, positionM: [0, 0, 0], rootRadiusM: 1, tipRadiusM: 2 }]);
    assert.equal(annular.mainRotorSpinInertiaKgM2, 7);
});

test('aircraft assumptions conserve mass, obey inertia scaling and retain uncertainty provenance', () => {
    for (const name of ['SAB Fireball', 'GAUI X4 II']) {
        const p = craftPrior(name), calculated = massProperties(p.components);
        near(calculated.massKg, p.massKg);
        assert.equal(p.identified, false); assert.equal(p.priorVersion, 2);
        assert.equal(p.mainRotor.alreadyIncludedInLockedInertia, true);
        assert.ok(p.components.every(c => c.provenance === 'assumed'));
        assert.match(p.inertia.rangeKind, /not-statistical-confidence/);
        const scaled = massProperties(p.components.map(c => ({ ...c, massKg: c.massKg * 2,
            positionM: c.positionM.map(x => x * 3), dimensionsM: c.dimensionsM && c.dimensionsM.map(x => x * 3),
            rootRadiusM: c.rootRadiusM === undefined ? undefined : c.rootRadiusM * 3,
            tipRadiusM: c.tipRadiusM === undefined ? undefined : c.tipRadiusM * 3 })));
        for (let i = 0; i < 3; i++) {
            near(scaled.diagonal[i], p.inertia.diagonal[i] * 18);
            assert.ok(p.inertia.diagonal[i] > 0);
            assert.ok(p.inertia.diagonal[i] <= p.inertia.diagonal[(i + 1) % 3] + p.inertia.diagonal[(i + 2) % 3]);
        }
        const tensor = p.inertia.tensor;
        assert.ok(tensor[0][0] * tensor[2][2] - tensor[0][2] ** 2 > 0);
        assert.ok(p.inertia.range.every(([lo, hi], i) => lo < p.inertia.diagonal[i] && hi > p.inertia.diagonal[i]));
    }
    assert.equal(craftPrior('unknown').inertia, null);
});

test('invalid geometry cannot silently produce a physical prior', () => {
    for (const c of [box(-1, [0, 0, 0], [1, 1, 1]), box(1, [NaN, 0, 0], [1, 1, 1]),
        box(1, [0, 0, 0], [1, 0, 1]), { shape: 'radial-blade-pair', massKg: 1, positionM: [0, 0, 0], rootRadiusM: 2, tipRadiusM: 1 }])
        assert.throws(() => massProperties([c]), /invalid/);
});
