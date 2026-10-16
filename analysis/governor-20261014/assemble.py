# Runs every section and writes log_evidence.json (OE fits, closed-loop check and gains come from their own json files)
from common import *
import s1_states, s2_tracking, s3_sat, s4_power, s5_plant, s5b_spool, s6_spool, s8_extra
out = {'sources': {
    'fireball': {'dump': 'RTFL_BLACKBOX_LOG_SAB_Fireball_20261005_204823.BBL', 'logs_zero_based': [5, 6, 8, 9, 10, 11, 13, 14, 15], 'missing': {7: 'Log truncated, no data', 12: 'Log truncated, no data'},
                 'cli': 'RTFL_cli_SAB_Fireball_20261013_184504.txt', 'app_log_number': 'zero-based index + 1'},
    'gaui': {'dump': 'RTFL_BLACKBOX_LOG_20261004_233406.BBL', 'logs_zero_based': [38, 39, 40, 41, 43, 45, 46, 47, 48, 49], 'cli': None}},
    'units': 'motor[0], govP/I/D/F/Sum in 0.1 % of full throttle; headspeed, govTarget, govRequest in rpm; Vbat 0.01 V; Ibat 0.01 A; mixer[] x1000 deflection; times s from log start (index time)'}
for craft in ['fireball', 'gaui']:
    R = {}
    R['states'] = s1_states.run(craft)
    R['tracking'] = s2_tracking.run(craft)
    R['saturation'] = s3_sat.run(craft)
    R['power'] = s4_power.run(craft)
    R['plantEquationError'] = s5_plant.run(craft)
    up, down = s5b_spool.run(craft, 0.06); R['spoolIdentification'] = dict(spoolup=up, spooldown=down, tau=0.06)
    R['events'] = s6_spool.run(craft)
    R['extra'] = s8_extra.run(craft)
    out[craft] = R
    print('done', craft)
out['plantOutputError'] = json.load(open('oe_fit.json')); out['plantOutputErrorEsc'] = json.load(open('oe_esc_fit.json'))
out['closedLoopCheck'] = json.load(open('closed_check.json')); out['gains'] = json.load(open('gains.json'))
def clean(o):
    if isinstance(o, dict): return {str(k): clean(v) for k, v in o.items()}
    if isinstance(o, (list, tuple)): return [clean(v) for v in o]
    if isinstance(o, np.ndarray): return clean(o.tolist())
    if isinstance(o, (np.bool_,)): return bool(o)
    return o
json.dump(clean(rnd(out, 5)), open('log_evidence.json', 'w'), indent=1)
print('written')
