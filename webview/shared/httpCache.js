// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Persistent cache of downloads for a WebView page, in IndexedDB: what was downloaded
// once is served from the device, so it shows without waiting for the network (also
// offline) and the server is asked far less. Its `fetch` replaces the page's own for
// the files it should keep: map tiles (map/createMap.js), avatar files
// (avatar/src/fileCache.js).
//
// Rules, as in an HTTP cache (RFC 9111) for a single user:
//  - Fresh entries (Cache-Control max-age / Expires, or 10% of the age of
//    Last-Modified) are served without any request.
//  - Stale entries are served at once and checked in the background
//    (stale-while-revalidate): with the ETag / Last-Modified the server gave, so an
//    unchanged file costs a 304 and no download; offline the stored copy keeps working.
//  - `no-store` is never stored, `no-cache` is always checked; only complete answers
//    (200 with data, 204 empty) are stored, never errors.
//  - Nothing downloaded more than maxAgeDays ago is ever served, and a cleanup deletes
//    it; above maxBytes the least recently used entries go, down to LOW_WATER of the
//    limit so the cleanup does not run again after every file. Entries kept by an
//    owner (pin()) go only after all the others: by their rank, the highest first
//    (a friend's avatar before nobody's), and those of rank 0 (the user's own) never.
//  - The bytes stored are counted in the database itself, inside the transaction of
//    each write: several pages (the map and the profiles' viewers) can share one cache
//    and its limit holds for all of them together.
//  - Keys leave out API keys / access tokens (a new key does not empty the cache, and
//    no secret is stored).
//  - Compressible bodies are stored gzip-compressed (CompressionStream); images and
//    other already compressed files as they are.
// Where IndexedDB is not available, every request goes to the network as before.

const DB_VERSION = 2;
// metadata (small, read whole by the cleanup), bodies, and the cache's own records
// (TOTAL: bytes stored; PIN_PREFIX + owner: { rank, keys } that owner keeps, or the
// keys alone, rank 0, as earlier versions wrote them)
const META = 'meta';
const BODY = 'body';
const STATE = 'state';
const TOTAL = 'total';
const PIN_PREFIX = 'pins:';
// Without any freshness information from the server
const DEFAULT_FRESHNESS_MS = 24 * 3600 * 1000;
// The cleanup brings the cache down to this share of its limit
const LOW_WATER = 0.9;
// The last use of an entry is written at most this often (fewer writes while browsing)
const LAST_USED_GRANULARITY_MS = 3600 * 1000;
// Deleting what is too old waits until the page is up
const STARTUP_CLEANUP_DELAY_MS = 10000;
const REVALIDATE_TIMEOUT_MS = 20000;
// Query parameters that carry credentials: left out of the keys
const CREDENTIAL_PARAMS = ['key', 'api_key', 'apikey', 'access_token', 'token'];
// Already compressed: gzip would only cost time
const INCOMPRESSIBLE = /^(image|video|audio)\/|zip|zstd/i;

const request = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
const completion = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = tx.onabort = () => reject(tx.error ?? new DOMException('Transaction aborted', 'AbortError'));
});

const abortError = () => new DOMException('Aborted', 'AbortError');

function cacheKey(url) {
  try {
    const parsed = new URL(url, location.href);
    for (const name of CREDENTIAL_PARAMS) parsed.searchParams.delete(name);
    return parsed.href;
  } catch {
    return String(url);
  }
}

