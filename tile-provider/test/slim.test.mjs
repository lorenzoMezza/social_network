// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { encodeTile } from '../src/encodeTile.mjs';
import { mergeLines } from '../src/mergeLines.mjs';
import { LINE, POINT, POLYGON } from '../src/rules.mjs';
import { slimTile } from '../src/slimTile.mjs';
import { tileMeters } from '../src/sidewalks.mjs';

const line = (...xs) => xs.map(([x, y]) => ({ x, y }));
const decode = (bytes) => new VectorTile(new PbfReader(bytes));
// Every segment of the lines, without direction: what the map draws
const segments = (lines) => lines.flatMap((points) => points.slice(1).map((point, i) => {
  const a = `${points[i].x},${points[i].y}`;
  const b = `${point.x},${point.y}`;
  return a < b ? `${a}-${b}` : `${b}-${a}`;
})).sort();

describe('mergeLines', () => {
  it('joins segments that continue each other, whatever their order and direction', () => {
    const merged = mergeLines([line([2, 0], [3, 0]), line([1, 0], [0, 0]), line([1, 0], [2, 0])]);
    assert.equal(merged.length, 1);
    assert.deepEqual(segments(merged), segments([line([0, 0], [1, 0], [2, 0], [3, 0])]));
  });

  it('leaves junctions of three or more lines as they are', () => {
    const lines = [line([0, 0], [1, 0]), line([1, 0], [2, 0]), line([1, 0], [1, 1])];
    const merged = mergeLines(lines);
    assert.equal(merged.length, 3);
    assert.deepEqual(segments(merged), segments(lines));
  });

  it('keeps loops closed (roundabouts)', () => {
    const merged = mergeLines([line([0, 0], [1, 0]), line([1, 0], [1, 1]), line([1, 1], [0, 0])]);
    assert.equal(merged.length, 1);
    assert.deepEqual(merged[0][0], merged[0].at(-1));
    assert.equal(merged[0].length, 4);
  });

  it('draws exactly the same segments on a random network', () => {
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) % 6;
    const lines = Array.from({ length: 400 }, () => {
      const points = [{ x: random(), y: random() }];
      for (let i = 0; i < 1 + (random() % 3); i++) points.push({ x: random(), y: random() });
      return points;
    });
    assert.deepEqual(segments(mergeLines(lines)), segments(lines));
  });
});

describe('encodeTile', () => {
  it('writes what @mapbox/vector-tile reads back', () => {
    const square = [line([0, 0], [10, 0], [10, 10], [0, 10], [0, 0])];
    const hole = line([2, 2], [2, 8], [8, 8], [8, 2], [2, 2]);
    const bytes = encodeTile([
      { name: 'building', extent: 4096, features: [{ type: POLYGON, properties: { render_height: 12.5, render_min_height: 3 }, geometry: [square[0], hole] }] },
      { name: 'transportation', extent: 4096, features: [{ type: LINE, properties: { class: 'minor', layer: -1, ramp: 1, flag: true }, geometry: [line([5, 5], [-20, 4100])] }] },
    ]);
    const tile = decode(bytes);
    const building = tile.layers.building.feature(0);
    assert.deepEqual({ ...building.properties }, { render_height: 12.5, render_min_height: 3 });
    assert.deepEqual(building.loadGeometry().map((ring) => ring.map(({ x, y }) => [x, y])), [square[0], hole].map((ring) => ring.map(({ x, y }) => [x, y])));
    const road = tile.layers.transportation.feature(0);
    assert.deepEqual({ ...road.properties }, { class: 'minor', layer: -1, ramp: 1, flag: true });
    assert.deepEqual(road.loadGeometry()[0].map(({ x, y }) => [x, y]), [[5, 5], [-20, 4100]]);
    assert.equal(tile.layers.transportation.extent, 4096);
  });
});

