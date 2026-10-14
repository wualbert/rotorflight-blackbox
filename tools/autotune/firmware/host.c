/* Exogenous measurements and inactive hardware entry points. No control law. */
static float input[64], output[80], config[256];
static uint32_t hostTimeUs;
static bool executeGovernor;
static float hostGearNumerator,hostGearDenominator;
static uint8_t hostBatteryCells,hostVoltageSource;
static governorConfig_t governorConfiguration;
static pidProfile_t profile;
static pidProfile_t *currentPidProfile = &profile;
static mixerConfig_t mixerConfiguration;
static mixerInput_t mixerInputConfiguration[MIXER_INPUT_COUNT];
static mixerRule_t mixerRuleConfiguration[MIXER_RULE_COUNT];
static struct {uint32_t targetLooptime; float targetRateHz,gyroADCf[3];} gyro;
static float rcCommand[18];
static mixerConfig_t *mixerConfig(void) {return &mixerConfiguration;}
static mixerConfig_t *mixerConfigMutable(void) {return &mixerConfiguration;}
static mixerInput_t *mixerInputs(int index) {return &mixerInputConfiguration[index];}
static mixerInput_t *mixerInputsMutable(int index) {return &mixerInputConfiguration[index];}
static mixerRule_t *mixerRules(int index) {return &mixerRuleConfiguration[index];}
static mixerRule_t *mixerRulesMutable(int index) {return &mixerRuleConfiguration[index];}
static pidProfile_t *pidProfilesMutable(int index) {(void)index; return &profile;}
static unsigned getCurrentPidProfileIndex(void) {return 0;}
static void changePidProfile(unsigned index) {(void)index;}
static float getSetpoint(int axis) {return axis == 3 ? input[6]*1000 : input[axis];}
static float rescueApply(int axis,float value) {(void)axis; return value;}
static void rescueInitProfile(const pidProfile_t *p) {(void)p;}
static void governorInitProfile(const pidProfile_t *p) {if(executeGovernor)fw_governorInitProfile(p);}
static void governorUpdate(void) {if(executeGovernor)fw_governorUpdate();}
static float getGovernorOutput(void) {return executeGovernor?fw_getGovernorOutput():input[11];}
static float getHeadSpeedf(void) {return input[7];}
static float getSpoolUpRatio(void) {return executeGovernor?fw_getSpoolUpRatio():input[8];}
static bool isAirborne(void) {return input[9] != 0;}
static bool isSpooledUp(void) {return executeGovernor?fw_isSpooledUp():input[10] != 0;}
static bool gyroOverflowDetected(void) {return input[13] != 0;}
static float getTTAIncrease(void) {return executeGovernor?fw_getTTAIncrease():input[12];}
static float getThrottle(void) {return executeGovernor?input[38]:input[11];}
static float getRcDeflection(int axis) {return input[24+axis];}
static bool wiggleActive(void) {return false;}
static float wiggleGetAxis(int axis) {(void)axis; return 0;}
static void wiggleUpdate(timeUs_t now) {(void)now;}
static void wiggleInit(void) {}
static governorConfig_t *governorConfig(void) {return &governorConfiguration;}
static governorConfig_t *governorConfigMutable(void) {return &governorConfiguration;}
static timeMs_t millis(void) {return hostTimeUs/1000;}
static int32_t cmp32(uint32_t a,uint32_t b) {return (int32_t)(a-b);}
static bool isThrottleOff(void) {return input[39]!=0;}
static float getMotorRawRPMf(int motor) {(void)motor;return input[36];}
static int getBatteryCellCount(void) {return hostBatteryCells;}
static int getBatteryVoltageSource(void) {return hostVoltageSource;}
typedef struct {float sample;} hostVoltageMeter_t;
static hostVoltageMeter_t *getBatteryVoltageMeter(void) {static hostVoltageMeter_t meter;meter.sample=input[37]*1000;return &meter;}
static int getMotorCount(void) {return 1;}
static bool isMotorFastRpmSourceActive(int motor) {(void)motor;return true;}
static void setArmingDisabled(int reason) {(void)reason;}
static float getMainGearRatio(void) {return hostGearNumerator/hostGearDenominator;}

static float servoConfigValues[65];
static bool executeServo;
static servoParam_t servoConfiguration[MAX_SUPPORTED_SERVOS];
static servoParam_t *servoParams(int index) {return &servoConfiguration[index];}
static servoParam_t *servoParamsMutable(int index) {return &servoConfiguration[index];}

static bool hostArmed(void) {return input[35]==0;}
