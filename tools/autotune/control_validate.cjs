'use strict';

/**
 * Execute the production tuning worker in a browser-like Node VM for repeatable
 * offline validation. No controller connection, network fetch or environment
 * mutation. --logs uses the one-based log numbers shown by the app.
 *
 * node tools/autotune/control_validate.cjs <outdir> <flight.BBL> [more.BBL ...]
 *   [--configuration A|latest] [--step cyclic] [--craft fireball] [--logs 13,14,15]
 *   [--cli configuration.txt] [--identify-only] [--analysis-cache prior-directory]
 *
 * worker().request(message, optionalBytes) resolves to the production message
 * envelope. Worker error messages reject with the original envelope attached.
 * Full validation fits once through controlTune; its twin is also reported as
 * identification. --identify-only instead runs systemIdentify without tuning.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { fileURLToPath, pathToFileURL } = require('node:url');
const { performance } = require('node:perf_hooks');

const REPO = path.resolve(__dirname, '../..');
const STEPS = ['governor', 'cyclic', 'tail', 'cycomp', 'tailcomp'];
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
const json = value => JSON.stringify(value, (key, v) => ArrayBuffer.isView(v) ? Array.from(v) : v, 2) + '\n';

// These removals concern the worker realm only. Host Node builtins are untouched.
const CHROMIUM_99 = `(function () {
    const del = (o, keys) => { if (o) for (const k of keys) delete o[k]; };
    del(Array.prototype, ['toSorted', 'toReversed', 'toSpliced', 'with']);
    del(Object.getPrototypeOf(Int8Array.prototype), ['toSorted', 'toReversed', 'with']);
    del(Object, ['groupBy']); del(Map, ['groupBy']);
    del(Promise, ['withResolvers', 'try']); del(Array, ['fromAsync']); del(JSON, ['rawJSON', 'isRawJSON']);
    del(Set.prototype, ['union', 'intersection', 'difference', 'symmetricDifference', 'isSubsetOf', 'isSupersetOf', 'isDisjointFrom']);
    del(String.prototype, ['isWellFormed', 'toWellFormed']);
    del(ArrayBuffer.prototype, ['transfer', 'transferToFixedLength', 'resize']);
    del(Object.getPrototypeOf(Object.getPrototypeOf([][Symbol.iterator]())), ['map', 'filter', 'take', 'drop', 'flatMap', 'reduce', 'toArray', 'forEach', 'some', 'every', 'find']);
    del(RegExp, ['escape']); delete globalThis.Iterator;
})();`;

function worker(options = {}) {
    const root = fs.realpathSync(options.root || REPO);
    const entry = path.join(root, 'js/tuning_worker.js');
    const base = pathToFileURL(entry);
    const ctx = vm.constants && vm.constants.DONT_CONTEXTIFY
        ? vm.createContext(vm.constants.DONT_CONTEXTIFY) : vm.createContext({});
    const run = (source, filename) => vm.runInContext(source, ctx, { filename });
    const pending = new Map(), loaded = new Map(), progress = [], timers = new Set();
    let nextId = 1, closed = false;

    function localFile(url) {
        const parsed = new URL(String(url), base);
        if (parsed.protocol !== 'file:') throw new Error('Validation permits local worker resources only.');
        const candidate = fileURLToPath(parsed);
        const file = fs.existsSync(candidate) ? fs.realpathSync(candidate) : path.resolve(candidate);
        if (file !== root && !file.startsWith(root + path.sep)) throw new Error('The worker resource is outside the project.');
        return file;
    }
    function read(file) {
        const data = fs.readFileSync(file);
        const name = path.relative(root, file).split(path.sep).join('/');
        const prior = loaded.get(name), digest = sha256(data);
        if (prior && prior.sha256 !== digest) throw new Error('A worker resource changed during validation: ' + name);
        loaded.set(name, { path: name, bytes: data.length, sha256: digest });
        return data;
    }
    function realmBuffer(bytes) {
        const source = ArrayBuffer.isView(bytes)
            ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) : new Uint8Array(bytes);
        const buffer = run(`new ArrayBuffer(${source.byteLength})`, 'validation-transfer.js');
        new Uint8Array(buffer).set(source);
        return buffer;
    }
    function settle(message) {
        const copy = structuredClone(message);
        if (copy.type === 'progress') {
            progress.push(copy);
            if (options.onProgress) options.onProgress(copy);
            return;
        }
        const task = pending.get(copy.id);
        if (!task) return;
        pending.delete(copy.id);
        if (copy.type === 'error') {
            const error = new Error(copy.message || 'Worker validation failed.');
            error.workerMessage = copy;
            if (copy.stack) error.stack = copy.stack;
            task.reject(error);
        } else task.resolve(copy);
    }
    Object.assign(ctx, {
        console: options.console || { log() {}, info() {}, warn() {}, debug() {}, error() {} },
        performance, crypto: crypto.webcrypto, TextEncoder, TextDecoder, URL, Response, Request, Headers,
        setTimeout(fn, delay, ...args) {
            const timer = setTimeout(() => { timers.delete(timer); fn(...args); }, delay);
            timers.add(timer);
            return timer;
        },
        clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
        importScripts(...urls) { for (const url of urls) { const file = localFile(url); run(read(file).toString('utf8'), file); } },
        async fetch(url) {
            const file = localFile(url);
            let data;
            try { data = read(file); }
            catch (error) {
                if (error.code !== 'ENOENT') throw error;
                return new Response('Not found', { status: 404 });
            }
            // Real Response supports arrayBuffer, text, json, clone, headers and
            // WebAssembly.instantiateStreaming just as browser fetch does.
            return new Response(data, { status: 200, headers: {
                'content-type': file.endsWith('.wasm') ? 'application/wasm' : 'text/plain; charset=utf-8'
            } });
        },
        postMessage: settle
    });
    run(CHROMIUM_99, 'chromium-99-builtins.js');
    run('var self = globalThis;', 'validation-worker-global.js');
    run(read(entry).toString('utf8'), entry);

    return {
        progress,
        get sources() { return [...loaded.values()].sort((a, b) => a.path.localeCompare(b.path)); },
        logCount(bytes) {
            if (closed) throw new Error('The validation worker is closed.');
            ctx.__validationBytes = realmBuffer(bytes);
            try { return run('new FlightLogIndex(new Uint8Array(__validationBytes)).getLogCount()', 'validation-index.js'); }
            finally { delete ctx.__validationBytes; }
        },
        request(message, bytes) {
            if (closed) return Promise.reject(new Error('The validation worker is closed.'));
            const id = nextId++, data = Object.assign({}, structuredClone(message), { id });
            if (bytes !== undefined) data.bytes = realmBuffer(bytes);
            else if (data.bytes) data.bytes = realmBuffer(data.bytes);
            return new Promise((resolve, reject) => {
                pending.set(id, { resolve, reject });
                try { ctx.onmessage({ data }); }
                catch (error) { pending.delete(id); reject(error); }
            });
        },
        async controlInputs(message, bytes) {
            if (closed) throw new Error('The validation worker is closed.');
            if (pending.size) throw new Error('Finish the current worker request before extracting control inputs.');
            const extract = run('TuningWorker.controlInputs', 'validation-control-inputs.js');
            if (typeof extract !== 'function') throw new Error('The production worker does not expose its control-input diagnostics.');
            const data = Object.assign({}, structuredClone(message), { id: nextId++ });
            if (bytes !== undefined) data.bytes = realmBuffer(bytes);
            else if (data.bytes) data.bytes = realmBuffer(data.bytes);
            // Retain the native typed arrays for lossless V8/NPY serialization.
            // This calls the production decoder and eligibility path only.
            return extract(data, settle);
        },
        close() {
            closed = true;
            for (const timer of timers) clearTimeout(timer);
            timers.clear();
            for (const task of pending.values()) task.reject(new Error('The validation worker was closed.'));
            pending.clear();
        }
    };
}

function parseArgs(args) {
    if (!args.length || args.includes('--help') || args.includes('-h')) return { help: true };
    const out = { output: args[0], files: [], step: 'cyclic', craft: null, logs: null };
    let firstFlag = 1;
    while (firstFlag < args.length && !args[firstFlag].startsWith('--')) out.files.push(args[firstFlag++]);
    out.file = out.files[0]; // Backward-compatible API for single-file callers.
    if (!out.file) throw new Error('An output directory and at least one flight log are required.');
    for (let i = firstFlag; i < args.length; i++) {
        const flag = args[i];
        if (flag === '--identify-only') { out.identifyOnly = true; continue; }
        if (!['--configuration', '--step', '--craft', '--logs', '--cli', '--analysis-cache'].includes(flag)) throw new Error('Unknown option: ' + flag);
        const value = args[++i];
        if (!value || value.startsWith('--')) throw new Error('Missing value for ' + flag);
        out[flag === '--analysis-cache' ? 'analysisCache' : flag.slice(2)] = value;
    }
    if (!STEPS.includes(out.step)) throw new Error('The control step must be one of: ' + STEPS.join(', '));
    if (out.logs !== null) {
        if (!/^\d+(,\d+)*$/.test(out.logs)) throw new Error('--logs requires comma-separated one-based log numbers.');
        out.logs = [...new Set(out.logs.split(',').map(Number))].sort((a, b) => a - b);
        if (!out.logs.every(log => Number.isSafeInteger(log) && log >= 1)) throw new Error('Log numbers start at 1.');
    }
    if (out.files.length > 1 && !out.craft) throw new Error('--craft is required when combining files from one helicopter.');
    return out;
}

function selectConfigurations(analysis, selection) {
    const datasets = analysis.datasets || {};
    const available = (datasets.datasets || []).filter(d => d.analysed !== false);
    if (selection !== 'latest') return selection ? available.filter(d => d.id === selection) : available;
    const flown = available.filter(d => (d.analysedFlightSeconds === undefined ? d.flightSeconds : d.analysedFlightSeconds) > 0);
    const newest = flown.find(d => d.id === datasets.newest);
    if (newest) return [newest];
    // The worker's newest setting may only have a bench recording. In that
    // case use the final recorded configuration with eligible airborne data.
    const ids = new Set(flown.map(d => d.id));
    const labels = (datasets.labels || []).filter(label => ids.has(label.dataset) && label.flightSeconds > 0)
        .sort((a, b) => b.log - a.log || b.t1 - a.t1);
    return labels.length ? flown.filter(d => d.id === labels[0].dataset) : [];
}

async function configurationReport(engine, request, bytes, identifyOnly) {
    if (identifyOnly) return {
        identification: (await engine.request(Object.assign({ cmd: 'systemIdentify' }, request), bytes)).result
    };
    const tuning = (await engine.request(Object.assign({ cmd: 'controlTune' }, request), bytes)).result;
    return { identification: tuning.twin, tuning };
}

function readAnalysisCache(directory, manifest) {
    const source = path.resolve(directory), manifestBytes = fs.readFileSync(path.join(source, 'manifest.json'));
    const prior = JSON.parse(manifestBytes), analysisBytes = fs.readFileSync(path.join(source, 'analysis.json'));
    const artifact = (prior.artifacts || []).find(item => item.path === 'analysis.json');
    if (!artifact || artifact.sha256 !== sha256(analysisBytes)) throw new Error('The cached analysis does not match its manifest.');
    if (prior.input.sha256 !== manifest.input.sha256 || (prior.cli && prior.cli.sha256 || null) !== (manifest.cli && manifest.cli.sha256 || null) ||
        JSON.stringify(prior.request.logs || null) !== JSON.stringify(manifest.request.logs || null) ||
        (prior.request.craft || null) !== (manifest.request.craft || null))
        throw new Error('The cached analysis uses different input data, CLI data, selected logs or helicopter.');
    // These resources are not used by analyseFile. They can change between a
    // recorded preprocessing run and a new control-method validation run.
    const controlOnly = new Set(['tools/autotune/control_pipeline.cjs', 'tools/autotune/firmware_controller.cjs']);
    const exceptions = [];
    for (const resource of prior.sources || []) {
        const file = path.resolve(REPO, resource.path);
        if (!file.startsWith(REPO + path.sep)) throw new Error('The cached analysis resource is outside the project.');
        const current = fs.readFileSync(file), currentHash = sha256(current);
        if (currentHash === resource.sha256) continue;
        let reason = controlOnly.has(resource.path) ? 'control-module-unused-by-analyseFile' : null;
        if (!reason && resource.path === 'js/tuning_worker.js') {
            const oldText = 'The flight period has no known configuration or flight mask.';
            const newText = 'The flight period has no known configuration or flight phase.';
            const source = current.toString('utf8');
            if (source.split(newText).length === 2 && sha256(source.replace(newText, oldText)) === resource.sha256)
                reason = 'verified-single-message-change-in-controlInputs-unused-by-analyseFile';
        }
        if (!reason) throw new Error('A cached analysis dependency changed: ' + resource.path);
        exceptions.push({ path: resource.path, oldSha256: resource.sha256, newSha256: currentHash, reason });
    }
    return { analysis: JSON.parse(analysisBytes), provenance: { directory: path.basename(source),
        manifestSha256: sha256(manifestBytes), analysisSha256: sha256(analysisBytes),
        sourceStarted: prior.started, sourceFinished: prior.finished,
        sourceCheckpoint: prior.preprocessingCheckpoint || null, exceptions,
        policy: 'identical-data-and-analysis-dependencies-with-explicit-unused-control-exceptions; freshly-executed-control-method' } };
}

async function validate(options) {
    const files = options.files && options.files.length ? options.files : [options.file];
    if (files.length > 1 && !options.craft) throw new Error('A craft is required when combining files from one helicopter.');
    const inputs = files.map(file => { const bytes = fs.readFileSync(file); return { bytes,
        source: { fileName: path.basename(file), bytes: bytes.length, sha256: sha256(bytes) } }; });
    if (new Set(inputs.map(input => input.source.sha256)).size !== inputs.length)
        throw new Error('The same Blackbox file was supplied more than once.');
    // FlightLogIndex recognizes each complete log header in concatenated data.
    // Preserve the exact original bytes; do not insert delimiters or rewrite logs.
    const bytes = inputs.length === 1 ? inputs[0].bytes : Buffer.concat(inputs.map(input => input.bytes));
    const fileName = inputs.length === 1 ? inputs[0].source.fileName : `combined-${inputs.length}-files.BBL`;
    const output = path.resolve(options.output);
    fs.mkdirSync(output, { recursive: true });
    const started = new Date().toISOString();
    const cliBytes = options.cli ? fs.readFileSync(options.cli) : null;
    const common = { curves: false, gains: false, keepMetrics: false,
        craft: options.craft || undefined,
        cliText: cliBytes ? cliBytes.toString('utf8') : undefined,
        cliName: options.cli ? path.basename(options.cli) : undefined };
    if (options.logs) {
        // A null flight selects every flight in that zero-based log.
        common.flights = options.logs.map(log => ({ log: log - 1, flight: null }));
        common.logs = options.logs.map(log => log - 1);
    }
    const written = new Set(['progress.jsonl']);
    const write = (name, data) => { fs.writeFileSync(path.join(output, name), json(data)); written.add(name); };
    const progressFile = path.join(output, 'progress.jsonl');
    fs.writeFileSync(progressFile, '');
    const engine = worker({ onProgress(message) {
        fs.appendFileSync(progressFile, JSON.stringify(Object.assign({ at: new Date().toISOString() }, message)) + '\n');
        if (options.onProgress) options.onProgress(message);
    } });
    const results = [], errors = [];
    let analysis = null;
    const manifest = { schema: 1, started, node: process.version, platform: process.platform, arch: process.arch,
        input: { fileName, bytes: bytes.length, sha256: sha256(bytes), files: inputs.map(input => input.source) },
        cli: cliBytes ? { fileName: path.basename(options.cli), bytes: cliBytes.length, sha256: sha256(cliBytes) } : null,
        request: { craft: options.craft || null, configuration: options.configuration || null, step: options.step,
            logs: options.logs || null, logIndexBase: 1, identifyOnly: !!options.identifyOnly,
            identification: options.identifyOnly ? 'systemIdentify' : 'shared-controlTune-twin' },
        runner: { path: 'tools/autotune/control_validate.cjs', sha256: sha256(fs.readFileSync(__filename)) } };
    try {
        let byteOffset = 0, logOffset = 0;
        for (const input of inputs) {
            const logs = engine.logCount(input.bytes);
            Object.assign(input.source, { byteOffset, logOffset, logs });
            if (!logs) throw new Error('The file contains no Blackbox log: ' + input.source.fileName);
            byteOffset += input.bytes.length; logOffset += logs;
        }
        const logCount = engine.logCount(bytes);
        manifest.input.logs = logCount;
        if (logCount !== logOffset) throw new Error('The combined file index does not match the source file indexes.');
        if (options.logs && options.logs.some(log => !Number.isInteger(log) || log < 1 || log > logCount))
            throw new Error('A selected log number is outside the input. The input contains ' + logCount + ' logs.');
        common.sourceFiles = manifest.input.files;
        if (options.analysisCache) {
            const cache = readAnalysisCache(options.analysisCache, manifest);
            analysis = cache.analysis; manifest.analysisCache = cache.provenance;
        } else analysis = (await engine.request({ cmd: 'analyseFile', fileName, selectedLog: options.logs ? options.logs[0] - 1 : 0,
            options: common }, bytes)).result;
        write('analysis.json', analysis);
        const configurations = selectConfigurations(analysis, options.configuration);
        manifest.request.resolvedConfigurations = configurations.map(configuration => configuration.id);
        if (!configurations.length) throw new Error(options.configuration
            ? 'The selected configuration is not available: ' + options.configuration : 'No analyzed configuration is available.');
        for (const configuration of configurations) {
            const entry = { configuration: configuration.id, profile: configuration.pidProfile || null };
            results.push(entry);
            const request = { fileName, configuration: configuration.id, step: options.step, analysis, options: common };
            try {
                Object.assign(entry, await configurationReport(engine, request, bytes, options.identifyOnly));
            } catch (error) {
                entry.error = { message: error.message, worker: error.workerMessage || null };
                errors.push({ configuration: configuration.id, message: error.message });
            }
            write('report.json', { schema: 1, input: manifest.input, results, errors });
        }
    } catch (error) {
        errors.push({ configuration: null, message: error.message, worker: error.workerMessage || null });
    } finally {
        engine.close();
        write('report.json', { schema: 1, input: manifest.input, results, errors });
        manifest.finished = new Date().toISOString();
        manifest.status = errors.length ? 'runtime-error' : 'complete';
        manifest.sources = engine.sources;
        manifest.artifacts = [...written].filter(name => fs.existsSync(path.join(output, name)))
            .map(name => { const data = fs.readFileSync(path.join(output, name)); return { path: name, bytes: data.length, sha256: sha256(data) }; });
        write('manifest.json', manifest);
    }
    return { analysis, results, errors, manifest };
}

module.exports = { worker, validate, parseArgs, selectConfigurations, configurationReport, readAnalysisCache };
if (require.main !== module) return;

(async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        process.stdout.write('Usage: node tools/autotune/control_validate.cjs <outdir> <flight.BBL> [more.BBL ...]\n' +
            '  [--configuration A|latest] [--step cyclic] [--craft fireball] [--logs 13,14,15]\n' +
            '  [--cli configuration.txt] [--identify-only] [--analysis-cache prior-directory]\n' +
            '--logs uses one-based log numbers across the combined input, in file order.\n' +
            'Multiple files require --craft and must describe the same helicopter.\n' +
            'The manifest records each file hash, byte offset and zero-based log offset.\n' +
            'Full validation fits once through controlTune and reports its twin as identification.\n');
        return;
    }
    let last = '';
    options.onProgress = message => { if (message.text && message.text !== last) {
        last = message.text; process.stderr.write(message.text + '\n');
    } };
    const result = await validate(options);
    process.stdout.write(json({ status: result.manifest.status, configurations: result.results.length,
        errors: result.errors.map(error => error.message), report: path.join(path.resolve(options.output), 'report.json') }));
    if (result.errors.length) process.exitCode = 1;
})().catch(error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
