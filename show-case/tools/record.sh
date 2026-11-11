#!/usr/bin/env bash
# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

# One take of the simulator's screen (show-case/tools/ready.sh):
#   show-case/tools/record.sh <name> <tail seconds> ["WAIT:js" | "WAIT:@tap X Y" | "WAIT:@hold X Y" | "WAIT:@swipe|@drag|@fling X1 Y1 X2 Y2" | "WAIT:@type words" | "WAIT:@scan guest"]...
# Starts recording, then for each step waits WAIT seconds and sends the script to the map
# (director) or taps/swipes the screen (points), then records <tail seconds> more.
# Writes show-case/raw/<name>.mov (the screen at full resolution, h264).
set -euo pipefail
cd "$(dirname "$0")/../.."
UDID="${UDID:-E4783D1F-2709-4801-A85B-EB0498480EC7}"
IDB="${IDB:-$HOME/.local/bin/idb}"
name="$1"; tail="$2"; shift 2
mkdir -p show-case/raw
xcrun simctl io "$UDID" recordVideo --codec=h264 --force "show-case/raw/$name.mov" >/dev/null 2>&1 &
recorder=$!
sleep 2
for step in "$@"; do
  sleep "${step%%:*}"
  action="${step#*:}"
  case "$action" in
    @tap\ *) "$IDB" ui tap --udid "$UDID" ${action#@tap } ;;
    @swipe\ *) "$IDB" ui swipe --udid "$UDID" ${action#@swipe } --duration 0.5 ;;
    # A slow drag (no momentum: a sheet goes to its next height, nothing scrolls on), and a
    # fling (scrolls to the end, where it always stops at the same place)
    @drag\ *) "$IDB" ui swipe --udid "$UDID" ${action#@drag } --duration 2.0 ;;
    @fling\ *) "$IDB" ui swipe --udid "$UDID" ${action#@fling } --duration 0.25 ;;
    @scan\ *) node show-case/tools/scan.mjs ${action#@scan } >/dev/null ;;
    # Typing into the focused field, a word at a time (idb drops words sent all at once)
    @type\ *)
      first=1
      for word in ${action#@type }; do
        [ "$first" = 1 ] || "$IDB" ui key --udid "$UDID" 44
        first=0
        "$IDB" ui text --udid "$UDID" "$word"; sleep 0.35
      done ;;
    @hold\ *) "$IDB" ui tap --udid "$UDID" --duration 1.1 ${action#@hold } ;;
    *) node show-case/tools/director.mjs run "$action" >/dev/null ;;
  esac
done
sleep "$tail"
kill -INT "$recorder"
wait "$recorder" 2>/dev/null || true
echo "show-case/raw/$name.mov"
