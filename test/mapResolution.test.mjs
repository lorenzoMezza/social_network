// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The map's adaptive resolution (webview/map/src/scene/adaptiveResolution.js): it keeps
// the screen's full density (at most 2.25×) where the phone keeps up, steps down only
// while that helps, and back up when the GPU has room again
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = { devicePixelRatio: 3 };
globalThis.innerWidth = 393;
globalThis.innerHeight = 852;
const { createAdaptiveResolution, startingPixelRatio } = await import('../webview/map/src/scene/adaptiveResolution.js');

// Frames at the pace a device would deliver them, `interval(pixelRatio)` ms apart, for
// `seconds`; the GPU needing `gpu(pixelRatio, time)` ms for each (what its fences would say)
function run({ interval, gpu, seconds = 60, busy = () => false }) {
  // A 3× screen: the map starts at its maximum, 2.25× (createRenderer.js)
  const renderer = { ratio: 2.25, setPixelRatio(r) { this.ratio = r; }, setSize() {} };
  const samples = [];
  const gpuTimer = {
    begin: () => {},
    end: () => samples.push(gpu(renderer.ratio, now)),
    take: () => (samples.length ? samples.splice(0).sort((a, b) => a - b)[0] : null),
  };
  const adaptive = createAdaptiveResolution(renderer, { targetFrameIntervalMs: 1000 / 60, isBusy: busy, gpuTimer });
  const ratios = [];
  let now = 0;
  for (let time = 0; time < seconds * 1000; time += interval(renderer.ratio, time)) {
    now = time;
    adaptive.frameRendered(time);
    if (ratios.at(-1) !== renderer.ratio) ratios.push(renderer.ratio);
  }
  return { final: adaptive.pixelRatio, ratios };
}
// One vsync of a 60 Hz screen: a late frame waits for the next one
const vsynced = (ms) => Math.ceil(ms / (1000 / 60)) * (1000 / 60);

describe('adaptive resolution of the map', () => {
  it('starts at the screen density, at most 2.25×', () => {
    assert.equal(startingPixelRatio(), 2.25);
    window.devicePixelRatio = 2;
    assert.equal(startingPixelRatio(), 2);
    window.devicePixelRatio = 3;
  });

  it('keeps the full density on a phone that keeps up, never above 2.25×', () => {
    const { ratios, final } = run({ interval: () => 1000 / 60, gpu: () => 3, seconds: 120 });
    assert.deepEqual(ratios, [2.25]);
    assert.equal(final, 2.25);
  });

  it('steps down at once as far as the GPU needs, no further (its time grows with the pixels)', () => {
    // 2.25× takes 21 ms a frame, 2× 16.6 ms (both shown at 30 fps on a 60 Hz screen),
    // 1.75× 12.7 ms: in time again
    const gpu = (r) => 4.15 * r * r;
    const { final, ratios } = run({ interval: (r) => vsynced(gpu(r)), gpu });
    assert.deepEqual(ratios, [2.25, 1.75]);
    assert.equal(final, 1.75);
  });

  it('steps down again if the first step was not enough', () => {
    // Part of the GPU's time does not depend on the pixels: 2× is still too slow
    const gpu = (r) => 14 + r * r;
    const { ratios } = run({ interval: (r) => vsynced(gpu(r)), gpu });
    assert.equal(ratios[0], 2.25);
    assert.ok(ratios.length >= 3, `steps: ${ratios}`);
    assert.ok(gpu(ratios.at(-1)) < 1000 / 60, `ends at 60 fps: ${ratios}`);
  });

  it('keeps the full density when the system caps the frame rate (Low Power Mode, heat)', () => {
    assert.deepEqual(run({ interval: () => 1000 / 30, gpu: () => 10 }).ratios, [2.25]);
  });

  it('never blames the pixels when the main thread is the bottleneck', () => {
    assert.deepEqual(run({ interval: () => 30, gpu: () => 6 }).ratios, [2.25]);
  });

  it('counts nothing while tiles load', () => {
    assert.deepEqual(run({ interval: () => 40, gpu: () => 30, busy: () => true }).ratios, [2.25]);
  });

  it('goes back up to the full density when the GPU has room again', () => {
    // A heavy scene for 20 s (2.25× takes 21 ms a frame), then a light one (3.4 ms at 2.25×)
    const gpu = (r, time) => (time < 20000 ? 4.15 : 0.67) * r * r;
    const { final, ratios } = run({ interval: (r, time) => vsynced(gpu(r, time)), gpu, seconds: 120 });
    assert.equal(ratios[1], 1.75, `stepped down first: ${ratios}`);
    assert.equal(final, 2.25, `back up: ${ratios}`);
  });

  it('stays where it settled when going up would be too much again', () => {
    const gpu = (r) => 4.15 * r * r;
    assert.deepEqual(run({ interval: (r) => vsynced(gpu(r)), gpu, seconds: 300 }).ratios, [2.25, 1.75]);
  });

  it('never keeps going up and down: a step up taken back waits longer each time', () => {
    // The guess is wrong here: 2× is light, 2.25× much heavier than its pixels say
    const gpu = (r) => (r >= 2.25 ? 22 : 4);
    const { ratios, final } = run({ interval: (r) => vsynced(gpu(r)), gpu, seconds: 600 });
    // 2.25× tried again after 1, 2, 4 minutes: a handful of tries in 10 minutes, and
    // between them the map stays at the density it can draw
    const tries = ratios.filter((r) => r === 2.25).length;
    assert.ok(tries <= 6, `2.25× tried ${tries} times: ${ratios}`);
    assert.ok(final <= 2, `ends where it keeps up: ${ratios}`);
  });

  it('goes down to the last step at most', () => {
    const { final } = run({ interval: () => 50, gpu: () => 40, seconds: 120 });
    assert.equal(final, 1);
  });
});

