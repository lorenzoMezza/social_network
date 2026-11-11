// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Planetiler's MBTiles → the same tiles with only what the map draws (src/slimTile.mjs),
// one thread per core. Identical tiles (open sea, ice, forest) are stored once and
// slimmed once. When the map's ZOOM (src/rules.mjs) is deeper than Planetiler's (it
// stops at 15), every tile is cut into its children at ZOOM (src/splitTile.mjs).
//   node scripts/slim.mjs <raw.mbtiles> <slim.mbtiles>
import { rmSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Worker } from 'node:worker_threads';
import { LAYERS, ZOOM } from '../src/rules.mjs';
import { tileMeters } from '../src/sidewalks.mjs';

const [input, output] = process.argv.slice(2);
const source = new DatabaseSync(input, { readOnly: true });
const tables = new Set(source.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all().map((row) => row.name));
// Planetiler writes the deduplicated layout (tiles_shallow → tiles_data); a plain
// `tiles` table works too
const compact = tables.has('tiles_data') && tables.has('tiles_shallow');
const query = compact
  ? 'SELECT tile_data_id AS id, tile_data AS data FROM tiles_data WHERE tile_data_id BETWEEN ? AND ?'
  : 'SELECT rowid AS id, tile_data AS data FROM tiles WHERE rowid BETWEEN ? AND ?';
const { first, last, count } = source.prepare(compact
  ? 'SELECT min(tile_data_id) AS first, max(tile_data_id) AS last, count(*) AS count FROM tiles_data'
  : 'SELECT min(rowid) AS first, max(rowid) AS last, count(*) AS count FROM tiles').get();

rmSync(output, { force: true });
const db = new DatabaseSync(output);
db.exec(`
  PRAGMA journal_mode = OFF;
  PRAGMA synchronous = OFF;
  CREATE TABLE metadata (name TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE tiles_data (tile_data_id INTEGER PRIMARY KEY, tile_data BLOB);
  CREATE TABLE tiles_shallow (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data_id INTEGER,
    PRIMARY KEY (zoom_level, tile_column, tile_row)) WITHOUT ROWID;
  CREATE VIEW tiles AS SELECT tiles_shallow.zoom_level, tiles_shallow.tile_column, tiles_shallow.tile_row, tiles_data.tile_data
    FROM tiles_shallow JOIN tiles_data ON tiles_shallow.tile_data_id = tiles_data.tile_data_id;
`);

// The metadata, with the layers and attributes that are left
const metadata = Object.fromEntries(source.prepare('SELECT name, value FROM metadata').all().map((row) => [row.name, row.value]));
const rawZoom = Number(metadata.maxzoom);
const levels = ZOOM - rawZoom;
if (Number(metadata.minzoom) !== rawZoom || levels < 0) {
  throw new Error(`${input} has zooms ${metadata.minzoom}–${metadata.maxzoom}: expected one zoom up to ${ZOOM}`);
}
const json = JSON.parse(metadata.json ?? '{}');
json.vector_layers = (json.vector_layers ?? []).filter((layer) => LAYERS[layer.id]).map((layer) => ({
  ...layer,
  fields: Object.fromEntries(Object.entries(layer.fields ?? {}).filter(([field]) => LAYERS[layer.id].includes(field))),
  minzoom: ZOOM,
  maxzoom: ZOOM,
}));
delete json.tilestats;
Object.assign(metadata, {
  minzoom: ZOOM,
  maxzoom: ZOOM,
  json: JSON.stringify(json),
  description: `OpenMapTiles z${ZOOM}, only what the app map draws (tile-provider/)`,
});
const putMetadata = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
for (const [name, value] of Object.entries(metadata)) putMetadata.run(name, String(value));

