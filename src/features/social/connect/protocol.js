// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Rules of connecting in person, shared by the screens and (as a contract) the
// backend: see docs/CONNECT-PROTOCOL.md. The backend is the one that
// enforces them.
//
// In short: the phone showing its code (the host) holds a session on the server that
// hands out short-lived, single-use tokens, shown as a QR code that changes every few
// seconds. The code carries only the token: never a user ID or a username, so nobody
// can make a code for someone else. The phone reading it (the guest) sends the token
// to the server, and the two are connected.

const QR_PREFIX = 'masterkey://c/';

// The code on screen changes this often; each token stays valid a little longer, so a
// code read just before it changes still works. A photo of it is useless seconds later.
export const TOKEN_ROTATE_MS = 5 * 1000;
// How often the host's phone asks the server whether someone scanned its code while
// the socket is down (otherwise the scan arrives over it)
export const POLL_MS = 1500;

// The server checks the two phones' positions are within 100 m (when both are recent
// and real: CONNECT-PROTOCOL.md). The app sends its position with every request, when it has one.

// Why a connection did not happen; the server answers with the same codes (API.md)
export const CONNECT_ERRORS = {
  expired: 'expired', // the token is too old, already used, or the session closed
  self: 'self', // the user's own code
  blocked: 'blocked', // one of the two blocked the other
  already: 'already', // they are already connected
  tooFar: 'too_far', // the two phones are not together
  rateLimited: 'rate_limited',
  offline: 'offline',
  invalid: 'invalid', // not a code of the app
};

export function connectError(code, message) {
  return Object.assign(new Error(message ?? `Connect failed: ${code}`), { code });
}

// Opaque, URL-safe, at least 128 bits once the server makes them
const TOKEN = /^[A-Za-z0-9_-]{22,128}$/;

export const encodeQr = (token) => `${QR_PREFIX}${token}`;

// The token in a scanned code, or null when it is not one of ours
export function decodeQr(data) {
  if (typeof data !== 'string' || data.length > QR_PREFIX.length + 128) return null;
  if (!data.startsWith(QR_PREFIX)) return null;
  const token = data.slice(QR_PREFIX.length);
  return TOKEN.test(token) ? token : null;
}
