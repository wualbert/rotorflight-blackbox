'use strict';

function create(bytes) {
    const compiled = new WebAssembly.Module(bytes);
    if (WebAssembly.Module.imports(compiled).length) throw new Error('The filter math module must have no host imports.');
    const libm = new WebAssembly.Instance(compiled).exports;
    // Only filter computations use this object. Do not change global Math or
    // inherit host transcendental functions, whose last bits vary by runtime.
    const portable = Object.create(globalThis.Math);
    for (const name of ['sin', 'cos', 'tan', 'atan', 'atan2', 'log', 'log2', 'log10', 'exp', 'sqrt']) {
        Object.defineProperty(portable, name, { value: libm['rf_' + name] });
    }
    Object.defineProperty(portable, 'pow', { value(x, y) {
        x = +x; y = +y;
        // C libm defines these limits as one; ECMAScript defines them as NaN.
        if (!Number.isFinite(y) && globalThis.Math.abs(x) === 1) return NaN;
        return libm.rf_pow(x, y);
    } });
    Object.defineProperty(portable, 'hypot', { value(...values) {
        let largest = 0;
        const magnitudes = values.map(value => {
            const x = globalThis.Math.abs(+value);
            largest = globalThis.Math.max(largest, x);
            return x;
        });
        if (magnitudes.includes(Infinity)) return Infinity;
        if (Number.isNaN(largest)) return NaN;
        if (largest === 0) return 0;
        // Scaling prevents overflow/underflow. Compensated addition preserves
        // small terms without delegating this reduction to a host Math.hypot.
        let sum = 0, correction = 0;
        for (const x of magnitudes) {
            const scaled = x / largest, term = scaled * scaled - correction;
            const next = sum + term;
            correction = (next - sum) - term;
            sum = next;
        }
        return largest * libm.rf_sqrt(sum);
    } });
    return Object.freeze(portable);
}

module.exports = { create };
