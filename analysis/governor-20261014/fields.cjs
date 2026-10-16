// Print main field names and governor-related header values of one log.
// node fields.cjs <bbl> <log index>
const L = require('../../tools/autotune/lib.cjs'), fs = require('fs'), vm = require('vm');
const [file, li] = process.argv.slice(2);
const app = L.loadApp();
app.__bytes = new Uint8Array(fs.readFileSync(file));
const log = vm.runInContext('new FlightLog(__bytes)', app);
console.log('logs', log.getLogCount());
log.openLog(+li);
const sc = log.getSysConfig();
console.log(JSON.stringify(log.getMainFieldNames()));
for (const k of Object.keys(sc)) if (/gov|bat|volt|curr|motor|rpm|gear|throttle|esc|pole|cell|Firmware|Craft|looptime|frameInterval|pid_process|Log start/i.test(k)) console.log(k, JSON.stringify(sc[k]));
