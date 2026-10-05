'use strict';

/**
 * A vibration line that is no multiple of rotor speed, measured window by window, to find what makes it.
 *
 *   node tools/autotune/line.cjs <out dir> <log file> [order to look near, default 3.79]
 *
 * Writes <out dir>/line.json; line_report.cjs reads it. Besides the windows it keeps, per log and PID profile, the
 * summed cross-spectral matrix of the three raw gyro axes against revolutions (long windows, orders up to `upTo`), from
 * which the report reads every line and how it shakes the airframe. The raw gyro is resampled against revolutions of the logged
 * headspeed. In every window the line, the main rotor's once-per-revolution line and the line at 4 × rotor speed are
 * found and their positions refined; the ratio of the line to the main rotor line is therefore free of any error
 * in the headspeed reading. With each window go the conditions it was flown in.
 *
 * Why this tells sources apart:
 *   - a part driven by the belt (pulley, tensioner roller) turns at a fixed ratio to the main rotor, whatever the load
 *   - the ball-pass frequencies of a ball bearing depend on its contact angle, which changes with axial load
 *   - a blade or rotor mode that scales with rotor speed changes its ratio when the blades are changed
 */

const fs = require('node:fs'), path = require('node:path');
const lib = require('./lib.cjs');

const RULE = {
    headspeed: 1500,         // windows below this are skipped
    perRev: 32,
    passes: [
        { name: 'long', revolutions: 512, hop: 128, steady: 150 },  // precise positions: headspeed within this many rpm
        { name: 'short', revolutions: 128, hop: 64, steady: 300 },  // also short stays and the ground
    ],
    search: { line: [3.70, 3.88], main: [0.97, 1.03], tail: [3.97, 4.03], belt: [0.160, 0.190] }, // multiples of the logged headspeed
    upTo: 9,                 // orders kept in the summed spectra
};

const [OUT, FILE, NEAR] = process.argv.slice(2);
if (!OUT || !FILE) { console.error('usage: node line.cjs <out dir> <log file> [order]'); process.exit(2); }
if (NEAR) { const c = +NEAR; RULE.search.line = [c - 0.09, c + 0.09]; }

const app = lib.loadApp();
const r = (v, d = 5) => (typeof v === 'number' && isFinite(v)) ? +v.toFixed(d) : null;
const mean = (x, list) => list.reduce((s, i) => s + x[i], 0) / list.length;

