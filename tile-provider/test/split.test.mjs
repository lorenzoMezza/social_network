// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { LINE, POLYGON } from '../src/rules.mjs';
import { BUFFER, splitLayers } from '../src/splitTile.mjs';

const E = 4096;
const pts = (...xs) => xs.map(([x, y]) => ({ x, y }));
const xy = (points) => points.map(({ x, y }) => [x, y]);
const layer = (features) => [{ name: 'test', extent: E, features }];
const child = (children, dx, dy) => children.find((c) => c.dx === dx && c.dy === dy).layers[0].features;
const area = (ring) => {
  let sum = 0;
  for (let i = 0; i + 1 < ring.length; i++) sum += (ring[i].x - ring[i + 1].x) * (ring[i].y + ring[i + 1].y);
  return sum / 2;
};

describe('splitLayers', () => {
  it('gives the four children of a tile, left to right, top to bottom', () => {
    assert.deepEqual(splitLayers(layer([]), 1).map(({ dx, dy }) => [dx, dy]), [[0, 0], [1, 0], [0, 1], [1, 1]]);
  });

  it('cuts a line where it crosses into the next child, a buffer beyond the edge', () => {
    // From the left half into the right half, along y = 1000
    const children = splitLayers(layer([{ type: LINE, properties: { class: 'minor' }, geometry: [pts([1000, 1000], [3000, 1000])] }]), 1);
    const [left] = child(children, 0, 0);
    const [right] = child(children, 1, 0);
    assert.deepEqual(xy(left.geometry[0]), [[2000, 2000], [E + BUFFER, 2000]]);
    assert.deepEqual(xy(right.geometry[0]), [[-BUFFER, 2000], [3000 * 2 - E, 2000]]);
    assert.deepEqual(left.properties, { class: 'minor' });
    assert.equal(child(children, 0, 1).length, 0, 'nothing in the children it does not reach');
  });

  it('keeps a closed line (a roundabout) closed', () => {
    const loop = pts([100, 100], [300, 100], [300, 300], [100, 300], [100, 100]);
    const [inside] = child(splitLayers(layer([{ type: LINE, properties: {}, geometry: [loop] }]), 1), 0, 0);
    const line = inside.geometry[0];
    assert.deepEqual(xy([line[0]]), xy([line[line.length - 1]]));
    assert.equal(line.length, 5);
  });

  it('clips polygons to each child with the buffer, keeping holes as holes', () => {
    // The whole tile, with a hole in its top-left quarter
    const outer = pts([0, 0], [E, 0], [E, E], [0, E], [0, 0]);
    const hole = pts([500, 500], [500, 1500], [1500, 1500], [1500, 500], [500, 500]);
    const children = splitLayers(layer([{ type: POLYGON, properties: { class: 'grass' }, geometry: [outer, hole] }]), 1);
    const [topLeft] = child(children, 0, 0);
    assert.equal(topLeft.geometry.length, 2);
    const [childOuter, childHole] = topLeft.geometry;
    assert.equal(Math.sign(area(childOuter)), Math.sign(area(outer)), 'outer ring winding kept');
    assert.equal(Math.sign(area(childHole)), Math.sign(area(hole)), 'hole winding kept');
    // The outer ring, scaled ×2, cut at the child plus its buffer
    assert.equal(Math.abs(area(childOuter)), (E + BUFFER) * (E + BUFFER));
    assert.equal(child(children, 1, 1)[0].geometry.length, 1, 'no hole in the bottom-right child');
  });

  it('covers the parent exactly: without the buffers, the children add up to its area', () => {
    const square = pts([300, 700], [3900, 300], [3500, 3800], [200, 3500], [300, 700]);
    const children = splitLayers(layer([{ type: POLYGON, properties: {}, geometry: [square] }]), 1);
    const inner = (ring) => {
      // The part of a child's ring inside the child itself (0 … E), by sampling a fine grid
      let count = 0;
      for (let x = 8; x < E; x += 16) for (let y = 8; y < E; y += 16) {
        let c = false;
        for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
          const a = ring[i], b = ring[j];
          if ((a.y > y) !== (b.y > y) && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) c = !c;
        }
        if (c) count++;
      }
      return count * 16 * 16;
    };
    const total = children.reduce((sum, c) => sum + (c.layers[0].features[0] ? inner(c.layers[0].features[0].geometry[0]) : 0), 0) / 4;
    assert.ok(Math.abs(total - Math.abs(area(square))) / Math.abs(area(square)) < 0.01);
  });
});