// The same with the browser's frame loop as a phone runs it: called once per refresh of
// the display (`displayFps`), each call told to the adaptive resolution; a frame is drawn
// when one is due (42 a second asked for), and the next call then waits for the GPU
function runOnDisplay({ displayFps, gpu, seconds = 40, limit = () => null }) {
  const renderer = { ratio: 2.25, setPixelRatio(r) { this.ratio = r; }, setSize() {} };
  const samples = [];
  let now = 0;
  const gpuTimer = {
    begin: () => {},
    end: () => samples.push(gpu(renderer.ratio, now)),
    take: () => (samples.length ? samples.splice(0).sort((a, b) => a - b)[0] : null),
  };
  const target = 1000 / 42;
  const adaptive = createAdaptiveResolution(renderer, { targetFrameIntervalMs: target, isBusy: () => false, gpuTimer });
  const ratios = [];
  let undrawn = 0;
  let nextFrame = 0;
  let told;
  const refresh = (time) => 1000 / displayFps(time);
  for (let time = 0; time < seconds * 1000;) {
    now = time;
    const say = limit(time);
    if (say !== told) adaptive.setDisplayLimit(told = say);
    adaptive.displayTick(time);
    let wait = refresh(time);
    if (adaptive.probing) undrawn++;
    else if (time >= nextFrame - target * 0.15) {
      nextFrame = time - nextFrame > target ? time + target : nextFrame + target;
      adaptive.frameRendered(time);
      // Shown at the first refresh after the GPU is done
      wait = Math.ceil(gpu(renderer.ratio, time) / refresh(time)) * refresh(time) || refresh(time);
    }
    if (ratios.at(-1) !== renderer.ratio) ratios.push(renderer.ratio);
    time += wait;
  }
  return { final: adaptive.pixelRatio, ratios, undrawn, frameInterval: adaptive.frameInterval };
}

describe('adaptive resolution and a display slower than the frame rate asked for', () => {
  // A GPU slowed down by Low Power Mode: 25 ms a frame at 2.25×, more than a frame at 42 fps
  const slowGpu = (r) => 25 * (r / 2.25) ** 2;

  it('keeps the resolution in Low Power Mode, told by the app: 30 fps is all there is', () => {
    const { ratios, undrawn, frameInterval } = runOnDisplay({ displayFps: () => 30, gpu: slowGpu, limit: () => 30 });
    assert.deepEqual(ratios, [2.25]);
    assert.equal(undrawn, 0, 'nothing to find out: no frame left undrawn');
    assert.ok(Math.abs(frameInterval - 1000 / 30) < 0.01);
  });

  it('finds a 30 fps display by itself when nobody says so, at the cost of a few frames once', () => {
    const { ratios, undrawn, frameInterval } = runOnDisplay({ displayFps: () => 30, gpu: slowGpu });
    assert.deepEqual(ratios, [2.25]);
    assert.equal(undrawn, 3, 'three frames, about a tenth of a second');
    assert.ok(Math.abs(frameInterval - 1000 / 30) < 0.01);
  });

  it('still lowers it on a 60 Hz display when the GPU is what holds the frames back', () => {
    // Every frame takes two refreshes: the calls come 33 ms apart, as on a 30 fps display
    const { ratios, final, undrawn } = runOnDisplay({ displayFps: () => 60, gpu: slowGpu });
    assert.equal(undrawn, 3, 'heard the display first');
    assert.ok(final < 2.25, `lowered: ${ratios}`);
    assert.ok(slowGpu(final) < (1000 / 42) * 0.9);
  });

  it('lowers it on a 30 fps display too, when the GPU cannot even keep that', () => {
    const gpu = (r) => 45 * (r / 2.25) ** 2;
    const { final } = runOnDisplay({ displayFps: () => 30, gpu, limit: () => 30 });
    assert.ok(final < 2.25);
    assert.ok(gpu(final) < (1000 / 30) * 0.9, 'as far as 30 fps needs');
    assert.ok(gpu(final) > (1000 / 42) * 0.5, 'not as far as 42 fps would');
  });

  it('judges by the frame rate asked for again once Low Power Mode is off', () => {
    // 30 fps for 20 s (told), then the display is back at 60 Hz and the app says so
    const { ratios, final } = runOnDisplay({
      displayFps: (time) => (time < 20000 ? 30 : 60),
      limit: (time) => (time < 20000 ? 30 : null),
      gpu: slowGpu,
      seconds: 60,
    });
    assert.equal(ratios[0], 2.25);
    assert.ok(final < 2.25, `lowered after it: ${ratios}`);
  });

  it('leaves a fast display alone: 120 Hz, a light scene', () => {
    const { ratios, undrawn, frameInterval } = runOnDisplay({ displayFps: () => 120, gpu: () => 6 });
    assert.deepEqual(ratios, [2.25]);
    assert.equal(undrawn, 0);
    assert.ok(Math.abs(frameInterval - 1000 / 42) < 0.01);
  });
});
