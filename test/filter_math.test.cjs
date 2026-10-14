'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const vm = require('node:vm'), crypto = require('node:crypto');
const M = require('../tools/autotune/filter_math.cjs');
const root = path.join(__dirname, '../tools/autotune');
const unary = ['sin', 'cos', 'tan', 'atan', 'log', 'log2', 'log10', 'exp', 'sqrt'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
test('portable libm is accurate over filter, FFT and spectral calculation inputs', () => {
    for (const name of unary) for (let i = 0; i < 2000; i++) {
        const x = ['log', 'log2', 'log10', 'sqrt'].includes(name) ? 10 ** (-12 + 24 * i / 1999)
            : name === 'exp' ? -700 + 1400 * i / 1999 : -1e4 + 2e4 * i / 1999;
        const expected = Math[name](x), actual = M[name](x);
        assert.ok(Math.abs(actual - expected) <= 4 * Number.EPSILON * Math.abs(expected) + Number.MIN_VALUE, `${name}(${x})`);
    }
    for (let i = 1; i < 1000; i++) {
        const x = i / 37, y = 10 * Math.sin(i);
        for (const [name, args] of [['pow', [x, y]], ['atan2', [x - 13, y]], ['hypot', [x, y, x / 1e6]]]) {
            const expected = Math[name](...args), actual = M[name](...args);
            assert.ok(Math.abs(actual - expected) <= 4 * Number.EPSILON * Math.abs(expected), `${name}(${args})`);
        }
    }
});
test('portable math preserves NaN, infinities and signed zeros', () => {
    const values = [-Infinity, -2, -1, -0, 0, .5, 1, 2, Infinity, NaN];
    for (const name of unary) for (const x of values) {
        const a = M[name](x), b = Math[name](x);
        if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0 || b === 0) assert.ok(Object.is(a, b), `${name}(${x})`);
    }
    for (const x of values) for (const y of values) {
        const a = M.pow(x, y), b = Math.pow(x, y);
        if (!Number.isFinite(a) || !Number.isFinite(b) || a === 0 || b === 0 || Math.abs(x) === 1) assert.ok(Object.is(a, b), `pow(${x}, ${y})`);
        const c = M.atan2(x, y), d = Math.atan2(x, y);
        assert.ok(Object.is(c, d), `atan2(${x}, ${y})`);
    }
});
test('portable hypot scales extreme magnitudes and handles exceptional arguments', () => {
    assert.equal(M.hypot(3, 4, 12), 13);
    assert.ok(Math.abs(M.hypot(3e200, 4e200) / 5e200 - 1) <= Number.EPSILON);
    assert.ok(Math.abs(M.hypot(3e-200, 4e-200) / 5e-200 - 1) <= Number.EPSILON);
    assert.equal(M.hypot(NaN, Infinity), Infinity);
    assert.ok(Number.isNaN(M.hypot(1, NaN)));
    assert.ok(Object.is(M.hypot(-0, 0), 0));
    assert.equal(M.hypot(), 0);
});
test('worker-only loading never uses host transcendental functions or changes global Math', () => {
    const text = fs.readFileSync(path.join(root, 'filter_math.cjs'), 'utf8');
    const context = vm.createContext({ module: { exports: {} } });
    vm.runInContext(`for (const name of ${JSON.stringify([...unary, 'atan2', 'pow', 'hypot'])}) Math[name] = () => { throw Error('host math'); };`, context);
    vm.runInContext(text, context);
    const workerMath = context.module.exports;
    for (const name of unary) assert.equal(workerMath[name](.73), M[name](.73));
    for (const name of ['atan2', 'pow', 'hypot']) assert.equal(workerMath[name](.73, 1.32), M[name](.73, 1.32));
    assert.throws(() => vm.runInContext('Math.sin(1)', context), /host math/);
    assert.equal(M.PI, Math.PI);
    assert.equal(M.floor(-1.5), -2);
    assert.ok(Object.isFrozen(M));
});
test('portable math artifact has no host imports and matches its source manifest', () => {
    const metadata = JSON.parse(fs.readFileSync(path.join(root, 'math/manifest.json')));
    const text = fs.readFileSync(path.join(root, 'filter_math.cjs'), 'utf8');
    const bytes = Buffer.from(text.match(/create\(decode\('([A-Za-z0-9+/=]+)'\)\)/)[1], 'base64');
    assert.equal(sha(bytes), metadata.wasmSha256);
    assert.equal(bytes.length, metadata.wasmBytes);
    assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(bytes)), []);
    assert.equal(sha(fs.readFileSync(path.join(root, 'math/portable_math.c'))), metadata.sourceSha256);
    const runtime = fs.readFileSync(path.join(root, 'math/runtime.cjs'), 'utf8').replace(/\nmodule\.exports = \{ create \};\s*$/, '');
    assert.equal(sha(runtime), metadata.runtimeSha256);
    assert.ok(text.includes(runtime));
    assert.ok(metadata.flags.includes('-ffp-contract=off'));
    assert.ok(metadata.flags.includes('-fno-fast-math'));
});
