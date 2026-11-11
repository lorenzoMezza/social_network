// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The network of the try-it demo (show-case/demo/). The app was built to talk to three
// servers, under names that exist nowhere (.invalid): this worker answers for them.
//   api.demo.invalid      the backend: Python in this tab (backend-worker.js), reached
//                         through the page that runs it
//   avatars.demo.invalid  the avatar files, copied into demo/avatars/
//   tiles.demo.invalid    the map tiles around the demo's spot, in demo/tiles/
// Everything else (the app's own files, the weather) goes to the network as usual.
const HERE = new URL('./', self.location).href;
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': '*',
};

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// The pages that run a backend say so; the latest one answers for the others
let backendPage = null;
self.addEventListener('message', (event) => {
  if (event.data?.type === 'backend-ready') backendPage = event.source.id;
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method === 'OPTIONS' && url.hostname.endsWith('.demo.invalid')) {
    event.respondWith(new Response(null, { status: 204, headers: CORS }));
  } else if (url.hostname === 'api.demo.invalid') {
    event.respondWith(toBackend(event, url));
  } else if (url.hostname === 'avatars.demo.invalid') {
    event.respondWith(avatarFile(url));
  } else if (url.hostname === 'tiles.demo.invalid') {
    event.respondWith(tile(url));
  }
});

const withCors = (response, extra = {}) => {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries({ ...CORS, ...extra })) headers.set(name, value);
  const empty = [101, 204, 205, 304].includes(response.status);
  return new Response(empty ? null : response.body, { status: response.status, statusText: response.statusText, headers });
};
const missing = (status = 404) => new Response(null, { status, headers: CORS });

async function pageWithBackend(event) {
  const pages = await self.clients.matchAll({ type: 'window' });
  return pages.find((page) => page.id === event.clientId && page.id === backendPage)
    ?? pages.find((page) => page.id === backendPage)
    ?? pages.find((page) => page.id === event.clientId)
    ?? pages.find((page) => page.frameType === 'top-level');
}

async function toBackend(event, url) {
  const page = await pageWithBackend(event);
  if (!page) return withCors(Response.json({ code: 'unavailable', message: 'the demo server is not running' }, { status: 503 }));
  const request = event.request;
  const body = ['GET', 'HEAD'].includes(request.method) ? null : await request.arrayBuffer();
  const channel = new MessageChannel();
  const answer = new Promise((resolve) => {
    channel.port1.onmessage = (message) => resolve(message.data);
  });
  page.postMessage({
    type: 'http', method: request.method, path: url.pathname, query: url.search.slice(1),
    headers: [...request.headers], body,
  }, [channel.port2, ...(body ? [body] : [])]);
  const { status, headers, body: bytes } = await answer;
  const empty = [101, 204, 205, 304].includes(status) || request.method === 'HEAD';
  return new Response(empty ? null : bytes, { status, headers: [...headers.filter(([name]) => name.toLowerCase() !== 'content-length'), ...Object.entries(CORS)] });
}

// The avatar server's routes, as files
async function avatarFile(url) {
  const route = url.pathname;
  let file = null;
  if (route === '/v1/catalog') file = 'avatars/catalog.json';
  else if (route === '/v1/presets') file = 'avatars/presets.json';
  else if (route === '/v1/map-avatars/stand-in') file = 'avatars/stand-in.json';
  else if (route.startsWith('/v1/files/')) file = `avatars/files/${route.slice('/v1/files/'.length)}`;
  else if (route.startsWith('/v1/map-avatars/')) file = `avatars/map/${route.slice('/v1/map-avatars/'.length)}`;
  // (the optimised library is not in the demo: the viewer falls back to the files above)
  if (!file || file.includes('..')) return missing();
  const response = await fetch(new URL(file, HERE));
  return response.ok ? withCors(response) : missing();
}

async function tile(url) {
  const file = url.pathname === '/tiles.json' ? 'tiles/tiles.json' : `tiles${url.pathname}`;
  if (!/^tiles(\/tiles\.json|\/\d+\/\d+\/\d+\.mvt)$/.test(file)) return missing();
  const response = await fetch(new URL(file, HERE));
  // No tile there (outside the area of the demo): empty, as the tile server answers
  return response.ok ? withCors(response, { 'Content-Type': file.endsWith('.json') ? 'application/json' : 'application/vnd.mapbox-vector-tile' }) : missing(204);
}
