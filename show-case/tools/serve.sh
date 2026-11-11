#!/usr/bin/env bash
# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

# Every server of showcase mode, in the background (logs in .dev/logs/): the development
# backend with SHOWCASE=1, the director, tiles, avatars and Metro with the showcase app.
set -euo pipefail
cd "$(dirname "$0")/../.."
LAN="${LAN:-$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1)}"
mkdir -p .dev/logs
for port in 8081 7777 8092 8093 8095; do
  pids=$(lsof -ti tcp:$port -sTCP:LISTEN || true); [ -n "$pids" ] && kill $pids || true
done
sleep 1
(cd backend && DEV_TOOLS=1 TRUST_UNVERIFIED_TOKENS=1 SHOWCASE=1 nohup .venv/bin/python -m app.main > ../.dev/logs/backend.log 2>&1 &)
DIRECTOR_URL="http://$LAN:8095" nohup node show-case/tools/director.mjs > .dev/logs/director.log 2>&1 &
nohup node tile-provider/scripts/serve.mjs > .dev/logs/tiles.log 2>&1 &
nohup node avatar-server/server.mjs > .dev/logs/avatars.log 2>&1 &
EXPO_PUBLIC_SHOWCASE=1 EXPO_PUBLIC_API_URL="http://$LAN:7777/v1" EXPO_PUBLIC_AVATAR_URL="http://$LAN:8092" \
  EXPO_PUBLIC_TILE_URL="http://$LAN:8093/tiles.json" \
  nohup npx expo start --lan --dev-client --scheme projectexpofrontend --no-dev --minify --clear < /dev/null > .dev/logs/metro.log 2>&1 &
for i in $(seq 90); do curl -s -m 1 http://127.0.0.1:8081/status | grep -q running && break; sleep 1; done
echo "showcase servers up on $LAN"
