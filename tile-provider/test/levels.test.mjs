// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { flattenLevels } from '../src/levels.mjs';

const line = (...xs) => xs.map(([x, y]) => ({ x, y }));
const bridge = { class: 'primary', brunnel: 'bridge', layer: 1 };
const road = { class: 'primary' };
// One metre per unit: KEEP_M (25 m) is 25 units
const flat = (items) => flattenLevels(items, 1).map(({ attributes, line: l }) => [attributes.brunnel ?? 'ground', l[0].x, l[l.length - 1].x]);

describe('flattenLevels', () => {
  it('turns a bridge over nothing drawn into plain road', () => {
    assert.deepEqual(flat([{ attributes: bridge, line: line([0, 0], [200, 0]) }]), [['ground', 0, 200]]);
  });

  it('keeps the bridge only around the road it passes over', () => {
    const items = [
      { attributes: bridge, line: line([0, 0], [200, 0]) },
      { attributes: road, line: line([100, -50], [100, 50]) },
    ];
    assert.deepEqual(flat(items).slice(0, 3), [['ground', 0, 75], ['bridge', 75, 125], ['ground', 125, 200]]);
  });

  it('does not count a bridge joining a road at its end as a crossing', () => {
    const items = [
      { attributes: bridge, line: line([0, 0], [100, 0]) },
      { attributes: road, line: line([100, 0], [200, 30]) },
    ];
    assert.deepEqual(flat(items)[0], ['ground', 0, 100]);
  });

  it('leaves level-0 lines and lines crossing their own level alone', () => {
    const items = [
      { attributes: road, line: line([0, 0], [200, 0]) },
      { attributes: road, line: line([100, -50], [100, 50]) },
    ];
    assert.deepEqual(flattenLevels(items, 1), items);
  });
});
