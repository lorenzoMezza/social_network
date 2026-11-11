// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The avatar library (avatar-server/library, built from Decentraland's avatar-assets)
// optimised once for the GPU, into avatar-server/library-astc with the same paths:
//   items/**/*.glb                         → glTF binary, ASTC KTX2 textures, meshopt geometry (src/model.mjs)
//   face textures (eyebrows, mouth)        → .ktx2 next to them; masks linear. Which
//                                            file is what comes from catalog.json
//   eyes (texture and iris mask)           → not compressed: the app shows the PNGs
//                                            (small, and where any loss shows first)
// Thumbnails stay where they are (the app's lists use the originals).
//
//   npm run avatars [-- --src <library> --out <folder> --force]
//
// Incremental: library-astc/manifest.json records each source's hash and the settings;
// a later run only redoes what changed. The report at the end sums it all up.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTools } from './fetch-tools.mjs';
import { optimizeModel } from '../src/model.mjs';
import { SETTINGS, encodeTexture } from '../src/texture.mjs';
import sharp from 'sharp';

// Bump when the output of the pipeline changes for the same input and settings
const PIPELINE_VERSION = 4;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const source = path.resolve(argument('--src', path.join(root, '../avatar-server/library')));
const output = path.resolve(argument('--out', path.join(root, '../avatar-server/library-astc')));
const force = process.argv.includes('--force');
const concurrency = Math.max(1, Math.floor(availableParallelism() / 2));
const threads = 2;

if (!existsSync(path.join(source, 'items'))) {
  console.error(`No library at ${source}: build it first (make setup).`);
  process.exit(1);
}
const astcenc = await fetchTools();
// Face textures never compressed: the eyes, where any loss reads as grain at once
const LOSSLESS = /^items\/eyes\//;
const settingsHash = createHash('sha1').update(JSON.stringify({ PIPELINE_VERSION, SETTINGS })).digest('hex').slice(0, 12);

// Every file to make: { source, targets: [relative output paths], kind }. The face
// textures and their masks as the catalog names them (masks hold data: linear)
function collect() {
  const catalog = JSON.parse(readFileSync(path.join(source, 'catalog.json'), 'utf8'));
  const faceKinds = new Map();
  for (const item of catalog.items) {
    for (const representation of Object.values(item.representations ?? {})) {
      if (representation.texture) faceKinds.set(path.normalize(representation.texture), 'face');
      if (representation.mask) faceKinds.set(path.normalize(representation.mask), 'mask');
    }
  }
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(path.relative(source, full));
    }
  };
  walk(path.join(source, 'items'));
  const jobs = new Map(); // content hash + kind → job (identical files are made once)
  for (const relative of files) {
    const kind = relative.endsWith('.glb') ? 'model' : faceKinds.get(relative) ?? null;
    if (!kind) continue;
    const bytes = readFileSync(path.join(source, relative));
    const hash = createHash('sha1').update(bytes).digest('hex');
    const target = kind === 'model' ? relative : relative.replace(/\.png$/, '.ktx2');
    // The eyes stay as they are (LOSSLESS)
    const lossless = kind !== 'model' && LOSSLESS.test(relative);
    const key = `${hash}:${kind}:${lossless}`;
    if (!jobs.has(key)) jobs.set(key, { hash, kind, lossless, source: relative, size: bytes.byteLength, targets: [] });
    jobs.get(key).targets.push(target);
  }
  return [...jobs.values()];
}

