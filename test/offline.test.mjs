// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// What the app keeps on the phone to work offline (src/lib/offline, socialCache): the
// limit always holds and what matters least goes first; nothing half-written or from
// a signed-out account comes back; a chat's messages never get a hole
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PRIORITY, createDiskCache, hashKey } from '../src/lib/offline/diskCache.js';
import { mergeNewestPage, storedMessages } from '../src/features/social/state/socialCache.js';

// The phone's storage, in memory: path → text
function memoryFs({ downloads = {} } = {}) {
  const files = new Map();
  return {
    files,
    downloadsAsked: [],
    readText: async (path) => (files.has(path) ? files.get(path) : null),
    writeText: async (path, text) => void files.set(path, text),
    remove: async (path) => void files.delete(path),
    removeDir: async (dir) => {
      for (const path of [...files.keys()]) if (path.startsWith(`${dir}/`)) files.delete(path);
    },
    async download(url, path) {
      this.downloadsAsked.push(url);
      await new Promise((resolve) => setTimeout(resolve, 5));
      if (!(url in downloads)) throw new Error('404');
      files.set(path, downloads[url]);
      return downloads[url].length;
    },
    uri: (path) => `file:///${path}`,
  };
}

let clock = 1000;
const now = () => clock++;

describe('disk cache', () => {
  it('keeps a value across restarts of the app', async () => {
    const fs = memoryFs();
    const cache = createDiskCache({ dir: 'acc/chats', maxBytes: 10_000, fs, now });
    cache.writeJson('inbox', { chats: [1, 2] }, { priority: PRIORITY.OWN });
    assert.deepEqual(await cache.readJson('inbox'), { chats: [1, 2] }, 'waiting writes are read back at once');
    await cache.flush();
    const again = createDiskCache({ dir: 'acc/chats', maxBytes: 10_000, fs, now });
    assert.deepEqual(await again.readJson('inbox'), { chats: [1, 2] });
    assert.equal(await again.readJson('nothing'), null);
  });

  it('writes the newest value once when it changes in a burst', async () => {
    const fs = memoryFs();
    let writes = 0;
    const counting = { ...fs, writeText: async (path, text) => { if (!path.endsWith('index.json')) writes++; return fs.writeText(path, text); } };
    const cache = createDiskCache({ dir: 'a', maxBytes: 10_000, fs: counting, now });
    for (let i = 0; i < 20; i++) cache.writeJson('messages:c1', { n: i });
    await cache.flush();
    assert.equal(writes, 1);
    assert.deepEqual(await cache.readJson('messages:c1'), { n: 19 });
  });

  it('drops the least important first: the lowest priority, then the least recently used', async () => {
    const fs = memoryFs();
    const value = 'x'.repeat(90); // about 100 bytes each with the key
    const cache = createDiskCache({ dir: 'a', maxBytes: 500, fs, now });
    cache.writeJson('own', value, { priority: PRIORITY.OWN });
    cache.writeJson('friend', value, { priority: PRIORITY.CLOSE });
    cache.writeJson('old', value, { priority: PRIORITY.RECENT });
    cache.writeJson('recent', value, { priority: PRIORITY.RECENT });
    await cache.flush();
    await cache.readJson('old'); // used again: now the most recent of its priority
    cache.writeJson('other', value, { priority: PRIORITY.OTHER });
    cache.writeJson('new', value, { priority: PRIORITY.RECENT });
    await cache.flush();
    assert.ok(cache.usage().bytes <= 500);
    const kept = ['own', 'friend', 'old', 'recent', 'other', 'new'].filter((key) => cache.has(key));
    assert.deepEqual(kept, ['own', 'friend', 'old', 'new']);
  });

  it('keeps the limit even with only the user\'s own data', async () => {
    const fs = memoryFs();
    const cache = createDiskCache({ dir: 'a', maxBytes: 300, fs, now });
    for (let i = 0; i < 6; i++) cache.writeJson(`own${i}`, 'x'.repeat(90), { priority: PRIORITY.OWN });
    await cache.flush();
    assert.ok(cache.usage().bytes <= 300);
    assert.ok(cache.has('own5'), 'the newest stays');
  });

  it('downloads a picture once, however many ask, and keeps it with the best priority', async () => {
    const fs = memoryFs({ downloads: { 'https://cdn/p.jpg': 'JPEGDATA' } });
    const cache = createDiskCache({ dir: 'a', maxBytes: 10_000, fs, now });
    const [a, b] = await Promise.all([
      cache.download('https://cdn/p.jpg', { priority: PRIORITY.RECENT }),
      cache.download('https://cdn/p.jpg', { priority: PRIORITY.RECENT }),
    ]);
    assert.equal(a, b);
    assert.match(a, /^file:\/\/\/a\/.+\.jpg$/);
    assert.equal(fs.downloadsAsked.length, 1);
    assert.equal(cache.fileUri('https://cdn/p.jpg'), a);
    await cache.download('https://cdn/p.jpg', { priority: PRIORITY.OWN });
    assert.equal(fs.downloadsAsked.length, 1);
    assert.equal(await cache.download('https://cdn/missing.jpg'), null, 'a failed download is a miss');
  });

  it('treats a file the system deleted as a miss', async () => {
    const fs = memoryFs();
    const cache = createDiskCache({ dir: 'a', maxBytes: 10_000, fs, now });
    cache.writeJson('event:1', { id: 1 });
    await cache.flush();
    fs.files.delete(`a/${hashKey('event:1')}.json`);
    assert.equal(await cache.readJson('event:1'), null);
    assert.equal(cache.has('event:1'), false);
  });

  it('forgets everything at sign-out, writes still waiting included', async () => {
    const fs = memoryFs();
    const cache = createDiskCache({ dir: 'acc', maxBytes: 10_000, fs, now });
    cache.writeJson('inbox', { a: 1 });
    await cache.flush();
    cache.writeJson('outbox', [{ text: 'late' }]);
    await cache.clear();
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.equal(fs.files.size, 0);
    assert.equal(await createDiskCache({ dir: 'acc', maxBytes: 10_000, fs, now }).readJson('inbox'), null);
  });

  it('settles every write it promised, also when flushed early or cleared', async () => {
    const fs = memoryFs();
    const cache = createDiskCache({ dir: 'a', maxBytes: 10_000, fs, now });
    const settled = (promise) => Promise.race([promise.then(() => true), new Promise((resolve) => setTimeout(() => resolve(false), 1000))]);
    // flush() before the delayed write: the promise of writeJson still resolves
    const early = cache.writeJson('one', { n: 1 });
    await cache.flush();
    assert.equal(await settled(early), true);
    // cleared at sign-out before it was written: resolved too, never left hanging
    const dropped = cache.writeJson('two', { n: 2 });
    await cache.clear();
    assert.equal(await settled(dropped), true);
    assert.equal(await cache.readJson('two'), null);
  });

  it('names files safely and stably', () => {
    assert.equal(hashKey('messages:chat-1'), hashKey('messages:chat-1'));
    assert.notEqual(hashKey('messages:chat-1'), hashKey('messages:chat-2'));
    assert.match(hashKey('api:/users/a b?x=1'), /^[0-9a-z]+$/);
  });
});

