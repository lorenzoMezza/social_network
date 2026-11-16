// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// How the features of the tiles are drawn: to which style layer and type each one
// goes (three-geo-play's MapConfig.tileSchema). What the tiles hold is decided by
// tile-provider/src/rules.mjs, which already leaves out what the map never shows
// (sidewalks, stairs, tunnels, driveways…): this only routes, along the
// OpenMapTiles schema (style layer, then subclass and class as the type).
//
//  - Protected areas (park) are land use, the first in its draw order: every other
//    land use, land cover and water is drawn over them, so they colour only the
//    land nothing else describes (in Rome a sixth of them, the rest lies under
//    woods, fields, towns and the sea).
//  - Railways go to the railway layer, drawn in relief (bed and rails).
//  - Land use grass and parks use the land cover style of the same name.
const LAYERS = new Set(['transportation', 'building', 'water', 'landuse', 'landcover', 'park']);
const RAILS = new Set(['rail', 'transit']);

// One result object reused for every feature (the schema runs for each of them)
const match = { layer: '', type: [undefined, undefined], ramp: false };

export function mapSchema(sourceLayer, p) {
  if (!LAYERS.has(sourceLayer)) return null;
  let layer = sourceLayer;
  if (layer === 'park') layer = 'landuse';
  else if (layer === 'landuse' && (p.class === 'grass' || p.class === 'park')) layer = 'landcover';
  else if (layer === 'transportation' && RAILS.has(p.class)) layer = 'railway';
  match.layer = layer;
  if (sourceLayer === 'park') {
    // national_park and the rest have no style of their own: protected areas
    match.type[0] = p.class;
    match.type[1] = 'protected_area';
  } else {
    match.type[0] = p.subclass;
    match.type[1] = p.class ?? (layer === 'water' ? 'lake' : layer);
  }
  match.ramp = p.ramp === 1 || p.ramp === true;
  return match;
}
