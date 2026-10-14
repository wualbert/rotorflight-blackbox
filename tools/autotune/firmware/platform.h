/* Host boundary for the unmodified Rotorflight 4.6.0 PID/mixer sources. GPL-3.0. */
#include <stdint.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#define FAST_CODE
#define FAST_DATA_ZERO_INIT
#define INIT_CODE
#define MATH_CODE
#define STATIC_ASSERT(a,b) _Static_assert(a,b)
#define UNUSED(x) (void)(x)
#define BIT(x) (1U << (x))
#define DEBUG(...)
#define DEBUG_SET(...)
#define DEBUG_AXIS(...)
#define ADJFUN_DECLARE(...)
#define PID_PROFILE_COUNT 6
#define MAX_SUPPORTED_SERVOS 8
#define MAX_SUPPORTED_MOTORS 4
#define MAX_SUPPORTED_RC_CHANNEL_COUNT 18
#define PG_DECLARE(type,name) static type *name(void); static type *name##Mutable(void)
#define PG_DECLARE_ARRAY(type,count,name) static type *name(int); static type *name##Mutable(int)
#define ARMED 1
static bool hostArmed(void);
#define ARMING_FLAG(flag) hostArmed()
#define ROLL 0
#define PITCH 1
#define COLLECTIVE 3
enum {YAW=2};
#define IS_RC_MODE_ACTIVE(mode) (input[40+(mode)] != 0)
#define BOXGOVBYPASS 0
#define BOXGOVSUSPEND 1
#define BOXGOVFALLBACK 2
#define VOLTAGE_METER_ADC 1
#define ARMING_DISABLED_GOVERNOR 1
#define ARMING_DISABLED_RPM_SIGNAL 2
#define CLEAR_BIT(reg,bits) ((reg)&=~(bits))
#ifndef __unused
#define __unused __attribute__((unused))
#endif
typedef uint32_t timeUs_t;
typedef uint32_t timeMs_t;
typedef unsigned int uint;
typedef uint32_t bitmap_t;

#define USE_SERVO_GEOMETRY_CORRECTION
typedef uint16_t ioTag_t;
typedef struct {uint32_t *ccr;} timerChannel_t;
