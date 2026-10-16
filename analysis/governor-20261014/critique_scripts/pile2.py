import numpy as np
exec(open('check.py').read().split("what = sys.argv[1]")[0])
s = [x for x in load('gaui') if x['meta']['log'] == 49][0]
a = (s['st'] == 4) & (np.round(s['govRequest']/50)*50 == 2700) & (s['motor[0]'] == 904)
d = s['govSum'][a] - s['motor[0]'][a]
print('gaui log 49, 2700 rpm, frames at motor 904:', a.sum(), 'govSum - motor: max %.0f, p50 %.0f' % (d.max(), np.median(d)))
