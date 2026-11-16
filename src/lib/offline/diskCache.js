// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// A cache on the phone's storage with a size limit: JSON documents (a chat's
// messages, an event, a profile) and downloaded files (pictures), each with a
// priority. When it outgrows its limit what matters least goes first, down to
// LOW_WATER of the limit (so it does not clean up again after every write): the
// lowest priority first, within a priority what was used longest ago. Nothing is
// ever kept for good: even the user's own data goes last, not never, so the limit
// always holds.
//
// One folder per cache: one file per entry (named by a hash of its key, the key itself
// in the index) and `index.json` (key → file, size, priority, last use), written a
// moment after it changes. Files are written to a temporary name and then moved over
// the old one, so a write cut short (the app killed) leaves the previous copy, never
// half a file. An entry whose file went missing (the system cleared its caches) is
// simply a miss.
//
// `fs` is the storage (fileSystem.js on the phone, a map in memory in the tests):
//   readText(path) → string | null, writeText(path, text) (atomic), remove(path),
//   removeDir(path), download(url, path) → bytes, size(path) → bytes | null,
//   uri(path) → what an <Image> loads
// Paths are joined with '/'; the folder is created by the first write.

export const PRIORITY = {
  // The user's own: their profile, avatar, events, the inbox
  OWN: 0,
  // Close to them: connections, events they saved, chats they write in
  CLOSE: 1,
  // Seen recently
  RECENT: 2,
  // Everything else
  OTHER: 3,
};

const INDEX = 'index.json';
const LOW_WATER = 0.9;
// A JSON write waits this long for more changes to the same entry (a chat receiving
// a burst of messages is written once)
const WRITE_DELAY_MS = 400;
// The index (last uses) is written at most this often
const INDEX_DELAY_MS = 3000;
// Downloads at the same time, the rest wait their turn
const PARALLEL_DOWNLOADS = 4;

// A short, stable, file-safe name for any key: two 32-bit FNV-1a hashes with
// different seeds (64 bits: no two keys of a cache share a name in practice)
export function hashKey(key) {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < key.length; i++) {
    const code = key.charCodeAt(i);
    a = Math.imul(a ^ code, 0x01000193);
    b = Math.imul(b ^ code, 0x5bd1e995);
  }
  return (a >>> 0).toString(36).padStart(7, '0') + (b >>> 0).toString(36).padStart(7, '0');
}

