#!/bin/bash
# from-scratch identification on Fireball then Gaui, with closed-loop checks
export PATH="$HOME/.nvm/versions/node/v22.17.0/bin:$PATH"; unset -f node npm npx nvm 2>/dev/null
cd "$(dirname "$0")"
CLI=$(ls ~/My\ Drive*/RC/SAB/Fireball*/RTFL_cli_SAB_Fireball_20261013_184504.txt)
node --max-old-space-size=8000 dev.cjs data/fireball out/prod3_fireball --fit stages_prod.json > out/prod3_fireball.log 2>&1
node closed.cjs data/fireball out/prod3_fireball/model.json "$CLI" out/prod3_fireball/closed.json 10 > out/prod3_fireball_closed.log 2>&1
AUTOTUNE_FLIGHT_RPM=2000 node --max-old-space-size=8000 dev.cjs data/gaui out/prod3_gaui --fit stages_prod.json --craft 'GAUI X4 II' > out/prod3_gaui.log 2>&1
echo finished
