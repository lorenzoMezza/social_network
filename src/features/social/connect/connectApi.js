// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Connecting in person on the backend: the operations of CONNECT-PROTOCOL.md (docs/API.md).
// Each request carries the phone's position when it has one (or null), for the
// distance check the server makes.

import { CONNECT_ERRORS, connectError } from './protocol';

const json = (body) => JSON.stringify(body);
const path = (id) => encodeURIComponent(id);

// HTTP errors → the protocol's codes, so the screens explain them the same way
const KNOWN = new Set(Object.values(CONNECT_ERRORS));
function toConnectError(error) {
  if (error?.code && KNOWN.has(error.code)) return error;
  const code = error?.body?.code;
  const as = (known) => Object.assign(connectError(known, error.message), { cause: error });
  if (code && KNOWN.has(code)) return as(code);
  if (error?.status === 0) return as(CONNECT_ERRORS.offline);
  if (error?.status === 410 || error?.status === 404) return as(CONNECT_ERRORS.expired);
  if (error?.status === 409) return as(CONNECT_ERRORS.already);
  if (error?.status === 429) return as(CONNECT_ERRORS.rateLimited);
  return error;
}
const call = async (run) => {
  try {
    return await run();
  } catch (error) {
    if (error?.name === 'AbortError') throw error;
    throw toConnectError(error);
  }
};

/**
 * @param {object} deps
 * @param {(path: string, options?: RequestInit) => Promise<any>} deps.request - useApi()
 */
export function createConnectApi({ request }) {
  return {

    // --- The phone showing its code (host) ---

    // POST /connections/sessions { location } → { sessionId, token, expiresAt }
    startSession: (location) => call(() => request('/connections/sessions', {
      method: 'POST',
      body: json({ location }),
    })),

    // POST /connections/sessions/{id}/token { location } → { token, expiresAt }: a new
    // token every few seconds
    rotateToken: (sessionId, location) => call(() => request(`/connections/sessions/${path(sessionId)}/token`, {
      method: 'POST',
      body: json({ location }),
    })),

    // GET /connections/sessions/{id} → { status: 'waiting' | 'connected' | 'closed', user? }
    // (`user`: who scanned the code, once connected)
    getSession: (sessionId, { signal } = {}) => call(() => request(`/connections/sessions/${path(sessionId)}`, { signal })),

    // DELETE /connections/sessions/{id}: the screen closed, its codes stop working
    closeSession: (sessionId) => call(() => request(`/connections/sessions/${path(sessionId)}`, { method: 'DELETE' })),

    // --- The phone reading the code (guest) ---

    // POST /connections/claims { token, location }
    //   → { status: 'connected', user } (`user`: whose code it was)
    claim: (token, location) => call(() => request('/connections/claims', {
      method: 'POST',
      body: json({ token, location }),
    })),
  };
}
