// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The try-it demo of the showcase site: the whole app, running in a browser, in
// show-case/demo/ (a static folder, any host). What goes in:
//   - the app itself, the Expo web build (react-native-web), the map and the avatar in
//     iframes instead of WebViews (src/web/WebView.js);
//   - its backend, backend/app, run by Pyodide (Python compiled to WebAssembly) in a worker,
//     with FastAPI, pydantic, orjson, Pillow and PyJWT next to it in demo/pyodide/;
//   - a service worker answering for the app's three servers (runtime/sw.js), a WebSocket
//     shim and a fixed GPS position in Rome (runtime/boot.js);
//   - the avatar files the demo people and the editor need, and the map looks of the demo
//     people baked in advance by the avatar server;
//   - the map tiles around the demo's spot, cut out of tile-provider/output/roma.pmtiles.
//
//   node show-case/tools/web/build.mjs [--base /path/demo]
// The address of demo/ on the site is not known here (GitHub Pages: /<repo>/demo): the build
// writes the placeholder /__DEMO_BASE__ instead, replaced when the site is published
// (.github/workflows/pages.yml) or served (show-case/tools/serve-site.mjs, make site).
// --base writes a real path instead. Needs the avatar server running (make dev, or
// show-case/tools/serve.sh) to bake the map looks.
import { Buffer } from 'node:buffer';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../../..');
const showcase = path.join(root, 'show-case');
const out = path.join(showcase, 'demo');
const cache = path.join(showcase, 'raw', 'web-cache');
const args = process.argv.slice(2);
const base = (args[args.indexOf('--base') + 1] && args.includes('--base') ? args[args.indexOf('--base') + 1] : '/__DEMO_BASE__').replace(/\/$/, '');

