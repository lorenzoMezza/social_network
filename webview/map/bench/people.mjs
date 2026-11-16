// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// How many people the map can show: make map-bench-people [COUNTS=0,25,50,…]
//
// The map page the app ships, in Chrome at an iPhone's size, with more and more people, a
// new browser for each count. By default they all stand within --spread metres of the
// player (a crowd around them, the worst case: everyone in view). For each count:
//  - the main thread: the JavaScript of a frame while everyone walks, and the cost of one
//    update of the people from the app (window.setMapPeople, every second here);
//  - the GPU: a frozen frame, at the density the map draws (2.25×) and at 5× (at low
//    densities this computer's GPU is limited by its CPU);
//  - the GPU memory asked for: what WebGL allocates, summed (textures and buffers);
//  - the JavaScript heap.
// The times are this computer's, not a phone's: what counts is how they grow with the
// people. Saved in .dev/map-bench/.
import puppeteer from 'puppeteer-core';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const option = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const COUNTS = option('counts', '0,25,50,75,100,150,200,300,500,1000').split(',').map(Number);
const SPREAD = Number(option('spread', 40));
const SECONDS = Number(option('seconds', 10));
const TILE_URL = process.env.TILE_URL ?? 'http://localhost:8093/tiles.json';
const AVATAR_URL = process.env.AVATAR_URL ?? 'http://localhost:8092';
const CENTER = { latitude: 41.8953, longitude: 12.4918 };
const CHROME = process.env.CHROME ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// In the page, before anything else: every byte WebGL is asked to allocate
function countGlMemory() {
  const P = WebGL2RenderingContext.prototype;
  const bytes = { textures: 0, buffers: 0 };
  window.__glBytes = bytes;
  const ASTC = new Set([0x93b4, 0x93d4]); // 6×6, linear and sRGB
  const texelBytes = (format) => (format === 0x8814 ? 16 : format === 0x881a ? 8 : format === 0x822e ? 4 : 4);
  const levelBytes = (format, w, h) => (ASTC.has(format) ? Math.ceil(w / 6) * Math.ceil(h / 6) * 16 : w * h * texelBytes(format));
  const storage = (levels, format, w, h, layers) => {
    for (let level = 0; level < levels; level++) bytes.textures += levelBytes(format, Math.max(w >> level, 1), Math.max(h >> level, 1)) * layers;
  };
  const texStorage3D = P.texStorage3D;
  P.texStorage3D = function (target, levels, format, w, h, depth) {
    storage(levels, format, w, h, depth);
    return texStorage3D.apply(this, arguments);
  };
  const texStorage2D = P.texStorage2D;
  P.texStorage2D = function (target, levels, format, w, h) {
    storage(levels, format, w, h, 1);
    return texStorage2D.apply(this, arguments);
  };
  const bufferData = P.bufferData;
  P.bufferData = function (target, data) {
    bytes.buffers += typeof data === 'number' ? data : data?.byteLength ?? 0;
    return bufferData.apply(this, arguments);
  };
}

const serve = (html) => new Promise((resolve) => {
  const server = createServer((request, response) => {
    response.writeHead(request.url.startsWith('/map.html') ? 200 : 404, { 'content-type': 'text/html' });
    response.end(request.url.startsWith('/map.html') ? html : '');
  }).listen(0, '127.0.0.1', () => resolve(server));
});

