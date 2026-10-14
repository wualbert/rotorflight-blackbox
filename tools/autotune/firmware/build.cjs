'use strict';
// Platform adaptation only: remove includes and supply hardware/config accessors.
// All PID, mixer, and filter algorithm bodies come from hash-checked source.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), crypto = require('node:crypto');
const ROOT = __dirname;
const strip = source => source.replace(/^\s*#include[^\n]*$/gm, '').replace(/^\s*#pragma once[^\n]*$/gm, '');
function verifySources() {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    for (const [name, hash] of Object.entries(manifest.files)) {
        const bytes = fs.readFileSync(path.join(ROOT, 'vendor', name.replace('/', '_')));
        if (crypto.createHash('sha256').update(bytes).digest('hex') !== hash) throw Error('Firmware source hash mismatch: ' + name);
    }
    return manifest;
}
function source() {
    verifySources();
    const read = name => fs.readFileSync(path.join(ROOT, 'vendor', name.replace('/', '_')), 'utf8');
    const maths = read('common/maths.c');
    const servos = read('flight/servos.c');
    // Hardware timer initialization is external. The complete output mapping,
    // geometry correction, speed limiter and saturation code stays upstream.
    const servoState=servos.slice(servos.indexOf('static FAST_DATA_ZERO_INIT uint8_t'),servos.indexOf('void validateAndFixServoConfig'));
    const servoUpdate=servos.slice(servos.indexOf('static inline void servoSetOutput'),servos.lastIndexOf('\n#endif')); 
    const polynomial = maths.slice(maths.indexOf('#if 0\n// Taylor'), maths.indexOf('MATH_CODE float tan_approx2'));
    const arcMath=maths.slice(maths.indexOf('MATH_CODE float asin_approx'),maths.indexOf('MATH_CODE float atan2_approx'));
    const powerMath = maths.slice(maths.indexOf('MATH_CODE float exp_approx'), maths.indexOf('\n#endif',maths.indexOf('MATH_CODE float pow_approx')));
    const governorNames=['governorInit','governorInitProfile','governorUpdate','getGovernorOutput','getSpoolUpRatio','isSpooledUp','getTTAIncrease'];
    const governorAliases=governorNames.map(n=>'#define '+n+' fw_'+n).join('\n');
    const governorUnalias=governorNames.map(n=>'#undef '+n).join('\n');
    // The complete upstream math header also defines unrelated vector types.
    // Keep the contiguous constants, scalar operators and exact helper bodies.
    const mh = read('common/maths.h');
    const scalarMath = strip(mh.slice(mh.indexOf('/*\n * Floating point constants'), mh.indexOf('/*\n * Standard deviation calculus')));
    const content = [fs.readFileSync(path.join(ROOT, 'platform.h'), 'utf8'), scalarMath,
        strip(read('common/axis.h')), strip(read('common/filter.h')), polynomial,arcMath,powerMath, strip(read('common/filter.c')),
        strip(read('pg/governor.h')), strip(read('pg/pid.h')), strip(read('pg/mixer.h')),
        strip(read('pg/servos.h')),strip(read('flight/servos.h')),
        strip(read('flight/pid.h')), strip(read('flight/mixer.h')),
        governorAliases,strip(read('flight/governor.h')),governorUnalias,
        fs.readFileSync(path.join(ROOT, 'host.c'), 'utf8'),
        strip(read('flight/pid.c')), strip(read('flight/mixer.c')),
        governorAliases,strip(read('flight/governor.c')),governorUnalias,servoState,servoUpdate,
        fs.readFileSync(path.join(ROOT, 'bridge.c'), 'utf8')].join('\n');
    return content;
}
function build(options = {}) {
    const output = options.output || path.join(ROOT, 'controller.wasm');
    const dir = options.buildDir || path.join(require('node:os').tmpdir(), 'rotorflight-controller-build');
    fs.mkdirSync(dir, {recursive:true});
    const file = path.join(dir, 'controller.c'); fs.writeFileSync(file, source());
    const compiler = options.compiler || process.env.WASI_CC || '/private/tmp/wasi-sdk-25.0-arm64-macos/bin/clang';
    cp.execFileSync(compiler, ['-std=gnu11', '-O2', '-ffp-contract=off', '-fno-fast-math', '-Werror=implicit-function-declaration',
        '-mexec-model=reactor', file, '-lm', '-Wl,--export=rf_config', '-Wl,--export=rf_input', '-Wl,--export=rf_output',
        '-Wl,--export=rf_reset', '-Wl,--export=rf_step', '-Wl,--export=rf_seed',
        '-Wl,--export=rf_servo_config', '-Wl,--export=rf_servo_reset', '-Wl,--export=rf_map_mixer', '-o', output], {stdio:'pipe'});
    const bytes = fs.readFileSync(output), module = new WebAssembly.Module(bytes);
    if (WebAssembly.Module.imports(module).length) throw Error('Controller must have no host imports');
    const provenance = {...verifySources(), artifactSha256:crypto.createHash('sha256').update(bytes).digest('hex'),
        adaptationSha256:crypto.createHash('sha256').update(source()).digest('hex'),
        compiler:cp.execFileSync(compiler, ['--version'], {encoding:'utf8'}).split('\n')[0],
        exports:WebAssembly.Module.exports(module).map(x=>x.name)};
    fs.writeFileSync(output.replace(/\.wasm$/, '.json'), JSON.stringify(provenance,null,2)+'\n');
    return {output, provenance};
}
module.exports = {build, verifySources, source};
if (require.main !== module) return;
console.log(JSON.stringify(build(), null, 2));
