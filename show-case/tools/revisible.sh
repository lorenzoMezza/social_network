#!/usr/bin/env bash
# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

# Invisible, then Visible again: the development backend puts the demo people back around
# the player (they drift away after a few minutes). Run before a take on the map.
UDID="${UDID:-E4783D1F-2709-4801-A85B-EB0498480EC7}"; IDB="${IDB:-$HOME/.local/bin/idb}"
"$IDB" ui tap --udid "$UDID" 201 88; sleep 1.2; "$IDB" ui tap --udid "$UDID" 117 306; sleep 1.5
"$IDB" ui tap --udid "$UDID" 201 88; sleep 1.2; "$IDB" ui tap --udid "$UDID" 117 146; sleep 4