describe('chat messages kept on the phone', () => {
  const message = (id, at, extra = {}) => ({ id, at, chatId: 'c', text: id, ...extra });

  it('keeps the older messages the newest page reaches', () => {
    const cached = { items: [message('a', 1), message('b', 2), message('c', 3)], nextCursor: 'a0' };
    const page = [message('c', 3, { text: 'poll updated' }), message('d', 4)];
    const merged = mergeNewestPage(cached, page, 'c');
    assert.deepEqual(merged.items.map((m) => m.id), ['a', 'b', 'c', 'd']);
    assert.equal(merged.items[2].text, 'poll updated', "the server's copy wins");
    assert.equal(merged.nextCursor, 'a0', 'older pages continue from the oldest kept');
    assert.equal(merged.gap, false);
  });

  it('never leaves a hole when more was written than one page', () => {
    const cached = { items: [message('a', 1), message('b', 2)], nextCursor: null };
    const merged = mergeNewestPage(cached, [message('x', 50), message('y', 51)], 'x');
    assert.equal(merged.gap, true);
    assert.deepEqual(merged.items.map((m) => m.id), ['x', 'y'], 'without the missing ones, only the page');
    assert.equal(merged.nextCursor, 'x');
  });

  it('keeps the own messages still being sent', () => {
    const cached = { items: [message('a', 1), message('c1', 5, { pending: true, clientId: 'c1' })], nextCursor: null };
    const merged = mergeNewestPage(cached, [message('a', 1), message('b', 2)], null);
    assert.deepEqual(merged.items.map((m) => m.id), ['a', 'b', 'c1']);
  });

  it('stores only what the server has, the newest ones', () => {
    const items = Array.from({ length: 3005 }, (_, i) => message(`m${i}`, i));
    items.push(message('p', 9999, { pending: true }));
    const stored = storedMessages({ items, nextCursor: 'older' });
    assert.equal(stored.items.length, 3000);
    assert.equal(stored.items[0].id, 'm5');
    assert.equal(stored.nextCursor, 'm5');
    assert.ok(!stored.items.some((m) => m.pending));
    assert.equal(storedMessages({ items: items.slice(0, 3), nextCursor: 'older' }).nextCursor, 'older');
  });
});
