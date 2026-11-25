#!/usr/bin/env bash
# Like time-view.sh, from a screen recording: starts recording, moves the emulator after 1 s,
# and prints the painted share at 10 frames a second against the time since the move.
#   time-view-video.sh <adb-serial> <lng> <lat> <seconds> <out-dir>
set -euo pipefail
serial=$1 lng=$2 lat=$3 secs=$4 out=$5
here=$(dirname "$0")
adb=(~/Android/Sdk/platform-tools/adb -s "$serial")
mkdir -p "$out"; rm -f "$out"/*.png
"${adb[@]}" shell rm -f /sdcard/tv.mp4
"${adb[@]}" shell screenrecord --time-limit $((secs + 1)) --size 540x1200 /sdcard/tv.mp4 &
rec=$!
sleep 1
"${adb[@]}" emu geo fix "$lng" "$lat" >/dev/null
wait $rec || true
"${adb[@]}" pull -q /sdcard/tv.mp4 "$out/tv.mp4"
ffmpeg -loglevel error -i "$out/tv.mp4" -vf fps=10 "$out/v-%04d.png"
i=0
for f in "$out"/v-*.png; do
  ms=$(( i * 100 - 1000 ))
  [ "$ms" -ge -200 ] && printf '%6d ms  %s\n' "$ms" "$(python3 "$here/painted-share.py" "$f" | cut -f2)"
  i=$((i + 1))
done