// The width in metres of each tile (one sequential read; identical tiles share an id
// and are told apart by nothing that depends on where they are), shared with the workers
const widths = new Float32Array(new SharedArrayBuffer(4 * ((last ?? 0) + 1)));
for (const { id, z, row } of source.prepare(compact
  ? 'SELECT tile_data_id AS id, zoom_level AS z, tile_row AS row FROM tiles_shallow'
  : 'SELECT rowid AS id, zoom_level AS z, tile_row AS row FROM tiles').iterate()) widths[id] = tileMeters(z, row);

// The tiles, in ranges of ids handed to the workers
const putTile = db.prepare('INSERT INTO tiles_data (tile_data_id, tile_data) VALUES (?, ?)');
const ranges = [];
for (let from = first ?? 1; from <= (last ?? 0); from += 500) ranges.push({ from, to: Math.min(from + 499, last) });
const totals = { before: 0, after: 0, bytesBefore: 0, bytesAfter: 0, emptied: 0 };
const started = Date.now();
let done = 0;
let lastReport = 0;
let next = 0;

await Promise.all(Array.from({ length: Math.min(availableParallelism(), ranges.length) }, () => new Promise((resolve, reject) => {
  const worker = new Worker(new URL('./slim-worker.mjs', import.meta.url), { workerData: { input, query, tileMeters: widths, levels } });
  const send = () => {
    if (next < ranges.length) worker.postMessage(ranges[next++]);
    else worker.terminate().then(resolve);
  };
  worker.on('message', ({ tiles, stats }) => {
    db.exec('BEGIN');
    for (const { id, bytes } of tiles) putTile.run(id, bytes);
    db.exec('COMMIT');
    for (const key of Object.keys(totals)) totals[key] += stats[key];
    done++;
    if (Date.now() - lastReport > 5000 || done === ranges.length) {
      lastReport = Date.now();
      console.log(`  slim: ${Math.round((done / ranges.length) * 100)}% (${Math.round((Date.now() - started) / 1000)} s)`);
    }
    send();
  });
  worker.on('error', reject);
  send();
})));

// Where each tile is: the same as before (or its children), without the tiles left empty
if (levels === 0) {
  db.exec(`ATTACH DATABASE '${input.replaceAll("'", "''")}' AS raw`);
  db.exec(compact
    ? `INSERT INTO tiles_shallow SELECT zoom_level, tile_column, tile_row, tile_data_id FROM raw.tiles_shallow
         WHERE tile_data_id IN (SELECT tile_data_id FROM tiles_data)`
    : `INSERT INTO tiles_shallow SELECT zoom_level, tile_column, tile_row, rowid FROM raw.tiles
         WHERE rowid IN (SELECT tile_data_id FROM tiles_data)`);
  db.exec('DETACH DATABASE raw');
} else {
  // Child k = dy × n + dx of a tile (splitTile.mjs order); MBTiles rows count from the
  // bottom (TMS), so the top child (dy = 0) gets the highest row
  const n = 2 ** levels;
  const written = new Set(db.prepare('SELECT tile_data_id AS id FROM tiles_data').all().map((row) => row.id));
  const putPlace = db.prepare('INSERT INTO tiles_shallow (zoom_level, tile_column, tile_row, tile_data_id) VALUES (?, ?, ?, ?)');
  db.exec('BEGIN');
  for (const { id, x, row } of source.prepare(compact
    ? 'SELECT tile_data_id AS id, tile_column AS x, tile_row AS row FROM tiles_shallow'
    : 'SELECT rowid AS id, tile_column AS x, tile_row AS row FROM tiles').iterate()) {
    for (let k = 0; k < n * n; k++) {
      const childId = id * n * n + k;
      if (!written.has(childId)) continue;
      const dx = k % n;
      const dy = Math.floor(k / n);
      putPlace.run(ZOOM, x * n + dx, row * n + (n - 1 - dy), childId);
    }
  }
  db.exec('COMMIT');
}
db.close();

const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
console.log(`  ${count} distinct tiles: ${mb(totals.bytesBefore)} → ${mb(totals.bytesAfter)}, features ${totals.before} → ${totals.after}, ${totals.emptied} left empty`);
