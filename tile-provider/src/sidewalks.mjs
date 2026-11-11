// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Footways and cycleways mapped along a road: sidewalks, cycle lanes, crossings.
// OpenMapTiles does not carry OSM's footway=sidewalk / crossing, so the geometry tells
// them from the paths of parks, squares and the countryside, and from the short
// footways that join a street to the next one (kept: they connect the network):
//  - a sidewalk runs beside a road and along it: SHARE of its length lies within
//    NEAR_M of a road and parallel to it (within PARALLEL_DEG);
//  - a crossing is short (up to CROSSING_M) and goes across a road, or (often mapped
//    in two halves, each ending on the road) it is a stub of up to STUB_M ending on one.

// Measured against the OSM tags (Overpass, 2026-10) in Villa Borghese, Prati and
// Monte Mario: 89 / 86 / 91 % of the sidewalks and crossings left out, 87 / 75 / 85 %
// of the other footways and cycleways kept (in Prati many untagged footways are
// sidewalks too). Without the parallel test: 89 / 86 / 94 % and 85 / 70 / 83 %, and
// the footways joining two streets were lost (Via Cardinal Mistrangelo, Rome).

const NEAR_M = 12;
const SHARE = 0.7;
const PARALLEL_DEG = 45;
const CROSSING_M = 30;
const STUB_M = 10;
const STEP_M = 2;

// The roads a sidewalk can run along (not paths, tracks or railways)
export const ROAD_CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service']);

// lines: [{ x, y }][] of one tile; metersPerUnit: metres per tile unit at this tile
export function roadIndex(lines, metersPerUnit) {
  const cell = NEAR_M / metersPerUnit;
  const cells = new Map();
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      const x0 = Math.floor(Math.min(a.x, b.x) / cell);
      const x1 = Math.floor(Math.max(a.x, b.x) / cell);
      const y0 = Math.floor(Math.min(a.y, b.y) / cell);
      const y1 = Math.floor(Math.max(a.y, b.y) / cell);
      for (let cx = x0; cx <= x1; cx++) {
        for (let cy = y0; cy <= y1; cy++) {
          const key = `${cx},${cy}`;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(a, b);
        }
      }
    }
  }
  return { cell, cells };
}

// Whether a way (its lines) is a sidewalk or a crossing of the roads of the index
export function alongRoads(lines, { cell, cells }, metersPerUnit) {
  const step = STEP_M / metersPerUnit;
  const parallel = Math.cos((PARALLEL_DEG * Math.PI) / 180);
  let samples = 0;
  let beside = 0;
  let length = 0;
  for (const line of lines) {
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      const segment = Math.hypot(b.x - a.x, b.y - a.y);
      length += segment;
      if (segment === 0) continue;
      const ux = (b.x - a.x) / segment;
      const uy = (b.y - a.y) / segment;
      const n = Math.max(1, Math.ceil(segment / step));
      for (let k = i === 1 ? 0 : 1; k <= n; k++) {
        samples++;
        const road = nearestRoad(a.x + ((b.x - a.x) * k) / n, a.y + ((b.y - a.y) * k) / n, cell, cells);
        if (!road) continue;
        const rx = road[1].x - road[0].x;
        const ry = road[1].y - road[0].y;
        const rl = Math.hypot(rx, ry);
        if (rl > 0 && Math.abs((ux * rx + uy * ry) / rl) >= parallel) beside++;
      }
    }
  }
  if (samples > 0 && beside / samples >= SHARE) return true;
  const meters = length * metersPerUnit;
  if (meters <= STUB_M && lines.some((line) => endsOnRoad(line, cell, cells, 1 / metersPerUnit))) return true;
  return meters <= CROSSING_M && lines.some((line) => crossesRoad(line, cell, cells));
}

// Whether one end of the line lies on a road (within `tolerance`)
function endsOnRoad(line, cell, cells, tolerance) {
  return [line[0], line[line.length - 1]].some((p) => {
    const road = nearestRoad(p.x, p.y, cell, cells);
    return road !== null && distance(p.x, p.y, road[0], road[1]) <= tolerance;
  });
}

// The road segment nearest to (x, y) within the cell size (NEAR_M), or null.
// The cells are NEAR_M wide: a road within NEAR_M is in this cell or a neighbour
function nearestRoad(x, y, cell, cells) {
  const cx = Math.floor(x / cell);
  const cy = Math.floor(y / cell);
  let best = null;
  let bestDistance = cell;
  for (let dx = -1; dx <= 1; dx++) {
    for (let dy = -1; dy <= 1; dy++) {
      const segments = cells.get(`${cx + dx},${cy + dy}`);
      if (!segments) continue;
      for (let i = 0; i < segments.length; i += 2) {
        const d = distance(x, y, segments[i], segments[i + 1]);
        if (d <= bestDistance) {
          bestDistance = d;
          best = [segments[i], segments[i + 1]];
        }
      }
    }
  }
  return best;
}

// Whether the line goes across a road: a road segment cuts it away from its ends
function crossesRoad(line, cell, cells) {
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const seen = new Set();
    for (let x = Math.floor(Math.min(a.x, b.x) / cell); x <= Math.floor(Math.max(a.x, b.x) / cell); x++) {
      for (let y = Math.floor(Math.min(a.y, b.y) / cell); y <= Math.floor(Math.max(a.y, b.y) / cell); y++) {
        const segments = cells.get(`${x},${y}`) ?? [];
        for (let k = 0; k < segments.length; k += 2) {
          if (seen.has(segments[k])) continue;
          seen.add(segments[k]);
          const t = cut(a, b, segments[k], segments[k + 1]);
          // Not at the line's own ends: a footway ending on a road joins it, it does not cross it
          const first = i === 1 && t < 0.05;
          const last = i === line.length - 1 && t > 0.95;
          if (t !== null && !first && !last) return true;
        }
      }
    }
  }
  return false;
}

// Parameter along AB (0–1) where it crosses segment CD, or null
function cut(a, b, c, d) {
  const rx = b.x - a.x, ry = b.y - a.y, sx = d.x - c.x, sy = d.y - c.y;
  const denom = rx * sy - ry * sx;
  if (denom === 0) return null;
  const t = ((c.x - a.x) * sy - (c.y - a.y) * sx) / denom;
  const u = ((c.x - a.x) * ry - (c.y - a.y) * rx) / denom;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : null;
}

function distance(x, y, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length2 = dx * dx + dy * dy;
  const t = length2 === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / length2));
  return Math.hypot(x - (a.x + t * dx), y - (a.y + t * dy));
}

// Width in metres of a tile, at its centre (TMS row, as MBTiles stores it)
export function tileMeters(zoom, tmsRow) {
  const y = 2 ** zoom - 1 - tmsRow + 0.5;
  const latitude = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / 2 ** zoom)));
  return (40075016.686 * Math.cos(latitude)) / 2 ** zoom;
}
