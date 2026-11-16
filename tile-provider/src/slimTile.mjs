// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// One tile as Planetiler makes it (OpenMapTiles schema) → only what the map draws
// (rules.mjs), with the footways along the roads left out (sidewalks.mjs), bridges
// only where they pass over something drawn (levels.mjs) and the roads that continue
// each other joined (mergeLines.mjs).
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { encodeTile } from './encodeTile.mjs';
import { mergeLines } from './mergeLines.mjs';
import { LAYERS, LINE, drawnBuilding, drawnGeometry, drawnLine, lineAttributes, mayRunAlongRoad, polygonAttributes } from './rules.mjs';
import { ROAD_CLASSES, alongRoads, roadIndex } from './sidewalks.mjs';
import { flattenLevels } from './levels.mjs';

const plain = (geometry) => geometry.map((ring) => ring.map(({ x, y }) => ({ x, y })));

// The tile encoded again (bytes empty when nothing is left)
export function slimTile(bytes, options) {
  const slim = slimLayers(bytes, options);
  return { ...slim, bytes: encodeTile(slim.layers) };
}

// The layers left, not encoded yet (they may be cut into smaller tiles, splitTile.mjs).
// tileMeters: width of the tile in metres (sidewalks.mjs tileMeters)
export function slimLayers(bytes, { tileMeters }) {
  const tile = new VectorTile(new PbfReader(bytes));
  const layers = [];
  let before = 0;
  for (const name of Object.keys(tile.layers)) before += tile.layers[name].length;

  for (const name of Object.keys(LAYERS)) {
    const layer = tile.layers[name];
    if (!layer) continue;
    const features = [];
    let lines = []; // transportation: [{ attributes, line }]
    const metersPerUnit = tileMeters / layer.extent;
    const index = name === 'transportation' ? roadIndex(roadLines(layer), metersPerUnit) : null;
    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);
      if (!drawnGeometry(name, feature.type)) continue;
      const p = feature.properties;
      if (name === 'transportation') {
        if (!drawnLine(p)) continue;
        if (mayRunAlongRoad(p) && alongRoads(plain(feature.loadGeometry()), index, metersPerUnit)) continue;
        const attributes = lineAttributes(p);
        for (const line of plain(feature.loadGeometry())) if (line.length > 1) lines.push({ attributes, line });
      } else if (name !== 'building' || drawnBuilding(p)) {
        features.push({ type: feature.type, properties: polygonAttributes(name, p), geometry: plain(feature.loadGeometry()) });
      }
    }
    lines = flattenLevels(lines, metersPerUnit);
    const roads = new Map(); // attributes → lines: one feature each, like OpenMapTiles
    for (const { attributes, line } of lines) {
      const group = JSON.stringify(attributes);
      if (!roads.has(group)) roads.set(group, { attributes, lines: [] });
      roads.get(group).lines.push(line);
    }
    for (const { attributes, lines: group } of roads.values()) {
      features.push({ type: LINE, properties: attributes, geometry: mergeLines(group) });
    }
    layers.push({ name, extent: layer.extent, features });
  }

  const after = layers.reduce((sum, layer) => sum + layer.features.length, 0);
  return { layers, before, after };
}

// The roads a sidewalk can run along: above ground (the paths of a park over a road
// tunnel are not sidewalks)
function roadLines(layer) {
  const lines = [];
  for (let i = 0; i < layer.length; i++) {
    const feature = layer.feature(i);
    const p = feature.properties;
    if (feature.type === LINE && ROAD_CLASSES.has(p.class) && p.brunnel !== 'tunnel') lines.push(...plain(feature.loadGeometry()));
  }
  return lines;
}
