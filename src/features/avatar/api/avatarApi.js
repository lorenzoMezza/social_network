// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { timeoutSignal } from '../../../lib/timeoutSignal';
import { AVATAR_SERVER_URL } from './avatarServer';

// The avatar assets: the catalog, the presets and the item files are static (a CDN in
// production, avatar-server/ in development). The avatars people save are the API's
// (docs/API.md: GET /users/{id}/avatar, PUT /me/avatar), loaded with useApi.

const TIMEOUT_MS = 15000;

async function request(path, options = {}) {
  if (!AVATAR_SERVER_URL) {
    throw Object.assign(new Error('No avatar server: start it with `make dev` (or set EXPO_PUBLIC_AVATAR_URL)'), { code: 'no-server' });
  }
  const timeout = timeoutSignal(TIMEOUT_MS, options.signal);
  let response;
  let body;
  try {
    response = await fetch(`${AVATAR_SERVER_URL}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...options.headers },
      signal: timeout.signal,
    });
    body = await response.json().catch(() => null);
  } finally {
    timeout.clear();
  }
  if (!response.ok) {
    throw Object.assign(new Error(body?.error ?? `Avatar server error ${response.status}`), { status: response.status, details: body?.details });
  }
  return body;
}

// The catalog, unless it is still the one with ETag `etag`: { catalog, etag } or
// { notModified: true }. RN's fetch decompresses the gzip answer by itself.
export async function getCatalog(etag) {
  if (!AVATAR_SERVER_URL) throw Object.assign(new Error('No avatar server'), { code: 'no-server' });
  const timeout = timeoutSignal(TIMEOUT_MS);
  try {
    const response = await fetch(`${AVATAR_SERVER_URL}/v1/catalog`, {
      headers: etag ? { 'If-None-Match': etag } : {},
      signal: timeout.signal,
    });
    if (response.status === 304) return { notModified: true };
    if (!response.ok) throw Object.assign(new Error(`Avatar server error ${response.status}`), { status: response.status });
    return { catalog: await response.json(), etag: response.headers.get('etag') };
  } finally {
    timeout.clear();
  }
}

export const getPresets = () => request('/v1/presets').then((body) => body.presets);

// { body: { userId, source: 'saved' | 'preset', avatar, avatarVersion, mapAvatar }, etag,
// notModified } — `request`: useApi(); `etag`: the one of the copy kept (null: none)
export const getAvatar = (request, userId, etag = null) => request(`/users/${encodeURIComponent(userId)}/avatar`, { etag });

// The files of a map avatar (docs/API.md Avatars): the key is 32 hex characters,
// anything else is refused rather than put in a URL
const MAP_KEY = /^[0-9a-f]{32}$/;
export function mapAvatarFiles(key) {
  if (!AVATAR_SERVER_URL || typeof key !== 'string' || !MAP_KEY.test(key)) return null;
  const base = `${AVATAR_SERVER_URL}/v1/map-avatars/${key}`;
  return { model: `${base}.glb`, astc: `${base}.ktx2`, png: `${base}.png` };
}

// The map avatar people wear until theirs has arrived: its files, or null
export const getStandIn = () => request('/v1/map-avatars/stand-in').then((body) => mapAvatarFiles(body?.key));

export const saveAvatar = (request, avatar) => request('/me/avatar', { method: 'PUT', body: JSON.stringify(avatar) });
