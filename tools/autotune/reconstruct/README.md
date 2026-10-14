# Reconstruction kernel

`../filter_solve.cjs` is generated from `kernel.c` and `runtime.cjs`. It embeds
an import-free binary64 WebAssembly implementation of the repeated filter
operators and conjugate-gradient solve. The JavaScript reference remains in
`../filter_reconstruct.cjs` and the differential tests. The C implementation
preserves its arithmetic order, fixed-prefix elimination and stopping rules.

Use the official wasi-sdk 25 (clang 19.1.5):

```sh
WASI_CC=/path/to/wasi-sdk-25.0/bin/clang node tools/autotune/reconstruct/build.cjs
node --test test/filter_solve.test.cjs test/filter_reconstruct_fast.test.cjs
```

The generated module is checked in; ordinary app builds need no C compiler.
`manifest.json` records source, wrapper and WebAssembly hashes and compiler
flags. Fast-math reassociation and floating-point contraction are disabled.
Tests compare exact outputs, residuals and iteration counts against JavaScript
for static and adaptive chains, PID observers, and committed prefixes.

The kernel uses the SDK's allocator and C runtime. The associated wasi-libc
and musl notices are in `../math/LICENSES.txt`, which ships with the app.