const PYODIDE = '314.0.7';
const PYODIDE_CDN = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE}/full/`;
const PYJWT = '2.10.1';
const HOME = { latitude: 41.8953, longitude: 12.4918 };
const TILE_RADIUS_M = 3500;
const AVATAR_SERVER = process.env.AVATAR_SERVER ?? 'http://127.0.0.1:8092';
const PRESETS_KEPT = 16; // the first presets of the library, plus those of the demo people
const ITEMS_PER_CATEGORY = 6; // and the first wearables of each category, for the editor
const HOSTS = ['alex', 'giulia', 'marco', 'luca', 'sofia', 'chiara', 'paolo', 'elena', 'irene', 'davide', 'fabio'];

const step = (text) => console.log(`\n== ${text}`);
const sizeOf = (target) => {
  const info = statSync(target);
  return info.isFile() ? info.size : readdirSync(target).reduce((sum, name) => sum + sizeOf(path.join(target, name)), 0);
};
const mb = (bytes) => `${(bytes / 1e6).toFixed(1)} MB`;
const download = async (url, file) => {
  if (existsSync(file)) return file;
  mkdirSync(path.dirname(file), { recursive: true });
  const answer = await fetch(url);
  if (!answer.ok) throw new Error(`${url}: ${answer.status}`);
  writeFileSync(file, Buffer.from(await answer.arrayBuffer()));
  return file;
};

// --- 1. The app ---
step(`Expo web build (served at ${base}/)`);
rmSync(out, { recursive: true, force: true });
execFileSync('npx', ['expo', 'export', '--platform', 'web', '--output-dir', out, '--clear'], {
  cwd: root,
  stdio: ['ignore', 'ignore', 'inherit'],
  env: {
    ...process.env,
    EXPO_PUBLIC_SHOWCASE: '1',
    EXPO_PUBLIC_API_URL: 'https://api.demo.invalid/v1',
    EXPO_PUBLIC_AVATAR_URL: 'https://avatars.demo.invalid',
    EXPO_PUBLIC_TILE_URL: 'https://tiles.demo.invalid/tiles.json',
    EXPO_WEB_BASE_URL: base,
  },
});

// The packages' own assets (the icon fonts) come out under assets/node_modules/, a folder
// name every .gitignore leaves out, so they would never reach the published site: moved to
// assets/vendor/, and the scripts that name them changed with them
const vendored = path.join(out, 'assets', 'node_modules');
if (existsSync(vendored)) {
  renameSync(vendored, path.join(out, 'assets', 'vendor'));
  const scriptsDir = path.join(out, '_expo', 'static', 'js', 'web');
  for (const name of readdirSync(scriptsDir)) {
    const file = path.join(scriptsDir, name);
    const text = readFileSync(file, 'utf8');
    if (text.includes('/assets/node_modules/')) writeFileSync(file, text.replaceAll('/assets/node_modules/', '/assets/vendor/'));
  }
}

// The page: boot.js first, the app's scripts once the backend answers
const page = path.join(out, 'index.html');
let html = readFileSync(page, 'utf8');
const scripts = [...html.matchAll(/<script src="([^"]+)"[^>]*><\/script>/g)].map((match) => match[1]);
if (!scripts.length) throw new Error('No scripts in the exported index.html');
html = html.replace(/<script src="[^"]+"[^>]*><\/script>/g, '');
html = html.replace('</head>', `<link rel="stylesheet" href="${base}/demo.css"><script>window.DEMO_BASE=${JSON.stringify(`${base}/`)};window.DEMO_SCRIPTS=${JSON.stringify(scripts)}</script><script src="${base}/boot.js"></script></head>`);
writeFileSync(page, html);
for (const file of ['boot.js', 'sw.js', 'backend-worker.js', 'demo.css']) cpSync(path.join(here, 'runtime', file), path.join(out, file));

// --- 2. Python ---
step(`Pyodide ${PYODIDE} and the packages the backend imports`);
const pyCache = path.join(cache, `pyodide-${PYODIDE}`);
const pyOut = path.join(out, 'pyodide');
mkdirSync(pyOut, { recursive: true });
for (const file of ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json']) {
  cpSync(await download(PYODIDE_CDN + file, path.join(pyCache, file)), path.join(pyOut, file));
}
const lock = JSON.parse(readFileSync(path.join(pyOut, 'pyodide-lock.json'), 'utf8'));
const wanted = ['fastapi', 'orjson', 'pillow', 'httpx', 'cryptography'];
const needed = new Set();
const visit = (name) => {
  const key = name.toLowerCase().replace(/_/g, '-');
  if (needed.has(key)) return;
  const entry = lock.packages[key];
  if (!entry) throw new Error(`Pyodide has no package ${name}`);
  needed.add(key);
  for (const dependency of entry.depends ?? []) visit(dependency);
};
wanted.forEach(visit);
for (const name of needed) {
  const file = lock.packages[name].file_name;
  cpSync(await download(PYODIDE_CDN + file, path.join(pyCache, file)), path.join(pyOut, file));
}
// PyJWT is pure Python, not part of Pyodide: its wheel from PyPI
const pypi = await (await fetch(`https://pypi.org/pypi/PyJWT/${PYJWT}/json`)).json();
const wheel = pypi.urls.find((entry) => entry.filename.endsWith('-py3-none-any.whl'));
cpSync(await download(wheel.url, path.join(pyCache, wheel.filename)), path.join(pyOut, wheel.filename));
console.log(`${needed.size} packages + ${wheel.filename}: ${mb(sizeOf(pyOut))}`);

