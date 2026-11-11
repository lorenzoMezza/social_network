// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Serves every output/*.pmtiles as ONE tile source for the app's map (make serve here,
// make dev in the app): the map asks /tiles.json, then /{z}/{x}/{y}.mvt, and each tile
// comes from whichever area holds it, so Rome, New York… all work at the same time.
// A tile no area holds is an empty answer (204): the map draws nothing there.
// An area made or remade while the server runs (make tiles) is picked up at once.
//   node scripts/serve.mjs   (PORT, default 8093; TILES_DIR, default output/)
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { open, readdir, stat } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import { PMTiles } from 'pmtiles';

const PORT = Number(process.env.PORT) || 8093;
// TILES_DIR: another folder of .pmtiles (e.g. to compare two builds side by side)
const OUTPUT = process.env.TILES_DIR ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '../output');
const gzipAsync = promisify(gzip);
const TILE = /^\/(\d+)\/(\d+)\/(\d+)\.mvt$/;
const ATTRIBUTION = '© OpenMapTiles © OpenStreetMap contributors';
// The map page is a file:// page, and its tile cache revalidates with If-None-Match
// (webview/shared/httpCache.js). no-cache: a stored tile is shown at once and checked,
// so a remade area replaces the old tiles on the phone from the next view.
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'If-None-Match, If-Modified-Since',
  'Access-Control-Expose-Headers': 'ETag',
};

// PMTiles reads the archive in pieces from the file
class FileSource {
  constructor(file, handle) {
    this.file = file;
    this.handle = handle;
  }

  getKey() {
    return this.file;
  }

  async getBytes(offset, length) {
    const data = new Uint8Array(length);
    const { bytesRead } = await this.handle.read(data, 0, length, offset);
    return { data: data.buffer.slice(0, bytesRead) };
  }
}

let areas = [];
let areasVersion = '';
let loading = null;

// Opens the archives again whenever output/ changes (make tiles renames the finished
// file into it). Smaller areas first: where two overlap, the more detailed one answers.
async function loadAreas() {
  const files = (await readdir(OUTPUT).catch(() => [])).filter((name) => name.endsWith('.pmtiles')).sort();
  const stats = await Promise.all(files.map((name) => stat(path.join(OUTPUT, name))));
  const version = files.map((name, i) => `${name}:${stats[i].size}:${stats[i].mtimeMs}`).join('|');
  if (version === areasVersion) return;

  const next = await Promise.all(files.map(async (name, i) => {
    const file = path.join(OUTPUT, name);
    const handle = await open(file);
    const archive = new PMTiles(new FileSource(file, handle));
    const [header, metadata] = await Promise.all([archive.getHeader(), archive.getMetadata()]);
    const etag = `"${name}-${stats[i].size.toString(36)}-${Math.round(stats[i].mtimeMs).toString(36)}"`;
    return { name, handle, archive, header, metadata, etag };
  }));
  const size = ({ header: h }) => (h.maxLon - h.minLon) * (h.maxLat - h.minLat);
  const previous = areas;
  areas = next.sort((a, b) => size(a) - size(b));
  areasVersion = version;
  // Reads already started on the old files finish first
  setTimeout(() => previous.forEach(({ handle }) => handle.close().catch(() => {})), 60_000).unref();
  console.log(areas.length ? `Areas: ${areas.map(({ name }) => name.replace(/\.pmtiles$/, '')).join(', ')}`
    : 'No areas in output/: make tiles AREA=roma');
}

const refresh = () => {
  loading ??= loadAreas().finally(() => { loading = null; });
  return loading;
};

const lon = (x, z) => (x / 2 ** z) * 360 - 180;
const lat = (y, z) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** z))) * 180) / Math.PI;

async function findTile(z, x, y) {
  const [west, east, north, south] = [lon(x, z), lon(x + 1, z), lat(y, z), lat(y + 1, z)];
  for (const area of areas) {
    const { header: h } = area;
    if (z < h.minZoom || z > h.maxZoom) continue;
    if (east < h.minLon || west > h.maxLon || north < h.minLat || south > h.maxLat) continue;
    const tile = await area.archive.getZxy(z, x, y);
    if (tile) return { area, data: tile.data };
  }
  return null;
}

