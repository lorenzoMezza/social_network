// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Developer overlay, refreshed every frame:
//  - fps         averaged over the last half second
//  - draw calls  GPU draw calls of the frame (extra passes included)
//  - tris        real triangles on screen: every drawn object counted once, after
//                frustum culling (BatchedMesh tiles outside the view are not drawn)
//  - gpu tris    triangles sent to the GPU, extra passes included (the depth
//                pre-pass of transparent buildings draws them twice)
//  - tiles       on screen / in the render area, and still loading
//  - res         pixel ratio of the canvas (adaptiveResolution.js lowers it on a slow GPU)
//  - touch       with a finger down: the frames that got no new touch, how old the newest one was
//  - gpu         how long the GPU takes over a frame (median of frames timed with a fence:
//                above ~21 ms it cannot keep the 42 fps of MAX_FPS), and the main thread's time per frame
//
// Triangles come from three.js itself: around every renderBufferDirect() call the
// overlay reads how much renderer.info.render.triangles grew, so the numbers match
// exactly what was drawn, whatever the draw range, groups, instancing or multi-draw.
import { startupMarks } from '../startupTimeline.js';
import { createGpuTimer } from '../scene/adaptiveResolution.js';
import { MAX_FPS } from '../config.js';

const FPS_WINDOW_MS = 500;
// The page's start, as it went: ms from the moment it began to load, the app's wait before it
const startupLine = () => {
  const appWait = new URLSearchParams(location.search).get('appStarted');
  const before = appWait ? `app ${Math.round(performance.timeOrigin - Number(appWait))} · ` : '';
  const short = { 'provisional position': 'last', script: 'js', 'map-ready': 'ready', view: 'view', 'first position': 'gps', 'first tile': 'tile', 'all tiles': 'tiles', avatar: 'av' };
  return before + startupMarks().filter(({ name }) => short[name]).map(({ name, at }, index) => `${index && index % 3 === 0 ? '\n' : ''}${short[name]} ${Math.round(at)}`).join(' · ');
};

export function createDebugStats(renderer, geo) {
  const el = document.createElement('div');
  el.id = 'debug-stats';
  // Top inset of the app's safe area, passed in by the React Native WebView
  el.style.top = `${(window.SAFE_AREA_TOP ?? 0) + 6}px`;
  document.body.append(el);

  // Count each drawn object (and material group) once per frame
  const drawn = new Set();
  let uniqueTriangles = 0;
  // Every draw of the frame, for the console: mapDebug.draws(); the map: mapDebug.geo
  let draws = [];
  let lastDraws = [];
  window.mapDebug = { draws: () => lastDraws, geo };
  const originalRenderBufferDirect = renderer.renderBufferDirect;
  const renderBufferDirect = originalRenderBufferDirect.bind(renderer);
  renderer.renderBufferDirect = (camera, scene, geometry, material, object, group) => {
    const before = renderer.info.render.triangles;
    renderBufferDirect(camera, scene, geometry, material, object, group);
    draws.push({
      kind: object.userData.kind ?? object.name ?? object.type,
      renderOrder: object.renderOrder,
      color: material.color?.getHexString(),
      colorWrite: material.colorWrite,
      triangles: renderer.info.render.triangles - before,
    });
    const key = group ? `${object.id}:${group.start}:${group.count}` : object.id;
    if (!drawn.has(key)) {
      drawn.add(key);
      uniqueTriangles += renderer.info.render.triangles - before;
    }
  };

  const nf = new Intl.NumberFormat('en-US');
  let frames = 0;
  let fps = 0;
  let windowStart = performance.now();
  let lastText = '';
  const gpuTimer = createGpuTimer(renderer.getContext());
  let gpuMs = null;
  // Main-thread time of the frames (the whole frame callback), averaged like the fps
  let cpuTotal = 0;
  let cpuMs = 0;
  // While a finger is down: the share of frames that got no touch, and how old the newest was
  let touch = null;

  // The display's own frame rate, when it is under the one asked for (Low Power Mode, a
  // 30 Hz screen: adaptiveResolution.js judges the GPU against it)
  const displayLine = () => {
    const adaptive = window.mapDebug?.adaptiveResolution;
    if (!adaptive || adaptive.frameInterval <= 1000 / MAX_FPS + 0.5) return '';
    return ` · display ${(1000 / adaptive.frameInterval).toFixed(0)} fps`;
  };

  return {
    // Call before the frame's first draw
    frameStarting() {
      gpuTimer.begin();
    },
    // Call right after renderer.render(): renderer.info holds the numbers of that frame.
    // frameStart: performance.now() when the frame callback began
    update(frameStart = performance.now(), takeInputStats = null) {
      const now = performance.now();
      frames++;
      cpuTotal += now - frameStart;
      gpuTimer.end();
      if (now - windowStart >= FPS_WINDOW_MS) {
        fps = (frames * 1000) / (now - windowStart);
        cpuMs = cpuTotal / frames;
        gpuMs = gpuTimer.take() ?? gpuMs;
        touch = takeInputStats?.() ?? touch;
        frames = 0;
        cpuTotal = 0;
        windowStart = now;
      }

      const { calls, triangles } = renderer.info.render;
      const tiles = geo.getTileStats();
      const text =
        `${fps.toFixed(0)} fps\n` +
        `${calls} draw calls\n` +
        `${nf.format(uniqueTriangles)} tris\n` +
        `${nf.format(triangles)} gpu tris\n` +
        `tiles ${tiles.ready}/${tiles.total}` +
        (tiles.loading ? ` · ${tiles.loading} loading` : '') +
        `\nres ${renderer.getPixelRatio()}×${displayLine()}` +
        `\ngpu ${gpuMs === null ? '–' : gpuMs.toFixed(1)} ms · js ${cpuMs.toFixed(1)} ms` +
        `\n${startupLine()}` +
        (touch ? `\ntouch ${(touch.emptyShare * 100).toFixed(0)}% empty · ${touch.ageMs.toFixed(0)} ms old` : '');

      if (text !== lastText) {
        el.textContent = text;
        lastText = text;
      }

      drawn.clear();
      uniqueTriangles = 0;
      lastDraws = draws;
      draws = [];
    },
    dispose() {
      if (renderer.renderBufferDirect !== originalRenderBufferDirect) {
        renderer.renderBufferDirect = originalRenderBufferDirect;
      }
      el.remove();
      drawn.clear();
      draws = [];
      lastDraws = [];
    },
  };
}