// --- 3. The avatars ---
step('Avatar files of the demo');
const library = path.join(root, 'avatar-server', 'library');
const catalog = JSON.parse(readFileSync(path.join(library, 'catalog.json'), 'utf8'));
const { presets } = JSON.parse(readFileSync(path.join(library, 'presets.json'), 'utf8'));
const people = JSON.parse(execFileSync(path.join(root, 'backend', '.venv', 'bin', 'python'), ['-c', [
  'import os, json',
  "os.environ['DEV_TOOLS'] = '1'; os.environ['PERSIST'] = '0'",
  'from app import seed',
  'print(json.dumps({seed.bot_id(name): [name, entry[2]] for name, entry in seed.PEOPLE.items()}))',
].join('\n')], { cwd: path.join(root, 'backend'), env: { ...process.env, DEV_TOOLS: '1', PERSIST: '0' } }).toString().trim().split('\n').pop());
const botPresets = new Set(Object.values(people).map(([, preset]) => preset).filter(Boolean));
const keptPresets = presets.filter((preset, index) => index < PRESETS_KEPT || botPresets.has(preset.id));
const items = new Map(catalog.items.map((item) => [item.id, item]));
const keptItems = new Set(catalog.bodyShapes);
for (const preset of keptPresets) {
  for (const id of Object.values(preset.avatar.wearables)) if (id) keptItems.add(id);
}
const perCategory = {};
for (const item of catalog.items) {
  perCategory[item.category] = (perCategory[item.category] ?? 0) + 1;
  if (perCategory[item.category] <= ITEMS_PER_CATEGORY) keptItems.add(item.id);
}
for (const id of keptItems) if (!items.has(id)) throw new Error(`A preset wears ${id}, which the catalog has not`);
const demoCatalog = { ...catalog, items: catalog.items.filter((item) => keptItems.has(item.id)) };
const demoPresets = { format: 'masterkey.avatar-presets', version: 1, presets: keptPresets };
const avatarsOut = path.join(out, 'avatars');
mkdirSync(avatarsOut, { recursive: true });
writeFileSync(path.join(avatarsOut, 'catalog.json'), JSON.stringify(demoCatalog));
writeFileSync(path.join(avatarsOut, 'presets.json'), JSON.stringify(demoPresets));
const files = new Set();
for (const item of demoCatalog.items) {
  if (item.thumbnail) files.add(item.thumbnail);
  for (const representation of Object.values(item.representations ?? {})) {
    for (const value of Object.values(representation)) if (typeof value === 'string' && value.startsWith('items/')) files.add(value);
  }
}
for (const emote of catalog.emotes ?? []) for (const file of Object.values(emote.files ?? {})) files.add(file);
for (const preset of keptPresets) if (preset.image) files.add(preset.image);
for (const file of files) {
  const from = path.join(library, file);
  if (!existsSync(from)) continue;
  mkdirSync(path.dirname(path.join(avatarsOut, 'files', file)), { recursive: true });
  cpSync(from, path.join(avatarsOut, 'files', file));
}
console.log(`${demoCatalog.items.length} of ${catalog.items.length} items, ${keptPresets.length} presets: ${mb(sizeOf(avatarsOut))}`);

// The look of everyone in the demo, as the backend picks it (avatars.preset_for): their own
// preset for the demo people, else one by a hash of their id over the presets it has
const presetFor = (userId, wanted) => keptPresets.find((preset) => preset.id === wanted)?.avatar
  ?? keptPresets[createHash('sha1').update(userId).digest().readUInt32BE(0) % keptPresets.length].avatar;
const lookOf = (avatar) => Object.fromEntries(['format', 'version', 'bodyShape', 'colors', 'wearables'].map((key) => [key, avatar[key] ?? null]));
const everyone = [
  ...Object.entries(people).map(([id, [, preset]]) => [id, preset]),
  ...HOSTS.map((name) => [`showcase.${name}`, null]),
];
step(`Map looks of ${everyone.length} people, from the avatar server (${AVATAR_SERVER})`);
const mapOut = path.join(avatarsOut, 'map');
mkdirSync(mapOut, { recursive: true });
const mapAvatars = path.join(root, 'avatar-server', 'map-avatars');
const copyLook = (key) => {
  for (const extension of ['glb', 'ktx2', 'png']) {
    const from = path.join(mapAvatars, `${key}.${extension}`);
    if (existsSync(from)) cpSync(from, path.join(mapOut, `${key}.${extension}`));
  }
};
const looks = [];
const baked = new Map();
for (const [id, preset] of everyone) {
  const look = lookOf(presetFor(id, preset));
  const canonical = JSON.stringify(look);
  if (!baked.has(canonical)) {
    const answer = await fetch(`${AVATAR_SERVER}/v1/map-avatars`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: canonical });
    if (!answer.ok) throw new Error(`The avatar server did not bake ${id}: ${answer.status} (is it running? make dev)`);
    const { key } = await answer.json();
    baked.set(canonical, key);
    looks.push([look, key]);
    copyLook(key);
  }
}
const standIn = await (await fetch(`${AVATAR_SERVER}/v1/map-avatars/stand-in`)).json();
copyLook(standIn.key);
writeFileSync(path.join(avatarsOut, 'stand-in.json'), JSON.stringify(standIn));
console.log(`${looks.length} looks: ${mb(sizeOf(mapOut))}`);

