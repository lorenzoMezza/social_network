// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The showcase site on this computer, as GitHub Pages serves it (make site):
//   node show-case/tools/serve-site.mjs        → http://localhost:8099
// The try-it demo needs a web server (its service worker and Python worker do not run from
// file://), and its build holds the placeholder /__DEMO_BASE__ for the address of demo/
// (show-case/tools/web/build.mjs): replaced here by /demo, as the publishing workflow
// replaces it by /<repo>/demo.
import { Buffer } from 'node:buffer';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT) || 8099;
const BASE = '/demo';
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.wasm': 'application/wasm', '.zip': 'application/zip',
  '.whl': 'application/zip', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.mp4': 'video/mp4',
  '.glb': 'model/gltf-binary', '.ktx2': 'image/ktx2', '.mvt': 'application/vnd.mapbox-vector-tile', '.ttf': 'font/ttf',
};
const TEXT = new Set(['.html', '.js', '.mjs', '.css', '.json']);
// Not part of the site
const PRIVATE = /^\/(raw|tools)(\/|$)/;

const fileFor = async (pathname) => {
  if (PRIVATE.test(pathname) || pathname.includes('\0')) return null;
  let file = path.join(ROOT, path.normalize(decodeURIComponent(pathname)));
  if (!file.startsWith(ROOT)) return null;
  const info = await stat(file).catch(() => null);
  if (info?.isDirectory()) file = path.join(file, 'index.html');
  return (await stat(file).catch(() => null))?.isFile() ? file : null;
};

const send = async (req, res, file, status = 200) => {
  const extension = path.extname(file);
  let body = await readFile(file);
  if (TEXT.has(extension)) body = Buffer.from(body.toString('utf8').replaceAll('/__DEMO_BASE__', BASE));
  // Videos are asked for in ranges (Safari plays nothing otherwise)
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
  if (range && status === 200) {
    const start = range[1] ? Number(range[1]) : body.length - Number(range[2]);
    const end = range[1] && range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
    res.writeHead(206, { 'Content-Type': TYPES[extension] ?? 'application/octet-stream', 'Content-Range': `bytes ${start}-${end}/${body.length}`, 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    res.end(body.subarray(start, end + 1));
    return;
  }
  res.writeHead(status, { 'Content-Type': TYPES[extension] ?? 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-cache' });
  res.end(body);
};

createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    const file = await fileFor(pathname);
    if (file) await send(req, res, file);
    else await send(req, res, path.join(ROOT, '404.html'), 404);
  } catch (error) {
    console.error(req.url, error);
    res.writeHead(500).end();
  }
}).listen(PORT, '127.0.0.1', () => console.log(`http://localhost:${PORT}  (Ctrl+C stops it)`));
