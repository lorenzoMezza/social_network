// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The map's performance, measured: make map-bench [REF=<git ref>]
//
// Runs the map page the app ships (assets/webview/map.html) in Chrome on this computer,
// at the size of an iPhone Pro (393×852 points), in a busy world that is the same at
// every run (scenario.js: events, people walking in their map avatars, the player
// walking), with the tiles and avatars of `make dev`. It measures:
//  - the GPU: the time of one frame at each pixel density (a frozen frame drawn many
//    times, to the end of the GPU's work), and what each part of the scene costs of
//    it at the highest density (the frame without that part);
//  - the main thread: the JavaScript time of each frame while everything moves, and
//    the memory it keeps;
//  - what the map received of what the app sent: events and people.
// The times are this computer's (a phone's GPU is several times slower, the shares
// are alike: the same kind of GPU on an iPhone); compare runs, and versions:
// REF=<commit> measures that commit's map too, side by side. Each run is saved in
// .dev/map-bench/.
import puppeteer from 'puppeteer-core';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const run = promisify(execFile);
const option = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at > 0 ? process.argv[at + 1] : fallback;
};
const REF = option('ref', null);
const SECONDS = Number(option('seconds', 15));
const PEOPLE = Number(option('people', 60));
const EVENTS = Number(option('events', 25));
const DENSITIES = option('densities', '3,2.5,2,1.75').split(',').map(Number);
const TILE_URL = process.env.TILE_URL ?? 'http://localhost:8093/tiles.json';
const AVATAR_URL = process.env.AVATAR_URL ?? 'http://localhost:8092';
const CENTER = { latitude: 41.8953, longitude: 12.4918 }; // Rione Monti, Rome
// One frozen frame drawn this many times, to the end of the GPU's work, per sample
const FRAMES_PER_SAMPLE = 30;
const SAMPLES = 9;

const reachable = async (url) => {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(3000) });
    return response.ok;
  } catch {
    return false;
  }
};

async function chrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const mac = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  if (existsSync(mac)) return mac;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    try {
      return (await run('which', [name])).stdout.trim();
    } catch {
      // next one
    }
  }
  throw new Error('Chrome not found: install Google Chrome or Chromium, or set CHROME=/path/to/chrome');
}

// The map page of a commit: built in a temporary worktree with this checkout's packages
async function pageOfRef(ref) {
  const dir = join(tmpdir(), `map-bench-${ref.replace(/[^\w.-]/g, '_')}`);
  rmSync(dir, { recursive: true, force: true });
  await run('git', ['worktree', 'prune'], { cwd: root });
  await run('git', ['worktree', 'add', '--detach', dir, ref], { cwd: root });
  for (const folder of ['webview/map', 'webview/three-geo-play', 'webview/avatar']) {
    const modules = join(root, folder, 'node_modules');
    if (existsSync(modules) && existsSync(join(dir, folder))) symlinkSync(modules, join(dir, folder, 'node_modules'));
  }
  console.log(`Building the map page of ${ref}…`);
  await run(process.execPath, ['webview/map/scripts/build.mjs'], { cwd: dir, maxBuffer: 64 * 1024 * 1024 });
  return {
    html: readFileSync(join(dir, 'assets/webview/map.html'), 'utf8'),
    cleanup: () => run('git', ['worktree', 'remove', '--force', dir], { cwd: root }).catch(() => {}),
  };
}

// Serves one page (all of it is inline) on a free port
function serve(html) {
  return new Promise((resolve) => {
    const server = createServer((request, response) => {
      response.writeHead(request.url.startsWith('/map.html') ? 200 : 404, { 'content-type': 'text/html' });
      response.end(request.url.startsWith('/map.html') ? html : '');
    }).listen(0, '127.0.0.1', () => resolve(server));
  });
}

