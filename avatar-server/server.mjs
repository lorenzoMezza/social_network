// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The avatar assets in development (a CDN in production), like
// tile-provider/scripts/serve.mjs for the map tiles:
//   node avatar-server/server.mjs          (make dev sets it up and starts it)
//
//   GET  /v1/catalog            every item an avatar can wear (shared/avatarFormat.js)
//   GET  /v1/presets            ready-made avatars
//   GET  /v1/files/<path>       item files (models, face textures, thumbnails, preset pictures)
//   GET  /v1/files-astc/<path>  the same models and face textures optimised for the GPU
//                               (ASTC KTX2, meshopt), made once by asset-pipeline/
//   GET  /v1/map-avatars/<key>.glb|.ktx2|.png
//                               map avatars: one avatar as the people around see it on
//                               the map (asset-pipeline/src/mapAvatar.mjs), never changing
//   GET  /v1/map-avatars/stand-in
//                               { key } of the one people wear until theirs arrives
//   POST /v1/map-avatars        an avatar → { key }, made if it was not yet. For the
//                               backend only (when a user saves an avatar): from this
//                               computer, or with the bake secret (AVATAR_BAKE_SECRET)
//
// The avatars people save are the backend's (docs/API.md: GET /users/{id}/avatar,
// PUT /me/avatar), validated with the same rules.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { existsSync, mkdirSync } from 'node:fs';
import { readFile, rename, stat, writeFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PORT = Number(process.env.AVATAR_PORT ?? 8092);
const root = fileURLToPath(new URL('./', import.meta.url));
const library = path.join(root, 'library');
const optimizedLibrary = path.join(root, 'library-astc');
const mapAvatars = path.join(root, 'map-avatars');
const TYPES = { '.json': 'application/json', '.png': 'image/png', '.glb': 'model/gltf-binary', '.ktx2': 'image/ktx2' };

if (!existsSync(path.join(library, 'catalog.json'))) {
  console.error('library/ is missing: run `make setup` first.');
  process.exit(1);
}

const catalog = JSON.parse(await readFile(path.join(library, 'catalog.json'), 'utf8'));
const { presets } = JSON.parse(await readFile(path.join(library, 'presets.json'), 'utf8'));

const cors = {
  'Access-Control-Allow-Origin': '*', // the viewer is a file:// page
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  // The app's file cache (webview/shared/httpCache.js) checks a stored file with its
  // ETag: an unchanged one costs a 304, no download
  'Access-Control-Allow-Headers': 'Content-Type, If-None-Match',
  'Access-Control-Expose-Headers': 'ETag',
  'Access-Control-Max-Age': '86400',
};

function send(res, status, body, headers = {}) {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { ...cors, 'Content-Type': 'application/json', ...headers }).end(data);
}

// Files: revalidated by ETag (they change only when the library is rebuilt)
async function sendFile(req, res, file, cacheControl) {
  let info;
  try {
    info = await stat(file);
  } catch {
    send(res, 404, { error: 'not found' });
    return;
  }
  const etag = `"${info.size.toString(36)}-${Math.floor(info.mtimeMs).toString(36)}"`;
  const headers = { ...cors, ETag: etag, 'Cache-Control': cacheControl, 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers).end();
    return;
  }
  // JSON documents (the catalog is ~0.5 MB) travel compressed: about a tenth of the size
  if (path.extname(file) === '.json' && /\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) {
    const cached = compressed.get(file);
    const body = cached?.etag === etag ? cached.body : gzipSync(await readFile(file));
    compressed.set(file, { etag, body });
    res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding', 'Content-Length': body.length }).end(body);
    return;
  }
  res.writeHead(200, { ...headers, 'Content-Length': info.size }).end(await readFile(file));
}
const compressed = new Map();

// --- Map avatars ---
// The baker lives in asset-pipeline/ (its own dependencies): loaded on first use
let baker = null;
const loadBaker = () => {
  baker ??= (async () => {
    const [{ bakeMapAvatar, mapAvatarKey }, { fetchTools }] = await Promise.all([
      import('../asset-pipeline/src/mapAvatar.mjs'),
      import('../asset-pipeline/scripts/fetch-tools.mjs'),
    ]);
    return { bakeMapAvatar, mapAvatarKey, astcenc: await fetchTools() };
  })();
  baker.catch(() => {
    baker = null;
  });
  return baker;
};
mkdirSync(mapAvatars, { recursive: true });
const KEY = /^[0-9a-f]{32}$/;
// One bake at a time (each takes a fraction of a second and a few hundred MB at
// peak); the same avatar asked twice is made once
const QUEUE_LIMIT = 64;
let queue = Promise.resolve();
let waiting = 0;
const inFlight = new Map();
async function bake(avatar) {
  const { bakeMapAvatar, mapAvatarKey, astcenc } = await loadBaker();
  const key = mapAvatarKey(avatar, catalog);
  if (existsSync(path.join(mapAvatars, `${key}.glb`))) return key;
  if (inFlight.has(key)) return inFlight.get(key);
  if (waiting >= QUEUE_LIMIT) throw Object.assign(new Error('busy'), { status: 503 });
  waiting++;
  const job = queue.then(async () => {
    const baked = await bakeMapAvatar(avatar, { library, catalog, astcenc });
    const write = async (name, data) => {
      const temporary = path.join(mapAvatars, `.${name}.${process.pid}`);
      await writeFile(temporary, data);
      await rename(temporary, path.join(mapAvatars, name));
    };
    await write(`${key}.ktx2`, baked.ktx2);
    await write(`${key}.png`, baked.png);
    await write(`${key}.glb`, baked.glb); // last: its presence means all three are there
    return key;
  }).finally(() => {
    waiting--;
    inFlight.delete(key);
  });
  queue = job.catch(() => {});
  inFlight.set(key, job);
  return job;
}

