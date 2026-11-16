// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The API clients against a recording `request` (useApi's signature): paths, bodies,
// encoding of IDs, shapes back to the screens, errors. Plus uploads and the account
// data kept on the phone.
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';
import { createEventsApi, normalizeEvent } from '../src/features/events/api/eventsApi.js';
import { createAlbumApi } from '../src/features/album/api/albumApi.js';
import { createConnectApi } from '../src/features/social/connect/connectApi.js';
import { CONNECT_ERRORS } from '../src/features/social/connect/protocol.js';
import { discardPickedFile, uploadFile } from '../src/features/api/uploads.js';
import { forgetAccountData } from '../src/lib/accountStorage.js';
import AsyncStorage from './stubs/async-storage.mjs';

globalThis.__DEV__ = true;

// A request that records calls and answers from a table: path → answer | (options) => answer
function recorder(answers = {}) {
  const calls = [];
  const request = async (path, options = {}) => {
    calls.push({ path, method: options.method ?? 'GET', body: options.body ? JSON.parse(options.body) : undefined });
    const key = Object.keys(answers).find((prefix) => path.startsWith(prefix));
    const answer = key ? answers[key] : {};
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer(options) : answer;
  };
  return { request, calls };
}

const summary = { id: 'ev 1/../x', title: 'T', creator: { id: 'u1', username: 'u', name: 'U', pictureUrl: null }, followerCount: 3 };

describe('events client', () => {
  it('keeps a summary from wiping the details already loaded', () => {
    const normalized = normalizeEvent(summary);
    assert.equal(normalized.creatorId, 'u1');
    for (const key of ['followers', 'ratings', 'myRating', 'album']) assert.equal(key in normalized, false, key);
    assert.deepEqual(normalized.imageUrls, []);
    const merged = { ...{ followers: [{ id: 'a' }], ratings: [1] }, ...normalized };
    assert.equal(merged.followers.length, 1);
  });

  it('builds the list query and leaves out what is not set', async () => {
    const { request, calls } = recorder({ '/events': { items: [summary] } });
    const events = await createEventsApi({ request }).getEvents({ range: 2000, categories: ['food', 'free entry'], latitude: 41.9, longitude: 12.5 });
    assert.equal(calls[0].path, '/events?latitude=41.9&longitude=12.5&range=2000&categories=food&categories=free+entry');
    assert.equal(events[0].creatorId, 'u1');
    await createEventsApi({ request }).getEvents({ range: 500, latitude: 1, longitude: 2 });
    assert.equal(calls[1].path, '/events?latitude=1&longitude=2&range=500');
  });

  it('never lets an ID escape its path', async () => {
    const { request, calls } = recorder();
    const api = createEventsApi({ request });
    await api.getEvDetails('ev 1/../x');
    await api.followEvent('a/b');
    await api.deleteRating('../me');
    assert.deepEqual(calls.map((c) => c.path), ['/events/ev%201%2F..%2Fx', '/events/a%2Fb/followers/me', '/events/..%2Fme/ratings/me']);
  });

  it('answers empty lists when the server sends none', async () => {
    const { request } = recorder({ '/me/events': {}, '/events': null });
    const api = createEventsApi({ request });
    assert.deepEqual(await api.getOwnEvents(), { followed: [], created: [] });
    assert.deepEqual(await api.getEvents({ latitude: 1, longitude: 1 }), []);
  });

  it('reports with the unified endpoint', async () => {
    const { request, calls } = recorder();
    await createEventsApi({ request }).reportEvent('e1', { reportCategories: ['not an event'], description: '' });
    assert.deepEqual(calls[0], { path: '/reports', method: 'POST', body: { kind: 'event', targetId: 'e1', reasons: ['not an event'] } });
  });

  it('keeps the event\'s pictures by address, in order, without uploading them', async () => {
    const { request, calls } = recorder({ '/events/': { ...summary, imageUrls: [] } });
    await createEventsApi({ request }).setImages('e1', ['https://cdn/b.jpg', 'https://cdn/a.jpg']);
    assert.deepEqual(calls, [{ path: '/events/e1', method: 'PATCH', body: { images: [{ url: 'https://cdn/b.jpg' }, { url: 'https://cdn/a.jpg' }] } }]);
  });

  it('removes every picture with an empty list', async () => {
    const { request, calls } = recorder({ '/events/': { ...summary, imageUrls: [] } });
    await createEventsApi({ request }).setImages('e1', []);
    assert.deepEqual(calls, [{ path: '/events/e1', method: 'PATCH', body: { images: [] } }]);
  });
});

