// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { devHost } from '../../lib/devHost';

// Where the backend is (docs/API.md): EXPO_PUBLIC_API_URL (with its /v1), else in
// development the development server (`make dev` runs it, backend/) on the computer
// running Expo, like the map's tiles and the avatar assets.
const LOCAL_PORT = 7777;

export const API_URL = (process.env.EXPO_PUBLIC_API_URL || (devHost ? `http://${devHost}:${LOCAL_PORT}/v1` : '')).replace(/\/$/, '') || null;

// The one WebSocket of the app (wss:// next to an https:// API)
export const SOCKET_URL = API_URL ? `${API_URL.replace(/^http/, 'ws')}/ws` : null;

// An address the server answered (upload, data export): HTTPS, or the development
// server's own HTTP origin; never credentials in it. The URL, or null.
export function safeServiceUrl(value) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (url.protocol === 'https:') return url.href;
    const api = API_URL ? new URL(API_URL) : null;
    return url.protocol === 'http:' && api?.protocol === 'http:' && url.origin === api.origin ? url.href : null;
  } catch {
    return null;
  }
}
