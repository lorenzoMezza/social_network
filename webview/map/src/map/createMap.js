// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { ThreeGeoPlay } from 'lm-three-geo-play';
import { MAP_CONFIG, MAP_RADIUS, TILE_CACHE_MAX_AGE_DAYS, TILE_CACHE_MAX_BYTES, WORLD_CURVATURE, tileSizeAt } from '../config.js';
import { applyTheme } from './themes/index.js';
import { mapSchema } from './mapSchema.js';
import { createHttpCache } from '../../../shared/httpCache.js';

// The world bends in the vertex shader (horizontalFog.js), which moves vertices only:
// an edge stays straight between them, at most WORLD_CURVATURE × (length / 2)² below
// the bent ground. Edges no longer than this stay within CURVE_TOLERANCE of it, so
// long straight roads and large areas meet their neighbours (a 1 km edge would sink
// almost 7 m in the middle)
const CURVE_TOLERANCE = 0.05; // metres
export const MAX_SEGMENT_METERS = 2 * Math.sqrt(CURVE_TOLERANCE / WORLD_CURVATURE);

// Loads the tiles within MAP_RADIUS of the player (a circle around its exact position)
export function createMap(scene, renderCamera, renderer, player, { startImmediately = true } = {}) {
  const geo = new ThreeGeoPlay(scene, renderCamera, renderer, {
    ...MAP_CONFIG,
    renderDistance: MAP_RADIUS / tileSizeAt(MAP_CONFIG.originLatLon.lat),
    followUpdateInterval: 0,
    maxSegmentMeters: MAX_SEGMENT_METERS,
    // The ground, the land, the roads' edges and the roads lie one over the other, and
    // every one of them runs the scene's whole shader (fog, grade, weather: horizontalFog.js)
    // on its pixels, also where a layer above then covers them. Drawn the other way round,
    // the topmost first, each pixel is shaded once: the same picture, for a third of the
    // work on the phones whose GPU does not drop hidden pixels by itself (most Android
    // ones; Apple's do, and lose nothing)
    flatLayersFrontToBack: true,
    // Which style draws each feature (what reaches the map: tile-provider/src/rules.mjs)
    tileSchema: mapSchema,
    // Tiles already downloaded come from the device (shared/httpCache.js)
    fetch: createHttpCache({ name: 'map-tile-cache', label: 'Tile cache', maxBytes: TILE_CACHE_MAX_BYTES, maxAgeDays: TILE_CACHE_MAX_AGE_DAYS }).fetch,
  });
  // The camera is only the render/picking camera. Both the initial tile center
  // and subsequent tile selection follow the player's world position.
  geo.setFollowTarget(player);

  applyTheme(geo, scene);

  geo.addEventListener('sourceerror', ({ error }) => console.error(error.message));
  if (startImmediately) geo.start();

  return geo;
}

// Moves the map's geographic origin (the first GPS fix, a long journey, a teleport),
// keeping the loaded radius MAP_RADIUS metres there: the library counts it in tiles,
// and a tile is narrower towards the poles (counted at Rome's latitude, Oslo's map
// reached 530 m, under the fog's 700: the empty ground beyond showed)
export function moveMapOrigin(geo, latitude, longitude) {
  geo.moveMapOriginToLatLon(latitude, longitude);
  geo.getMapConfig().renderDistance = MAP_RADIUS / tileSizeAt(latitude);
}