describe('albums client', () => {
  it('maps the page and repairs missing sizes', async () => {
    const { request, calls } = recorder({ '/events/e1/photos': { items: [{ id: 'p', url: 'u', author: { id: 'a' }, width: 0 }], total: 1, nextCursor: null } });
    const page = await createAlbumApi({ request }).getAlbum('e1', { cursor: '60' });
    assert.equal(calls[0].path, '/events/e1/photos?limit=60&cursor=60');
    assert.deepEqual(page.settings, { whoCanPost: 'everyone', contributors: [] });
    assert.equal(page.photos[0].authorId, 'a');
    assert.equal(page.photos[0].thumbUrl, 'u');
    assert.equal(page.photos[0].width, 1);
  });

  it('names the same upload again when a photo is sent again, without sending the file twice', async () => {
    const { request, calls } = recorder({ '/events/e1/photos': { id: 'p', url: 'u', author: { id: 'a' } } });
    const photo = await createAlbumApi({ request }).uploadPhoto('e1', { uri: 'file:///photo.jpg' }, { sent: 'up_1', key: 'upload-k' });
    // No new ticket, no file: only the request that uses the upload the storage has
    assert.deepEqual(calls.map((call) => `${call.method} ${call.path}`), ['POST /events/e1/photos']);
    assert.deepEqual(calls[0].body, { uploadId: 'up_1' });
    assert.equal(photo.authorId, 'a');
  });

  it('reports a photo with its event', async () => {
    const { request, calls } = recorder();
    await createAlbumApi({ request }).reportPhoto('e1', 'p1', { reason: 'shows_me' });
    assert.deepEqual(calls[0].body, { kind: 'photo', targetId: 'p1', eventId: 'e1', reasons: ['shows_me'] });
  });
});

describe('connect client', () => {
  const failing = (error) => createConnectApi({ request: async () => { throw error; } });

  it('turns HTTP errors into the protocol codes', async () => {
    const cases = [
      [Object.assign(new Error('x'), { status: 0 }), CONNECT_ERRORS.offline],
      [Object.assign(new Error('x'), { status: 410 }), CONNECT_ERRORS.expired],
      [Object.assign(new Error('x'), { status: 409 }), CONNECT_ERRORS.already],
      [Object.assign(new Error('x'), { status: 429 }), CONNECT_ERRORS.rateLimited],
      [Object.assign(new Error('x'), { status: 403, body: { code: 'too_far' } }), CONNECT_ERRORS.tooFar],
      [Object.assign(new Error('x'), { status: 403, body: { code: 'blocked' } }), CONNECT_ERRORS.blocked],
    ];
    for (const [error, code] of cases) {
      await assert.rejects(failing(error).claim('t', null, 'qr'), (thrown) => thrown.code === code);
    }
  });

  it('lets an abort through untouched', async () => {
    const abort = Object.assign(new Error('Aborted'), { name: 'AbortError' });
    await assert.rejects(failing(abort).getSession('s'), (thrown) => thrown === abort);
  });
});

describe('uploads', () => {
  it('asks a ticket with the real size, sends the file there, answers its ID', async () => {
    globalThis.__fileSizes = { 'file:///photo.jpg': 4321 };
    const puts = [];
    globalThis.fetch = async (url, options) => {
      puts.push({ url, options });
      return { ok: true, status: 200 };
    };
    const { request, calls } = recorder({ '/uploads': { uploadId: 'up1', uploadUrl: 'https://storage/x?sig=1', headers: { 'x-amz': '1' } } });
    const id = await uploadFile(request, { purpose: 'profile-picture', uri: 'file:///photo.jpg' });
    assert.equal(id, 'up1');
    assert.equal(calls[0].body.fileSize, 4321);
    assert.equal(puts[0].url, 'https://storage/x?sig=1');
    assert.equal(puts[0].options.method, 'PUT');
    assert.equal(puts[0].options.headers['Content-Type'], 'image/jpeg');
    assert.equal(puts[0].options.headers['x-amz'], '1');
  });

  it('fails when the storage refuses the file', async () => {
    globalThis.fetch = async () => ({ ok: false, status: 403 });
    const { request } = recorder({ '/uploads': { uploadId: 'up1', uploadUrl: 'https://storage/x' } });
    await assert.rejects(uploadFile(request, { purpose: 'event-photo', eventId: 'e', uri: 'file:///a.jpg' }), (error) => error.status === 403);
  });
});

describe('picked photos', () => {
  it('deletes the copies the picker made, never other files', () => {
    globalThis.__deleted = [];
    discardPickedFile('file:///var/mobile/Containers/Data/Application/X/Library/Caches/ImagePicker/a.jpeg');
    discardPickedFile('file:///data/user/0/app/cache/ImagePicker/b.jpeg');
    discardPickedFile('file:///var/mobile/Containers/Data/Application/X/Documents/c.jpeg');
    discardPickedFile('https://cdn.example/d.jpeg');
    discardPickedFile(null);
    assert.deepEqual(globalThis.__deleted, [
      'file:///var/mobile/Containers/Data/Application/X/Library/Caches/ImagePicker/a.jpeg',
      'file:///data/user/0/app/cache/ImagePicker/b.jpeg',
    ]);
  });
});

describe('account data on the phone', () => {
  beforeEach(() => AsyncStorage.clear());

  it('forgets the account at sign-out, keeps the phone settings', async () => {
    await AsyncStorage.setItem('me:v1:user1', '{}');
    await AsyncStorage.setItem('avatar:own:v1', '{}');
    await AsyncStorage.setItem('settings:v1', '{"theme":"dark"}');
    await AsyncStorage.setItem('avatar:catalog:v1', '{}');
    await forgetAccountData();
    assert.deepEqual((await AsyncStorage.getAllKeys()).sort(), ['avatar:catalog:v1', 'settings:v1']);
  });
});
