'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), cp = require('node:child_process');
const FT = require('../tools/autotune/filter_tune.cjs'), R = require('../tools/autotune/filter_replay.cjs');
const native = require('./helpers/filter_native.cjs');
function cfg(type, fpl = 1, dynamic = false, rpm = true) {
    return FT.config({ looptime: 500, pid_process_denom: fpl, filter_process_denom: 1, frameIntervalPNum: 1, frameIntervalPDenom: 1,
        gyro_soft_type: type, gyro_lowpass_hz: 160, gyro_soft2_type: 0, gyro_lowpass2_hz: 50,
        gyro_lowpass_dyn_hz: dynamic ? [60, 240] : [0, 0], gyro_notch_hz: [0, 0], gyro_notch_cutoff: [0, 0],
        features: (1 << 29) | (rpm ? 1 << 30 : 0), dyn_notch_count: 2, dyn_notch_q: 50, dyn_notch_min_hz: 80, dyn_notch_max_hz: 350,
        gyro_rpm_notch_preset: 1, gyro_rpm_notch_min_hz: 20,
        rollBW: [80, 35], pitchBW: [80, 35], yawBW: [80, 35] }, { gear: { main: [2, 15], tail: [1, 4], motorisedTail: false } });
}
test('native C differential replay: all ten LPF types, RPM scheduling, SDFT, PID derivative and dynamic LPF at 1/2 PID rates', t => {
    const dir = fs.mkdtempSync(os.tmpdir() + '/rf-filter-native-');
    try {
        const exe = native.build(dir);
        for (const type of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) for (const fpl of [1, 2]) {
            const dynamic = type > 0 && fpl === 2, c = cfg(type, fpl, dynamic), E = R.engine(c, Array.from({length: 3}, () => ({gyro_cutoff: 80, d_cutoff: 35, Kp: 0, Kd: 1})));
            const B = FT.effectiveBanks(c.s), head = B.map(list => Array.from({length: 16}, (_, j) => list[j] ? `${list[j].source} ${list[j].q} ${list[j].center}` : '0 0 0').join('\n')).join('\n');
            let input = head + '\n', expected = [];
            for (let i = 0; i < 6000; i++) {
                const time = i / 2000, hs = 3000 + 1200 * Math.sin(time / 2), ratio = 0.7 + 0.35 * Math.sin(time);
                const x = [0,1,2].map(a => 20 * Math.sin(2 * Math.PI * 155 * time + a) + 6 * Math.sin(2 * Math.PI * 237 * time) + 10 * Math.sin(2 * Math.PI * 13 * time));
                input += x.concat([hs, ratio]).join(' ') + '\n'; E.tick(x, hs, 0, ratio); expected.push([...E.gyro, ...E.dterm]);
            }
            const args = [type,160,0,50,2,50,80,350,2000,fpl,1,dynamic?60:0,dynamic?240:0,1].map(String);
            const got = cp.execFileSync(exe, args, {input, maxBuffer: 4e6}).toString().trim().split('\n').map(l => l.split(' ').map(Number));
            let maxGyro=0, maxD=0, rms=0, count=0;
            for(let i=500;i<got.length;i++) for(let a=0;a<6;a++) {const error=Math.abs(got[i][a]-expected[i][a]); if(a<3)maxGyro=Math.max(maxGyro,error);else maxD=Math.max(maxD,error); if(a<3){rms+=error*error;count++;}}
            t.diagnostic(`type ${type}, PID /${fpl}: max gyro ${maxGyro.toFixed(5)}, RMS ${Math.sqrt(rms/count).toFixed(5)}, max derivative ${maxD.toFixed(3)}`);
            assert.ok(Math.sqrt(rms/count)<0.025, `native gyro type ${type} /${fpl}: ${Math.sqrt(rms/count)}`);
            assert.ok(maxD<8, `native derivative type ${type} /${fpl}: ${maxD}`);
        }
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
test('sample-rate conversion preserves in-band signals and scheduler offset', () => {
    const n=4000, x=Float64Array.from({length:n},(_,i)=>Math.sin(2*Math.PI*190*i/1000));
    const y=R.resample(x,2,0.25,0,n); let mse=0;
    for(let k=100;k<y.length-100;k++) mse+=(y[k]-Math.sin(2*Math.PI*190*(k/2-0.25)/1000))**2;
    assert.ok(Math.sqrt(mse/(y.length-200))<0.0002);
});

test('gyro state checkpoints preserve RPM fades, biquads, dynamic LPF timing and every SDFT update phase',()=>{
    const c=FT.withSettings(cfg(8,2,true),{gyro_lpf2_type:7,gyro_lpf2_static_hz:350,gyro_notch1_hz:237,gyro_notch1_cutoff:220,gyro_notch2_hz:155,gyro_notch2_cutoff:140});
    const pid=Array(3).fill({gyro_cutoff:80,d_cutoff:35,Kp:0,Kd:1}),whole=R.engine(c,pid);
    let resumed=null;
    for(let i=0;i<6000;i++) {
        if([1237,2389,4010].includes(i))resumed=R.engine(c,pid,{state:whole.snapshot()});
        const time=i/2000,hs=150+1800*(1+Math.sin(3*time)),ratio=.75+.25*Math.sin(time);
        const input=[0,1,2].map(a=>20*Math.sin(2*Math.PI*(155+3*a)*time)+7*Math.sin(2*Math.PI*237*time));
        whole.tick(input,hs,0,ratio);
        if(resumed){resumed.tick(input,hs,0,ratio);assert.deepEqual(resumed.gyro,whole.gyro);}
    }
});

test('a changed filter configuration retains the update phase, including activation from OFF',()=>{
    const pid=Array(3).fill({gyro_cutoff:0,d_cutoff:0,Kp:0,Kd:0});
    for(const maximum of [35,70,80,95,140,240,350]) {
        const changed=FT.withSettings(cfg(1,2,false),{dyn_notch_max_hz:maximum});
        const old=FT.withSettings(changed,{DYN_NOTCH:false}),past=R.engine(old,pid),whole=R.engine(changed,pid);
        for(let i=0;i<1037;i++){past.tick([0,0,0],0,0,1);whole.tick([0,0,0],0,0,1);}
        const resumed=R.engine(changed,pid,{state:past.snapshot()});
        assert.equal(past.snapshot().dynamicUpdates,518);
        assert.deepEqual(resumed.dynamic.X.ints,whole.dynamic.X.ints,'the SDFT averaging and axis/step phases must agree');
        for(let i=0;i<8000;i++) {
            const x=[0,1,2].map(a=>20*Math.sin(i*.07+a)+7*Math.sin(i*.7));
            whole.tick(x,0,0,1);resumed.tick(x,0,0,1);
            assert.deepEqual(resumed.gyro,whole.gyro,'zero prehistory with the same scheduler phase gives identical output');
        }
    }
});

test('native RPM coefficients follow the gyro clock when Blackbox task throughput is lower',()=>{
    const dir=fs.mkdtempSync(os.tmpdir()+'/rf-filter-clock-');
    try {
        const exe=native.build(dir), c=cfg(1,2,false), reconstruct=require('../tools/autotune/filter_reconstruct.cjs');
        let now=0;const timestamps=Float64Array.from({length:10000},(_,i)=>now+=987+(i%20===0?247:0));
        const average=(timestamps.length-1)*1e6/(timestamps[timestamps.length-1]-timestamps[0])/1000;
        c.rates.scale=reconstruct.schedulerScale(timestamps,1000,average);
        const paths=Array(3).fill({gyro_cutoff:80,d_cutoff:35,Kp:0,Kd:1});
        const E=R.engine(c,paths), wrong=R.engine({...c,rates:{...c.rates,scale:average}},paths);
        let input=FT.effectiveBanks(c.s).map(bs=>Array.from({length:16},(_,j)=>bs[j]?`${bs[j].source} ${bs[j].q} ${bs[j].center}`:'0 0 0').join('\n')).join('\n')+'\n';
        const correct=[], biased=[];
        for(let i=0;i<8000;i++) {
            const t=i/2000,hs=3000+300*Math.sin(t),x=[0,1,2].map(a=>20*Math.sin(2*Math.PI*155*t+a)+8*Math.sin(2*Math.PI*237*t));
            input+=x.concat([hs,1]).join(' ')+'\n';E.tick(x,hs,0,1);wrong.tick(x,hs,0,1);
            correct.push([...E.gyro]);biased.push([...wrong.gyro]);
        }
        const args=[1,160,0,50,2,50,80,350,2000,2,1,0,0,1000/987].map(String);
        const got=cp.execFileSync(exe,args,{input,maxBuffer:4e6}).toString().trim().split('\n').map(l=>l.split(' ').map(Number));
        let error=0,oldError=0,n=0;for(let i=1000;i<got.length;i++)for(let a=0;a<3;a++){error+=(got[i][a]-correct[i][a])**2;oldError+=(got[i][a]-biased[i][a])**2;n++;}
        assert.ok(Math.sqrt(error/n)<.03);
        assert.ok(oldError>error*100,'the mean frame rate must not replace the interrupt clock in RPM coefficients');
    }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
module.exports={cfg};

test('native C differential replay: both static notches, LPF2, 48 custom banks, source offsets and RPM fade', () => {
    const dir=fs.mkdtempSync(os.tmpdir()+'/rf-filter-banks-');
    try {
        const exe=native.build(dir), base=cfg(4,1,false), changes={gyro_lpf2_type:7,gyro_lpf2_static_hz:350,gyro_rpm_notch_preset:0,
            gyro_notch1_hz:237,gyro_notch1_cutoff:220,gyro_notch2_hz:155,gyro_notch2_cutoff:140};
        for(const ax of ['roll','pitch','yaw']) {
            changes[`gyro_rpm_notch_source_${ax}`]=Array.from({length:16},(_,j)=>j<8?11+j:21+j-8);
            changes[`gyro_rpm_notch_q_${ax}`]=Array.from({length:16},(_,j)=>10+j*15);
            changes[`gyro_rpm_notch_center_${ax}`]=Array.from({length:16},(_,j)=>j%2?150:-150);
        }
        const c=FT.withSettings(base,changes), E=R.engine(c,Array(3).fill({gyro_cutoff:80,d_cutoff:35,Kp:0,Kd:1}));
        let input=FT.effectiveBanks(c.s).map(bs=>bs.map(b=>`${b.source} ${b.q} ${b.center}`).join('\n')).join('\n')+'\n', want=[];
        for(let i=0;i<10000;i++) {
            const t=i/2000, hs=i<4000?300+1700*i/4000:2000+1000*Math.sin(t), x=[0,1,2].map(a=>20*Math.sin(2*Math.PI*(155+3*a)*t)+10*Math.sin(2*Math.PI*237*t));
            input+=x.concat([hs,1]).join(' ')+'\n';E.tick(x,hs,0,1);want.push([...E.gyro,...E.dterm]);
        }
        const args=[4,160,7,350,2,50,80,350,2000,1,1,0,0,1,237,220,155,140].map(String);
        const got=cp.execFileSync(exe,args,{input,maxBuffer:4e6}).toString().trim().split('\n').map(l=>l.split(' ').map(Number));
        let rms=0,n=0;for(let i=1000;i<got.length;i++)for(let a=0;a<3;a++){rms+=(got[i][a]-want[i][a])**2;n++;}
        assert.ok(Math.sqrt(rms/n)<0.03,String(Math.sqrt(rms/n)));
    } finally {fs.rmSync(dir,{recursive:true,force:true});}
});
