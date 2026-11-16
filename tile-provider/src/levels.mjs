// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Bridges and lowered roads only where they pass over or under something the map
// draws. OSM marks the whole structure (a bridge over a lane that is now in a tunnel,
// a ramp on an embankment…), and the map draws a line of another level over or under
// the roads of level 0: where a bridge joins the road at an angle, its casing cuts
// into the road surface. Here a line keeps its level only within KEEP_M of where it
// crosses a drawn line of another level; the rest is plain road (level 0), which also
// merges with the road it continues (mergeLines.mjs).
//   items: [{ attributes, line }] (lineAttributes of rules.mjs, a line of { x, y })

const KEEP_M = 25;

export function lineLevel(attributes) {
  let level = attributes.layer ?? 0;
  if (attributes.brunnel === 'bridge' && level < 1) level = 1;
  return level;
}

export function flattenLevels(items, metersPerUnit) {
  const raised = items.filter((item) => lineLevel(item.attributes) !== 0);
  if (raised.length === 0) return items;
  const keep = KEEP_M / metersPerUnit;

  // Every segment, in a grid of cells about KEEP_M wide
  const cells = new Map();
  items.forEach((item, owner) => {
    const level = lineLevel(item.attributes);
    const { line } = item;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      for (const key of cellsOf(a, b, keep)) {
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push({ a, b, level, owner });
      }
    }
  });

  const out = [];
  items.forEach((item, owner) => {
    const level = lineLevel(item.attributes);
    if (level === 0) {
      out.push(item);
      return;
    }
    // Distances along the line where it crosses a line of another level (not where
    // two lines only meet at their ends: a bridge joining its road)
    const { line } = item;
    const crossings = [];
    let start = 0;
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1];
      const b = line[i];
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      const seen = new Set();
      for (const key of cellsOf(a, b, keep)) {
        for (const other of cells.get(key) ?? []) {
          if (other.owner === owner || other.level === level || seen.has(other)) continue;
          seen.add(other);
          const t = cut(a, b, other.a, other.b);
          if (t === null) continue;
          const point = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
          if (atEnd(point, line) || atEnd(point, items[other.owner].line)) continue;
          crossings.push(start + t * length);
        }
      }
      start += length;
    }
    const total = start;
    const ground = withoutLevel(item.attributes);
    if (crossings.length === 0) {
      out.push({ attributes: ground, line });
      return;
    }
    // Stretches kept at their level, merged where they overlap
    crossings.sort((x, y) => x - y);
    const stretches = [];
    for (const d of crossings) {
      const from = Math.max(0, d - keep);
      const to = Math.min(total, d + keep);
      const last = stretches[stretches.length - 1];
      if (last && from <= last.to) last.to = Math.max(last.to, to);
      else stretches.push({ from, to });
    }
    let at = 0;
    for (const { from, to } of stretches) {
      if (from > at) out.push({ attributes: ground, line: slice(line, at, from) });
      out.push({ attributes: item.attributes, line: slice(line, from, to) });
      at = to;
    }
    if (at < total) out.push({ attributes: ground, line: slice(line, at, total) });
  });
  return out.filter((item) => item.line.length > 1);
}

function withoutLevel(attributes) {
  const { brunnel, layer, ...rest } = attributes;
  return rest;
}

// Whether a point is one of the two ends of a line (within a unit)
function atEnd(point, line) {
  return [line[0], line[line.length - 1]].some((p) => Math.abs(p.x - point.x) <= 1 && Math.abs(p.y - point.y) <= 1);
}

function cellsOf(a, b, size) {
  const keys = [];
  for (let x = Math.floor(Math.min(a.x, b.x) / size); x <= Math.floor(Math.max(a.x, b.x) / size); x++) {
    for (let y = Math.floor(Math.min(a.y, b.y) / size); y <= Math.floor(Math.max(a.y, b.y) / size); y++) keys.push(`${x},${y}`);
  }
  return keys;
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

// The part of a line between two distances along it (integer coordinates, as in tiles)
function slice(line, from, to) {
  const out = [];
  let start = 0;
  const push = (p) => {
    const q = { x: Math.round(p.x), y: Math.round(p.y) };
    const last = out[out.length - 1];
    if (!last || last.x !== q.x || last.y !== q.y) out.push(q);
  };
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const end = start + length;
    if (end >= from && start <= to && length > 0) {
      const t0 = Math.max(0, (from - start) / length);
      const t1 = Math.min(1, (to - start) / length);
      push({ x: a.x + (b.x - a.x) * t0, y: a.y + (b.y - a.y) * t0 });
      push({ x: a.x + (b.x - a.x) * t1, y: a.y + (b.y - a.y) * t1 });
    }
    start = end;
    if (start > to) break;
  }
  return out;
}