const EXTRA = ['govTarget', 'gyroRAW[0]', 'gyroRAW[1]', 'gyroRAW[2]', 'servo[3]'];
const windows = [], logs = [], spectra = [];
for (const w of lib.segments(app, FILE, { whole: true, extra: EXTRA })) {
    const fl = w.flight, raw = [0, 1, 2].map(a => w.extra[`gyroRAW[${a}]`]);
    if (!raw.every(Boolean) || !w.coll) continue;
    const rate = fl.actualRate, target = w.extra.govTarget || w.hs, profile = lib.profilesOf(w, target).p;
    const R = lib.byRevolution(w.hs, rate, raw, RULE.perRev);
    logs.push({ log: fl.log, start: fl.start, seconds: r(w.n / rate, 1), header: { yawPID: fl.header.yawPID } });
    for (const pass of RULE.passes) {
        const N = pass.revolutions * RULE.perRev, { fft, win } = lib.fftFor(app, N), buf = new Float64Array(N), X = [0, 1, 2].map(() => new Float64Array(2 * N));
        const bin = (o) => Math.round(o * pass.revolutions), scale = N / 4;
        for (let s = 0; s + N <= R.M; s += pass.hop * RULE.perRev) {
            const idx = []; for (let k = s; k < s + N; k += 8) idx.push(R.index[k]);
            let lo = Infinity, hi = -Infinity; for (const i of idx) { if (w.hs[i] < lo) lo = w.hs[i]; if (w.hs[i] > hi) hi = w.hs[i]; }
            if (lo < RULE.headspeed || hi - lo > pass.steady) continue;
            for (let a = 0; a < 3; a++) { const c = R.columns[a]; let m = 0; for (let i = 0; i < N; i++) m += c[s + i]; m /= N; for (let i = 0; i < N; i++) buf[i] = (c[s + i] - m) * win[i]; fft.simple(X[a], buf, 'real'); }
            const P = new Float64Array(Math.min(N / 2, bin(6)));
            for (let k = 0; k < P.length; k++) for (let a = 0; a < 3; a++) P[k] += X[a][2 * k] ** 2 + X[a][2 * k + 1] ** 2;
            const peak = (range) => { const pk = lib.spectralPeak(P, bin(range[0]), bin(range[1])), k = Math.round(pk.bin), around = [];
                for (let j = k - bin(0.1); j <= k + bin(0.1); j++) if (Math.abs(j - k) > 3) around.push(P[j]);
                around.sort((u, v) => u - v);
                return { order: pk.bin / pass.revolutions, snr: Math.sqrt(P[k] / around[around.length >> 1]),
                    axes: [0, 1, 2].map(a => [r(X[a][2 * k] / scale, 3), r(X[a][2 * k + 1] / scale, 3)]) }; };  // complex amplitude per axis, deg/s
            const line = peak(RULE.search.line), main = peak(RULE.search.main), tail = peak(RULE.search.tail), belt = peak(RULE.search.belt);
            // a second line close by: the largest local maximum 4 to 40 bins away from the first
            const k0 = Math.round(line.order * pass.revolutions); let second = null;
            for (let k = k0 - 40; k <= k0 + 40; k++) if (Math.abs(k - k0) >= 4 && P[k] > P[k - 1] && P[k] > P[k + 1] && (!second || P[k] > P[second])) second = k;
            const air = mean(w.airborneAt, idx), coll = idx.map(i => w.coll[i]);
            if (pass.name === 'long') { // summed cross-spectral matrix: [rr, pp, yy, rp re, rp im, ry re, ry im, py re, py im] per bin
                const pr = profile[R.index[s + (N >> 1)]], key = `${fl.log}|${pr}|${air > 0.5 ? 'air' : 'ground'}`; let e = spectra.find(v => v.key === key);
                if (!e) spectra.push(e = { key, log: fl.log, profile: pr, air: air > 0.5, windows: 0, revolutions: pass.revolutions, m: new Float64Array(9 * bin(RULE.upTo)) });
                for (let k = 0; k < bin(RULE.upTo); k++) { const x = [0, 1, 2].map(a => [X[a][2 * k] / scale, X[a][2 * k + 1] / scale]), c = (u, v) => [u[0] * v[0] + u[1] * v[1], u[0] * v[1] - u[1] * v[0]]; // conj(u) v
                    const rp = c(x[0], x[1]), ry = c(x[0], x[2]), py = c(x[1], x[2]), o = 9 * k;
                    e.m[o] += x[0][0] ** 2 + x[0][1] ** 2; e.m[o + 1] += x[1][0] ** 2 + x[1][1] ** 2; e.m[o + 2] += x[2][0] ** 2 + x[2][1] ** 2;
                    e.m[o + 3] += rp[0]; e.m[o + 4] += rp[1]; e.m[o + 5] += ry[0]; e.m[o + 6] += ry[1]; e.m[o + 7] += py[0]; e.m[o + 8] += py[1]; }
                e.windows++; }
            windows.push({ pass: pass.name, log: fl.log, t: r(w.fromS + R.index[s] / rate, 1), seconds: r((R.index[s + N - 1] - R.index[s]) / rate, 1), profile: profile[R.index[s + (N >> 1)]],
                headspeed: r(mean(w.hs, idx), 0), hsRange: hi - lo, airborne: r(air, 2),
                collective: r(coll.reduce((t, v) => t + v, 0) / coll.length, 0), collectiveAbs: r(coll.reduce((t, v) => t + Math.abs(v), 0) / coll.length, 0),
                collectiveSd: r(Math.sqrt(coll.reduce((t, v) => t + v * v, 0) / coll.length - (coll.reduce((t, v) => t + v, 0) / coll.length) ** 2), 0),
                tailServo: w.extra['servo[3]'] ? r(mean(w.extra['servo[3]'], idx), 0) : null, yawControl: r(mean(w.u[2], idx), 3),
                line: { order: r(line.order, 6), snr: r(line.snr, 1), axes: line.axes }, main: { order: r(main.order, 6), snr: r(main.snr, 1), axes: main.axes },
                tail: { order: r(tail.order, 6), snr: r(tail.snr, 1), axes: tail.axes }, belt: { order: r(belt.order, 6), snr: r(belt.snr, 1), axes: belt.axes },
                second: second === null ? null : { order: r(second / pass.revolutions, 5), relative: r(Math.sqrt(P[second] / P[k0]), 3) } });
        }
    }
    console.error(`#${fl.log}: ${windows.filter(v => v.log === fl.log).length} windows`);
}
fs.mkdirSync(OUT, { recursive: true });
for (const e of spectra) e.m = Array.from(e.m, v => +v.toPrecision(5));
fs.writeFileSync(path.join(OUT, 'line.json'), JSON.stringify({ file: path.basename(FILE), rule: RULE, logs, windows, spectra }));
console.error(`${windows.length} windows -> ${path.join(OUT, 'line.json')}`);
