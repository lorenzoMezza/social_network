// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The legal texts the app shows, made from their sources:
//   node scripts/legal.mjs
//
//  - legal/en/*.md and legal/it/*.md (privacy policy, terms, community guidelines, each
//    in full and in short) → src/features/legal/documents.js, shown by the app in the
//    user's language
//  - the notices the app must carry (what it ships under a licence that asks for its
//    notice: see "Third-party notices" below) → src/features/legal/thirdParty.js
//    (Settings → Licenses) and legal/THIRD-PARTY-NOTICES.md. Texts that differ only in
//    their copyright lines are stored once, with each package's own copyright lines.
//
// Run again after changing a document or the dependencies (it exports the app's
// bundle to see what is in it: about a minute).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => readFileSync(path.join(root, file), 'utf8');

// --- Documents ---
// Each in two versions: the full text, the one that applies, and a short one in plain
// words for the users, saying the same things (the app shows both, short first)
const DOCUMENTS = {
  privacy: {
    full: { en: 'legal/en/privacy-policy.md', it: 'legal/it/informativa-privacy.md' },
    short: { en: 'legal/en/privacy-policy-short.md', it: 'legal/it/informativa-privacy-breve.md' },
  },
  terms: {
    full: { en: 'legal/en/terms-of-use.md', it: 'legal/it/termini-di-utilizzo.md' },
    short: { en: 'legal/en/terms-of-use-short.md', it: 'legal/it/termini-di-utilizzo-breve.md' },
  },
  guidelines: {
    full: { en: 'legal/en/community-guidelines.md', it: 'legal/it/linee-guida-community.md' },
    short: { en: 'legal/en/community-guidelines-short.md', it: 'legal/it/linee-guida-community-breve.md' },
  },
};
const mapValues = (object, fn) => Object.fromEntries(Object.entries(object).map(([key, value]) => [key, fn(value)]));
const documents = mapValues(DOCUMENTS, (versions) => mapValues(versions, (files) => mapValues(files, read)));
writeFileSync(path.join(root, 'src/features/legal/documents.js'), `// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Made by scripts/legal.mjs from legal/: do not edit here.
// { [document]: { full: { en, it }, short: { en, it } } } (markdown)
export const DOCUMENTS = ${JSON.stringify(documents, null, 2)};
`);

// --- Third-party notices ---
// Only what a licence obliges us to credit: the works the app really ships (in the
// JavaScript bundle, in the native binary, in the WebView pages, the avatar assets and
// the map and weather data) under a licence that requires its notice with every copy.
// Build tools and dev servers never reach a phone; licences such as CC0, 0BSD,
// Unlicense, MIT-0, BSL-1.0 (boost) or zlib ask for nothing in a compiled app.
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([.-](md|txt|markdown|mit))?$/i;
const COPYRIGHT = /^\s*(copyright\b|\(c\)|©)/i;
const NO_NOTICE = /^(0BSD|CC0-1\.0|Unlicense|WTFPL|MIT-0|BSL-1\.0|Zlib)$/i;
// Whether some choice of the licence ("A OR B", "A AND B") requires the notice
const needsNotice = (license) => !license.replace(/[()]/g, '').split(/\s+OR\s+/i)
  .some((choice) => choice.split(/\s+AND\s+/i).every((part) => NO_NOTICE.test(part.trim())));

function licenseFiles(dir) {
  try {
    return readdirSync(dir).filter((name) => LICENSE_FILE.test(name)).sort((a, b) => /notice/i.test(a) - /notice/i.test(b));
  } catch {
    return [];
  }
}

// The package folder a file belongs to: .../node_modules/<name> or .../node_modules/@scope/<name>
function packageDir(file) {
  const at = file.lastIndexOf('/node_modules/');
  if (at < 0) return null;
  const rest = file.slice(at + '/node_modules/'.length).split('/');
  return file.slice(0, at + '/node_modules/'.length) + (rest[0].startsWith('@') ? `${rest[0]}/${rest[1]}` : rest[0]);
}

const shipped = new Set(); // package folders

