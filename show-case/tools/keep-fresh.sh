#!/usr/bin/env bash
# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

# A still simulator sends no new GPS fixes, and after a few minutes the player's position
# is too old for the server to show anyone around: nudge it by ~10 cm every 20 s.
UDID="${UDID:-E4783D1F-2709-4801-A85B-EB0498480EC7}"
while true; do
  xcrun simctl location "$UDID" set 41.8953,12.4918; sleep 20
  xcrun simctl location "$UDID" set 41.895301,12.4918; sleep 20
done
