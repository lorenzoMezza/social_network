// Copyright (c) 2026 Lorenzo Mezzabarba. MIT License (see LICENSE).

import polygonClipping from 'polygon-clipping';
import { simplifyLine } from './simplifyLine.js';
import { triangulate } from './polygonGeometry.js';

/**
 * @typedef {Object} BlockMember
 * @property {number[][]} polygon - `[exterior, ...holes]`, flat rings in extent coordinates (exterior with positive area).
 * @property {number} yBase
 * @property {number} yTop
 * @property {number[]} roof  - r, g, b
 * @property {number[]} walls - r, g, b
 *
 * @typedef {Object} Block
 * @property {number[][]} polygon - `[exterior, ...holes]` of the merged outline, simplified.
 * @property {number} yBase
 * @property {number} yTop  - Area-weighted mean of the tops of its buildings.
 * @property {number[]} roof  - Colours of its largest building.
 * @property {number[]} walls
 */

/**
 * Merges buildings that touch or overlap into blocks: the union of their footprints,
 * with its holes (courtyards), simplified by `tolerance`, at one height.
 *
 * Vertices on the clip boundary (`min` / `max` on either axis) are never simplified
 * away: a block cut by a tile edge has the same outline on both sides of it.
 *
 * @param {BlockMember[]} members
 * @param {number} tolerance - Simplification of the outlines (extent units).
 * @param {number} [min=-Infinity] - Clip boundary of the footprints (extent units).
 * @param {number} [max=Infinity]
 * @returns {Block[]|null} `null` when the footprints cannot be merged (degenerate data).
 */
export function mergeBuildingBlocks(members, tolerance, min = -Infinity, max = Infinity) {
    if (members.length === 0) return [];
    let union;
    try {
        union = polygonClipping.union(...members.map(member => member.polygon.map(toPairs)));
    } catch {
        return null;
    }

    const blocks = union.map(polygon => ({
        rings: polygon.map(fromPairs),
        area: 0, top: 0, largest: null, largestArea: -1,
        yBase: members[0].yBase,
    }));

    // Each building lies inside exactly one block: weigh its top by its area.
    for (const member of members) {
        const area = polygonArea(member.polygon);
        if (!(area > 0)) continue;
        const [px, py] = interiorPoint(member.polygon);
        const block = blocks.find(b => insidePolygon(b.rings, px, py));
        if (!block) continue;
        block.area += area;
        block.top  += area * member.yTop;
        if (area > block.largestArea) {
            block.largestArea = area;
            block.largest = member;
        }
    }

    const result = [];
    for (const block of blocks) {
        if (!block.largest) continue;
        const rings = block.rings.map(ring => simplifyRing(ring, tolerance, min, max)).filter(ring => ring.length >= 6);
        if (rings.length === 0) continue;
        result.push({
            polygon: rings,
            yBase:   block.yBase,
            yTop:    block.top / block.area,
            roof:    block.largest.roof,
            walls:   block.largest.walls,
        });
    }
    return result;
}

/** Flat ring → closed list of [x, y] pairs. */
function toPairs(ring) {
    const pairs = [];
    for (let i = 0; i < ring.length; i += 2) pairs.push([ring[i], ring[i + 1]]);
    pairs.push([ring[0], ring[1]]);
    return pairs;
}

/** Closed list of [x, y] pairs → open flat ring. */
function fromPairs(pairs) {
    const ring = [];
    for (let i = 0; i < pairs.length - 1; i++) ring.push(pairs[i][0], pairs[i][1]);
    return ring;
}

/**
 * Simplified ring that keeps every vertex on the clip boundary: the ring is cut
 * into chains between such vertices, and only the chains are simplified.
 */
function simplifyRing(ring, tolerance, min, max) {
    if (!(tolerance > 0)) return ring;
    const n = ring.length / 2;
    const pinned = [];
    for (let i = 0; i < n; i++) {
        const x = ring[2 * i], y = ring[2 * i + 1];
        if (x === min || x === max || y === min || y === max) pinned.push(i);
    }
    let simplified;
    if (pinned.length === 0) {
        simplified = simplifyLine(ring, tolerance);
    } else {
        simplified = [];
        for (let p = 0; p < pinned.length; p++) {
            const from = pinned[p];
            const to   = p + 1 < pinned.length ? pinned[p + 1] : pinned[0] + n;   // wraps around
            const chain = [];
            for (let i = from; i <= to; i++) chain.push(ring[2 * (i % n)], ring[2 * (i % n) + 1]);
            const kept = simplifyLine(chain, tolerance);
            for (let i = 0; i < kept.length - 2; i += 2) simplified.push(kept[i], kept[i + 1]);   // the end starts the next chain
        }
    }
    return simplified.length >= 6 ? simplified : ring;
}

function ringArea(ring) {
    let sum = 0;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) sum += ring[j] * ring[i + 1] - ring[i] * ring[j + 1];
    return sum / 2;
}

function polygonArea(polygon) {
    return polygon.reduce((sum, ring) => sum + ringArea(ring), 0);
}

/** A point strictly inside a polygon: the centroid of its first roof triangle. */
function interiorPoint(polygon) {
    const { flat, indices } = triangulate(polygon);
    if (indices.length < 3) return [polygon[0][0], polygon[0][1]];
    const a = indices[0] * 2, b = indices[1] * 2, c = indices[2] * 2;
    return [(flat[a] + flat[b] + flat[c]) / 3, (flat[a + 1] + flat[b + 1] + flat[c + 1]) / 3];
}

/** Even-odd test against every ring (exterior and holes). */
function insidePolygon(rings, x, y) {
    let inside = false;
    for (const ring of rings) {
        for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
            const yi = ring[i + 1], yj = ring[j + 1];
            if ((yi > y) !== (yj > y) && x < ((ring[j] - ring[i]) * (y - yi)) / (yj - yi) + ring[i]) inside = !inside;
        }
    }
    return inside;
}
