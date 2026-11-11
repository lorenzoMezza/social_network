// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The phone's last known position, to start drawing the map while the GPS looks for its first
// fix (it can take seconds). Only the map draws from it. It never reaches the server: whoever
// is matched with whom, and what is around, is decided on fresh GPS fixes only
// (usePlayerLocation's onPosition). Old or vague, it is not used at all: better an empty
// moment than the wrong neighbourhood.
export const PROVISIONAL_MAX_AGE_MS = 5 * 60 * 1000;
export const PROVISIONAL_MAX_ACCURACY_M = 150;

// { latitude, longitude } of a last known fix fit for that, or null. `allowMocked`: development,
// where an emulator's position counts as one
export function provisionalPosition(fix, now = Date.now(), { allowMocked = false } = {}) {
  const coords = fix?.coords;
  if (!coords || !Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) return null;
  if (Math.abs(coords.latitude) > 90 || Math.abs(coords.longitude) > 180) return null;
  if (fix.mocked && !allowMocked) return null;
  // A time in the future is a clock that cannot be trusted
  const age = now - fix.timestamp;
  if (!Number.isFinite(age) || age < -2000 || age > PROVISIONAL_MAX_AGE_MS) return null;
  if (!Number.isFinite(coords.accuracy) || coords.accuracy > PROVISIONAL_MAX_ACCURACY_M) return null;
  return { latitude: coords.latitude, longitude: coords.longitude };
}
