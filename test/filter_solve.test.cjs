'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm');
const Solver=require('../tools/autotune/filter_solve.cjs'),C=require('../tools/autotune/filter_reconstruct.cjs'),FT=require('../tools/autotune/filter_tune.cjs');

// Independent JS composition of the public forward/adjoint operations. Retain
// the previous scalar CG algorithm as the equality reference for the kernel.
function reference(o,jacobian) {
    const {n,nf,step,pp,tape,gyroWeight,rawWeight,obs,regularization,damping,prefix}=o;
    const operator=x=>{
        const down=new Float64Array(nf);for(let i=0;i<nf;i++)down[i]=x[i*step];
        const filtered=jacobian?jacobian.forward(down):C.chain(down,tape),g=new Float64Array(nf);
        for(let i=0;i<nf;i++)g[i]=gyroWeight[i]*filtered[i];
        for(const ob of obs) {
            const p=new Float64Array(ob.weight.length);for(let i=0;i<p.length;i++)p[i]=filtered[i*pp];
            const y=C.chain(p,ob.tape),q=new Float64Array(y.length);
            for(let i=0;i<q.length;i++)q[i]=ob.weight[i]*y[i];
            const z=C.chain(q,ob.tape,true);for(let i=0;i<z.length;i++)g[i*pp]+=z[i];
        }
        const z=jacobian?jacobian.transpose(g):C.chain(g,tape,true),out=new Float64Array(n);
        for(let i=0;i<nf;i++)out[i*step]+=z[i];
        for(let i=0;i<n;i++)out[i]+=rawWeight[i]*x[i];
        for(let i=1;i<n-1;i++){const v=regularization*(x[i-1]-2*x[i]+x[i+1]);out[i-1]+=v;out[i]-=2*v;out[i+1]+=v;}
        for(let i=0;i<n;i++)out[i]+=1e-7*x[i];
        for(let i=0;i<n;i++)out[i]+=damping*x[i];
        return out;
    };
    if(!prefix)return C.cg(operator,o.rhs,o.seed,o.iterations);
    const fixed=new Float64Array(n);fixed.set(o.seed.subarray(0,prefix));
    const effect=operator(fixed),rhs=new Float64Array(n),seed=new Float64Array(n);
    for(let i=0;i<n;i++){rhs[i]=i<prefix?0:o.rhs[i]-effect[i];seed[i]=i<prefix?0:o.seed[i];}
    const solved=C.cg(x=>{const y=operator(x);y.fill(0,0,prefix);return y;},rhs,seed,o.iterations);
    solved.x.set(fixed.subarray(0,prefix));return solved;
}
function fixture(mode,step,withObservations,prefix) {
    const n=256,nf=n/step,pp=2;
    const tape=mode==='identity'?[]:[0,1,2].map(s=>{
        const t=new Float64Array(nf*6);
        for(let i=0;i<nf;i++){t.set(FT.biquad('notch',60+i*.2+s*35,1000,2+s),i*6);t[i*6+5]=.6+.3*Math.sin(i*.02+s);}
        return t;
    });
    const seed=Float64Array.from({length:n},(_,i)=>Math.sin(i*.7)+Math.cos(i*.23));
    const options={n,nf,step,pp,tape,gyroWeight:Float64Array.from({length:nf},(_,i)=>i>17&&i%5!==2?1:0),
        rawWeight:Float64Array.from({length:n},(_,i)=>i%4===1?1:0),obs:[],jac:null,
        rhs:Float64Array.from(seed,(v,i)=>v+Math.cos(i*.31)),seed,damping:mode==='adaptive'?.1:0,
        regularization:.003,iterations:37,prefix};
    if(withObservations)options.obs=[
        {weight:Float64Array.from({length:nf/pp},(_,i)=>i>4?.8:0),tape:[C.constant(FT.firstOrderLpf(80,500),nf/pp)]},
        {weight:Float64Array.from({length:nf/pp},(_,i)=>i>4&&i%5!==2?1e6:0),tape:[C.constant(FT.firstOrderLpf(80,500),nf/pp),C.constant(FT.difSection(35,500).map((v,i)=>i<3?-v*.0001:v),nf/pp)]}
    ];
    let jacobian=null;
    if(mode==='adaptive') {
        const events=[0,1].map(s=>Array.from({length:Math.floor(nf/16)},(_,k)=>({at:(k+1)*16,first:Math.max(0,k*4-3),
            weights:Float64Array.from({length:Math.min(k*4+1,4)},(_,i)=>.01*Math.cos(i+k+s)),dc:[.0001,.0002,.0001,-.0003,.0001]})));
        const record={events:[events],avg:Array.from({length:nf/4},(_,k)=>({start:k*4,end:k*4+4})),rcp:.25};
        const input=Float64Array.from({length:nf},(_,i)=>seed[i*step]);
        jacobian=C.linearizeDynamic(C,tape,input,null,record,0,2);options.jac=jacobian.kernel;
    }
    return {options,jacobian};
}
for(const mode of ['identity','fixed','adaptive'])for(const step of [1,2])for(const observations of [false,true])for(const prefix of [0,17,256]) {
    test(`portable inverse equals JS: ${mode}, step ${step}, observations ${observations}, prefix ${prefix}`,()=>{
        const {options,jacobian}=fixture(mode,step,observations,prefix);
        assert.deepStrictEqual(Solver.solve(options),reference(options,jacobian));
    });
}
test('zero initial residual stops without a spurious iteration',()=>{
    const {options}=fixture('identity',2,false,0);options.rhs.fill(0);options.seed.fill(0);
    const result=Solver.solve(options);assert.equal(result.iterations,0);assert.equal(result.residual,0);assert.ok(result.x.every(x=>x===0));
});
test('portable kernel runs in the worker without Node globals and matches its source manifest',()=>{
    const file=path.resolve(__dirname,'../tools/autotune/filter_solve.cjs'),source=fs.readFileSync(file,'utf8');
    const context=vm.createContext({module:{exports:{}}});vm.runInContext(source,context,{filename:file});
    assert.equal(typeof context.module.exports.solve,'function');
    const dir=path.resolve(__dirname,'../tools/autotune/reconstruct'),manifest=JSON.parse(fs.readFileSync(path.join(dir,'manifest.json'),'utf8'));
    const sha=x=>crypto.createHash('sha256').update(x).digest('hex');
    const encoded=/create\(decode\('([A-Za-z0-9+/=]+)'\)\)/.exec(source);assert.ok(encoded);
    const bytes=Buffer.from(encoded[1],'base64');assert.equal(sha(bytes),manifest.wasmSha256);assert.equal(Solver.wasmSha256,manifest.wasmSha256);
    assert.equal(sha(fs.readFileSync(path.join(dir,'kernel.c'))),manifest.sourceSha256);
    const runtime=fs.readFileSync(path.join(dir,'runtime.cjs'),'utf8').replace(/\nmodule\.exports=\{create\};\s*$/,'');
    assert.equal(sha(runtime),manifest.runtimeSha256);
    assert.deepEqual(WebAssembly.Module.imports(new WebAssembly.Module(bytes)),[]);
});
