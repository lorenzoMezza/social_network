// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// What the app's map draws, and so what the tiles keep: everything else is left out.
// These rules decide what reaches the map; the map only routes it to its styles.
// Change them together with:
//   webview/map/src/map/mapSchema.js                          tile features → style types
//   webview/three-geo-play/src/tiles/TileFeatureCollector.js  geometry types per layer
//   webview/three-geo-play/src/style/layers/*.js              types drawn, attributes read

// The only zoom level of the tiles, which the map draws (webview/map/src/config.js,
// MAP_CONFIG.zoomLevel): change them together
export const ZOOM = 16;

// The layers generated (Planetiler --only-layers) and the attributes the map reads.
// park: protected areas (nature reserves, national and regional parks), drawn under
// every other land layer, so they fill only the land nothing else describes; city
// parks are in landcover. Not generated: waterway (not wanted), names, POIs, places,
// boundaries, house numbers, aeroways.
export const LAYERS = {
  water: ['class'],
  landcover: ['class', 'subclass'],
  landuse: ['class'],
  park: ['class'],
  building: ['render_height', 'render_min_height'],
  transportation: ['class', 'subclass', 'ramp', 'brunnel', 'layer'],
};

export const POINT = 1;
export const LINE = 2;
export const POLYGON = 3;

// Transportation draws lines only; every other layer polygons only
export const drawnGeometry = (layer, type) => (layer === 'transportation' ? type === LINE : type === POLYGON);

// The line types of TransportationLayer.js drawn by the app, and those it never shows
const DRAWN_LINES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service', 'track', 'path', 'pedestrian']);
const HIDDEN_LINES = new Set([
  'motorway_construction', 'trunk_construction', 'primary_construction', 'secondary_construction',
  'tertiary_construction', 'minor_construction', 'service_construction', 'track_construction',
  'path_construction', 'raceway', 'raceway_construction', 'busway', 'bus_guideway', 'pier', 'ferry',
]);
// Railways (all their subclasses: rail, light rail, subway, tram…), drawn in relief
// by the RailwayLayer of three-geo-play
const RAIL_CLASSES = new Set(['rail', 'transit']);
// Stairs, corridors inside buildings, railway platforms
const HIDDEN_PATHS = new Set(['steps', 'corridor', 'platform']);
// Footways, cycleways and bridleways are paths, except along a road: sidewalks, cycle
// lanes and crossings (sidewalks.mjs, applied by slimTile.mjs)
const ALONG_ROAD_PATHS = new Set(['footway', 'cycleway', 'bridleway']);
// Driveways, parking aisles, drive-throughs, emergency accesses (private roads are kept)
const HIDDEN_SERVICES = new Set(['driveway', 'parking_aisle', 'drive-through', 'emergency_access']);

// A line is drawn as its subclass, else its class, whichever the style knows first
const lineType = (p) => [p.subclass, p.class].find((name) => DRAWN_LINES.has(name) || HIDDEN_LINES.has(name));

const isRail = (p) => RAIL_CLASSES.has(p.class);

// A path that is left out when it runs along a road
export const mayRunAlongRoad = (p) => p.class === 'path' && ALONG_ROAD_PATHS.has(p.subclass);

// Under ground and inside buildings nothing is seen from above
export function drawnLine(p) {
  if (p.brunnel === 'tunnel' || p.indoor === 1 || p.indoor === true) return false;
  if (isRail(p)) return true;
  if (p.class === 'path' && HIDDEN_PATHS.has(p.subclass)) return false;
  if (p.class === 'service' && HIDDEN_SERVICES.has(p.service)) return false;
  return DRAWN_LINES.has(lineType(p));
}

// A drawn line's attributes, reduced to what changes how it looks: fewer distinct
// values, so more segments are identical and merge (mergeLines.mjs)
export function lineAttributes(p) {
  const out = { class: p.class };
  // e.g. pedestrian streets; every railway keeps its kind (tram, subway…)
  if (DRAWN_LINES.has(p.subclass) || (isRail(p) && p.subclass)) out.subclass = p.subclass;
  if (p.ramp === 1 || p.ramp === true) out.ramp = 1;
  if (p.brunnel === 'bridge') out.brunnel = 'bridge';
  const layer = Math.round(Number(p.layer));
  if (layer) out.layer = layer;
  return out;
}

// Building parts that start this high above the ground (render_min_height) are left
// out: canopies, footbridges, decks over roads, upper floors over an outline. The map
// extrudes every footprint from the ground (simpleExtrusion), so they would stand on
// the street as blocks of glass; over a building, its outline covers them anyway
const RAISED_PART_M = 3;
export const drawnBuilding = (p) => !(Number(p.render_min_height) >= RAISED_PART_M);

// Protected areas by kind; the many local designations (regional laws, natural
// monuments…) are all protected areas
const PARK_CLASSES = new Set(['national_park', 'nature_reserve']);

export function polygonAttributes(layer, p) {
  if (layer === 'park') return { class: PARK_CLASSES.has(p.class) ? p.class : 'protected_area' };
  const out = {};
  for (const key of LAYERS[layer]) if (p[key] !== undefined && p[key] !== null) out[key] = p[key];
  if (out.render_min_height === 0) delete out.render_min_height; // the map's default
  return out;
}
