// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback } from 'react';
import { useLogto } from '@logto/rn';
import { API_RESOURCE } from '../auth/logtoConfig';
import { timeoutSignal } from '../../lib/timeoutSignal';
import { API_URL } from './apiConfig';
import { CLIENT, markUpdateRequired } from './appVersion';
import { responseCache } from './responseCache';

const TIMEOUT_MS = 15000;

// Calls the backend (docs/API.md) as the signed-in user. The SDK caches the access
// token and refreshes it with the refresh token when it expires, so it is asked for on
// every request. The address is apiConfig.js's. Usage:
//   const api = useApi();
//   const events = await api('/events');
//   await api('/events', { method: 'POST', body: JSON.stringify(event) });
// Errors carry `status` (HTTP status, 0 when the server could not be reached), `code`
// (the API's error code: username_taken, forbidden…) and `body`. Requests give up
// after 15 s.
// With `etag` (a string, or null when nothing is kept yet) a GET checks a copy the app
// already has (If-None-Match) and answers { body, etag, notModified }: `notModified`
// (304, no body) when that copy is still the current one. With `revalidate` (a list the
// app asks for often) the same is done for the caller: it just gets the answer, the one it
// had when nothing changed.
export function useApi() {
  const { getAccessToken } = useLogto();

  return useCallback(async (path, { etag, revalidate = false, ...options } = {}) => {
    if (!API_URL) throw Object.assign(new Error('No backend: set EXPO_PUBLIC_API_URL'), { status: 0 });
    const method = options.method ?? 'GET';
    const revalidating = etag !== undefined;
    let token;
    try {
      token = await getAccessToken(API_RESOURCE);
    } catch (error) {
      // No token: the session is over (401: useSessionExpiryCheck signs out), or there is
      // no network to refresh it (0, like a server that cannot be reached: the screens
      // say "offline" and the request is tried again when the network is back)
      const expired = ['oidc.invalid_grant', 'oidc.invalid_target', 'not_authenticated'].includes(error?.code);
      throw Object.assign(new Error(`API ${method} ${path}: no access token`), { status: expired ? 401 : 0, cause: error });
    }
    const kept = revalidate ? responseCache.get(path) : null;
    const timeout = timeoutSignal(TIMEOUT_MS, options.signal);
    let response;
    let text;
    try {
      response = await fetch(`${API_URL}${path}`, {
        ...options,
        signal: timeout.signal,
        headers: {
          Accept: 'application/json',
          ...(options.body != null ? { 'Content-Type': 'application/json' } : {}),
          ...(etag ? { 'If-None-Match': etag } : {}),
          ...(kept ? { 'If-None-Match': kept.etag } : {}),
          ...options.headers,
          'X-Client': CLIENT,
          Authorization: `Bearer ${token}`,
        },
      });
      text = await response.text();
    } catch (error) {
      // The caller gave up: let it see its own AbortError
      if (options.signal?.aborted) throw error;
      throw Object.assign(
        new Error(timeout.timedOut() ? `API ${method} ${path} timed out` : `API ${method} ${path} unreachable`),
        { status: 0, cause: error },
      );
    } finally {
      timeout.clear();
    }

    if (response.status === 426) markUpdateRequired();
    if (revalidating && response.status === 304) return { body: null, etag, notModified: true };
    if (kept && response.status === 304) return kept.body;
    // 201 and 204 may come without a body, and an error may come with plain text
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = text;
      }
    }
    if (!response.ok) {
      const detail = typeof body === 'string' ? body : body?.message ?? body?.error;
      throw Object.assign(new Error(`API ${method} ${path} failed: ${response.status}${detail ? ` ${detail}` : ''}`), {
        status: response.status,
        code: typeof body === 'object' ? body?.code ?? null : null,
        body,
      });
    }
    if (revalidate) responseCache.set(path, response.headers.get('etag'), body);
    return revalidating ? { body, etag: response.headers.get('etag'), notModified: false } : body;
  }, [getAccessToken]);
}
