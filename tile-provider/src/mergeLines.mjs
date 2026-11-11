// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Joins the lines that continue each other: where exactly two lines end at the same
// point. Junctions (three or more ends), dead ends and lines that only cross stay as
// they are. The output has the same points in the same order, so the map draws the
// same roads; only where two segments met, a join replaces two overlapping caps.
// OpenMapTiles does the same (Planetiler's FeatureMerge.mergeLineStrings) on lines
// with identical attributes, the only ones given here.
//   lines: [[{ x, y }, …], …] in tile coordinates (integers)
export function mergeLines(lines) {
  const key = (point) => `${point.x},${point.y}`;
  const ends = new Map(); // point → indices of the lines ending there (twice for a closed line)
  const addEnd = (point, index) => {
    const list = ends.get(key(point));
    if (list) list.push(index);
    else ends.set(key(point), [index]);
  };
  lines.forEach((line, index) => {
    addEnd(line[0], index);
    addEnd(line[line.length - 1], index);
  });

  const used = new Uint8Array(lines.length);
  const merged = [];
  const oriented = (index, from) => (key(lines[index][0]) === from ? lines[index] : lines[index].toReversed());
  const walk = (start, from) => {
    used[start] = 1;
    const chain = oriented(start, from).slice();
    let current = start;
    for (;;) {
      const at = key(chain[chain.length - 1]);
      const list = ends.get(at);
      if (list.length !== 2) break;
      const next = list[0] === current ? list[1] : list[0];
      if (used[next]) break;
      used[next] = 1;
      const line = oriented(next, at);
      for (let i = 1; i < line.length; i++) chain.push(line[i]);
      current = next;
    }
    merged.push(chain);
  };
  // Chains start at a junction or a dead end, then follow the line through the points
  // where only two lines meet
  lines.forEach((line, index) => {
    if (used[index]) return;
    const first = key(line[0]);
    const last = key(line[line.length - 1]);
    if (ends.get(first).length !== 2) walk(index, first);
    else if (ends.get(last).length !== 2) walk(index, last);
  });
  // What is left only meets in pairs: loops (roundabouts, rings of segments)
  lines.forEach((line, index) => {
    if (!used[index]) walk(index, key(line[0]));
  });
  return merged;
}