function tileJson(req) {
  const origin = process.env.PUBLIC_URL ?? `http://${req.headers.host}`;
  const layers = new Map();
  for (const { metadata } of areas) {
    for (const layer of metadata?.vector_layers ?? []) if (!layers.has(layer.id)) layers.set(layer.id, layer);
  }
  const headers = areas.map(({ header }) => header);
  return {
    tilejson: '3.0.0',
    name: areas.map(({ name }) => name.replace(/\.pmtiles$/, '')).join(', '),
    attribution: ATTRIBUTION,
    tiles: [`${origin}/{z}/{x}/{y}.mvt`],
    minzoom: Math.min(...headers.map((h) => h.minZoom)),
    maxzoom: Math.max(...headers.map((h) => h.maxZoom)),
    bounds: [
      Math.min(...headers.map((h) => h.minLon)), Math.min(...headers.map((h) => h.minLat)),
      Math.max(...headers.map((h) => h.maxLon)), Math.max(...headers.map((h) => h.maxLat)),
    ],
    vector_layers: [...layers.values()],
  };
}

// What each device asked, summed up every few seconds in the log: shows at a glance
// whether a phone reaches the server and whether its area is in output/
const asked = new Map();
function note(req, status, z, x, y) {
  const client = req.socket.remoteAddress?.replace(/^::ffff:/, '') ?? '?';
  const entry = asked.get(client) ?? { other: [], served: [], empty: [] };
  if (z === undefined) entry.other.push(`${req.url.split('?')[0]} ${status}`);
  else entry[status === 204 ? 'empty' : 'served'].push(`${z}/${x}/${y}`);
  asked.set(client, entry);
}
// "12 tiles x 4820-4824 y 6155-6158 (around 40.758,-73.986)"
function summary(tiles, label) {
  if (!tiles.length) return `0 ${label}`;
  const [xs, ys] = [0, 1].map((i) => tiles.map((t) => Number(t.split('/')[i + 1])));
  const z = Number(tiles[0].split('/')[0]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  const around = `${lat((y0 + y1 + 1) / 2, z).toFixed(3)},${lon((x0 + x1 + 1) / 2, z).toFixed(3)}`;
  return `${tiles.length} ${label} x ${x0}-${x1} y ${y0}-${y1} (around ${around})`;
}
setInterval(() => {
  for (const [client, { other, served, empty }] of asked) {
    console.log(`${client}: ${[...other, summary(served, 'tiles'), summary(empty, 'empty (no area there)')].join(', ')}`);
  }
  asked.clear();
}, 5000).unref();

function send(req, res, status, etag, headers = {}, body = undefined) {
  if (etag && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { ...CORS, ETag: etag, 'Cache-Control': 'no-cache' }).end();
    return;
  }
  res.writeHead(status, { ...CORS, ...(etag && { ETag: etag, 'Cache-Control': 'no-cache' }), ...headers }).end(body);
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS).end();
    return;
  }
  try {
    await refresh();
    const url = req.url.split('?')[0];
    // The TileJSON changes with the set of areas
    const allEtag = `"${createHash('sha1').update(areasVersion).digest('base64url')}"`;
    if (url === '/tiles.json') {
      note(req, areas.length ? 200 : 503);
      if (!areas.length) send(req, res, 503, null, { 'Content-Type': 'text/plain' }, 'No areas in tile-provider/output/: make tiles AREA=roma');
      else send(req, res, 200, allEtag, { 'Content-Type': 'application/json' }, JSON.stringify(tileJson(req)));
      return;
    }
    const match = TILE.exec(url);
    if (!match) {
      send(req, res, 404, null);
      return;
    }
    const [z, x, y] = match.slice(1).map(Number);
    const tile = await findTile(z, x, y);
    note(req, tile ? 200 : 204, z, x, y);
    // Never kept by a cache: an area made later must show at once, not after the
    // phone has served the remembered empty tile one more time
    if (!tile) {
      send(req, res, 204, null, { 'Cache-Control': 'no-store' });
      return;
    }
    // PMTiles gives the tile uncompressed: compressed again for the Wi-Fi
    const compress = /\bgzip\b/.test(req.headers['accept-encoding'] ?? '');
    send(req, res, 200, tile.area.etag, {
      'Content-Type': 'application/vnd.mapbox-vector-tile',
      Vary: 'Accept-Encoding',
      ...(compress && { 'Content-Encoding': 'gzip' }),
    }, compress ? await gzipAsync(tile.data) : Buffer.from(tile.data));
  } catch (error) {
    console.error(req.url, error);
    send(req, res, 500, null);
  }
});

await refresh();
server.listen(PORT, '0.0.0.0', () => {
  const addresses = Object.values(networkInterfaces()).flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal).map((a) => a.address);
  console.log(`Tiles on port ${PORT} (EXPO_PUBLIC_TILE_URL of the app):`);
  for (const address of ['localhost', ...addresses]) console.log(`  http://${address}:${PORT}/tiles.json`);
});
