'use strict';
// Runs the actual browser worker on a recorded file in Node. No duplicated
// analysis or profile inference. Use this to reproduce the UI's filter result.
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function session(file, progress = () => {}, observeReconstruction = null, restoreReconstruction = null) {
    const root = path.resolve(__dirname, '../..'), js = path.join(root, 'js');
    const ctx = vm.constants && vm.constants.DONT_CONTEXTIFY ? vm.createContext(vm.constants.DONT_CONTEXTIFY) : vm.createContext({});
    const run = (code, name) => vm.runInContext(code, ctx, { filename: name });
    let resolve, reject;
    let sequence=0, pending=false;
    const local = url => { const f = path.resolve(js, url); if (!f.startsWith(root + path.sep)) throw Error('Worker file outside the project'); return f; };
    Object.assign(ctx, { setTimeout, console: { log() {}, info() {}, warn() {}, debug() {}, error() {} },
        importScripts: (...urls) => urls.forEach(url => { const f = local(url); run(fs.readFileSync(f, 'utf8'), f); }),
        fetch: async url => { const f = local(url); return {ok:fs.existsSync(f),status:fs.existsSync(f)?200:404,text:async()=>{
            let source=fs.readFileSync(f,'utf8');
            if((observeReconstruction||restoreReconstruction)&&path.basename(f)==='filter_reconstruct.cjs')source+='\nconst originalWindows=module.exports.reconstructWindows;module.exports.reconstructWindows=function(seg,windows,progress){const restored=self.restoreReconstruction&&self.restoreReconstruction(seg,windows);if(restored){for(const w of windows)progress(w);}else originalWindows(seg,windows,progress);self.postMessage({type:"reconstructed",seg,windows});};';
            return source;
        }}; },
        restoreReconstruction,
        postMessage: m => { if(m.type==='reconstructed'){if(observeReconstruction)observeReconstruction(m.seg,m.windows);} else if (m.type === 'progress') progress(m.text); else if (m.type === 'filterTuned') { pending=false;resolve(m.result); } else { pending=false;reject(Error(m.message || m.type)); } }
    });
    run('var self = globalThis;', 'worker-global.js');
    run(fs.readFileSync(path.join(js, 'tuning_worker.js'), 'utf8'), 'tuning_worker.js');
    const bytes = fs.readFileSync(file), ab = run(`new ArrayBuffer(${bytes.length})`, 'input-buffer.js'); new Uint8Array(ab).set(bytes);
    return { send(options={}, replay=false) {
        if(pending)throw Error('A filter replay is already running.');pending=true;
        const result=new Promise((ok,fail)=>{resolve=ok;reject=fail;});
        ctx.onmessage({data:{cmd:replay?'filterReplay':'filterTune',workspaceKey:'validation-session',id:++sequence,bytes:replay?undefined:ab,fileName:path.basename(file),options}});
        return result;
    }};
}
async function validate(file,options={},progress=()=>{},observeReconstruction=null,restoreReconstruction=null) {
    return session(file,progress,observeReconstruction,restoreReconstruction).send(options);
}
function reuseReconstruction(reportFile,file) {
    const crypto=require('node:crypto'),v8=require('node:v8'),root=path.resolve(__dirname,'../..');
    const sha=file=>crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const report=JSON.parse(fs.readFileSync(reportFile,'utf8'));
    for(const file of ['tools/autotune/filter_replay.cjs','tools/autotune/filter_reconstruct.cjs','tools/autotune/filter_tune.cjs'])
        if(sha(path.join(root,file))!==report.sourceSha256[file])throw Error('Reconstruction source differs from the cached run: '+file);
    const record=report.recordings.find(r=>r.inputSha256===sha(file));
    if(!record)throw Error('The recorded input differs from the cached run.');
    const folder=path.join(report.reconstructionCache,path.dirname(record.result));
    const signature=(seg,windows)=>{
        const hash=crypto.createHash('sha256');
        hash.update(JSON.stringify([seg.cfg,seg.observers,seg.initialState,seg.n,seg.log,seg.firstProfile,seg.fromS,
            windows.map(w=>[w.st,w.N,w.lead,w.profile,w.unit,w.held])]));
        for(const x of [].concat(seg.raw,seg.filt,seg.w.P||[],seg.w.D||[],seg.w.sp||[],[seg.hs,seg.tail,seg.ratio,seg.time,seg.prof,seg.mask])) {
            hash.update(x?String(x.length):'null');
            if(x)hash.update(Buffer.from(x.buffer,x.byteOffset,x.byteLength));
        }
        return hash.digest('hex');
    };
    return (seg,windows)=>{
        const cached=v8.deserialize(fs.readFileSync(path.join(folder,'log-'+seg.log+'.bin')));
        if(signature(seg,windows)!==signature(cached.seg,cached.windows))throw Error('Reconstruction cache settings, observations or flight windows differ.');
        seg.replayStates=cached.seg.replayStates;seg.dynamicSeeds=cached.seg.dynamicSeeds;
        windows.forEach((w,i)=>{w.input=cached.windows[i].input;});
        return true;
    };
}
module.exports = {validate,session,reuseReconstruction};
if (require.main === module) {
    const args=process.argv.slice(2), out=args[0], file=args[1], opt=k=>args.includes(k)?args[args.indexOf(k)+1]:null;
    if (!file) { console.error('usage: node tools/autotune/filter_validate.cjs <out directory> <file.bbl> [--flight-rpm 2000] [--cli dump.txt] [--budget-ms 120000] [--logs 0,1] [--cache-dir directory] [--reuse-report validation-report.json]'); process.exitCode=1; }
    else validate(file,{flightRpm:+opt('--flight-rpm')||undefined,cliText:opt('--cli')?fs.readFileSync(opt('--cli'),'utf8'):null,
        budgetMs:+opt('--budget-ms')||undefined,logs:opt('--logs')?opt('--logs').split(',').map(Number):undefined}, s=>console.error(s),opt('--cache-dir')?(seg,windows)=>{
            const {model,...saved}=seg,folder=opt('--cache-dir');fs.mkdirSync(folder,{recursive:true});
            fs.writeFileSync(path.join(folder,'log-'+seg.log+'.bin'),require('node:v8').serialize({seg:saved,windows:windows.map(w=>({...w,seg:saved}))}));
        }:null,opt('--reuse-report')?reuseReconstruction(opt('--reuse-report'),file):null).then(res=>{
        fs.mkdirSync(out,{recursive:true});
        fs.writeFileSync(path.join(out,'filter_tune.json'),JSON.stringify(res,(k,v)=>ArrayBuffer.isView(v)?Array.from(v):v,1));
        if(res.cliFile) fs.writeFileSync(path.join(out,'filter-autotune.txt'),res.cliFile);
        else fs.rmSync(path.join(out,'filter-autotune.txt'),{force:true});
        console.log(JSON.stringify({status:res.recommended.status,reasons:res.recommended.reasons,noise:res.recommended.predicted,delay:res.recommended.delay,
            holdout:res.recommended.validation.holdout,search:res.search,parity:res.model.parity,ms:res.ms},null,2));
    }).catch(e=>{console.error(e.stack);process.exitCode=1;});
}
