// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// How far the map shows (webview/map/src/config.js): its tiles reach MAP_RADIUS metres at
// every latitude, and the fog is complete just inside what they always cover
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window ??= {};
globalThis.location ??= { search: '' };
const { MAP_RADIUS, fogFarAt, tileSizeAt } = await import('../webview/map/src/config.js');

describe('the fog of the map', () => {
  it('is complete at about 700 m, a little farther towards the poles', () => {
    assert.equal(Math.round(fogFarAt(41.9)), 708); // Rome
    assert.equal(Math.round(fogFarAt(59.9)), 727); // Oslo
    assert.equal(Math.round(fogFarAt(0)), 689);
  });

  it('never shows where there is no map: the tiles always reach past it', () => {
    for (let lat = 0; lat <= 80; lat += 5) {
      // Tiles within MAP_RADIUS of where they were chosen, and they are chosen again
      // once the centre moved an eighth of a tile
      const alwaysLoaded = MAP_RADIUS - tileSizeAt(lat) / 8;
      assert.ok(fogFarAt(lat) < alwaysLoaded, `latitude ${lat}`);
      assert.ok(alwaysLoaded - fogFarAt(lat) <= 20, `no map hidden for nothing at latitude ${lat}`);
    }
  });
});
