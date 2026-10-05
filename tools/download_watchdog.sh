#!/bin/sh
# Watch a flash download made with the Rotorflight Configurator on macOS. When the partial file stops growing,
# take a process sample of the Configurator's main process, which is what made a stalled download resume on
# 2026-09-26 (analysis/download-stall/README.md), and log whether the download moves again.
#
#   tools/download_watchdog.sh "<folder the Configurator saves into>" [seconds without growth, default 20]
#
# If the download stays stuck, close the Configurator and continue the same file with
#   cp "<file>.crswap" partial.bbl && python3 tools/flash_read.py /dev/cu.usbmodemXXXX --out partial.bbl --resume
dir=${1:?usage: download_watchdog.sh <folder> [stall seconds]}
stall=${2:-20}
last=-1; still=0; seen=
while :; do
    f=$(ls -t "$dir"/*.crswap 2>/dev/null | head -1)
    if [ -z "$f" ]; then
        [ -n "$seen" ] && { echo "$(date +%T) partial file is gone: download finished or was cancelled"; exit 0; }
        sleep 5; continue
    fi
    seen=1
    size=$(stat -f%z "$f" 2>/dev/null) || continue
    if [ "$size" = "$last" ]; then still=$((still + 5)); else still=0; fi
    last=$size
    if [ "$still" -ge "$stall" ]; then
        pid=$(pgrep -f "Rotorflight Configurator.app/Contents/MacOS/nwjs" | head -1)
        if [ -z "$pid" ]; then echo "$(date +%T) stalled at $size bytes and the Configurator is not running"; exit 1; fi
        echo "$(date +%T) stalled at $size bytes for ${still} s; sampling Configurator main process $pid"
        sample "$pid" 1 -file /dev/null >/dev/null 2>&1
        sleep 10
        now=$(stat -f%z "$f" 2>/dev/null || echo gone)
        if [ "$now" = "$size" ]; then echo "$(date +%T) still stalled at $size bytes"; else echo "$(date +%T) moving again: $now"; fi
        still=0
    else
        echo "$(date +%T) $size bytes"
    fi
    sleep 5
done