// 1. The app's JavaScript bundle (both platforms): every module in its source maps
const exportDir = mkdtempSync(path.join(tmpdir(), 'legal-export-'));
try {
  execFileSync('npx', ['expo', 'export', '--platform', 'ios', '--platform', 'android', '--source-maps', '--output-dir', exportDir], { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  const maps = execFileSync('find', [exportDir, '-name', '*.map'], { encoding: 'utf8' }).split('\n').filter(Boolean);
  if (!maps.length) throw new Error('no source maps in the export');
  for (const map of maps) {
    for (const source of JSON.parse(readFileSync(map, 'utf8')).sources) {
      // Paths are the project's own, from its root ("/node_modules/…")
      const dir = packageDir(existsSync(source) ? source : path.join(root, source));
      if (dir) shipped.add(dir);
    }
  }
} finally {
  rmSync(exportDir, { recursive: true, force: true });
}

// 2. Native modules linked into the release binary, with or without JavaScript
// The package folder of a linked module: up from any of its native folders
const modulePackage = (module) => {
  const folders = JSON.stringify(module).match(/"\/[^"]+"/g)?.map((text) => JSON.parse(text)) ?? [];
  for (let dir of folders) {
    while (dir.length > root.length) {
      const manifest = path.join(dir, 'package.json');
      if (existsSync(manifest) && JSON.parse(readFileSync(manifest, 'utf8')).name === module.packageName) return dir;
      dir = path.dirname(dir);
    }
  }
  return null;
};
for (const platform of ['ios', 'android']) {
  const modules = JSON.parse(execFileSync('npx', ['expo-modules-autolinking', 'resolve', '--platform', platform, '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).modules;
  for (const module of modules) {
    // Debug tools never ship; our own modules (modules/) are not third-party works
    if (module.debugOnly || JSON.stringify(module).includes(`${path.join(root, 'modules')}/`)) continue;
    const dir = modulePackage(module);
    if (dir) shipped.add(dir);
    else console.warn(`Linked module not found: ${module.packageName}`);
  }
  const config = JSON.parse(execFileSync('npx', ['expo-modules-autolinking', 'react-native-config', '--platform', platform, '--json'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  for (const dependency of Object.values(config.dependencies ?? {})) {
    if (dependency.root && existsSync(path.join(dependency.root, 'package.json'))) shipped.add(dependency.root);
  }
}

// 3. The WebView pages (map, its tile worker, avatar viewer): esbuild's list of inputs
const webviewInputs = async (folder, options) => {
  const { build } = createRequire(path.join(root, folder, 'package.json'))('esbuild');
  const result = await build({ ...options, bundle: true, write: false, metafile: true, logLevel: 'silent' });
  return Object.keys(result.metafile.inputs).map((input) => path.resolve(process.cwd(), input.replace(/^[a-z-]+:/, '')));
};
const { bundleOptions } = await import(pathToFileURL(path.join(root, 'webview/map/scripts/bundleOptions.mjs')).href);
const inputs = [
  ...(await webviewInputs('webview/map', { ...(await bundleOptions()), define: { 'process.env.NODE_ENV': '"production"' } })),
  ...(await webviewInputs('webview/map', { entryPoints: [path.join(root, 'webview/three-geo-play/src/map/tileGeometryWorker.js')], format: 'iife' })),
  ...(await webviewInputs('webview/avatar', { entryPoints: [path.join(root, 'webview/avatar/src/main.js')], format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } })),
];
for (const input of inputs) {
  const dir = packageDir(input);
  if (dir) shipped.add(dir);
  // Our copy of lm-three-geo-play (MIT), compiled from its sources
  if (input.startsWith(path.join(root, 'webview/three-geo-play/src/'))) shipped.add(path.join(root, 'webview/three-geo-play'));
}

// Every installed production package, for the usual text of a licence whose package
// ships none (see below)
const packages = new Map(); // name@version → { name, version, license, text, author }
function readPackage(dir) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  if (!manifest.name || !manifest.version) return null;
  const id = `${manifest.name}@${manifest.version}`;
  if (!packages.has(id)) {
    const text = licenseFiles(dir).map((name) => readFileSync(path.join(dir, name), 'utf8').trim()).join('\n\n');
    const license = typeof manifest.license === 'string' ? manifest.license : manifest.license?.type ?? (manifest.licenses?.map((entry) => entry.type).join(' OR ') || 'UNKNOWN');
    const author = typeof manifest.author === 'string' ? manifest.author.replace(/\s*[<(].*$/, '') : manifest.author?.name ?? null;
    packages.set(id, { name: manifest.name, version: manifest.version, license, text, author, private: !!manifest.private });
  }
  return id;
}
for (const folder of ['.', 'webview/map', 'webview/avatar']) {
  for (const dir of productionPackages(folder)) readPackage(dir);
}

// Production packages under a folder with a package.json (npm's own view of the tree)
function productionPackages(folder) {
  if (!existsSync(path.join(root, folder, 'node_modules'))) return [];
  let out = '';
  try {
    out = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], { cwd: path.join(root, folder), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    out = error.stdout ?? ''; // npm ls exits non-zero for extraneous packages, still listing them
  }
  return out.split('\n').map((line) => line.trim()).filter(Boolean).slice(1);
}

// Works shipped that are not npm packages of their own, their texts kept in
// legal/notices/: the libraries React Native compiles into the binary (fmt, with its
// binary exception, boost, BSL-1.0, and fast_float, BSL-1.0 among its choices, need no
// notice) and the Ionicons font, inside @expo/vector-icons (the only icon set the app
// imports: import Ionicons from '@expo/vector-icons/Ionicons', never the package's
// index, which would bundle all its fonts)
const NATIVE = [
  { name: 'Ionicons (font)', version: `in @expo/vector-icons ${JSON.parse(read('node_modules/@expo/vector-icons/package.json')).version}`, license: 'MIT', file: 'ionicons.txt' },
  { name: 'Hermes', version: `React Native ${JSON.parse(read('node_modules/react-native/package.json')).version}`, license: 'MIT', file: 'hermes.txt' },
  { name: 'Folly', version: '2024.11.18.00', license: 'Apache-2.0', file: 'folly.txt', author: 'Meta Platforms, Inc. and affiliates' },
  { name: 'glog', version: '0.3.5', license: 'BSD-3-Clause', file: 'glog.txt' },
  { name: 'double-conversion', version: '1.1.6', license: 'BSD-3-Clause', file: 'double-conversion.txt' },
  { name: 'SocketRocket', version: '0.7.1', license: 'BSD-3-Clause', file: 'SocketRocket.txt' },
];

const credited = new Set(); // name@version
for (const dir of shipped) {
  const id = readPackage(dir);
  if (id && !packages.get(id).private) credited.add(id);
}
for (const item of NATIVE) {
  const id = `${item.name}@${item.version}`;
  packages.set(id, { ...item, text: read(`legal/notices/${item.file}`).trim(), author: item.author ?? null });
  credited.add(id);
}

// Texts equal but for their copyright lines are one group
const split = (text) => {
  const lines = text.split('\n');
  return {
    copyright: lines.filter((line) => COPYRIGHT.test(line)).map((line) => line.trim()).slice(0, 4),
    body: lines.filter((line) => !COPYRIGHT.test(line)).join('\n').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim(),
  };
};
// A package that declares a licence without shipping its text gets the licence's
// usual text (the one most packages with that licence ship), with its author as the
// copyright holder. "A OR B" licences are taken as their first choice.
const firstChoice = (license) => license.replace(/[()]/g, '').split(/\s+OR\s+/)[0].trim();
const canonical = new Map(); // licence → { body, count }
for (const entry of packages.values()) {
  if (!entry.text) continue;
  const { body } = split(entry.text);
  const license = firstChoice(entry.license);
  const counts = canonical.get(license) ?? new Map();
  counts.set(body, (counts.get(body) ?? 0) + 1);
  canonical.set(license, counts);
}
const usualText = (license) => {
  const counts = canonical.get(firstChoice(license));
  return counts ? [...counts].sort((a, b) => b[1] - a[1])[0][0] : null;
};
const groups = new Map(); // normalised text → { license, text, packages: [] }
const skipped = [];
for (const entry of [...credited].map((id) => packages.get(id)).sort((a, b) => a.name.localeCompare(b.name))) {
  if (!needsNotice(entry.license)) {
    skipped.push(`${entry.name} (${entry.license})`);
    continue;
  }
  let { copyright, body } = split(entry.text);
  if (!body) {
    body = usualText(entry.license) ?? '';
    if (entry.author) copyright = [`Copyright (c) ${entry.author}`];
  } else if (!copyright.length && entry.author) {
    copyright = [`Copyright (c) ${entry.author}`];
  }
  const key = body || `(no licence file: ${entry.license})`;
  if (!groups.has(key)) groups.set(key, { license: firstChoice(entry.license), text: body || `The package declares the ${entry.license} licence but ships no licence text.`, packages: [] });
  groups.get(key).packages.push([entry.name, entry.version, copyright.join(' · ')]);
}

// What is not an npm package: assets and data
const assets = [
  {
    name: 'Decentraland avatar assets',
    detail: 'Avatar bodies, wearables, face textures and emotes, served to the app by our servers. github.com/decentraland/avatar-assets',
    license: 'Apache-2.0',
    text: existsSync(path.join(root, 'avatar-server/source/LICENSE')) ? read('avatar-server/source/LICENSE').trim() : 'Apache License 2.0',
  },
  {
    name: 'Decentraland unity-explorer animations',
    detail: 'Idle, walk, jog and run animations, converted (sampled, mirrored, reduced). github.com/decentraland/unity-explorer',
    license: 'Apache-2.0',
    text: read('assets/models/decentraland/LICENSE').trim(),
  },
];
// Shown only in Settings → Licenses (not on the map): OSMF Attribution Guideline,
// "Computer games and simulations" (credits page or menu), with the link to the
// licence information
const data = [
  { name: 'OpenStreetMap', detail: 'Map data © OpenStreetMap contributors, available under the Open Database License (ODbL).', url: 'https://www.openstreetmap.org/copyright' },
  { name: 'OpenMapTiles', detail: 'Vector tile schema © OpenMapTiles, CC BY 4.0.', url: 'https://openmaptiles.org' },
  { name: 'Open-Meteo', detail: 'Weather data by Open-Meteo.com, CC BY 4.0.', url: 'https://open-meteo.com' },
];

const notices = { data, assets, groups: [...groups.values()].sort((a, b) => b.packages.length - a.packages.length) };
writeFileSync(path.join(root, 'src/features/legal/thirdParty.js'), `// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Made by scripts/legal.mjs from the installed packages: do not edit here.
// data: attributions; assets: { name, detail, license, text };
// groups: { license, text, packages: [[name, version, copyright]] }
export const NOTICES = ${JSON.stringify(notices)};
`);

const markdown = [
  '# Third-party notices',
  '',
  'Made by `scripts/legal.mjs`. The app includes or uses the following works.',
  '',
  '## Data',
  '',
  ...data.map((item) => `- **${item.name}**: ${item.detail} ${item.url}`),
  '',
  '## Assets',
  '',
  ...assets.flatMap((item) => [`### ${item.name} (${item.license})`, '', item.detail, '', '```', item.text, '```', '']),
  '## Software',
  '',
  ...notices.groups.flatMap((group) => [
    `### ${group.license} (${group.packages.length})`,
    '',
    ...group.packages.map(([name, version, copyright]) => `- ${name} ${version}${copyright ? ` — ${copyright}` : ''}`),
    '',
    '```',
    group.text,
    '```',
    '',
  ]),
].join('\n');
writeFileSync(path.join(root, 'legal/THIRD-PARTY-NOTICES.md'), markdown);

const listed = [...credited].map((id) => packages.get(id)).filter((entry) => needsNotice(entry.license));
const unknown = listed.filter((entry) => entry.license === 'UNKNOWN' || (!entry.text && !usualText(entry.license)));
console.log(`${listed.length} shipped works credited in ${groups.size} licence texts (of ${packages.size} installed packages); ${assets.length} assets; ${data.length} data sources.`);
if (skipped.length) console.log(`Shipped, no notice required: ${skipped.join(', ')}`);
if (unknown.length) console.log(`Licence unknown or without a text (check them): ${unknown.map((entry) => `${entry.name}@${entry.version} (${entry.license})`).join(', ')}`);
const licenses = new Map();
for (const entry of listed) licenses.set(entry.license, (licenses.get(entry.license) ?? 0) + 1);
console.log([...licenses].sort((a, b) => b[1] - a[1]).map(([license, count]) => `${license}: ${count}`).join(', '));
