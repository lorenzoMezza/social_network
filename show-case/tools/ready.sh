#!/usr/bin/env bash
# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

# The app fresh on the map, visible, with the staging helpers loaded (then show-case/tools/record.sh)
set -euo pipefail
cd "$(dirname "$0")/../.."
UDID="${UDID:-E4783D1F-2709-4801-A85B-EB0498480EC7}"
IDB="${IDB:-$HOME/.local/bin/idb}"
DEV_SERVER="${DEV_SERVER:-http://$(ipconfig getifaddr en0 || ipconfig getifaddr en1):8081}"
xcrun simctl terminate "$UDID" com.mezzakiller.projectExpoFrontend 2>/dev/null || true
xcrun simctl location "$UDID" set "${CENTER:-41.8953,12.4918}"
xcrun simctl status_bar "$UDID" override --time "9:41" --batteryState charged --batteryLevel 100 --cellularMode active --cellularBars 4 --wifiBars 3 --operatorName ""
xcrun simctl openurl "$UDID" "projectexpofrontend://expo-development-client/?url=$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1], safe=''))" "$DEV_SERVER")"
sleep 40
# Invisible → Visible (the map always opens invisible)
"$IDB" ui tap --udid "$UDID" 201 88; sleep 1.5
"$IDB" ui tap --udid "$UDID" 117 146; sleep 4
node show-case/tools/director.mjs file show-case/tools/stage.js >/dev/null
sleep 2
echo ready