describe('slimTile', () => {
  const raw = encodeTile([
    { name: 'transportation', extent: 4096, features: [
      // one street in two pieces that OpenMapTiles kept apart (oneway, surface)
      { type: LINE, properties: { class: 'minor', oneway: 1, surface: 'paved' }, geometry: [line([0, 0], [100, 0])] },
      { type: LINE, properties: { class: 'minor', surface: 'unpaved', access: 'yes' }, geometry: [line([100, 0], [200, 0])] },
      { type: LINE, properties: { class: 'path', subclass: 'pedestrian' }, geometry: [line([0, 50], [50, 50])] },
      // a sidewalk, 10 m beside the street, and a crossing over it: along the road
      { type: LINE, properties: { class: 'path', subclass: 'footway' }, geometry: [line([0, 10], [100, 10])] },
      { type: LINE, properties: { class: 'path', subclass: 'footway' }, geometry: [line([150, -8], [150, 8])] },
      // a path through a park, far from any road, and a cycleway along nothing
      { type: LINE, properties: { class: 'path', subclass: 'footway' }, geometry: [line([1000, 1000], [1000, 1200])] },
      { type: LINE, properties: { class: 'path', subclass: 'cycleway' }, geometry: [line([2000, 1000], [2000, 1200])] },
      { type: LINE, properties: { class: 'path', subclass: 'steps' }, geometry: [line([3000, 1000], [3000, 1200])] },
      { type: LINE, properties: { class: 'rail', subclass: 'subway' }, geometry: [line([0, 20], [100, 20])] },
      { type: LINE, properties: { class: 'primary', brunnel: 'tunnel', layer: -1 }, geometry: [line([0, 30], [100, 30])] },
      { type: LINE, properties: { class: 'primary', brunnel: 'bridge', layer: 1 }, geometry: [line([0, 40], [100, 40])] },
      { type: LINE, properties: { class: 'service', service: 'driveway' }, geometry: [line([0, 60], [10, 60])] },
      // a private road and a country track
      { type: LINE, properties: { class: 'service', access: 'no' }, geometry: [line([500, 3000], [600, 3000])] },
      { type: LINE, properties: { class: 'track' }, geometry: [line([500, 3500], [600, 3500])] },
      { type: LINE, properties: { class: 'rail', subclass: 'rail', brunnel: 'tunnel', layer: -1 }, geometry: [line([0, 70], [100, 70])] },
      { type: POLYGON, properties: { class: 'path', subclass: 'pedestrian' }, geometry: [line([0, 0], [9, 0], [9, 9], [0, 0])] },
    ] },
    { name: 'building', extent: 4096, features: [
      { type: POLYGON, properties: { render_height: 20, render_min_height: 0, hide_3d: true, colour: '#fff' }, geometry: [line([0, 0], [9, 0], [9, 9], [0, 0])] },
      // a canopy over a street, 4 m above it
      { type: POLYGON, properties: { render_height: 6, render_min_height: 4 }, geometry: [line([20, 0], [29, 0], [29, 9], [20, 0])] },
    ] },
    { name: 'waterway', extent: 4096, features: [{ type: LINE, properties: { class: 'river' }, geometry: [line([0, 0], [9, 9])] }] },
    { name: 'park', extent: 4096, features: [
      { type: POLYGON, properties: { class: 'dgr_2146/1996', name: 'Riserva' }, geometry: [line([0, 0], [9, 0], [9, 9], [0, 0])] },
      { type: POLYGON, properties: { class: 'national_park', rank: 1 }, geometry: [line([0, 0], [9, 0], [9, 9], [0, 0])] },
    ] },
    { name: 'poi', extent: 4096, features: [{ type: POINT, properties: { name: 'Bar' }, geometry: [line([3, 3])] }] },
  ].map((layer) => ({ ...layer, features: layer.features.filter((f) => f.type !== POINT) })));

  // 4096 m wide: one metre per tile unit
  const tile = decode(slimTile(raw, { tileMeters: 4096 }).bytes);
  const features = (name) => Array.from({ length: tile.layers[name]?.length ?? 0 }, (_, i) => tile.layers[name].feature(i));

  it('keeps only the layers the map draws', () => {
    assert.deepEqual(Object.keys(tile.layers).sort(), ['building', 'park', 'transportation']);
  });

  it('keeps only the roads the map draws, with the attributes it reads', () => {
    const roads = features('transportation').map((f) => ({ ...f.properties }));
    assert.deepEqual(roads, [
      { class: 'minor' }, { class: 'path', subclass: 'pedestrian' },
      { class: 'path' },                                         // the park path and the cycleway, as paths
      { class: 'rail', subclass: 'subway' },                     // railways stay, with their kind
      { class: 'primary' },                                      // a bridge over nothing drawn: plain road (levels.mjs)
      { class: 'service' }, { class: 'track' },                  // private roads and tracks too
    ]);
  });

  it('leaves out the footways along the roads (sidewalks, crossings), keeps the others', () => {
    const paths = features('transportation').filter((f) => f.properties.class === 'path' && !f.properties.subclass);
    const xs = paths.flatMap((f) => f.loadGeometry().map((part) => part[0].x)).sort((a, b) => a - b);
    assert.deepEqual(xs, [1000, 2000]);
  });

  it('keeps protected areas, the local designations as protected_area', () => {
    assert.deepEqual(features('park').map((f) => ({ ...f.properties })), [{ class: 'protected_area' }, { class: 'national_park' }]);
  });

  it('joins the pieces of the same street', () => {
    const [street] = features('transportation');
    assert.deepEqual(street.loadGeometry().map((part) => part.map(({ x, y }) => [x, y])), [[[0, 0], [100, 0], [200, 0]]]);
  });

  it('keeps every building on the ground, outlines with building parts included (not parts raised 3 m or more)', () => {
    assert.deepEqual(features('building').map((f) => ({ ...f.properties })), [{ render_height: 20 }]);
  });
});

describe('tileMeters', () => {
  it('is the width of a tile at its latitude', () => {
    // zoom 14 at the equator: 40 075 km / 16 384
    assert.ok(Math.abs(tileMeters(14, 2 ** 13) - 2446) < 1);
    // the TMS row of Rome (zoom 14, XYZ y 6087): about 1.8 km
    assert.ok(Math.abs(tileMeters(14, 2 ** 14 - 1 - 6087) - 1818) < 5);
  });
});