// The stand-in: the default avatar of the catalog (shared/avatarFormat.js), made once
let standIn = null;
const standInKey = () => {
  standIn ??= import('./shared/avatarFormat.js').then(({ defaultAvatar }) => bake(defaultAvatar()));
  standIn.catch(() => {
    standIn = null;
  });
  return standIn;
};

// Bakes are for the backend: this computer, or the shared secret
const BAKE_SECRET = process.env.AVATAR_BAKE_SECRET ?? '';
function maySubmit(req) {
  const given = String(req.headers['x-bake-secret'] ?? '');
  if (BAKE_SECRET && given.length === BAKE_SECRET.length && timingSafeEqual(Buffer.from(given), Buffer.from(BAKE_SECRET))) return true;
  const address = req.socket.remoteAddress ?? '';
  return !BAKE_SECRET && (address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1');
}

async function readBody(req, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error('too large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'HEAD') req.method = 'GET'; // node drops the body of HEAD answers itself
  const route = url.pathname;
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    if (req.method === 'GET' && route === '/health') return send(res, 200, { ok: true, items: catalog.items.length });
    if (req.method === 'GET' && route === '/v1/catalog') return sendFile(req, res, path.join(library, 'catalog.json'), 'no-cache');
    if (req.method === 'GET' && route === '/v1/presets') return sendFile(req, res, path.join(library, 'presets.json'), 'no-cache');

    if (req.method === 'GET' && route.startsWith('/v1/files/')) {
      const relative = decodeURIComponent(route.slice('/v1/files/'.length));
      const file = path.join(library, relative);
      if (!file.startsWith(path.join(library, 'items') + path.sep)) return send(res, 404, { error: 'not found' });
      return sendFile(req, res, file, 'public, max-age=86400');
    }
    if (req.method === 'GET' && route === '/v1/map-avatars/stand-in') {
      return send(res, 200, { key: await standInKey() }, { 'Cache-Control': 'no-cache' });
    }
    if (req.method === 'GET' && route.startsWith('/v1/map-avatars/')) {
      const [key, extension] = route.slice('/v1/map-avatars/'.length).split('.');
      if (!KEY.test(key) || !['glb', 'ktx2', 'png'].includes(extension)) return send(res, 404, { error: 'not found' });
      // Named by their content: they never change
      return sendFile(req, res, path.join(mapAvatars, `${key}.${extension}`), 'public, max-age=31536000, immutable');
    }
    if (req.method === 'POST' && route === '/v1/map-avatars') {
      if (!maySubmit(req)) return send(res, 403, { error: 'forbidden' });
      let avatar;
      try {
        avatar = JSON.parse(await readBody(req, 16 * 1024));
      } catch (error) {
        return send(res, error.status ?? 400, { error: error.status ? 'too large' : 'invalid json' });
      }
      const { validateAvatar } = await import('./shared/avatarFormat.js');
      const checked = validateAvatar(avatar, catalog);
      if (!checked.ok) return send(res, 400, { error: 'invalid avatar', details: checked.errors });
      try {
        return send(res, 200, { key: await bake(checked.avatar) });
      } catch (error) {
        if (error.status) return send(res, error.status, { error: error.message });
        throw error;
      }
    }
    // The optimised library (asset-pipeline, made by make setup);
    // without it the app falls back to the files above
    if (req.method === 'GET' && route.startsWith('/v1/files-astc/')) {
      const relative = decodeURIComponent(route.slice('/v1/files-astc/'.length));
      const file = path.join(optimizedLibrary, relative);
      if (!file.startsWith(path.join(optimizedLibrary, 'items') + path.sep)) return send(res, 404, { error: 'not found' });
      return sendFile(req, res, file, 'public, max-age=86400');
    }

    send(res, 404, { error: 'not found' });
  } catch (error) {
    console.error(error);
    send(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const addresses = Object.values(networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  console.log(`Avatar server on port ${PORT} (${catalog.items.length} items, ${presets.length} presets):`);
  for (const address of addresses) console.log(`  http://${address}:${PORT}/v1/catalog`);
});
