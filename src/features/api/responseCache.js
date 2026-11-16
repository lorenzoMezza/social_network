// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The last answer to the lists the app asks for again and again (the chats, the
// connections, the events around…): asked with If-None-Match, and an unchanged list
// costs a 304 with no body and no work for the phone (docs/API.md, Caching). Only in
// memory and only for the signed-in user: signing out empties it (accountStorage.js).
const MAX_ENTRIES = 40;

export function createResponseCache(maxEntries = MAX_ENTRIES) {
  const entries = new Map();
  return {
    get: (path) => entries.get(path) ?? null,
    set(path, etag, body) {
      if (!etag) {
        entries.delete(path);
        return;
      }
      // Most recent last: the oldest goes first
      entries.delete(path);
      entries.set(path, { etag, body });
      if (entries.size > maxEntries) entries.delete(entries.keys().next().value);
    },
    clear: () => entries.clear(),
    get size() {
      return entries.size;
    },
  };
}

export const responseCache = createResponseCache();
