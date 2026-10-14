'use strict';
// Factory accepts verified bytes so the eventual worker module needs no Node API.
function create(bytes) {
    const W=new WebAssembly.Instance(new WebAssembly.Module(bytes)).exports;
    return {solve(options) {
        const allocations=[];
        function allocate(count,kind='f64',values=null) {
            const width=kind==='f64'?8:4,p=W.malloc(Math.max(8,count*width));
            if(!p)throw Error('The reconstruction buffer is not available.');
            allocations.push(p);
            if(values) {
                const view=kind==='f64'?new Float64Array(W.memory.buffer,p,count):new Int32Array(W.memory.buffer,p,count);
                view.set(values);
            }
            return p;
        }
        const f64=values=>allocate(values.length,'f64',values);
        const i32=values=>allocate(values.length,'i32',values);
        const tapes=values=>i32(values.map(f64));
        try {
            const tape=tapes(options.tape),gyroWeight=f64(options.gyroWeight),rawWeight=f64(options.rawWeight);
            const observations=i32(options.obs.flatMap(ob=>[ob.weight.length,f64(ob.weight),tapes(ob.tape),ob.tape.length]));
            let jac=0,rcp=0;
            if(options.jac) {
                const j=options.jac;
                jac=i32([j.count,j.split,j.record.avg.length,i32(j.record.avg.flatMap(a=>[a.start,a.end])),
                    i32(j.events.map(list=>list.length)),i32(j.events.map(list=>i32(list.flatMap(e=>[e.at,e.first,e.weights.length,f64(e.weights)])))),
                    tapes(j.drives),tapes(j.allpole)]);
                rcp=j.record.rcp;
            }
            const rhs=f64(options.rhs),seed=f64(options.seed),out=allocate(options.n),stats=allocate(2);
            const success=W.rf_solve(options.n,options.nf,options.step,options.pp,tape,options.tape.length,gyroWeight,rawWeight,
                observations,options.obs.length,jac,rcp,rhs,seed,options.damping,options.regularization,
                options.iterations,options.prefix,out,stats);
            if(!success)throw Error('The reconstruction buffer is not available.');
            const result=new Float64Array(W.memory.buffer,stats,2);
            return {x:new Float64Array(new Float64Array(W.memory.buffer,out,options.n)),iterations:result[0],residual:result[1]};
        } finally {for(let i=allocations.length-1;i>=0;i--)W.free(allocations[i]);}
    }};
}
module.exports={create};
