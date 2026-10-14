/* Generated from schema.cjs. Protocol bridge, no controller equations. */
void *rf_config(void) {return config;}
void *rf_input(void) {return input;}
void *rf_output(void) {return output;}
void rf_servo_reset(void);
void rf_reset(void) {
 memset(&gov,0,sizeof(gov)); memset(&governorConfiguration,0,sizeof(governorConfiguration)); hostTimeUs=0; executeGovernor=config[255]!=0;
 memset(&pid,0,sizeof(pid)); memset(&mixer,0,sizeof(mixer));
 memset(&profile,0,sizeof(profile)); memset(&mixerConfiguration,0,sizeof(mixerConfiguration));
 memset(mixerRuleConfiguration,0,sizeof(mixerRuleConfiguration));
 memset(input,0,sizeof(input)); memset(output,0,sizeof(output));
 for(int i=0;i<MIXER_INPUT_COUNT;i++) {mixerInputConfiguration[i].min=-2500;mixerInputConfiguration[i].max=2500;mixerInputConfiguration[i].rate=1000;}
 gyro.targetLooptime = config[0];
 profile.pid_mode = config[1];
 profile.pid[0].P = config[2];
 profile.pid[0].I = config[3];
 profile.pid[0].D = config[4];
 profile.pid[0].F = config[5];
 profile.pid[0].B = config[6];
 profile.pid[0].O = config[7];
 profile.pid[1].P = config[8];
 profile.pid[1].I = config[9];
 profile.pid[1].D = config[10];
 profile.pid[1].F = config[11];
 profile.pid[1].B = config[12];
 profile.pid[1].O = config[13];
 profile.pid[2].P = config[14];
 profile.pid[2].I = config[15];
 profile.pid[2].D = config[16];
 profile.pid[2].F = config[17];
 profile.pid[2].B = config[18];
 profile.pid[2].O = config[19];
 profile.error_decay_time_ground = config[20];
 profile.error_decay_time_cyclic = config[21];
 profile.error_decay_time_yaw = config[22];
 profile.error_decay_limit_cyclic = config[23];
 profile.error_decay_limit_yaw = config[24];
 profile.offset_flood_relax_level = config[25];
 profile.offset_flood_relax_cutoff = config[26];
 profile.iterm_relax_type = config[27];
 profile.yaw_cw_stop_gain = config[28];
 profile.yaw_ccw_stop_gain = config[29];
 profile.yaw_precomp_cutoff = config[30];
 profile.yaw_cyclic_ff_gain = config[31];
 profile.yaw_collective_ff_gain = config[32];
 profile.yaw_inertia_precomp_gain = config[33];
 profile.yaw_inertia_precomp_cutoff = config[34];
 profile.pitch_collective_ff_gain = config[35];
 profile.cyclic_cross_coupling_gain = config[36];
 profile.cyclic_cross_coupling_ratio = config[37];
 profile.cyclic_cross_coupling_cutoff = config[38];
 profile.error_limit[0] = config[39];
 profile.error_limit[1] = config[40];
 profile.error_limit[2] = config[41];
 profile.offset_limit[0] = config[42];
 profile.offset_limit[1] = config[43];
 profile.iterm_relax_level[0] = config[44];
 profile.iterm_relax_level[1] = config[45];
 profile.iterm_relax_level[2] = config[46];
 profile.iterm_relax_cutoff[0] = config[47];
 profile.iterm_relax_cutoff[1] = config[48];
 profile.iterm_relax_cutoff[2] = config[49];
 profile.gyro_cutoff[0] = config[50];
 profile.dterm_cutoff[0] = config[51];
 profile.bterm_cutoff[0] = config[52];
 profile.gyro_cutoff[1] = config[53];
 profile.dterm_cutoff[1] = config[54];
 profile.bterm_cutoff[1] = config[55];
 profile.gyro_cutoff[2] = config[56];
 profile.dterm_cutoff[2] = config[57];
 profile.bterm_cutoff[2] = config[58];
 mixerConfiguration.main_rotor_dir = config[59];
 mixerConfiguration.tail_rotor_mode = config[60];
 mixerConfiguration.tail_motor_idle = config[61];
 mixerConfiguration.tail_center_trim = config[62];
 mixerConfiguration.swash_type = config[63];
 mixerConfiguration.swash_ring = config[64];
 mixerConfiguration.swash_phase = config[65];
 mixerConfiguration.swash_pitch_limit = config[66];
 mixerConfiguration.swash_tta_precomp = config[67];
 mixerConfiguration.swash_geo_correction = config[68];
 mixerConfiguration.collective_tilt_correction_pos = config[69];
 mixerConfiguration.collective_tilt_correction_neg = config[70];
 mixerConfiguration.swash_trim[0] = config[71];
 mixerConfiguration.swash_trim[1] = config[72];
 mixerConfiguration.swash_trim[2] = config[73];
 mixerInputConfiguration[1].rate = config[74];
 mixerInputConfiguration[1].min = config[75];
 mixerInputConfiguration[1].max = config[76];
 mixerInputConfiguration[2].rate = config[77];
 mixerInputConfiguration[2].min = config[78];
 mixerInputConfiguration[2].max = config[79];
 mixerInputConfiguration[3].rate = config[80];
 mixerInputConfiguration[3].min = config[81];
 mixerInputConfiguration[3].max = config[82];
 mixerInputConfiguration[4].rate = config[83];
 mixerInputConfiguration[4].min = config[84];
 mixerInputConfiguration[4].max = config[85];
 mixerInputConfiguration[5].rate = config[86];
 mixerInputConfiguration[5].min = config[87];
 mixerInputConfiguration[5].max = config[88];
 governorConfiguration.gov_mode = config[89];
 governorConfiguration.gov_throttle_type = config[90];
 governorConfiguration.gov_startup_time = config[91];
 governorConfiguration.gov_spoolup_time = config[92];
 governorConfiguration.gov_tracking_time = config[93];
 governorConfiguration.gov_recovery_time = config[94];
 governorConfiguration.gov_spooldown_time = config[95];
 governorConfiguration.gov_throttle_hold_timeout = config[96];
 governorConfiguration.gov_autorotation_timeout = config[97];
 governorConfiguration.gov_idle_throttle = config[98];
 governorConfiguration.gov_auto_throttle = config[99];
 governorConfiguration.gov_handover_throttle = config[100];
 governorConfiguration.gov_pwr_filter = config[101];
 governorConfiguration.gov_rpm_filter = config[102];
 governorConfiguration.gov_tta_filter = config[103];
 governorConfiguration.gov_ff_filter = config[104];
 governorConfiguration.gov_d_filter = config[105];
 governorConfiguration.gov_bypass_throttle[0] = config[106];
 governorConfiguration.gov_bypass_throttle[1] = config[107];
 governorConfiguration.gov_bypass_throttle[2] = config[108];
 governorConfiguration.gov_bypass_throttle[3] = config[109];
 governorConfiguration.gov_bypass_throttle[4] = config[110];
 governorConfiguration.gov_bypass_throttle[5] = config[111];
 governorConfiguration.gov_bypass_throttle[6] = config[112];
 governorConfiguration.gov_bypass_throttle[7] = config[113];
 governorConfiguration.gov_bypass_throttle[8] = config[114];
 profile.governor.flags = config[115];
 profile.governor.headspeed = config[116];
 profile.governor.min_throttle = config[117];
 profile.governor.max_throttle = config[118];
 profile.governor.gain = config[119];
 profile.governor.p_gain = config[120];
 profile.governor.i_gain = config[121];
 profile.governor.d_gain = config[122];
 profile.governor.f_gain = config[123];
 profile.governor.p_limit = config[124];
 profile.governor.i_limit = config[125];
 profile.governor.d_limit = config[126];
 profile.governor.f_limit = config[127];
 profile.governor.tta_gain = config[128];
 profile.governor.tta_limit = config[129];
 profile.governor.yaw_weight = config[130];
 profile.governor.cyclic_weight = config[131];
 profile.governor.collective_weight = config[132];
 profile.governor.collective_curve = config[133];
 profile.governor.fallback_drop = config[134];
 profile.governor.dyn_min_throttle = config[135];
 hostGearNumerator = config[136];
 hostGearDenominator = config[137];
 hostBatteryCells = config[138];
 hostVoltageSource = config[139];
 gyro.targetRateHz=1e6f/gyro.targetLooptime;
 mixerInit(); pidInit(&profile); if(executeGovernor)fw_governorInit(&profile); rf_servo_reset();
}
void rf_seed(void) {
 for(int a=0;a<3;a++) {pid.data[a].axisError=input[28+a];pid.data[a].axisOffset=input[31+a];}
}
void rf_step(void) {
 hostTimeUs = input[34]>=0 ? (uint32_t)(input[34]*1000000) : hostTimeUs+gyro.targetLooptime;
 for(int a=0;a<3;a++) gyro.gyroADCf[a]=input[3+a];
 if(input[14]!=0) {
  for(int a=0;a<4;a++) mixer.input[1+a]=input[15+a];
  mixer.cyclicTotal=sqrtf(input[15]*input[15]+input[16]*input[16]);
  for(int a=0;a<3;a++) mixer.saturation[1+a]=input[19+a]!=0 ? MIXER_SATURATION_TIME:0;
 }
 pidController(&profile,0); mixerUpdate(0); if(executeServo)servoUpdate();
 for(int a=0;a<5;a++) output[a]=mixer.input[1+a];
 for(int a=0;a<3;a++) {
  pidAxisData_t *d=&pid.data[a];
  float v[11]={d->P,d->I,d->D,d->F,d->B,d->O,d->pidSum,d->gyroRate,d->axisError,d->axisOffset,(float)pidAxisSaturated(a)};
  for(int k=0;k<11;k++) output[5+a*11+k]=v[k];
 }
 for(int a=0;a<8;a++) {output[38+a]=mixerGetServoOutput(a);output[64+a]=executeServo?getServoOutput(a):0;}
 float g[13]={gov.P,gov.I,gov.D,gov.F,gov.pidSum,gov.targetHeadSpeed,gov.requestedHeadSpeed,gov.currentHeadSpeed,(float)gov.state,gov.ttaAdd,fw_getSpoolUpRatio(),(float)fw_isSpooledUp(),gov.throttleOutput};
 for(int a=0;a<13;a++)output[46+a]=g[a];
}

float *rf_servo_config(void) {return servoConfigValues;}
void rf_servo_reset(void) {
 servoCount=(uint8_t)servoConfigValues[64];executeServo=servoCount>0;
 memset(servoInput,0,sizeof(servoInput));memset(servoOutput,0,sizeof(servoOutput));
 memset(servoChannel,0,sizeof(servoChannel));
 for(int a=0;a<MAX_SUPPORTED_SERVOS;a++) {
  float *v=&servoConfigValues[a*8];servoParam_t *s=&servoConfiguration[a];
  s->mid=v[0];s->min=v[1];s->max=v[2];s->rneg=v[3];s->rpos=v[4];s->rate=v[5];s->speed=v[6];s->flags=v[7];
  servoOutput[a]=s->mid;servoOverride[a]=SERVO_OVERRIDE_OFF;
 }
}
void rf_map_mixer(void) {
 for(int a=0;a<5;a++)mixer.input[1+a]=input[15+a];
 mixerUpdateSwash();mixerUpdateRules();if(executeServo)servoUpdate();
 for(int a=0;a<8;a++){output[38+a]=mixerGetServoOutput(a);output[64+a]=executeServo?getServoOutput(a):0;}
}