// --- 4. The backend ---
step('The backend (backend/app) as one archive');
const backendOut = path.join(out, 'backend');
const stage = path.join(cache, 'backend-stage');
rmSync(stage, { recursive: true, force: true });
cpSync(path.join(root, 'backend', 'app'), path.join(stage, 'backend', 'app'), { recursive: true, filter: (from) => !from.includes('__pycache__') });
cpSync(path.join(here, 'py', 'webdemo.py'), path.join(stage, 'backend', 'webdemo.py'));
mkdirSync(path.join(stage, 'library'), { recursive: true });
writeFileSync(path.join(stage, 'library', 'catalog.json'), JSON.stringify(demoCatalog));
writeFileSync(path.join(stage, 'library', 'presets.json'), JSON.stringify(demoPresets));
mkdirSync(backendOut, { recursive: true });
execFileSync('python3', ['-c', [
  'import os, sys, zipfile',
  'stage, target = sys.argv[1], sys.argv[2]',
  "with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:",
  '    for folder, _, names in os.walk(stage):',
  '        for name in names:',
  '            full = os.path.join(folder, name)',
  '            archive.write(full, os.path.relpath(full, stage))',
].join('\n'), stage, path.join(backendOut, 'backend.zip')]);
writeFileSync(path.join(backendOut, 'manifest.json'), JSON.stringify({
  packages: [...needed],
  wheels: [wheel.filename],
  env: {
    SHOWCASE: '1', DEV_TOOLS: '1', PERSIST: '1', DATA_DIR: '/data', AVATAR_LIBRARY: '/library', AVATAR_BAKER_URL: '',
    PUBLIC_URL: 'https://api.demo.invalid', ASSETS_URL: 'https://avatars.demo.invalid/v1/files',
  },
  looks,
  home: HOME,
}));
cpSync(path.join(showcase, 'tools', 'scene.mjs'), path.join(out, 'scene.mjs'));
console.log(mb(sizeOf(backendOut)));

// --- 5. The tiles ---
step(`Map tiles within ${TILE_RADIUS_M / 1000} km`);
const { PMTiles } = await import(path.join(root, 'tile-provider', 'node_modules', 'pmtiles', 'dist', 'esm', 'index.js'));
const archiveFile = path.join(root, 'tile-provider', 'output', 'roma.pmtiles');
const handle = await open(archiveFile);
const archive = new PMTiles({
  getKey: () => archiveFile,
  async getBytes(offset, length) {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, offset);
    return { data: buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + bytesRead) };
  },
});
const header = await archive.getHeader();
const metadata = await archive.getMetadata();
const tilesOut = path.join(out, 'tiles');
const toTile = (z, latitude, longitude) => {
  const n = 2 ** z;
  const x = Math.floor(((longitude + 180) / 360) * n);
  const rad = (latitude * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(rad) + 1 / Math.cos(rad)) / Math.PI) / 2) * n);
  return [x, y];
};
const dLat = TILE_RADIUS_M / 111_320;
const dLon = TILE_RADIUS_M / (111_320 * Math.cos((HOME.latitude * Math.PI) / 180));
let count = 0;
for (let z = header.minZoom; z <= header.maxZoom; z++) {
  const [x0, y0] = toTile(z, HOME.latitude + dLat, HOME.longitude - dLon);
  const [x1, y1] = toTile(z, HOME.latitude - dLat, HOME.longitude + dLon);
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const tile = await archive.getZxy(z, x, y);
      if (!tile) continue;
      mkdirSync(path.join(tilesOut, String(z), String(x)), { recursive: true });
      writeFileSync(path.join(tilesOut, String(z), String(x), `${y}.mvt`), Buffer.from(tile.data));
      count++;
    }
  }
}
await handle.close();
writeFileSync(path.join(tilesOut, 'tiles.json'), JSON.stringify({
  tilejson: '3.0.0',
  name: 'roma (demo)',
  attribution: '© OpenMapTiles © OpenStreetMap contributors',
  tiles: ['https://tiles.demo.invalid/{z}/{x}/{y}.mvt'],
  minzoom: header.minZoom,
  maxzoom: header.maxZoom,
  bounds: [HOME.longitude - dLon, HOME.latitude - dLat, HOME.longitude + dLon, HOME.latitude + dLat],
  vector_layers: metadata?.vector_layers ?? [],
}));
console.log(`${count} tiles: ${mb(sizeOf(tilesOut))}`);

step(`show-case/demo: ${mb(sizeOf(out))}`);
