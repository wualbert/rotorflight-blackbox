'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const O=require('../tools/autotune/filter_optimizer.cjs');

test('upstream NOMAD reaches the enumerated constrained integer optimum and audits every coordinate neighbour',()=>{
    const evaluate=([x,y])=>[(x-3)**2+(y-5)**2,x+y-6], feasible=[];
    for(let x=0;x<=10;x++)for(let y=0;y<=10;y++)if(x+y<=6)feasible.push(evaluate([x,y])[0]);
    const opts={lower:[0,0],upper:[10,10],initial:[0,0],constraints:1,maxEvaluations:180,timeMs:10000,evaluate};
    const r=O.minimize(opts),again=O.minimize(opts);
    assert.equal(r.best.values[0],Math.min(...feasible));
    assert.ok(r.best.values[1]<=0);
    assert.deepEqual(again.best,r.best,'no cached objective or constraint data crosses solves');
    assert.equal(r.audit.complete,true);assert.equal(r.audit.passed,true);
    assert.equal(r.audit.tested,4);
    assert.match(r.algorithm,/NOMAD 4.5.1/);
    assert.equal(r.stop,'evaluation budget','a finite-grid cache stop is not convergence');
});
test('budget, infeasibility and objective errors cannot become optimizer certificates',()=>{
    const opts={lower:[0],upper:[10],initial:[0],constraints:1,maxEvaluations:1,timeMs:1000};
    const short=O.minimize({...opts,evaluate:x=>[(x[0]-8)**2,-1]});
    assert.equal(short.stop,'evaluation budget');assert.equal(short.audit.complete,false);
    const infeasible=O.minimize({...opts,maxEvaluations:20,evaluate:x=>[x[0],1]});
    assert.equal(infeasible.best,null);assert.ok(infeasible.infeasible);
    assert.equal(infeasible.audit.passed,false);
    assert.throws(()=>O.minimize({...opts,evaluate:()=>{throw Error('broken replay');}}),/broken replay/);
    assert.throws(()=>O.minimize({...opts,evaluate:()=>[NaN,-1]}),/invalid values/);
    assert.ok(O.minimize({...opts,evaluate:()=>[0,-1]}).best,'exception cleanup allows a new solve');
});
test('integer bounds and a continuous analytic problem use the declared domains',()=>{
    assert.throws(()=>O.minimize({lower:[0],upper:[10],initial:[.5],evaluate:x=>[x[0]]}),/domain/);
    const r=O.minimize({lower:[-2,-2],upper:[2,2],initial:[1,1],integer:false,maxEvaluations:200,timeMs:3000,
        evaluate:([x,y])=>[(x-.25)**2+(y+.5)**2]});
    assert.ok(r.best.values[0]<1e-6);
    assert.equal(r.audit.complete,false,'integer neighbourhood statements do not apply to continuous inputs');
});
test('the bundled solver loads synchronously through the browser CommonJS shim without Node APIs',()=>{
    const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
    const context=vm.createContext({performance:require('node:perf_hooks').performance,console,
        importScripts:()=>{throw Error('The optimizer must use its bundled WebAssembly.');}});
    vm.runInContext('var self=globalThis;',context);
    const modules=new Map();
    context.require=name=>{
        if(modules.has(name))return modules.get(name);
        const file=name==='./optimizer/nomad.cjs'?'optimizer/nomad.cjs':'filter_optimizer.cjs';
        const code=fs.readFileSync(path.join(__dirname,'../tools/autotune',file),'utf8');
        const result=vm.runInContext('(function(require){var module={exports:{}};var exports=module.exports;'+code+'\nreturn module.exports;})(require)',context);
        modules.set(name,result);return result;
    };
    const result=vm.runInContext(`require('./filter_optimizer.cjs').minimize({lower:[0],upper:[10],initial:[0],maxEvaluations:40,timeMs:2000,
        evaluate:x=>[(x[0]-4)**2]})`,context);
    assert.equal(result.best.values[0],0);
    assert.equal(result.audit.passed,true);
});
test('bundled upstream source and compiled asset match their provenance manifest',()=>{
    const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
    const folder=path.join(__dirname,'../tools/autotune/optimizer'),manifest=require('../tools/autotune/optimizer/manifest.json');
    assert.equal(manifest.version,'4.5.1');assert.equal(manifest.algorithmChanges,false);
    for(const [name,hash] of Object.entries(manifest.files))
        assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(folder,name))).digest('hex'),hash,name);
});
