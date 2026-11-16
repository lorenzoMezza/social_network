// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Browser dev server for the map:  npm run dev  →  http://localhost:8091
// Rebuilds on every change in src/ (not minified) and reloads the page. index.html
// shows the map in a phone-sized frame; map.html plays the part of the Expo app:
// the tiles of tile-provider/ (make dev), a GPS fix in Rome (?at=lat,lon elsewhere), the
// live weather, map active, developer tools on.
import { context } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { bundleOptions, root } from './bundleOptions.mjs';
import { weatherRequestUrl } from '../../shared/weatherRequest.js';

const PORT = 8091;
const outdir = new URL('.dev/', root);
const START = { latitude: 41.8953, longitude: 12.4918 }; // Rione Monti, Rome

// What the React Native WebView injects before the page and sends after it loads
const beforeScript = `
  window.SAFE_AREA_TOP = 0;
  // The tiles of tile-provider/ (make dev, or make serve there); ?tiles=<TileJSON> another server of them
  window.TILE_URL = new URLSearchParams(location.search).get('tiles')
    ?? 'http://' + location.hostname + ':8093/tiles.json';
  // ?forceRender: keep drawing at about 60 fps when the browser reports the page
  // as hidden (e.g. a window driven by automation tools). Hidden pages get no
  // animation frames and throttled timers, but MessageChannel messages still run.
  if (new URLSearchParams(location.search).has('forceRender')) {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible' });
    const channel = new MessageChannel();
    let queue = [];
    let last = 0;
    channel.port1.onmessage = () => {
      const now = performance.now();
      if (now - last >= 16) {
        last = now;
        const callbacks = queue;
        queue = [];
        callbacks.forEach((callback) => callback(now));
      }
      if (queue.length) channel.port2.postMessage(0);
    };
    window.requestAnimationFrame = (callback) => {
      queue.push(callback);
      if (queue.length === 1) channel.port2.postMessage(0);
      return queue.length;
    };
  }
`;
const afterScript = `
  setMapActive(true);
  // As the app in development: the developer tools exist, and they are on
  setMapDevToolsAvailable(true);
  setMapDebugStatsEnabled(true);
  // ?at=lat,lon: start somewhere else (e.g. inside an area of tile-provider/output/)
  const at = new URLSearchParams(location.search).get('at')?.split(',').map(Number);
  const start = at?.length === 2 && at.every(Number.isFinite) ? { latitude: at[0], longitude: at[1] } : ${JSON.stringify(START)};
  updatePlayerLocation({ ...start, heading: 0, speed: 0, accuracy: 5, timestamp: Date.now() });
  // The live weather, asked as the app asks for it (src/features/map/hooks/useMapWeather.js)
  const weatherUrl = ${weatherRequestUrl.toString()};
  fetch(weatherUrl(start.latitude, start.longitude))
    .then((response) => response.json())
    .then((data) => setMapWeather({ data, fetchedAt: Date.now() }))
    .catch(() => {});
  new EventSource('/esbuild').addEventListener('change', () => location.reload());
`;

async function writePage() {
  const template = await readFile(new URL('src/index.html', root), 'utf8');
  const style = await readFile(new URL('src/style.css', root), 'utf8');
  const html = template
    .replace('/* STYLE */', () => style)
    .replace('<script>/* SCRIPT */</script>', () =>
      `<script>${beforeScript}</script><script src="/main.js"></script><script>${afterScript}</script>`);
  await writeFile(new URL('map.html', outdir), html);
}

// iPhone-sized frame around the map, which keeps the page's query (e.g. ?forceRender)
const framePage = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8" /><title>Map dev</title>
<style>
  html, body { margin: 0; height: 100%; background: #1d1f24; display: grid; place-items: center; }
  iframe { width: 393px; height: 852px; border: 0; border-radius: 28px; background: #000; }
</style></head>
<body><iframe id="map"></iframe>
<script>
  const frame = document.getElementById('map');
  frame.src = 'map.html' + location.search;
  const fit = () => { frame.style.transform = 'scale(' + Math.min(1, (innerHeight - 24) / 852) + ')'; };
  addEventListener('resize', fit);
  fit();
</script>
</body>
</html>
`;

await mkdir(outdir, { recursive: true });
await writeFile(new URL('index.html', outdir), framePage);
const options = await bundleOptions();
const ctx = await context({
  ...options,
  outdir: fileURLToPath(outdir),
  sourcemap: 'inline',
  define: { ...options.define, 'process.env.NODE_ENV': '"development"' },
  plugins: [
    ...options.plugins,
    { name: 'dev-page', setup: (b) => b.onEnd(writePage) }, // style.css is re-read on every rebuild
  ],
});
await ctx.watch();
await ctx.serve({ servedir: fileURLToPath(outdir), port: PORT });
console.log(`Map dev server: http://localhost:${PORT}  (tiles: make dev)`);
