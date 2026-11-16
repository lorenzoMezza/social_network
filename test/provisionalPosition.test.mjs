// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The last known position draws the map and goes nowhere else
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PROVISIONAL_MAX_AGE_MS, provisionalPosition } from '../src/features/map/model/provisionalPosition.js';

const now = 1_800_000_000_000;
const fix = (over = {}) => ({ timestamp: now - 60_000, mocked: false, ...over, coords: { latitude: 41.9, longitude: 12.5, accuracy: 20, ...over.coords } });

describe('the last known position', () => {
  it('is used when recent and precise', () => {
    assert.deepEqual(provisionalPosition(fix(), now), { latitude: 41.9, longitude: 12.5 });
  });

  it('is not used when old', () => {
    assert.equal(provisionalPosition(fix({ timestamp: now - PROVISIONAL_MAX_AGE_MS - 1 }), now), null);
  });

  it('is not used when vague, or when nothing says how precise it is', () => {
    assert.equal(provisionalPosition(fix({ coords: { accuracy: 151 } }), now), null);
    assert.equal(provisionalPosition(fix({ coords: { accuracy: null } }), now), null);
  });

  it('is not used from a clock in the future, without a time, or without a place', () => {
    assert.equal(provisionalPosition(fix({ timestamp: now + 60_000 }), now), null);
    assert.equal(provisionalPosition(fix({ timestamp: undefined }), now), null);
    assert.equal(provisionalPosition(fix({ coords: { latitude: 95 } }), now), null);
    assert.equal(provisionalPosition(null, now), null);
  });

  it('is not used from a fake-GPS app, but for an emulator in development', () => {
    assert.equal(provisionalPosition(fix({ mocked: true }), now), null);
    assert.ok(provisionalPosition(fix({ mocked: true }), now, { allowMocked: true }));
  });

  it('never reaches what the server hears', () => {
    const screen = readFileSync(new URL('../src/features/map/MapScreen.js', import.meta.url), 'utf8');
    const handler = screen.match(/const drawFromLastKnown = useCallback\(\(position\) => \{([\s\S]*?)\}, \[\]\);/)[1];
    assert.equal(handler.trim(), 'mapRef.current?.setProvisionalLocation(position);');
    const hook = readFileSync(new URL('../src/features/map/hooks/usePlayerLocation.js', import.meta.url), 'utf8');
    // It goes straight to its own callback: not into the tracker, nor through what publishes fixes
    assert.ok(/if \(position\) onProvisionalRef\.current\?\.\(position\);/.test(hook));
    assert.equal((hook.match(/provisionalPosition\(/g) ?? []).length, 1);
    assert.ok(!/tracker\.addGps\([^)]*provisional/i.test(hook));
  });
});
