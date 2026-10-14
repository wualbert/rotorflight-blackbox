# Portable filter arithmetic

`filter_math.cjs` gives filter preparation, coefficient generation, reconstruction
and scoring the same transcendental functions in Node and Chromium 99. Their
host `Math` implementations differ by a few last bits. Adaptive peak selection
and iterative inversion can amplify those differences into different samples
and baseline verdicts.

The module embeds a 28 KB WebAssembly library with no host imports. Basic
arithmetic remains binary64 JavaScript. The inverse solver uses a separate
binary64 kernel in `../reconstruct/`. Neither kernel uses SIMD reductions,
floating-point contraction, or fast-math reassociation. Global `Math` is unchanged.
The wrapper preserves JavaScript power special cases and supplies a scaled,
compensated `hypot` implementation.

Rebuild with the official [wasi-sdk 25](https://github.com/WebAssembly/wasi-sdk/releases/tag/wasi-sdk-25):

```sh
WASI_CC=/path/to/wasi-sdk-25.0/bin/clang node tools/autotune/math/build.cjs
node --test test/filter_math.test.cjs
```

The generated file is checked in, so normal app builds do not require this SDK.
`manifest.json` records source, wrapper, archive and artifact hashes, compiler
version, and floating-point flags. The SDK pins
[wasi-libc 574b88da](https://github.com/WebAssembly/wasi-libc/tree/574b88da481569b65a237cb80daf9a2d5aeaf82d).
Its musl math library is distributed under the MIT and permissive source
licenses reproduced in `LICENSES.txt`. Those notices ship with the app.

Tests cover finite accuracy, exceptional values and signed zero, worker-only
loading, independence from host transcendental functions, artifact identity,
and source provenance. Real-log runtime comparisons remain necessary: these
unit tests do not establish that reconstructed flight inputs are physically
correct or that a proposed tune passes replay validation.
