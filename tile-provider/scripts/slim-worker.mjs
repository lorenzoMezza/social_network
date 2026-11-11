// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// A range of tiles of slim.mjs, on its own thread: read, slim (src/slimTile.mjs), gzip.
// workerData.tileMeters: the width of each tile in metres, by id; workerData.levels:
// zoom levels to cut each tile into (its 4^levels children get the ids id × 4^levels + k)
import { DatabaseSync } from 'node:sqlite';
import { parentPort, workerData } from 'node:worker_threads';
import { gunzipSync, gzipSync, constants } from 'node:zlib';
import { encodeTile } from '../src/encodeTile.mjs';
import { slimLayers } from '../src/slimTile.mjs';
import { splitLayers } from '../src/splitTile.mjs';

const db = new DatabaseSync(workerData.input, { readOnly: true });
const select = db.prepare(workerData.query);
const gzipped = (bytes) => bytes[0] === 0x1f && bytes[1] === 0x8b;

parentPort.on('message', ({ from, to }) => {
  const tiles = [];
  const stats = { before: 0, after: 0, bytesBefore: 0, bytesAfter: 0, emptied: 0 };
  for (const { id, data } of select.iterate(from, to)) {
    const slim = slimLayers(gzipped(data) ? gunzipSync(data) : data, { tileMeters: workerData.tileMeters[id] });
    stats.before += slim.before;
    stats.after += slim.after;
    stats.bytesBefore += data.byteLength;
    const { levels } = workerData;
    const parts = levels > 0
      ? splitLayers(slim.layers, levels).map((child, k) => ({ id: id * 4 ** levels + k, layers: child.layers }))
      : [{ id, layers: slim.layers }];
    for (const part of parts) {
      const encoded = encodeTile(part.layers);
      // A tile left with nothing the map draws is not written: the map asks for it
      // and draws an empty tile, as with the empty tiles Planetiler leaves out
      if (!encoded.byteLength) {
        stats.emptied++;
        continue;
      }
      const bytes = gzipSync(encoded, { level: constants.Z_BEST_COMPRESSION });
      stats.bytesAfter += bytes.byteLength;
      tiles.push({ id: part.id, bytes });
    }
  }
  parentPort.postMessage({ tiles, stats });
});