async function measure(html, label, executablePath) {
  const server = await serve(html);
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: ['--enable-gpu', '--ignore-gpu-blocklist', ...(process.platform === 'darwin' ? ['--use-angle=metal'] : []), '--js-flags=--expose-gc'],
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewport({ width: 393, height: 852, deviceScaleFactor: Math.max(...DENSITIES), isMobile: true, hasTouch: true });
    await page.evaluateOnNewDocument((tiles) => {
      // The tile source, the way every version of the page reads it
      window.TILE_URL = tiles;
      window.LOCAL_TILE_URL = tiles;
      // The JavaScript time of each frame
      window.__frames = [];
      const raf = window.requestAnimationFrame.bind(window);
      window.requestAnimationFrame = (callback) => raf((time) => {
        const start = performance.now();
        callback(time);
        window.__frames.push([time, performance.now() - start]);
      });
    }, TILE_URL);
    const port = server.address().port;
    await page.goto(`http://127.0.0.1:${port}/map.html?tiles=${encodeURIComponent(TILE_URL)}`);
    await page.waitForFunction(() => typeof window.updatePlayerLocation === 'function', { timeout: 30000 });
    // What the app does once the page is ready (MapWebView)
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
    });

    // The world, busy
    const avatars = existsSync(join(root, 'avatar-server/map-avatars')) && await reachable(`${AVATAR_URL}/v1/map-avatars/stand-in`);
    const avatarKeys = avatars ? readdirSync(join(root, 'avatar-server/map-avatars')).filter((f) => f.endsWith('.glb')).map((f) => f.slice(0, -4)) : [];
    const standIn = avatars ? (await (await fetch(`${AVATAR_URL}/v1/map-avatars/stand-in`)).json()).key : null;
    await page.addScriptTag({ content: readFileSync(new URL('./scenario.js', import.meta.url), 'utf8') });
    await page.evaluate((options) => {
      window.__scenario = window.startBenchScenario(options);
    }, { center: CENTER, events: EVENTS, people: PEOPLE, avatarBase: `${AVATAR_URL}/v1/map-avatars/`, avatarKeys, standIn });
    // Avatars loaded, weather settled
    await new Promise((resolve) => setTimeout(resolve, 20000));

    // The main thread while everything moves
    await page.evaluate(() => {
      window.__frames = [];
      window.gc?.();
      window.__heap = performance.memory?.usedJSHeapSize ?? 0;
    });
    await new Promise((resolve) => setTimeout(resolve, SECONDS * 1000));
    const live = await page.evaluate(() => {
      const frames = window.__frames;
      const js = frames.map((frame) => frame[1]).sort((a, b) => a - b);
      const at = (share) => js[Math.min(js.length - 1, Math.floor(js.length * share))] ?? 0;
      window.gc?.();
      const { renderer, beacons, people } = window.mapDebug;
      return {
        frames: frames.length,
        jsMs: { mean: js.reduce((a, b) => a + b, 0) / Math.max(js.length, 1), p95: at(0.95), max: at(1) },
        heapGrowthMB: ((performance.memory?.usedJSHeapSize ?? 0) - window.__heap) / 1048576,
        draws: renderer.info.render.calls,
        triangles: renderer.info.render.triangles,
        programs: renderer.info.programs?.length ?? 0,
        textures: renderer.info.memory.textures,
        events: beacons?.stats?.() ?? null,
        people: people?.stats?.() ?? null,
      };
    });
    // Sent: what scenario.js gave the page
    live.eventsSent = EVENTS;
    live.peopleSent = PEOPLE;
    live.avatars = avatarKeys.length > 0;

    // The GPU: frozen frames
    const gpu = await page.evaluate(async ({ densities, framesPerSample, samples }) => {
      window.__scenario.stop();
      const { renderer, scene, clouds, environment, cameraRig } = window.mapDebug;
      const camera = cameraRig.camera;
      renderer.setAnimationLoop(null);
      const gl = renderer.getContext();
      const pixel = new Uint8Array(4);
      const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
      let withClouds = true;
      const frame = () => {
        if (withClouds && clouds) clouds.render(camera, environment.env, 1 / 60);
        renderer.render(scene, camera);
      };
      const sample = () => {
        frame();
        sync();
        const start = performance.now();
        for (let i = 0; i < framesPerSample; i++) frame();
        sync();
        return (performance.now() - start) / framesPerSample;
      };
      const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
      const warm = () => {
        const end = performance.now() + 2000;
        while (performance.now() < end) {
          frame();
          sync();
        }
      };
      const out = { densities: {}, parts: {}, size: null };
      for (const density of densities) {
        renderer.setPixelRatio(density);
        renderer.setSize(innerWidth, innerHeight);
        warm();
        out.densities[density] = median(Array.from({ length: samples }, sample));
      }
      // Each part of the scene: the frame without it, interleaved with the whole frame
      const top = Math.max(...densities);
      renderer.setPixelRatio(top);
      renderer.setSize(innerWidth, innerHeight);
      out.size = [gl.drawingBufferWidth, gl.drawingBufferHeight];
      out.samples = gl.getParameter(gl.SAMPLES);
      const map = scene.getObjectByName('ThreeGeoPlay');
      const mapParts = (...kinds) => (map?.children ?? []).filter((o) => kinds.includes(o.userData.kind ?? o.name));
      const sky = scene.children.find((o) => o.material?.uniforms?.uZenith);
      const hide = (objects) => () => {
        const shown = objects.filter((o) => o?.visible);
        shown.forEach((o) => { o.visible = false; });
        return () => shown.forEach((o) => { o.visible = true; });
      };
      const parts = {
        'sky': hide([sky]),
        'clouds (their two passes)': () => {
          withClouds = false;
          return () => { withClouds = true; };
        },
        'buildings and railways': hide(mapParts('building')),
        'roads': hide(mapParts('line', 'outline')),
        'land use, parks, water': hide(mapParts('polygon')),
        'ground': hide(mapParts('ThreeGeoPlayGround')),
        'people (avatars, shadows, names)': hide(scene.children.filter((o) => /player-avatar|capsule-shadows|crowd|billboards/.test(o.name))),
        'events (beacons)': hide(scene.children.filter((o) => o.name === 'event-beacons')),
        'fog, colour grade, ground weather': () => {
          const materials = new Set();
          scene.traverse((o) => { if (o.material?.fog) materials.add(o.material); });
          materials.forEach((m) => { m.fog = false; m.needsUpdate = true; });
          return () => materials.forEach((m) => { m.fog = true; m.needsUpdate = true; });
        },
      };
      warm();
      for (const [name, setup] of Object.entries(parts)) {
        const whole = [];
        const without = [];
        for (let i = 0; i < samples; i++) {
          whole.push(sample());
          const undo = setup();
          frame();
          sync();
          without.push(sample());
          undo();
          frame();
          sync();
        }
        out.parts[name] = median(whole) - median(without);
      }
      out.whole = out.densities[top];
      const debug = gl.getExtension('WEBGL_debug_renderer_info');
      out.renderer = debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : 'unknown';
      return out;
    }, { densities: DENSITIES, framesPerSample: FRAMES_PER_SAMPLE, samples: SAMPLES });
    return { label, live, gpu, errors };
  } finally {
    await browser.close();
    server.close();
  }
}

