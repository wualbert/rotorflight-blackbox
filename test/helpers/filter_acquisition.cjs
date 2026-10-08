'use strict';
const fs = require('node:fs'), path = require('node:path');
const native = require('./filter_native.cjs');
const dir = path.join(__dirname, '../fixtures/rotorflight-4.6');
const read = file => fs.readFileSync(path.join(dir, file), 'utf8');
function body(file, name) {
    const s = read(file), m = new RegExp('\\n[^\\n;]+\\b' + name + '\\([^;]*?\\)\\s*\\{').exec(s);
    if (!m) throw Error(name);
    let i = s.indexOf('{', m.index), j = i + 1, depth = 1;
    while (depth) { depth += (s[j] === '{') - (s[j] === '}'); j++; }
    return s.slice(m.index, j);
}
function build(dest) {
    const extra = `
#define GYRO_FILTER_FUNCTION_NAME nativeGyroFilter
#define GYRO_FILTER_DEBUG_SET(...)
#define GYRO_FILTER_AXIS_DEBUG_SET(...)
${read('sensors_gyro_filter_impl.c').replace(/^#include.*$/gm, '')}
${body('sensors_gyro_init.c', 'gyroInitDecimationFilter')}
typedef unsigned timeUs_t;
static int pidUpdateCounter, activeFilterLoopDenom, activePidLoopDenom, bbCount, bbDivider;
static order1Filter_t pg[3]; static difFilter_t df[3];
static float pidGyro[3], pidD[3], currentHS;
static void subTaskPosition(timeUs_t t) {}
static void subTaskSetpoint(timeUs_t t) {}
static void subTaskMixerUpdate(timeUs_t t) {}
static void subTaskBlackboxFlush(timeUs_t t) {}
static void subTaskMotorsServosUpdate(timeUs_t t) {motorRpm=currentHS*7.5f;}
static void subTaskFilterUpdate(timeUs_t t) {dynNotchUpdate();rpmFilterUpdate();}
static void subTaskPidController(timeUs_t t) {for(int a=0;a<3;a++) {pidGyro[a]=firstOrderFilterApply(&pg[a],gyro.gyroADCf[a]);pidD[a]=difFilterApply(&df[a],-pidGyro[a]);}}
static void subTaskBlackboxUpdate(timeUs_t t) {
 if(bbCount++%bbDivider) return;
 // Identical lrintf observations to loadMainState in blackbox.c.
 printf("%u",t);
 for(int a=0;a<3;a++)printf(" %ld %ld %.9g %.9g",lrintf(gyro.gyroADCd[a]),lrintf(gyro.gyroADCf[a]),pidGyro[a],pidD[a]);
 printf("\\n");
}
${body('fc_core.c', 'gyroFilterReady')}
${body('fc_core.c', 'taskMainPidLoop')}
`;
    const main = `
int main(int argc,char **argv) {
 if(argc<5)return 2;
 const float nativeHz=atof(argv[1]);activeFilterLoopDenom=atoi(argv[2]);activePidLoopDenom=activeFilterLoopDenom;bbDivider=atoi(argv[3]);
 gyro.filterRateHz=nativeHz/activeFilterLoopDenom;gyro.targetRateHz=gyro.filterRateHz;cycleScale=1;
 gyroInitDecimationFilter(argc>6?atof(argv[6]):500,nativeHz);
 dynNotchConfig_t dc={atoi(argv[4]),25,20,240};dynNotchInit(&dc);
 rpmEnabled=true;rpmConfig.min_hz=20;rpmConfig.preset=1;validateAndFixRPMFilterConfig();rpmFilterInit();
 for(int a=0;a<3;a++) {lowpassFilterInit(&gyro.lowpassFilter[a],LPF_1ST_ORDER,argc>5?atof(argv[5]):100,gyro.filterRateHz,0);lowpassFilterInit(&gyro.lowpass2Filter[a],0,0,gyro.filterRateHz,0);lowpassFilterInit(&gyro.notchFilter1[a],0,0,gyro.filterRateHz,0);lowpassFilterInit(&gyro.notchFilter2[a],0,0,gyro.filterRateHz,0);firstOrderLPFInit(&pg[a],80,gyro.targetRateHz);difFilterInit(&df[a],35,gyro.targetRateHz);}
 float x[3];unsigned tick=0;
 while(scanf("%f %f %f %f",&x[0],&x[1],&x[2],&currentHS)==4) {
  for(int a=0;a<3;a++)gyro.gyroADCd[a]=filterStackApply(gyro.decimator[a],x[a],2);
  if(gyroFilterReady())nativeGyroFilter();taskMainPidLoop(tick++);
 }
 return 0;
}
`;
    return native.build(dest, {extra,main});
}
module.exports = {build,body};
