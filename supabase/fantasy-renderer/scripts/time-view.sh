#!/usr/bin/env bash
# Moves the emulator to a place and screenshots the app every ~0.6 s, printing the painted
# share of each frame against the time since the move. For first-view and pan timings.
#   time-view.sh <adb-serial> <lng> <lat> <seconds> <out-dir>
set -euo pipefail
serial=$1 lng=$2 lat=$3 secs=$4 out=$5
here=$(dirname "$0")
adb=(~/Android/Sdk/platform-tools/adb -s "$serial")
mkdir -p "$out"
t0=$(date +%s%3N)
"${adb[@]}" emu geo fix "$lng" "$lat" >/dev/null
while :; do
  t=$(( $(date +%s%3N) - t0 ))
  [ "$t" -gt $(( secs * 1000 )) ] && break
  "${adb[@]}" exec-out screencap -p > "$out/f-$(printf %06d "$t").png"
done
for f in "$out"/f-*.png; do
  ms=$(basename "$f" .png); ms=$((10#${ms#f-}))
  printf '%6d ms  %s\n' "$ms" "$(python3 "$here/painted-share.py" "$f" | cut -f2)"
done
