// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Downloads the encoder the pipeline runs: ARM's astcenc (Apache-2.0), a pinned
// release, checked against the SHA-256 the release publishes. Into tools/ (ignored).
//   npm run tools
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '5.7.0';
const ASSETS = {
  darwin: `astcenc-${VERSION}-macos-universal.zip`,
  linux: process.arch === 'arm64' ? `astcenc-${VERSION}-linux-arm64.zip` : `astcenc-${VERSION}-linux-x64.zip`,
  win32: process.arch === 'arm64' ? `astcenc-${VERSION}-windows-arm64.zip` : `astcenc-${VERSION}-windows-x64.zip`,
};
const BASE = `https://github.com/ARM-software/astc-encoder/releases/download/${VERSION}`;
// The same release as source, for Linux systems older than its binaries (glibc < 2.38)
const SOURCE = `https://github.com/ARM-software/astc-encoder/archive/refs/tags/${VERSION}.tar.gz`;
const SOURCE_SHA256 = '7c1b28ece59c9c2737e297123a9910c1c548676c7aed87a09d5734e2fa7bdaf0';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tools = path.join(root, 'tools');
const ASTCENC = path.join(tools, 'astcenc', process.platform === 'win32' ? 'astcenc.exe' : 'astcenc');

async function download(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function runs(binary) {
  try {
    execFileSync(binary, ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// cmake + a C++ compiler, about a minute
async function compile() {
  console.log(`The astcenc build does not run on this system: compiling astcenc ${VERSION}…`);
  const tarball = await download(SOURCE);
  const actual = createHash('sha256').update(tarball).digest('hex');
  if (actual !== SOURCE_SHA256) throw new Error(`astcenc source checksum mismatch (${actual} ≠ ${SOURCE_SHA256})`);
  const work = path.join(tools, 'astcenc-source');
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, 'source.tar.gz'), tarball);
  execFileSync('tar', ['-xzf', 'source.tar.gz', '--strip-components=1'], { cwd: work });
  try {
    execFileSync('cmake', ['-S', '.', '-B', 'build', '-DCMAKE_BUILD_TYPE=Release', '-DASTCENC_ISA_NATIVE=ON'], { cwd: work, stdio: 'ignore' });
    execFileSync('cmake', ['--build', 'build', '-j'], { cwd: work, stdio: 'ignore' });
  } catch (error) {
    throw new Error(`Compiling astcenc failed: install cmake and g++ (apt install cmake g++)${error.code === 'ENOENT' ? '' : `\n${error.message}`}`);
  }
  execFileSync('cp', [path.join(work, 'build/Source/astcenc-native'), ASTCENC]);
  rmSync(work, { recursive: true, force: true });
}

export async function fetchTools() {
  if (existsSync(ASTCENC) && runs(ASTCENC)) return ASTCENC;
  const asset = ASSETS[process.platform];
  if (!asset) throw new Error(`No astcenc build for ${process.platform}`);
  console.log(`Downloading astcenc ${VERSION} (${asset})…`);
  const [zip, sums] = await Promise.all([download(`${BASE}/${asset}`), download(`${BASE}/release-sha256.txt`)]);
  const expected = sums.toString().split('\n').find((line) => line.includes(asset))?.split(/\s+/)[0];
  const actual = createHash('sha256').update(zip).digest('hex');
  if (!expected || expected !== actual) throw new Error(`astcenc checksum mismatch (${actual} ≠ ${expected})`);

  const unpacked = path.join(tools, 'astcenc-unpacked');
  rmSync(unpacked, { recursive: true, force: true });
  mkdirSync(unpacked, { recursive: true });
  const zipPath = path.join(tools, asset);
  writeFileSync(zipPath, zip);
  try {
    execFileSync('unzip', ['-q', '-o', zipPath, '-d', unpacked]);
  } catch (error) {
    throw error.code === 'ENOENT' ? new Error('unzip is missing: install it (apt install unzip)') : error;
  }
  rmSync(zipPath);

  // The archives hold several builds (one per SIMD level): the native/universal one
  const binaries = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/^astcenc(-[a-z0-9.]+)?(\.exe)?$/.test(entry.name)) binaries.push(full);
    }
  };
  walk(unpacked);
  const preferred = ['astcenc-native', 'astcenc-neon', 'astcenc-avx2', 'astcenc-sse4.1', 'astcenc'];
  const chosen = preferred.map((name) => binaries.find((file) => path.basename(file).replace('.exe', '') === name)).find(Boolean);
  if (!chosen) throw new Error(`astcenc binary not found in ${asset}: ${binaries.join(', ')}`);
  mkdirSync(path.dirname(ASTCENC), { recursive: true });
  execFileSync('cp', [chosen, ASTCENC]);
  chmodSync(ASTCENC, 0o755);
  rmSync(unpacked, { recursive: true, force: true });
  if (!runs(ASTCENC)) {
    if (process.platform !== 'linux') throw new Error(`${ASTCENC} does not run on this system`);
    await compile();
  }
  console.log(`astcenc ready: ${path.relative(root, ASTCENC)}`);
  return ASTCENC;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await fetchTools();
