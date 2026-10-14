
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
#define PG_RESET(x) memset(&rpmConfig,0,sizeof(rpmConfig))
static int debugAxis;
static float sensorConfig[192],sensorInput[8];
static uint32_t sensorErrors;
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
static bool mixerMotorizedTail(void) {return sensorConfig[19]!=0;}
static float getMainGearRatio(void) {return sensorConfig[17];}
static float getTailGearRatio(void) {return sensorConfig[18];}
static bool isMotorFastRpmSourceActive(int i) {return true;}
static void setArmingDisabled(int i) {sensorErrors|=1U<<i;}
static float getMotorRPMf(int i) {return i==0?sensorInput[3]/sensorConfig[17]:sensorInput[4]/sensorConfig[18];}
static float schedulerGetCycleTimeMultiplier(void) {return cycleScale;}
static float getThrottlePercent(void) {return 50;}
