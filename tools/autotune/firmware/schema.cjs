'use strict';
// CLI field -> C member. Defaults describe the pinned release, not a flight.
const fields = [], add = (name, member, value, max=255, min=0) => fields.push({name, member, default:value, min, max});
add('pid_looptime', 'gyro.targetLooptime', 1000, 32000, 125);
add('pid_mode', 'profile.pid_mode', 3, 4);
const gains=[[50,100,0,100,0,50],[50,100,40,100,0,50],[80,120,10,0,0,0]];
for(let a=0;a<3;a++) for(let t=0;t<6;t++) add(['roll','pitch','yaw'][a]+'_'+['p','i','d','f','b','o'][t]+'_gain', `profile.pid[${a}].${['P','I','D','F','B','O'][t]}`, gains[a][t],1000);
for(const [name,value] of Object.entries({error_decay_time_ground:25,error_decay_time_cyclic:250,error_decay_time_yaw:0,error_decay_limit_cyclic:12,error_decay_limit_yaw:0,offset_flood_relax_level:40,offset_flood_relax_cutoff:3,iterm_relax_type:2,yaw_cw_stop_gain:120,yaw_ccw_stop_gain:80,yaw_precomp_cutoff:5,yaw_cyclic_ff_gain:10,yaw_collective_ff_gain:60,yaw_inertia_precomp_gain:0,yaw_inertia_precomp_cutoff:25,pitch_collective_ff_gain:0,cyclic_cross_coupling_gain:50,cyclic_cross_coupling_ratio:0,cyclic_cross_coupling_cutoff:25})) add(name,'profile.'+name,value);
for(const [name,values] of Object.entries({error_limit:[45,45,60],offset_limit:[90,90],iterm_relax_level:[40,40,40],iterm_relax_cutoff:[10,10,10]})) values.forEach((value,a)=>add(name+'['+a+']',`profile.${name}[${a}]`,value));
for(let a=0;a<3;a++) for(const [name,member,values] of [['gyro_cutoff','gyro_cutoff',[50,50,100]],['d_cutoff','dterm_cutoff',[15,15,20]],['b_cutoff','bterm_cutoff',[15,15,20]]]) add(['roll','pitch','yaw'][a]+'_'+name,`profile.${member}[${a}]`,values[a]);
for(const [name,value,max,min] of [['main_rotor_dir',0,1,0],['tail_rotor_mode',0,2,0],['tail_motor_idle',0,250,0],['tail_center_trim',0,2500,-2500],['swash_type',2,6,0],['swash_ring',100,100,0],['swash_phase',0,1800,-1800],['swash_pitch_limit',0,2500,0],['swash_tta_precomp',0,250,0],['swash_geo_correction',0,100,-100],['collective_tilt_correction_pos',0,100,-100],['collective_tilt_correction_neg',10,100,-100]]) add(name,'mixerConfiguration.'+name,value,max,min);
for(let a=0;a<3;a++) add('swash_trim['+a+']',`mixerConfiguration.swash_trim[${a}]`,0,2500,-2500);
for(let a=0;a<5;a++) for(const [name,value] of [['rate',a===4?1000:250],['min',a===4?0:-1250],['max',a===4?1000:1250]]) add('mixer_'+['sr','sp','sy','sc','st'][a]+'_'+name,`mixerInputConfiguration[${a+1}].${name}`,value,name==='rate'?10000:2500,name==='rate'?-10000:-2500);
const governorStart=fields.length;
for(const [name,value] of Object.entries({gov_mode:0,gov_throttle_type:0,gov_startup_time:200,gov_spoolup_time:100,gov_tracking_time:50,gov_recovery_time:30,gov_spooldown_time:30,gov_throttle_hold_timeout:50,gov_autorotation_timeout:15,gov_idle_throttle:0,gov_auto_throttle:0,gov_handover_throttle:25,gov_pwr_filter:5,gov_rpm_filter:10,gov_tta_filter:0,gov_ff_filter:5,gov_d_filter:50})) add(name,'governorConfiguration.'+name,value,/time$/.test(name)?600:255);
for(let i=0;i<9;i++)add('gov_bypass_throttle['+i+']',`governorConfiguration.gov_bypass_throttle[${i}]`,0,200);
for(const [name,value] of Object.entries({flags:0,headspeed:1000,min_throttle:10,max_throttle:100,gain:40,p_gain:40,i_gain:50,d_gain:0,f_gain:10,p_limit:20,i_limit:95,d_limit:20,f_limit:100,tta_gain:0,tta_limit:20,yaw_weight:10,cyclic_weight:10,collective_weight:50,collective_curve:20,fallback_drop:10,dyn_min_throttle:80})) add('gov_'+name,'profile.governor.'+name,value,name==='headspeed'?50000:name==='flags'?4294967295:255);
add('main_rotor_gear_ratio[0]','hostGearNumerator',1,65535,1);
add('main_rotor_gear_ratio[1]','hostGearDenominator',1,65535,1);
add('battery_cell_count','hostBatteryCells',6,24,1);
add('voltage_meter','hostVoltageSource',1,2,0);
// Scalar bounds from release/4.6.0 cli/settings.c. Array members retain their
// storage-type bounds because firmware MODE_ARRAY has no per-element range.
const ranges={pid_mode:[0,9],iterm_relax_type:[0,2],yaw_cw_stop_gain:[25,250],yaw_ccw_stop_gain:[25,250],cyclic_cross_coupling_ratio:[0,200],cyclic_cross_coupling_cutoff:[1,250],offset_flood_relax_level:[10,250],offset_flood_relax_cutoff:[1,100],tail_center_trim:[-1000,1000],swash_pitch_limit:[0,3000],swash_geo_correction:[-125,125],gov_mode:[0,4],gov_throttle_type:[0,2],gov_handover_throttle:[10,100],gov_max_throttle:[10,100],gov_min_throttle:[10,100],gov_fallback_drop:[0,50],gov_collective_curve:[5,40],gov_dyn_min_throttle:[0,100]};
for(const field of fields) {
    if(field.max===255&&!field.name.includes('[')&&!['iterm_relax_type','gov_mode','gov_throttle_type'].includes(field.name))field.max=250;
    if(/^gov_[pidf]_limit$/.test(field.name))field.max=100;
    if(ranges[field.name]) [field.min,field.max]=ranges[field.name];
}
module.exports={fields,governorStart};