function parseCacheControl(header) {
  const directives = new Map();
  for (const part of (header ?? '').split(',')) {
    const [name, value] = part.trim().toLowerCase().split('=');
    if (name) directives.set(name, value?.replace(/"/g, ''));
  }
  return directives;
}

// Until when (ms since 1970) a response just received stays fresh, or null when
// it must not be stored
function freshUntil(response, now) {
  const cacheControl = parseCacheControl(response.headers.get('cache-control'));
  if (cacheControl.has('no-store')) return null;
  if (cacheControl.has('no-cache')) return now;
  const age = (Number(response.headers.get('age')) || 0) * 1000;
  const maxAge = Number(cacheControl.get('max-age'));
  if (Number.isFinite(maxAge)) return now + maxAge * 1000 - age;
  const date = Date.parse(response.headers.get('date')) || now;
  const expires = Date.parse(response.headers.get('expires'));
  if (Number.isFinite(expires)) return now + (expires - date) - age;
  const lastModified = Date.parse(response.headers.get('last-modified'));
  if (Number.isFinite(lastModified)) return now + Math.max(0, date - lastModified) * 0.1 - age;
  return now + DEFAULT_FRESHNESS_MS - age;
}

// Complete answers only: a file (200) or an empty one (204), never an error or a part
const storable = (response) => response.status === 200 || response.status === 204;

const canCompress = typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
const isGzip = (bytes) => bytes[0] === 0x1f && bytes[1] === 0x8b;
const pipeBytes = (buffer, transform) => new Response(new Blob([buffer]).stream().pipeThrough(transform)).arrayBuffer();

/**
 * @param {{ name: string, maxBytes: number, maxAgeDays?: number, label?: string }} options
 *   name: the IndexedDB database; label: how warnings name it
 * @returns {{
 *   fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<Response>,
 *   pin: (owner: string, urls: string[], options?: { rank?: number }) => Promise<void>,
 * }}
 */
export function createHttpCache({ name, maxBytes, maxAgeDays = Infinity, label = name }) {
  const maxAgeMs = maxAgeDays * 24 * 3600 * 1000;
  // The page's own fetch, whatever replaces it later
  const network = globalThis.fetch.bind(globalThis);
  let database = null;
  const revalidating = new Map();
  // Servers that refused a conditional request (CORS without If-None-Match): checked
  // with a plain download instead
  const plainOnly = new Set();

  const open = () => {
    database ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(name, DB_VERSION);
      req.onupgradeneeded = (event) => {
        const db = req.result;
        if (event.oldVersion < 1) {
          db.createObjectStore(META, { keyPath: 'key' });
          db.createObjectStore(BODY);
        }
        if (event.oldVersion < 2) db.createObjectStore(STATE);
      };
      req.onsuccess = () => {
        const db = req.result;
        // Another page upgrading the database: let it, open again next time
        db.onversionchange = () => {
          db.close();
          database = null;
        };
        resolve(db);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error(`${label} blocked by another page`));
    }).then((db) => {
      setTimeout(() => cleanup().catch(() => {}), STARTUP_CLEANUP_DELAY_MS);
      // Ask the system not to evict it under storage pressure (where supported)
      navigator.storage?.persist?.().catch(() => {});
      return db;
    }).catch((error) => {
      console.warn(`${label} unavailable, downloading every file:`, error?.message ?? error);
      return null;
    });
    return database;
  };

  const read = async (key) => {
    const db = await open();
    if (!db) return null;
    try {
      const tx = db.transaction([META, BODY], 'readonly');
      const [meta, body] = await Promise.all([
        request(tx.objectStore(META).get(key)),
        request(tx.objectStore(BODY).get(key)),
      ]);
      return meta && (body !== undefined || meta.status === 204) ? { meta, body } : null;
    } catch {
      return null;
    }
  };

  // Changes one entry's metadata (its last use, or its freshness after a 304)
  const amend = async (key, change) => {
    const db = await open();
    if (!db) return;
    try {
      const tx = db.transaction(META, 'readwrite');
      const meta = await request(tx.objectStore(META).get(key));
      if (meta) tx.objectStore(META).put({ ...meta, ...change });
      await completion(tx);
    } catch {
      // Only the eviction order or one more check is affected
    }
  };

  const touch = (key, lastUsed, now) => {
    if (now - lastUsed >= LAST_USED_GRANULARITY_MS) amend(key, { lastUsed: now });
  };

  const remove = (tx, key) => {
    tx.objectStore(META).delete(key);
    tx.objectStore(BODY).delete(key);
  };

  // Inside a write transaction: deletes what is too old, then the least recently used
  // (never a pinned one) until at most `target` bytes are left; returns the bytes left
  const evict = async (tx, target) => {
    const [metas, state, stateKeys] = await Promise.all([
      request(tx.objectStore(META).getAll()),
      request(tx.objectStore(STATE).getAll()),
      request(tx.objectStore(STATE).getAllKeys()),
    ]);
    // key → the best (lowest) rank any owner keeps it with
    const ranks = new Map();
    stateKeys.forEach((stateKey, index) => {
      if (!String(stateKey).startsWith(PIN_PREFIX)) return;
      const kept = Array.isArray(state[index]) ? { rank: 0, keys: state[index] } : state[index];
      for (const key of kept.keys) ranks.set(key, Math.min(ranks.get(key) ?? Infinity, kept.rank));
    });
    const now = Date.now();
    let size = 0;
    const evictable = [];
    for (const meta of metas) {
      if (now - meta.storedAt > maxAgeMs) {
        remove(tx, meta.key);
        continue;
      }
      size += meta.size;
      const rank = ranks.get(meta.key) ?? Infinity;
      if (rank > 0) evictable.push({ meta, rank });
    }
    if (size > target) {
      // Nobody's first, then the highest rank; within each the least recently used
      evictable.sort((a, b) => (b.rank - a.rank) || (a.meta.lastUsed - b.meta.lastUsed));
      for (const { meta } of evictable) {
        if (size <= target) break;
        remove(tx, meta.key);
        size -= meta.size;
      }
    }
    tx.objectStore(STATE).put(size, TOTAL);
    return size;
  };

  // Deletes what is too old (and, when asked, makes room down to `target` bytes)
  const cleanup = async (target = Infinity) => {
    const db = await open();
    if (!db) return;
    try {
      const tx = db.transaction([META, BODY, STATE], 'readwrite');
      await evict(tx, target);
      await completion(tx);
    } catch (error) {
      console.warn(`${label} cleanup failed:`, error?.message ?? error);
    }
  };

  const write = async (db, meta, body) => {
    const tx = db.transaction([META, BODY, STATE], 'readwrite');
    const [previous, counted] = await Promise.all([
      request(tx.objectStore(META).get(meta.key)),
      request(tx.objectStore(STATE).get(TOTAL)),
    ]);
    let total = typeof counted === 'number' ? counted - (previous?.size ?? 0) : null;
    // Not counted yet (a new database, or one from before the count), or over the
    // limit: measured again and room made in this same transaction, without the old
    // copy of this entry
    if (total === null || total + meta.size > maxBytes) {
      if (previous) remove(tx, meta.key);
      if (total === null) total = await evict(tx, Infinity);
      if (total + meta.size > maxBytes) total = await evict(tx, maxBytes * LOW_WATER - meta.size);
    }
    tx.objectStore(META).put(meta);
    if (body) tx.objectStore(BODY).put(body, meta.key);
    else tx.objectStore(BODY).delete(meta.key);
    tx.objectStore(STATE).put(total + meta.size, TOTAL);
    await completion(tx);
  };

  const store = async (key, response, now) => {
    const until = freshUntil(response, now);
    if (until === null) return;
    const contentType = response.headers.get('content-type') ?? '';
    let body = null;
    let encoding = null;
    if (response.status === 200) {
      body = await response.arrayBuffer();
      if (body.byteLength === 0) return;
      if (canCompress && !INCOMPRESSIBLE.test(contentType) && !isGzip(new Uint8Array(body, 0, 2))) {
        const compressed = await pipeBytes(body, new CompressionStream('gzip'));
        if (compressed.byteLength < body.byteLength) {
          body = compressed;
          encoding = 'gzip';
        }
      }
    }
    const size = (body?.byteLength ?? 0) + key.length + contentType.length;
    if (size > maxBytes * (1 - LOW_WATER)) return;
    const meta = {
      key, size, encoding, contentType, status: response.status,
      etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified'),
      storedAt: now, lastUsed: now, freshUntil: Math.min(until, now + maxAgeMs),
    };
    const db = await open();
    if (!db) return;
    try {
      await write(db, meta, body);
    } catch (error) {
      if (error?.name !== 'QuotaExceededError') throw error;
      // The device is short of space: make room, at the expense of the oldest
      await cleanup(maxBytes / 2);
      await write(db, meta, body);
    }
  };

  const storeQuietly = (key, response, now) => store(key, response, now).catch((error) => {
    // A download cancelled by the page (no longer needed) is simply not stored
    if (error?.name !== 'AbortError') console.warn(`${label} write failed:`, error?.message ?? error);
  });

  const toResponse = async ({ meta, body }) => {
    if (meta.status === 204) return new Response(null, { status: 204 });
    const bytes = meta.encoding === 'gzip' ? await pipeBytes(body, new DecompressionStream('gzip')) : body;
    return new Response(bytes, { status: meta.status, headers: { 'content-type': meta.contentType } });
  };

  // Asks the server in the background whether the stored copy is still current
  const revalidate = (url, key, meta) => {
    if (revalidating.has(key)) return;
    const origin = new URL(url, location.href).origin;
    const validators = plainOnly.has(origin) ? {}
      : meta.etag ? { 'If-None-Match': meta.etag }
        : meta.lastModified ? { 'If-Modified-Since': meta.lastModified } : {};
    const conditional = Object.keys(validators).length > 0;
    const check = (headers) => network(url, { signal: AbortSignal.timeout?.(REVALIDATE_TIMEOUT_MS), cache: 'no-store', headers });
    const job = check(validators)
      .catch((error) => {
        if (!conditional || error?.name === 'TimeoutError' || error?.name === 'AbortError') throw error;
        // A request with validators failed where a plain one may not (CORS)
        plainOnly.add(origin);
        return check({});
      })
      .then((response) => {
        const now = Date.now();
        if (response.status === 304) {
          const until = freshUntil(response, now);
          return amend(key, { freshUntil: Math.min(until ?? now, meta.storedAt + maxAgeMs) });
        }
        return storable(response) ? storeQuietly(key, response, now) : undefined;
      })
      .catch(() => {})
      .finally(() => revalidating.delete(key));
    revalidating.set(key, job);
  };

  return {
    async fetch(url, { signal } = {}) {
      if (!/^https?:/i.test(new URL(url, location.href).protocol)) return network(url, { signal });
      const key = cacheKey(url);
      const now = Date.now();
      const cached = await read(key);
      if (signal?.aborted) throw abortError();
      const usable = cached && now - cached.meta.storedAt <= maxAgeMs;
      if (usable) {
        touch(key, cached.meta.lastUsed, now);
        if (now >= cached.meta.freshUntil) revalidate(url, key, cached.meta);
        try {
          return await toResponse(cached);
        } catch {
          // Unreadable entry: download it again below
        }
      }
      const response = await network(url, { signal });
      if (storable(response)) storeQuietly(key, response.clone(), now);
      return response;
    },

    // The entries `owner` keeps (they still go when too old): rank 0 whatever else is
    // downloaded, a higher rank only after everything not kept and every lower rank.
    // `urls` replaces what that owner kept before
    async pin(owner, urls, { rank = 0 } = {}) {
      const db = await open();
      if (!db) return;
      try {
        const tx = db.transaction(STATE, 'readwrite');
        tx.objectStore(STATE).put({ rank, keys: [...new Set(urls.map(cacheKey))] }, PIN_PREFIX + owner);
        await completion(tx);
      } catch {
        // Only the eviction order is affected
      }
    },
  };
}