const extensionOf = (url) => {
  const match = /\.([a-z0-9]{2,5})(?:[?#]|$)/i.exec(url);
  return match ? `.${match[1].toLowerCase()}` : '';
};

/**
 * @param {{ dir: string, maxBytes: number, fs: object, now?: () => number, label?: string }} options
 */
export function createDiskCache({ dir, maxBytes, fs, now = Date.now, label = dir }) {
  const path = (name) => `${dir}/${name}`;
  // key → { file, size, priority, used }
  let entries = new Map();
  let total = 0;
  // Writes and removals, one at a time, in order
  let queue = Promise.resolve();
  // key → value waiting for its delayed write
  const pending = new Map();
  let pendingTimer = null;
  // Who waits for the values waiting now to be on storage (writeJson's promises): told
  // by whatever writes them first, the timer or flush(), and by clear()
  let waiters = [];
  let indexTimer = null;
  let indexDirty = false;
  // url → its download in progress
  const downloads = new Map();
  const waiting = [];
  let downloading = 0;
  // Bumped by clear(): what was queued before it does nothing
  let generation = 0;

  const serial = (task) => {
    const run = queue.then(task, task);
    queue = run.catch(() => {});
    return run;
  };

  const ready = (async () => {
    try {
      const text = await fs.readText(path(INDEX));
      const saved = text ? JSON.parse(text) : null;
      if (saved?.v === 1) {
        entries = new Map(Object.entries(saved.entries));
        for (const entry of entries.values()) total += entry.size;
      }
    } catch {
      // No index, or an unreadable one: an empty cache (the files are written again)
    }
  })();

  const saveIndex = () => serial(async () => {
    if (!indexDirty) return;
    indexDirty = false;
    await fs.writeText(path(INDEX), JSON.stringify({ v: 1, entries: Object.fromEntries(entries) }));
  }).catch((error) => console.warn(`${label}: index not saved`, error?.message ?? error));

  const indexChanged = () => {
    indexDirty = true;
    if (!indexTimer) indexTimer = setTimeout(() => {
      indexTimer = null;
      saveIndex();
    }, INDEX_DELAY_MS);
  };

  const drop = (key) => {
    const entry = entries.get(key);
    if (!entry) return null;
    entries.delete(key);
    total -= entry.size;
    indexChanged();
    return entry.file;
  };

  // Inside the queue: the least important entries go until LOW_WATER of the limit
  const makeRoom = async () => {
    if (total <= maxBytes) return;
    const target = maxBytes * LOW_WATER;
    const order = [...entries.entries()]
      .filter(([key]) => !pending.has(key))
      .sort(([, a], [, b]) => (b.priority - a.priority) || (a.used - b.used));
    for (const [key] of order) {
      if (total <= target) break;
      const file = drop(key);
      if (file) await fs.remove(path(file)).catch(() => {});
    }
  };

  const record = (key, file, size, priority) => {
    const previous = entries.get(key);
    if (previous) total -= previous.size;
    entries.set(key, { file, size, priority, used: now() });
    total += size;
    indexChanged();
  };

  const release = (done) => {
    const told = waiters;
    waiters = [];
    done.then(() => told.forEach((resolve) => resolve()), () => told.forEach((resolve) => resolve()));
    return done;
  };

  const flushPending = () => {
    clearTimeout(pendingTimer);
    pendingTimer = null;
    if (!pending.size) return release(Promise.resolve());
    const batch = [...pending.entries()];
    pending.clear();
    const started = generation;
    return release(serial(async () => {
      if (started !== generation) return;
      for (const [key, { value, priority }] of batch) {
        if (started !== generation || pending.has(key)) continue; // a newer value is waiting
        const text = JSON.stringify(value);
        const file = `${hashKey(key)}.json`;
        try {
          await fs.writeText(path(file), text);
          // Characters, about the bytes (the text is mostly ASCII)
          record(key, file, text.length + key.length, priority);
        } catch (error) {
          console.warn(`${label}: ${key} not saved`, error?.message ?? error);
        }
      }
      await makeRoom();
    }));
  };

  function setPriority(key, priority) {
    const entry = entries.get(key);
    if (entry && entry.priority !== priority) {
      entry.priority = priority;
      indexChanged();
    }
    const waitingWrite = pending.get(key);
    if (waitingWrite) waitingWrite.priority = priority;
  }

  const pump = () => {
    while (downloading < PARALLEL_DOWNLOADS && waiting.length) {
      const job = waiting.shift();
      downloading++;
      job().finally(() => {
        downloading--;
        pump();
      });
    }
  };

  return {
    ready,

    // The value stored under `key`, or null
    async readJson(key) {
      await ready;
      if (pending.has(key)) return pending.get(key).value;
      const entry = entries.get(key);
      if (!entry) return null;
      try {
        const text = await fs.readText(path(entry.file));
        if (text == null) {
          drop(key);
          return null;
        }
        entry.used = now();
        indexChanged();
        return JSON.parse(text);
      } catch {
        drop(key);
        return null;
      }
    },

    // Stores `value` (written a moment later: a newer value for the same key replaces
    // it before it is written). Resolves once on storage.
    writeJson(key, value, { priority = PRIORITY.OTHER } = {}) {
      pending.set(key, { value, priority });
      if (!pendingTimer) pendingTimer = setTimeout(flushPending, WRITE_DELAY_MS);
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },

    remove(key) {
      pending.delete(key);
      const started = generation;
      return serial(async () => {
        await ready;
        if (started !== generation) return;
        const file = drop(key);
        if (file) await fs.remove(path(file)).catch(() => {});
      });
    },

    has: (key) => pending.has(key) || entries.has(key),
    keys: (prefix = '') => [...new Set([...entries.keys(), ...pending.keys()])].filter((key) => key.startsWith(prefix)),

    // A new priority for an entry (a person became a connection)
    setPriority,

    // A file downloaded from `url` (immutable: a picture's address changes with the
    // picture): its local address at once when stored, else null
    fileUri(url) {
      const entry = entries.get(url);
      if (!entry) return null;
      entry.used = now();
      indexChanged();
      return fs.uri(path(entry.file));
    },

    // Downloads `url` into the cache (once, however many ask): its local address, or
    // null when it could not be downloaded
    download(url, { priority = PRIORITY.OTHER } = {}) {
      const known = entries.get(url);
      if (known) {
        if (priority < known.priority) setPriority(url, priority);
        return Promise.resolve(fs.uri(path(known.file)));
      }
      if (downloads.has(url)) return downloads.get(url);
      const started = generation;
      const job = new Promise((resolve) => {
        waiting.push(async () => {
          const file = `${hashKey(url)}${extensionOf(url)}`;
          try {
            await ready;
            const size = await fs.download(url, path(file));
            if (started !== generation) {
              await fs.remove(path(file)).catch(() => {});
              resolve(null);
              return;
            }
            await serial(async () => {
              // Emptied (sign-out) while this waited its turn: the file went with the
              // folder, and must not come back into the next account's index
              if (started !== generation) return;
              record(url, file, size + url.length, priority);
              await makeRoom();
            });
            resolve(entries.has(url) ? fs.uri(path(file)) : null);
          } catch {
            resolve(null);
          } finally {
            downloads.delete(url);
          }
        });
        pump();
      });
      downloads.set(url, job);
      return job;
    },

    // Bytes and entries stored
    usage: () => ({ bytes: total, count: entries.size }),

    // Everything waiting written now (the app goes to the background)
    async flush() {
      await flushPending();
      clearTimeout(indexTimer);
      indexTimer = null;
      await saveIndex();
    },

    // Everything deleted (sign-out): what was waiting is dropped
    clear() {
      generation++;
      pending.clear();
      clearTimeout(pendingTimer);
      clearTimeout(indexTimer);
      pendingTimer = null;
      indexTimer = null;
      entries = new Map();
      total = 0;
      indexDirty = false;
      // What waited for a write that will never happen is over
      return release(serial(() => fs.removeDir(dir).catch(() => {})));
    },
  };
}