const ms = (value) => (value == null ? '–' : `${value.toFixed(2)} ms`);
const pad = (text, width) => String(text).padEnd(width);

function report(results) {
  const [first] = results;
  console.log(`\nGPU: ${first.gpu.renderer}`);
  console.log(`Screen: 393×852 points; at ${Math.max(...DENSITIES)}× ${first.gpu.size.join('×')} pixels, ${first.gpu.samples > 1 ? `${first.gpu.samples}× MSAA` : 'no MSAA'}\n`);
  const columns = results.map((r) => r.label);
  console.log(pad('GPU time of a frame', 38) + columns.map((c) => pad(c, 16)).join(''));
  for (const density of DENSITIES) {
    console.log(pad(`  at ${density}×`, 38) + results.map((r) => pad(ms(r.gpu.densities[density]), 16)).join(''));
  }
  console.log(`\n${pad(`Of it, at ${Math.max(...DENSITIES)}× (frame without that part)`, 38)}${columns.map((c) => pad(c, 16)).join('')}`);
  for (const name of Object.keys(first.gpu.parts)) {
    console.log(pad(`  ${name}`, 38) + results.map((r) => {
      const value = r.gpu.parts[name];
      return pad(value == null ? '–' : `${ms(value)} ${Math.round((100 * value) / r.gpu.whole)}%`, 16);
    }).join(''));
  }
  console.log(`\n${pad('Main thread, everything moving', 38)}${columns.map((c) => pad(c, 16)).join('')}`);
  const row = (name, get) => console.log(pad(`  ${name}`, 38) + results.map((r) => pad(get(r), 16)).join(''));
  row('JavaScript per frame (mean)', (r) => ms(r.live.jsMs.mean));
  row('JavaScript per frame (p95)', (r) => ms(r.live.jsMs.p95));
  row('JavaScript per frame (worst)', (r) => ms(r.live.jsMs.max));
  row('memory kept over the run', (r) => `${r.live.heapGrowthMB.toFixed(1)} MB`);
  row('draw calls', (r) => r.live.draws);
  row('triangles', (r) => r.live.triangles.toLocaleString('en-US'));
  row('shader programs', (r) => r.live.programs);
  console.log(`\n${pad('Sent by the app → on the map', 38)}${columns.map((c) => pad(c, 16)).join('')}`);
  row('events (received / drawn in the fog)', (r) => (r.live.events ? `${r.live.events.events}/${r.live.eventsSent} · ${r.live.events.drawn}` : '–'));
  row('people (received / placed / in view)', (r) => (r.live.people ? `${r.live.people.people}/${r.live.peopleSent} · ${r.live.people.placed} · ${r.live.people.drawn}` : '–'));
  if (!first.live.avatars) console.log('\n(No avatar server on 8092: people wear nothing. Start make dev for the full scene.)');
  for (const r of results) if (r.errors.length) console.log(`\nErrors in ${r.label}: ${r.errors.join(' | ')}`);
}

const executablePath = await chrome();
if (!(await reachable(TILE_URL))) {
  console.error(`No tiles at ${TILE_URL}: start make dev (or set TILE_URL)`);
  process.exit(1);
}
const page = join(root, 'assets/webview/map.html');
if (!existsSync(page)) {
  console.error('No assets/webview/map.html: make setup builds it');
  process.exit(1);
}
const results = [];
if (REF) {
  const built = await pageOfRef(REF);
  try {
    results.push(await measure(built.html, REF, executablePath));
  } finally {
    await built.cleanup();
  }
}
results.push(await measure(readFileSync(page, 'utf8'), 'this checkout', executablePath));
report(results);
const saved = join(root, '.dev/map-bench');
mkdirSync(saved, { recursive: true });
const file = join(saved, `${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
writeFileSync(file, JSON.stringify({ densities: DENSITIES, people: PEOPLE, events: EVENTS, results }, null, 2));
console.log(`\nSaved: ${file.slice(root.length)}`);
