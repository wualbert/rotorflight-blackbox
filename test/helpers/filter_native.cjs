'use strict';
// Build the unmodified, pinned Rotorflight filter/RPM/SDFT implementations with
// only hardware/configuration stubs. No reimplementation of the DSP in C.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process');
const root = path.join(__dirname, '../fixtures/rotorflight-4.6');
const read = n => fs.readFileSync(path.join(root, n), 'utf8');
const strip = s => s.replace(/^\s*#include[^\n]*$/gm, '').replace(/^\s*#pragma once[^\n]*$/gm, '');
function build(dir, options = {}) {
    const manifest = JSON.parse(read('manifest.json')), crypto = require('node:crypto');
    for (const [file, hash] of Object.entries(manifest.files)) {
        if (crypto.createHash('sha256').update(read(file.replace('/', '_'))).digest('hex') !== hash) throw Error('Pinned firmware source changed: ' + file);
    }
    const maths = read('common_maths.c');
    const poly = maths.slice(maths.indexOf('#if 0\n// Taylor'), maths.indexOf('MATH_CODE float tan_approx2'));
    const prelude = `
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <complex.h>
#undef I
#define FAST_CODE
#define FAST_DATA_ZERO_INIT
#define INIT_CODE
#define MATH_CODE
#define STATIC_ASSERT(a,b) _Static_assert(a,b)
#define UNUSED(x) (void)(x)
#define M_PIf 3.14159265358979323846f
#define M_2PIf (2*M_PIf)
#define M_2_PIf (2/M_PIf)
#define M_1_2PIf (1/(2*M_PIf))
#define BIT(x) (1U << (x))
#define MIN(a,b) ((a)<(b)?(a):(b))
#define MAX(a,b) ((a)>(b)?(a):(b))
#define XYZ_AXIS_COUNT 3
#define USE_DYN_NOTCH_FILTER
#define USE_RPM_FILTER
#define DYN_NOTCH_COUNT_MAX 8
#define RPM_FILTER_NOTCH_COUNT 16
#define RPM_FILTER_AXIS_COUNT 3
#define DEBUG(...)
#define DEBUG_SET(...)
#define DEBUG_AXIS(...)
#define DEBUG_TIME_START(...)
#define DEBUG_TIME_END(...)
#define FEATURE_RPM_FILTER 30
#define ARMING_DISABLED_RPM_SIGNAL 1
#define ARMING_DISABLED_RPMFILTER 2
#define PG_RESET(x) abort()
static int debugAxis;
static float constrainf(float x,float lo,float hi) {return fminf(hi,fmaxf(lo,x));}
static int constrain(int x,int lo,int hi) {return MIN(hi,MAX(lo,x));}
static float transition(float x,float x0,float x1,float y0,float y1) {return x>x1?y1:x<x0?y0:y0+(x-x0)*(y1-y0)/(x1-x0);}
static float sq(float x) {return x*x;}
typedef struct {float sin,cos;} sincosf_t;
typedef struct {uint8_t dyn_notch_count,dyn_notch_q; uint16_t dyn_notch_min_hz,dyn_notch_max_hz;} dynNotchConfig_t;
typedef struct {uint8_t notch_source[3][16]; int16_t notch_center[3][16]; uint8_t notch_q[3][16];} rpmNotchConfig_t;
typedef struct {uint8_t preset,min_hz; rpmNotchConfig_t custom;} rpmFilterConfig_t;
static rpmFilterConfig_t rpmConfig;
static rpmFilterConfig_t *rpmFilterConfigMutable(void) {return &rpmConfig;}
static const rpmFilterConfig_t *rpmFilterConfig(void) {return &rpmConfig;}
static bool rpmEnabled;
static float motorRpm, cycleScale;
static int featureIsEnabled(int f) {return rpmEnabled;}
static bool mixerMotorizedTail(void) {return false;}
static float getMainGearRatio(void) {return 1.0f/7.5f;}
static float getTailGearRatio(void) {return 4.0f/7.5f;}
static bool isMotorFastRpmSourceActive(int i) {return true;}
static void setArmingDisabled(int i) {abort();}
static float getMotorRPMf(int i) {return motorRpm;}
static float schedulerGetCycleTimeMultiplier(void) {return cycleScale;}
static float getThrottlePercent(void) {return 50;}
`;
    const gyro = `struct {float filterRateHz, targetRateHz, gyroADCd[3], gyroADCf[3]; bool useDecimation; biquadFilter_t decimator[3][2]; filter_t lowpassFilter[3], lowpass2Filter[3], notchFilter1[3], notchFilter2[3];} gyro;\n`;
    const main = options.main || `
int main(int argc,char **argv) {
 if(argc<15) return 2;
 int type=atoi(argv[1]),type2=atoi(argv[3]),denom=atoi(argv[10]);
 float hz=atof(argv[2]),hz2=atof(argv[4]),fs=atof(argv[9]),minL=atof(argv[12]),maxL=atof(argv[13]);
 gyro.filterRateHz=fs; gyro.targetRateHz=fs/denom; cycleScale=atof(argv[14]);
 dynNotchConfig_t dc={atoi(argv[5]),atoi(argv[6]),atoi(argv[7]),atoi(argv[8])};
 dynNotchInit(&dc); rpmEnabled=atoi(argv[11]); rpmConfig.min_hz=20;
 for(int a=0;a<3;a++) for(int j=0;j<16;j++) {int s,q,c; if(scanf("%d %d %d",&s,&q,&c)!=3) return 3; rpmConfig.custom.notch_source[a][j]=s;rpmConfig.custom.notch_q[a][j]=q;rpmConfig.custom.notch_center[a][j]=c;}
 validateAndFixRPMFilterConfig(); rpmFilterInit();
 filter_t lp[3],lp2[3]; order1Filter_t pg[3]; difFilter_t df[3]; biquadFilter_t sn[3][2];
 float nh[2]={argc>15?atof(argv[15]):0,argc>17?atof(argv[17]):0},nc[2]={argc>16?atof(argv[16]):0,argc>18?atof(argv[18]):0};
 for(int a=0;a<3;a++)for(int s=0;s<2;s++)if(nh[s]>0)biquadFilterInit(&sn[a][s],nh[s],fs,notchFilterGetQ(nh[s],nc[s]),BIQUAD_NOTCH);
 for(int a=0;a<3;a++) {lowpassFilterInit(&lp[a],type,hz,fs,minL>0?LPF_UPDATE:0);lowpassFilterInit(&lp2[a],type2,hz2,fs,0);firstOrderLPFInit(&pg[a],80,gyro.targetRateHz);difFilterInit(&df[a],35,gyro.targetRateHz);}
 float x[3],hs,ratio,y[3]={0},d[3]={0}; int tick=0;float lastL=-1;
 while(scanf("%f %f %f %f %f",&x[0],&x[1],&x[2],&hs,&ratio)==5) {
  motorRpm=hs*7.5f;
  for(int a=0;a<3;a++) {float v=rpmFilterGyro(a,x[a]);v=filterApply(&lp2[a],v);v=filterApply(&lp[a],v);for(int s=1;s>=0;s--)if(nh[s]>0)v=biquadFilterApplyDF1(&sn[a][s],v);y[a]=dynNotchFilter(a,v);}
  if(tick%denom==0) for(int a=0;a<3;a++) {float g=firstOrderFilterApply(&pg[a],y[a]);d[a]=difFilterApply(&df[a],-g);}
  if(tick%denom==denom-1) {
   if(minL>0 && tick/(fs*cycleScale)-lastL>=0.005f-1e-7f) {for(int a=0;a<3;a++)filterUpdate(&lp[a],constrainf(hz*ratio,minL,maxL),fs);lastL=tick/(fs*cycleScale);}
   dynNotchUpdate();rpmFilterUpdate();
  }
  printf("%.9g %.9g %.9g %.9g %.9g %.9g\\n",y[0],y[1],y[2],d[0],d[1],d[2]);tick++;
 }
 return 0;
}
`;
    const source = prelude + strip(read('common_filter.h')) + gyro + poly + strip(read('common_filter.c')) + strip(read('common_sdft.h')) + strip(read('common_sdft.c')) + strip(read('flight_dyn_notch_filter.c')) + strip(read('flight_rpm_filter.c')) + (options.extra || '') + main;
    const file = path.join(dir, 'native.c'), exe = path.join(dir, 'native'); fs.writeFileSync(file, source);
    cp.execFileSync(process.env.CC || 'cc', ['-std=c11', '-O2', file, '-lm', '-o', exe], {stdio:'pipe'});
    return exe;
}
module.exports = {build};
