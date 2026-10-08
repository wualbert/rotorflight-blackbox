'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),v8=require('node:v8'),crypto=require('node:crypto');
const {reuseReconstruction}=require('../tools/autotune/filter_validate.cjs');
const root=path.resolve(__dirname,'..'),sha=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
test('reconstruction reuse requires the same source, recording, observations, settings and flight windows',()=>{
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rf-reuse-test-'));
    try {
        const input=path.join(dir,'flight.bbl'),reportFile=path.join(dir,'report.json');fs.writeFileSync(input,'recorded input');fs.mkdirSync(path.join(dir,'job'));
        const sourceSha256=Object.fromEntries(['filter_replay','filter_reconstruct','filter_tune'].map(n=>{const f='tools/autotune/'+n+'.cjs';return [f,sha(path.join(root,f))];}));
        const report={sourceSha256,reconstructionCache:dir,recordings:[{inputSha256:sha(input),result:'job/filter_tune.json'}]};
        fs.writeFileSync(reportFile,JSON.stringify(report));
        const seg={cfg:{s:{gyro_lpf1_static_hz:100}},n:3,log:0,firstProfile:1,fromS:0,observers:{},
            raw:[new Float64Array([1,2,3])],filt:[new Float64Array([2,3,4])],w:{D:[new Float64Array([.01,.02,.03])]},hs:new Float64Array([3000,3000,3000]),
            replayStates:new Map([[0,{tick:10}]]),dynamicSeeds:new Map([[0,new Float64Array([55,100])]])};
        const windows=[{st:0,N:3,lead:0,profile:1,unit:'0:0',held:false,input:{raw:[new Float32Array([1.1,2.1,3.1])],state:{tick:10}}}];
        fs.writeFileSync(path.join(dir,'job/log-0.bin'),v8.serialize({seg,windows}));
        const fresh=v8.deserialize(v8.serialize({seg,windows}));delete fresh.windows[0].input;delete fresh.seg.replayStates;delete fresh.seg.dynamicSeeds;
        const restore=reuseReconstruction(reportFile,input);assert.equal(restore(fresh.seg,fresh.windows),true);
        assert.deepEqual(fresh.windows[0].input,windows[0].input);assert.deepEqual(fresh.seg.replayStates,seg.replayStates);
        for(const mutate of [s=>s.cfg.s.gyro_lpf1_static_hz++,s=>s.w.D[0][1]+=.001,s=>s.raw[0][1]++,s=>s.hs[0]++]) {
            const changed=v8.deserialize(v8.serialize(seg));mutate(changed);
            assert.throws(()=>restore(changed,windows),/settings, observations or flight windows differ/);
        }
        assert.throws(()=>restore(seg,[{...windows[0],held:true}]),/flight windows differ/);
        fs.writeFileSync(input,'different input');assert.throws(()=>reuseReconstruction(reportFile,input),/recorded input differs/);
        report.sourceSha256['tools/autotune/filter_replay.cjs']='changed';fs.writeFileSync(reportFile,JSON.stringify(report));
        assert.throws(()=>reuseReconstruction(reportFile,input),/Reconstruction source differs/);
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
