/* Host protocol and scheduler boundary. Filter equations remain upstream. */
static unsigned sensorTick;
float *rs_config(void){return sensorConfig;}
float *rs_input(void){return sensorInput;}
float *rs_output(void){return gyro.gyroADCf;}
unsigned rs_errors(void){return sensorErrors;}
void rs_reset(void){
 sensorTick=0;sensorErrors=0;gyro.filterRateHz=sensorConfig[0];gyro.targetRateHz=sensorConfig[1];cycleScale=sensorConfig[2];
 dynNotchConfig_t dc={sensorConfig[7],sensorConfig[8],sensorConfig[9],sensorConfig[10]};dynNotchInit(&dc);
 rpmEnabled=sensorConfig[11]!=0;memset(&rpmConfig,0,sizeof(rpmConfig));rpmConfig.min_hz=sensorConfig[12];
 for(int a=0;a<3;a++)for(int j=0;j<16;j++){int k=32+3*(a*16+j);rpmConfig.custom.notch_source[a][j]=sensorConfig[k];rpmConfig.custom.notch_q[a][j]=sensorConfig[k+1];rpmConfig.custom.notch_center[a][j]=sensorConfig[k+2];}
 validateAndFixRPMFilterConfig();rpmFilterInit();
 for(int a=0;a<3;a++){
  lowpassFilterInit(&gyro.lowpassFilter[a],sensorConfig[3],sensorConfig[4],gyro.filterRateHz,0);
  lowpassFilterInit(&gyro.lowpass2Filter[a],sensorConfig[5],sensorConfig[6],gyro.filterRateHz,0);
  notchFilterInit(&gyro.notchFilter1[a],sensorConfig[13],sensorConfig[14],gyro.filterRateHz,0);
  notchFilterInit(&gyro.notchFilter2[a],sensorConfig[15],sensorConfig[16],gyro.filterRateHz,0);
 }
}
void rs_tick(void){
 for(int a=0;a<3;a++)gyro.gyroADCd[a]=sensorInput[a];
 nativeGyroFilter();
 // Control pipeline requires equal sensor-filter and PID update rates.
 // The scheduler updates notch coefficients after filtering and PID, once per PID loop.
 dynNotchUpdate();rpmFilterUpdate();sensorTick++;
}
