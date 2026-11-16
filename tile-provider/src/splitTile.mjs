// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// A tile cut into its children, `levels` zoom levels deeper: Planetiler stops at
// zoom 15, the map can ask for more (ZOOM, rules.mjs). Smaller tiles let the map
// draw only the ones in view. The children hold exactly the parent's geometry: the
// coordinates are scaled (×2 per level, integers stay integers) and clipped to each
// child plus BUFFER units around it, like the buffer OpenMapTiles leaves (a line
// goes on a little into the neighbouring tile, so the two halves of a road meet;
// the map clips polygons to the tile itself).
//   layers: [{ name, extent, features: [{ type, properties, geometry }] }] (slimTile.mjs)
import { POLYGON } from './rules.mjs';

export const BUFFER = 64;

// → [{ dx, dy, layers }] for the 4^levels children, left to right, top to bottom
// (dx, dy: position of the child inside the parent, 0 … 2^levels - 1)
export function splitLayers(layers, levels) {
  const n = 2 ** levels;
  const children = [];
  for (let dy = 0; dy < n; dy++) {
    for (let dx = 0; dx < n; dx++) {
      children.push({
        dx,
        dy,
        layers: layers.map(({ name, extent, features }) => ({
          name,
          extent,
          features: features.flatMap((feature) => {
            const geometry = childGeometry(feature, extent, n, dx, dy);
            return geometry.length ? [{ ...feature, geometry }] : [];
          }),
        })),
      });
    }
  }
  return children;
}

function childGeometry({ type, geometry }, extent, n, dx, dy) {
  const min = -BUFFER;
  const max = extent + BUFFER;
  const moved = geometry.map((points) => points.map(({ x, y }) => ({ x: x * n - dx * extent, y: y * n - dy * extent })));
  if (type === POLYGON) return moved.map((ring) => clipRing(ring, min, max)).filter(Boolean);
  return moved.flatMap((line) => clipLine(line, min, max));
}

// Sutherland–Hodgman against the square [min, max]²: keeps the winding (outer rings
// and holes stay what they are). Rings come and go closed (last point = first).
function clipRing(ring, min, max) {
  let points = ring.slice(0, -1);
  for (const [axis, bound, keepGreater] of [['x', min, true], ['x', max, false], ['y', min, true], ['y', max, false]]) {
    const inside = (p) => (keepGreater ? p[axis] >= bound : p[axis] <= bound);
    const out = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      if (inside(a)) out.push(a);
      if (inside(a) !== inside(b)) out.push(crossing(a, b, axis, bound));
    }
    points = dedupe(out, true);
    if (points.length < 3) return null;
  }
  if (Math.abs(area(points)) < 1) return null; // only a sliver along the edge is left
  return [...points, points[0]];
}

// The parts of a line inside the square (Liang–Barsky per segment, joined where they continue)
function clipLine(line, min, max) {
  const parts = [];
  let part = null;
  for (let i = 1; i < line.length; i++) {
    const segment = clipSegment(line[i - 1], line[i], min, max);
    if (!segment) {
      part = null;
      continue;
    }
    const [a, b] = segment;
    const last = part?.[part.length - 1];
    if (last && last.x === a.x && last.y === a.y) part.push(b);
    else parts.push((part = [a, b]));
  }
  return parts.map((p) => dedupe(p, false)).filter((p) => p.length > 1);
}

function clipSegment(a, b, min, max) {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  for (const [p, q] of [[-dx, a.x - min], [dx, max - a.x], [-dy, a.y - min], [dy, max - a.y]]) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return null;
  }
  const at = (t) => (t === 0 ? a : t === 1 ? b : { x: Math.round(a.x + dx * t), y: Math.round(a.y + dy * t) });
  return [at(t0), at(t1)];
}

function crossing(a, b, axis, bound) {
  const t = (bound - a[axis]) / (b[axis] - a[axis]);
  const other = axis === 'x' ? 'y' : 'x';
  return { [axis]: bound, [other]: Math.round(a[other] + (b[other] - a[other]) * t) };
}

// Without repeated points; for a ring (closed: true) also without the closing one
// (a closed line, a roundabout, keeps it)
function dedupe(points, closed) {
  const out = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) out.push(p);
  }
  if (closed && out.length > 1 && out[0].x === out[out.length - 1].x && out[0].y === out[out.length - 1].y) out.pop();
  return out;
}

function area(points) {
  let sum = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) sum += (points[j].x - points[i].x) * (points[j].y + points[i].y);
  return sum / 2;
}
