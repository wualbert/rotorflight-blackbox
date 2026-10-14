'use strict';
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto');
const B=require('./build.cjs'),ROOT=__dirname,strip=s=>s.replace(/^\s*#include[^\n]*$/gm,'').replace(/^\s*#pragma once[^\n]*$/gm,'');
function source(){B.verifySources();const read=n=>fs.readFileSync(path.join(ROOT,'vendor',n.replace('/','_')),'utf8'),math=read('common/maths.c');
 return fs.readFileSync(path.join(ROOT,'sensor_platform.h'),'utf8')+strip(read('common/filter.h'))+
 'struct {float filterRateHz,targetRateHz,gyroADCd[3],gyroADCf[3];filter_t lowpassFilter[3],lowpass2Filter[3],notchFilter1[3],notchFilter2[3];} gyro;\n'+
 math.slice(math.indexOf('#if 0\n// Taylor'),math.indexOf('MATH_CODE float tan_approx2'))+strip(read('common/filter.c'))+strip(read('common/sdft.h'))+strip(read('common/sdft.c'))+
 strip(read('flight/dyn_notch_filter.c'))+strip(read('flight/rpm_filter.c'))+
 '\n#define GYRO_FILTER_FUNCTION_NAME nativeGyroFilter\n#define GYRO_FILTER_DEBUG_SET(...)\n#define GYRO_FILTER_AXIS_DEBUG_SET(...)\n'+strip(read('sensors/gyro_filter_impl.c'))+fs.readFileSync(path.join(ROOT,'sensor_bridge.c'),'utf8');
}
function build(){const compiler=process.env.WASI_CC||'/private/tmp/wasi-sdk-25.0-arm64-macos/bin/clang',file=path.join(require('node:os').tmpdir(),'rotorflight-native-sensor.c'),out=path.join(ROOT,'sensor.wasm'),src=source();fs.writeFileSync(file,src);
 cp.execFileSync(compiler,['-std=gnu11','-O2','-ffp-contract=off','-fno-fast-math','-Werror=implicit-function-declaration','-mexec-model=reactor',file,'-lm',...['rs_config','rs_input','rs_output','rs_errors','rs_reset','rs_tick'].map(n=>'-Wl,--export='+n),'-o',out],{stdio:'pipe'});
 const bytes=fs.readFileSync(out),module=new WebAssembly.Module(bytes);if(WebAssembly.Module.imports(module).length)throw Error('Unexpected native sensor host import');
 const metadata={...B.verifySources(),artifactSha256:crypto.createHash('sha256').update(bytes).digest('hex'),adaptationSha256:crypto.createHash('sha256').update(src).digest('hex'),compiler:cp.execFileSync(compiler,['--version'],{encoding:'utf8'}).split('\n')[0]};
 fs.writeFileSync(out.replace('.wasm','.json'),JSON.stringify(metadata,null,2)+'\n');return metadata;
}
module.exports={source,build};if(require.main===module)console.log(JSON.stringify(build(),null,2));