async function measure(count, html, standIn, avatarKeys) {
  const server = await serve(html);
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    protocolTimeout: 600000,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []), '--js-flags=--expose-gc'],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewport({ width: 393, height: 852, deviceScaleFactor: 2.25, isMobile: true, hasTouch: true });
    await page.evaluateOnNewDocument(countGlMemory);
    await page.evaluateOnNewDocument(() => {
      window.__frames = [];
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => raf((time) => {
        const start = performance.now();
        callback(time);
        window.__frames.push(performance.now() - start);
      });
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/map.html?tiles=${encodeURIComponent(TILE_URL)}`);
    await page.waitForFunction(() => typeof window.updatePlayerLocation === 'function', { timeout: 30000 });
    await page.evaluate((center) => {
      window.setMapActive(true);
      window.setMapDevToolsAvailable?.(true);
      window.setMapDebugStatsEnabled(true);
      window.updatePlayerLocation({ ...center, heading: 0, speed: 0, accuracy: 5, timestamp: Date.now() });
    }, CENTER);
    await page.waitForFunction(() => {
      const tiles = window.mapDebug?.geo?.getTileStats?.();
      return tiles && tiles.total > 0 && tiles.loading === 0 && tiles.rebuilding === 0;
    }, { timeout: 120000, polling: 500 });
    await page.evaluate(() => {
      window.mapDebug.environment?.setTimeOverride?.(12);
      window.mapDebug.environment?.setWeatherOverride?.({ cloudCover: 0.5 });
      // The cost of an update of the people, as the app sends it
      const set = window.setMapPeople;
      window.__updates = [];
      window.setMapPeople = (list) => {
        const start = performance.now();
        const text = JSON.stringify(list);
        JSON.parse(text);
        set(list);
        window.__updates.push([performance.now() - start, text.length]);
      };
    });
    await page.addScriptTag({ content: readFileSync(new URL('./scenario.js', import.meta.url), 'utf8') });
    await page.evaluate((options) => {
      window.__scenario = window.startBenchScenario(options);
    }, { center: CENTER, events: 25, people: count, spread: SPREAD, walkRadius: 3, avatarBase: `${AVATAR_URL}/v1/map-avatars/`, avatarKeys, standIn });
    // Avatars arrived: their number stops growing (or two minutes)
    const looks = Math.min(count, avatarKeys.length);
    const until = Date.now() + 120000;
    let last = -1;
    let quiet = 0;
    while (Date.now() < until && quiet < 4) {
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const bytes = await page.evaluate(() => window.__glBytes.textures + window.__glBytes.buffers);
      quiet = bytes === last ? quiet + 1 : 0;
      last = bytes;
    }
    await page.evaluate(() => {
      window.__frames = [];
      window.__updates = [];
    });
    await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));
    if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
    const result = await page.evaluate(async () => {
      const sorted = [...window.__frames].sort((a, b) => a - b);
      const at = (share) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0;
      const updates = window.__updates;
      window.gc?.();
      const { renderer, people, scene, clouds, environment, cameraRig } = window.mapDebug;
      const live = {
        frames: sorted.length,
        jsMean: sorted.reduce((a, b) => a + b, 0) / Math.max(sorted.length, 1),
        jsP95: at(0.95),
        updateMs: updates.reduce((a, u) => a + u[0], 0) / Math.max(updates.length, 1),
        updateKB: (updates[0]?.[1] ?? 0) / 1024,
        draws: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        people: people?.stats?.() ?? null,
        heapMB: (performance.memory?.usedJSHeapSize ?? 0) / 1048576,
        glTexturesMB: window.__glBytes.textures / 1048576,
        glBuffersMB: window.__glBytes.buffers / 1048576,
      };
      window.__scenario.stop();
      const camera = cameraRig.camera;
      renderer.setAnimationLoop(null);
      const gl = renderer.getContext();
      const pixel = new Uint8Array(4);
      const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      const frame = () => {
        clouds?.render(camera, environment.env, 1 / 60);
        renderer.render(scene, camera);
      };
      const sample = () => {
        frame();
        sync();
        const start = performance.now();
        for (let i = 0; i < 20; i++) frame();
        sync();
        return (performance.now() - start) / 20;
      };
      const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
      const gpu = {};
      for (const density of [2.25, 5]) {
        renderer.setPixelRatio(density);
        renderer.setSize(innerWidth, innerHeight);
        const end = performance.now() + 1500;
        while (performance.now() < end) {
          frame();
          sync();
        }
        gpu[density] = median(Array.from({ length: 5 }, sample));
      }
      return { ...live, gpu };
    });
    return { count, looks, ...result, errors };
  } finally {
    await browser.close();
    server.close();
  }
}

const dir = join(root, 'avatar-server/map-avatars');
const avatarKeys = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.glb')).map((f) => f.slice(0, -4)) : [];
const standIn = (await (await fetch(`${AVATAR_URL}/v1/map-avatars/stand-in`)).json()).key;
const html = readFileSync(join(root, 'assets/webview/map.html'), 'utf8');
const results = [];
console.log(`${avatarKeys.length} different looks, within ${SPREAD} m`);
console.log('people  in view  draws  triangles   JS ms (p95)    update ms/KB   GPU 2.25×  GPU 5×   GL textures+buffers MB  heap MB');
for (const count of COUNTS) {
  const r = await measure(count, html, standIn, avatarKeys);
  results.push(r);
  console.log([
    String(count).padStart(6),
    String(r.people?.drawn ?? '–').padStart(8),
    String(r.draws).padStart(6),
    r.triangles.toLocaleString('en-US').padStart(10),
    `${r.jsMean.toFixed(2)} (${r.jsP95.toFixed(2)})`.padStart(14),
    `${r.updateMs.toFixed(2)} / ${r.updateKB.toFixed(1)}`.padStart(14),
    r.gpu[2.25].toFixed(2).padStart(10),
    r.gpu[5].toFixed(2).padStart(7),
    `${r.glTexturesMB.toFixed(0)}+${r.glBuffersMB.toFixed(0)}`.padStart(16),
    r.heapMB.toFixed(0).padStart(12),
    r.errors.length ? `ERRORS: ${r.errors[0]}` : '',
  ].join(' '));
}
const saved = join(root, '.dev/map-bench');
mkdirSync(saved, { recursive: true });
writeFileSync(join(saved, `people-${new Date().toISOString().replace(/[:.]/g, '-')}.json`), JSON.stringify({ spread: SPREAD, results }, null, 2));
