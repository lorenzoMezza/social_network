// Copyright (c) 2026 Lorenzo Mezzabarba. MIT License (see LICENSE).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { MapStyle } from '../src/index.js';
import { mergeBuildingBlocks } from '../src/geometry/buildingBlocks.js';
import { serveTiles, loadMap, settle } from './helpers.js';

const square = (x0, y0, x1, y1) => [[x0, y0, x1, y0, x1, y1, x0, y1]];   // positive area
const member = (polygon, yTop) => ({ polygon, yBase: 0, yTop, roof: [1, 1, 1], walls: [1, 1, 1] });

test('attached buildings become one block, at the area-weighted mean height', () => {
    const blocks = mergeBuildingBlocks([member(square(0, 0, 10, 10), 10), member(square(10, 0, 20, 10), 30)], 0.5);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].yTop, 20);
    assert.equal(blocks[0].polygon.length, 1, 'no hole');
    assert.equal(blocks[0].polygon[0].length, 8, 'a single rectangle: the shared corners are simplified away');
});

test('buildings around a courtyard become a block with a hole', () => {
    const blocks = mergeBuildingBlocks([
        member(square(0, 0, 30, 10), 12), member(square(0, 20, 30, 30), 12),
        member(square(0, 10, 10, 20), 12), member(square(20, 10, 30, 20), 12),
    ], 0.5);
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].polygon.length, 2, 'outline and courtyard');
});

test('separate buildings stay separate blocks', () => {
    const blocks = mergeBuildingBlocks([member(square(0, 0, 10, 10), 10), member(square(20, 0, 30, 10), 30)], 0.5);
    assert.deepEqual(blocks.map(b => b.yTop).sort(), [10, 30]);
});

let server;
before(async () => { server = await serveTiles(); });
after(() => server.close());

/** Vertices of the building geometry on screen. */
function buildingVertexCount(scene) {
    let count = 0;
    scene.traverse(object => {
        if (!object.isMesh || object.userData.kind !== 'building') return;
        if (!object.isBatchedMesh) { count += object.geometry.attributes.position.count; return; }
        for (const info of object._geometryInfo) if (info.active) count += info.vertexCount;
    });
    return count;
}

test('mergeBlocks draws less building geometry than simpleExtrusion alone', async () => {
    const { geo, scene } = await loadMap(server.url);
    const style = new MapStyle();
    style.buildingLayer.simpleExtrusion = true;
    geo.setMapStyle(style);
    await settle(geo);
    const simple = buildingVertexCount(scene);

    const merged = style.clone();
    merged.buildingLayer.mergeBlocks = true;
    assert.equal(merged.buildingLayer.mergeBlocks, true, 'copied by clone()');
    geo.setMapStyle(merged);
    await settle(geo);
    const blocks = buildingVertexCount(scene);

    assert.ok(blocks > 0 && blocks < simple, `${blocks} < ${simple} vertices`);
    geo.destroy();
});

test('outline vertices on the tile edge are kept, so both sides of a cut match', () => {
    // A block cut by the tile edge x = 100, leaving it at a shallow angle: plain simplification
    // would drop (100, 2) and move where the outline meets the edge.
    const polygon = [[50, 0, 100, 0, 100, 2, 50, 3]];
    const [block] = mergeBuildingBlocks([member(polygon, 10)], 5, -1, 100);
    const ring = block.polygon[0];
    const onEdge = [];
    for (let i = 0; i < ring.length; i += 2) if (ring[i] === 100) onEdge.push(ring[i + 1]);
    assert.deepEqual(onEdge.sort((a, b) => a - b), [0, 2]);
});
