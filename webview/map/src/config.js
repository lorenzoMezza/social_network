// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { CACHE_BUDGETS } from '../../shared/cacheBudgets.js';

export const MAP_CONFIG = {
  // The only tile source: the TileJSON of tile-provider/ (scripts/serve.mjs in
  // development, a server or CDN later), in the page's URL (map.html?tiles=…, see
  // MapWebView): there before any script runs. Not injected: on Android the WebView
  // runs injected scripts after the page's own. window.TILE_URL: the browser dev page.
  // There is no fallback provider: without it the map has no tiles.
  tileUrl: new URLSearchParams(location.search).get('tiles') ?? window.TILE_URL,
  originLatLon: { lat: 41.89656, lon: 12.51526 }, // Rome
  // The only zoom of the tiles of tile-provider/ (ZOOM in its src/rules.mjs): change
  // them together (the map would fall back to the source's zoom, with a warning).
  // Small tiles: the map skips the ones out of view, so it draws less (see its README)
  zoomLevel: 16,
  unitsPerMeter: 1,
};

// Tile cache on the device (shared/httpCache.js): the tiles and the tile source
// document already downloaded are not asked again of the provider. It never holds
// more than TILE_CACHE_MAX_BYTES (shared/cacheBudgets.js, with every other cache of
// the app; the least recently used go first), and whatever
// was downloaded more than TILE_CACHE_MAX_AGE_DAYS ago is deleted, so the map data
// is never older than that.
export const TILE_CACHE_MAX_BYTES = CACHE_BUDGETS.tiles;
export const TILE_CACHE_MAX_AGE_DAYS = 30;


// The map around the view centre (the player, or where the camera flew): its tiles
// are loaded within MAP_RADIUS metres, at every latitude (createMap.js; a tile is
// narrower towards the poles, so the count of tiles changes, not the distance)
export const MAP_RADIUS = 780;
const EARTH_CIRCUMFERENCE = 40075016.686; // metres
// Width of one tile in metres at a latitude
export const tileSizeAt = (lat) => (EARTH_CIRCUMFERENCE * Math.cos((lat * Math.PI) / 180)) / 2 ** MAP_CONFIG.zoomLevel;

// The ground fog starts at FOG_NEAR and grows gently (FOG_CURVE: the power of its
// growth) until it is complete at fogFarAt(): exactly where the loaded map always
// reaches, so it hides no map that is there and never shows where there is none (the
// ragged edge of the tiles, one still loading): the distance reads as air and the end
// of the world never shows (ART-DIRECTION.md). The tiles follow the view centre once
// it moved an eighth of a tile (three-geo-play), so they always reach MAP_RADIUS less
// that; FOG_EDGE_MARGIN is for the tiles coming in while the centre moves on (15 m: a
// second at the speed of a car). It never changes with the weather or the zoom: about
// 700 m (708 in Rome, 727 in Oslo, 690 at the equator).
export const FOG_NEAR = 60;
export const FOG_CURVE = 0.95;
const FOG_EDGE_MARGIN = 15;
export const fogFarAt = (lat) => MAP_RADIUS - tileSizeAt(lat) / 8 - FOG_EDGE_MARGIN;

// Width of the haze band at the horizon, as an angle (radians) below the edge of the
// curved ground: a few pixels on screen, whatever the zoom. The sky's haze climbs
// from the same edge (scene/sky/).
export const HORIZON_BAND = 0.012;

// Fog thickness in metres above the ground: above this height it thins out
export const FOG_HEIGHT = 150;

// Curvature of the world (Pokémon GO style): every vertex drops by
// WORLD_CURVATURE × (horizontal distance from the player)², so the map bends away
// below the horizon instead of ending at a visible edge. It is fixed: the world
// keeps its shape whatever the camera does. Seen from a height h the curved ground
// ends at √(h / WORLD_CURVATURE) metres: HORIZON_DISTANCE from the camera height of
// the default zoom, a little nearer zoomed in (where far distances shrink to a few
// pixels anyway), farther zoomed out; the fog is complete before it (fogFarAt).
const HORIZON_DISTANCE = 1000;
const DEFAULT_CAMERA_HEIGHT = 27;
export const WORLD_CURVATURE = DEFAULT_CAMERA_HEIGHT / (HORIZON_DISTANCE * HORIZON_DISTANCE);
// Slope (below the horizontal) at which the curved map ends, seen from the camera
// height of the default zoom: 2 √(height × curvature). The clouds are drawn down to
// it (scene/clouds/), so the sky meets the map's edge without an empty band
export const MAP_EDGE_SLOPE = 2 * Math.sqrt(DEFAULT_CAMERA_HEIGHT * WORLD_CURVATURE);

// Frame rate target of the map (frames per second): the app's own target, 42. On a
// 60 Hz screen frames then come one or two refreshes apart (17 or 33 ms, 42 a second
// on average); on 90 and 120 Hz screens they are evenly spaced. Every frame also
// leaves the GPU 24 ms (adaptiveResolution.js keeps the density to fit), and a
// higher cap would cost GPU work and battery and make the phone hot enough to throttle.
export const MAX_FPS = 42;

// While the map is not on screen (another screen of the app, page hidden) the
// simulation (GPS easing, weather, tile loading) keeps going at this rate only
export const BACKGROUND_FPS = 4;