mkdirSync(output, { recursive: true });
const manifestPath = path.join(output, 'manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : { files: {} };
const jobs = collect();
// Whatever no longer comes from the library (an item removed, a file renamed) goes
const wanted = new Set(jobs.flatMap((job) => job.targets));
for (const target of Object.keys(manifest.files)) {
  if (wanted.has(target)) continue;
  rmSync(path.join(output, target), { force: true });
  delete manifest.files[target];
}
console.log(`${jobs.length} distinct files (models and face textures) from ${path.relative(process.cwd(), source)}`);

const done = (job) => !force && job.targets.every((target) => {
  const entry = manifest.files[target];
  return entry && entry.source === job.hash && entry.settings === settingsHash && (job.lossless ? entry.kept : entry.kept || existsSync(path.join(output, target)));
});

async function make(job) {
  const input = readFileSync(path.join(source, job.source));
  let bytes;
  let stats;
  if (job.lossless) {
    bytes = null;
    const meta = await sharp(input).metadata();
    stats = { textures: [{
      name: path.basename(job.source), srgb: job.kind === 'face', size: `${meta.width}x${meta.height}`, kept: true, lossless: true,
      before: input.byteLength, after: input.byteLength,
      gpuBefore: Math.round(meta.width * meta.height * 4 * 4 / 3), gpuAfter: Math.round(meta.width * meta.height * 4 * 4 / 3),
    }] };
  } else if (job.kind === 'model') {
    const result = await optimizeModel(input, { astcenc, threads });
    bytes = result.glb;
    stats = { textures: result.textures };
  } else {
    const result = await encodeTexture(input, { srgb: job.kind === 'face', astcenc, threads });
    // Too fine to compress without a visible change: no .ktx2, the app uses the PNG
    bytes = result.passed ? result.ktx2 : null;
    stats = {
      textures: [{
        name: path.basename(job.source), srgb: job.kind === 'face', size: `${result.width}x${result.height}`,
        block: result.block, ssim: Number(result.ssim.toFixed(4)), tilePsnr: Number(result.tilePsnr.toFixed(1)), alpha: result.alpha,
        before: input.byteLength, after: bytes?.byteLength ?? input.byteLength,
        gpuBefore: Math.round(result.width * result.height * 4 * 4 / 3),
        gpuAfter: result.passed ? result.gpuBytes : Math.round(result.width * result.height * 4 * 4 / 3),
        kept: !result.passed,
      }],
    };
  }
  for (const target of job.targets) {
    const file = path.join(output, target);
    if (bytes) {
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(file, bytes);
    } else rmSync(file, { force: true });
    manifest.files[target] = { source: job.hash, settings: settingsHash, before: input.byteLength, after: bytes?.byteLength ?? input.byteLength, kept: !bytes, ...stats };
  }
}

const pending = jobs.filter((job) => !done(job));
console.log(`${jobs.length - pending.length} up to date, ${pending.length} to make (${concurrency} at a time)`);
const started = Date.now();
const failures = [];
const invalid = []; // broken source files: reported, the app loads the originals
let finished = 0;
let next = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < pending.length) {
    const job = pending[next++];
    try {
      await make(job);
    } catch (error) {
      (/^Invalid glTF/.test(error.message) ? invalid : failures).push(`${job.source}: ${error.message}`);
    }
    finished++;
    if (finished % 25 === 0 || finished === pending.length) {
      const seconds = (Date.now() - started) / 1000;
      console.log(`  ${finished}/${pending.length} (${seconds.toFixed(0)} s)`);
      writeFileSync(manifestPath, JSON.stringify(manifest)); // resumable
    }
  }
}));

// Summary over the whole output
const entries = Object.values(manifest.files);
const textures = entries.flatMap((entry) => entry.textures ?? []);
const sum = (list, key) => list.reduce((total, item) => total + (item[key] ?? 0), 0);
const blocks = {};
for (const texture of textures) {
  const key = texture.kept ? 'kept' : texture.block;
  blocks[key] = (blocks[key] ?? 0) + 1;
}
const compressed = textures.filter((texture) => !texture.kept);
const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
const summary = {
  generatedAt: new Date().toISOString(),
  pipeline: PIPELINE_VERSION,
  settings: SETTINGS,
  files: entries.length,
  textures: textures.length,
  blocks,
  minSsim: compressed.length ? Math.min(...compressed.map((texture) => texture.ssim)) : null,
  minTilePsnr: compressed.length ? Math.min(...compressed.map((texture) => texture.tilePsnr ?? 99)) : null,
  download: { before: sum(entries, 'before'), after: sum(entries, 'after') },
  gpuTextures: { before: sum(textures, 'gpuBefore'), after: sum(textures, 'gpuAfter') },
};
manifest.summary = summary;
writeFileSync(manifestPath, JSON.stringify(manifest));

console.log(`\nDone in ${((Date.now() - started) / 1000).toFixed(0)} s → ${path.relative(process.cwd(), output)}`);
console.log(`  files: ${summary.files}, textures: ${summary.textures}, blocks: ${JSON.stringify(blocks)}, lowest SSIM: ${summary.minSsim}, lowest worst-area PSNR: ${summary.minTilePsnr} dB`);
console.log(`  download: ${mb(summary.download.before)} → ${mb(summary.download.after)}`);
console.log(`  GPU memory of all textures (RGBA8 with mipmaps → ASTC): ${mb(summary.gpuTextures.before)} → ${mb(summary.gpuTextures.after)}`);
if (invalid.length) console.log(`\n${invalid.length} skipped (invalid source):\n  ${invalid.join('\n  ')}`);
if (failures.length) {
  console.log(`\n${failures.length} failed:\n  ${failures.join('\n  ')}`);
  process.exitCode = 1;
}
