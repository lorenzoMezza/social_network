// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// How the map's camera answers fingers (webview/map/src/scene/createCamera.js)
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

globalThis.innerWidth = 393;
globalThis.innerHeight = 852;
globalThis.window ??= {};
globalThis.location ??= { search: '' };
const { createCamera } = await import('../webview/map/src/scene/createCamera.js');

function rig() {
  const listeners = {};
  const dom = {
    style: {},
    addEventListener: (type, run) => { listeners[type] = run; },
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 393, height: 852 }),
  };
  const camera = createCamera(dom);
  camera.centerOn({ x: 0, y: 0, z: 0 });
  const fire = (type, touches, at) => listeners[type]({
    preventDefault() {},
    timeStamp: at,
    changedTouches: { length: touches.length, item: (i) => touches[i] },
  });
  const touch = (identifier, clientX, clientY) => ({ identifier, clientX, clientY });
  return { camera, fire, touch, angle: () => Math.atan2(camera.camera.position.z, camera.camera.position.x) };
}

// A finger turning the view, one touch every `every` ms, one frame every 16.7 ms; touches in
// `gaps` (their indexes) did not arrive in time for their frame: the next frame gets two
function drag({ gaps = new Set(), frames = 60 } = {}) {
  const r = rig();
  const finger = (i) => r.touch(1, 340 - i * 3, 700);
  r.fire('touchstart', [finger(0)], 0);
  const angles = [];
  for (let i = 1; i <= frames; i++) {
    if (!gaps.has(i)) {
      if (gaps.has(i - 1)) r.fire('touchmove', [finger(i - 1)], (i - 1) * 16.7);
      r.fire('touchmove', [finger(i)], i * 16.7);
    }
    r.camera.update(1 / 60);
    angles.push(r.angle());
  }
  return { r, angles, finger };
}

describe('the camera under a finger', () => {
  it('keeps moving through a frame with no touch, and does not jump in the next', () => {
    const { angles } = drag({ gaps: new Set([30, 41]) });
    const steps = angles.slice(1).map((a, i) => Math.abs(a - angles[i]));
    const usual = steps[25];
    assert.ok(steps[29] > usual * 0.3, `still in the frame without a touch: ${steps[29]} of ${usual}`);
    assert.ok(Math.max(...steps.slice(25)) < usual * 1.7, 'a jump after it');
  });

  it('follows the finger: it catches up within a few frames', () => {
    const { r, finger } = drag();
    r.fire('touchend', [finger(60)], 60 * 16.7 + 200);
    const before = r.angle();
    for (let i = 0; i < 30; i++) r.camera.update(1 / 60);
    const settled = r.angle();
    for (let i = 0; i < 30; i++) r.camera.update(1 / 60);
    assert.ok(Math.abs(r.angle() - settled) < 1e-3, 'still moving half a second after');
    assert.ok(Math.abs(settled - before) < 0.1, 'too far behind the finger');
  });

  it('carries on after a flick without a step down', () => {
    const { r, finger, angles } = drag();
    const speed = Math.abs(angles.at(-1) - angles.at(-2));
    r.fire('touchend', [finger(60)], 60 * 16.7 + 5);
    r.camera.update(1 / 60);
    const first = Math.abs(r.angle() - angles.at(-1));
    assert.ok(first > speed * 0.6, `after the release ${first}, before ${speed}`);
  });

  it('does not fling when the finger stopped before lifting', () => {
    const { r, finger } = drag();
    for (let i = 0; i < 30; i++) r.camera.update(1 / 60);
    const still = r.angle();
    r.fire('touchend', [finger(60)], 60 * 16.7 + 300);
    for (let i = 0; i < 30; i++) r.camera.update(1 / 60);
    assert.ok(Math.abs(r.angle() - still) < 1e-3, 'it flung');
  });

  it('zooms without a jump, and keeps the framing at both ends', () => {
    const r = rig();
    const start = r.camera.camera.position.clone();
    r.camera.setView({ zoom: 1 });
    const far = r.camera.camera.position.clone();
    r.camera.setView({ zoom: 0 });
    const near = r.camera.camera.position.clone();
    assert.ok(far.distanceTo(start) > 1 && near.distanceTo(start) > 1);
    // The camera's path has no corner: its direction turns little between two close zooms
    const path = [];
    for (let zoom = 0; zoom <= 1.0001; zoom += 0.02) {
      r.camera.setView({ zoom });
      path.push(r.camera.camera.position.clone());
    }
    let sharpest = 0;
    for (let i = 2; i < path.length; i++) {
      const a = path[i - 1].clone().sub(path[i - 2]).normalize();
      const b = path[i].clone().sub(path[i - 1]).normalize();
      sharpest = Math.max(sharpest, Math.acos(Math.min(1, a.dot(b))));
    }
    assert.ok(sharpest < 0.35, `a corner of ${(sharpest * 57.3).toFixed(0)}°`);
  });

  it('counts the frames that got no touch', () => {
    const { r } = drag({ gaps: new Set([10, 20, 30]) });
    const stats = r.camera.takeInputStats();
    assert.equal(Math.round(stats.emptyShare * 60), 3);
    assert.equal(r.camera.takeInputStats(), null);
  });
});
