// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// make tiles AREA=… : the tiles of an area at the map's zoom (ZOOM, src/rules.mjs), from OpenStreetMap to one file,
// output/<area>.pmtiles, ready to serve (make serve) or to upload to a CDN.
//   1. the OpenStreetMap extract, from Geofabrik (kept in data/sources/ for a day)
//   2. Planetiler (OpenMapTiles schema) → only the layers the map draws, at ZOOM only
//      (at 15 when ZOOM is deeper: Planetiler stops there, slim.mjs cuts the tiles)
//   3. slim.mjs → only the features and attributes the map draws, roads joined
//   4. go-pmtiles → one PMTiles file
//   node scripts/tiles.mjs <area> [west,south,east,north]
import { execFileSync } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { resolveArea } from '../src/areas.mjs';
import { LAYERS, ZOOM } from '../src/rules.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { PLANETILER, PMTILES } = process.env; // the Docker images, pinned in the Makefile
// Planetiler renders up to zoom 15
const PLANETILER_ZOOM = Math.min(ZOOM, 15);
const [name, bounds] = process.argv.slice(2);
const area = resolveArea(name, bounds);
const slug = name.replaceAll('/', '-');
const data = path.join(root, 'data');
const work = path.join(data, 'work', slug);
const output = path.join(root, 'output', `${slug}.pmtiles`);
const started = Date.now();
const mb = (file) => `${(statSync(file).size / 1048576).toFixed(1)} MB`;
const step = (text) => console.log(`\n[tiles] ${text}`);

// Docker runs as this user, so what it writes can be deleted without sudo (Linux)
const user = process.getuid ? ['--user', `${process.getuid()}:${process.getgid()}`] : [];
const docker = (image, options, args) => execFileSync('docker', ['run', '--rm', ...user, '-e', 'HOME=/tmp', ...options, image, ...args], { stdio: 'inherit' });

async function download(extract) {
  const file = path.join(data, 'sources', `${extract.replaceAll('/', '-')}.osm.pbf`);
  if (existsSync(file) && Date.now() - statSync(file).mtimeMs < 24 * 3600 * 1000) return file;
  const index = await (await fetch('https://download.geofabrik.de/index-v1-nogeom.json')).json();
  const url = index.features.find((feature) => feature.properties.id === extract)?.properties.urls.pbf;
  if (!url) throw new Error(`"${extract}" is neither an area of src/areas.mjs nor a Geofabrik id (download.geofabrik.de)`);
  step(`Downloading ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  mkdirSync(path.dirname(file), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(`${file}.part`));
  renameSync(`${file}.part`, file);
  console.log(`  ${mb(file)}`);
  return file;
}

// Docker must answer; on macOS Docker Desktop is started if it is off. Every check has
// a timeout: a Docker Desktop still starting (or stuck) can leave `docker version` hanging
const dockerAnswers = () => {
  try {
    execFileSync('docker', ['version'], { stdio: 'ignore', timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
};
if (!dockerAnswers() && process.platform === 'darwin') {
  console.log('[tiles] Starting Docker Desktop…');
  try {
    execFileSync('open', ['-a', 'Docker'], { stdio: 'ignore' });
  } catch { /* not installed: the message below says so */ }
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && !dockerAnswers()) await new Promise((resolve) => { setTimeout(resolve, 2000); });
}
if (!dockerAnswers()) {
  console.error(process.platform === 'darwin'
    ? 'Docker does not answer: install or restart Docker Desktop (docker desktop restart).'
    : 'Docker does not answer: install Docker and start it (sudo systemctl start docker), with this user in the docker group.');
  process.exit(1);
}
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
mkdirSync(path.dirname(output), { recursive: true });

// 1-2. Planetiler reads the extract (the planet it downloads itself) and the ocean and
// lake shapes it needs (--download: once, into data/sources)
const osm = area.planet
  ? ['--area=planet', '--download_threads=10', '--download_chunk_size_mb=1000', '--nodemap_type=array']
  : [`--osm_path=/data/sources/${path.basename(await download(area.extract))}`];
step(`Planetiler: ${name}, zoom ${PLANETILER_ZOOM}${PLANETILER_ZOOM < ZOOM ? ` (cut to ${ZOOM} next)` : ''}, layers ${Object.keys(LAYERS).join(', ')}`);
docker(PLANETILER, ['-v', `${data}:/data`, '-e', 'JAVA_TOOL_OPTIONS=-XX:MaxRAMPercentage=75'], [
  ...osm,
  '--download',
  `--only_layers=${Object.keys(LAYERS).join(',')}`,
  `--minzoom=${PLANETILER_ZOOM}`,
  `--maxzoom=${PLANETILER_ZOOM}`,
  ...(area.bounds ? [`--bounds=${area.bounds.join(',')}`] : []),
  `--tmpdir=/data/work/${slug}/tmp`,
  `--output=/data/work/${slug}/raw.mbtiles`,
]);
const raw = path.join(work, 'raw.mbtiles');

// 3. Only what the map draws
step(`Slimming (${mb(raw)})`);
const slim = path.join(work, 'slim.mbtiles');
execFileSync(process.execPath, [path.join(root, 'scripts/slim.mjs'), raw, slim], { stdio: 'inherit' });

// 4. One PMTiles file, swapped in only when complete (a server may be reading the old one)
step('PMTiles');
docker(PMTILES, ['-v', `${root}:/work`], ['convert', `/work/data/work/${slug}/slim.mbtiles`, `/work/data/work/${slug}/${slug}.pmtiles`]);
renameSync(path.join(work, `${slug}.pmtiles`), output);
rmSync(work, { recursive: true, force: true });

const minutes = ((Date.now() - started) / 60000).toFixed(1);
step(`Done in ${minutes} min: ${path.relative(process.cwd(), output)} (${mb(output)})`);
console.log('  the map has it now if make dev (or make serve) is running');
