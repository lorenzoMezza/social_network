// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Map avatars made ahead of time (src/mapAvatar.mjs): the presets (what users who never
// saved an avatar wear) and a stand-in, so they are ready before anyone asks.
//   npm run map-avatars [-- --out <folder> --only <n>]
// The avatar server makes the others when people save their avatar.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchTools } from './fetch-tools.mjs';
import { bakeMapAvatar, mapAvatarKey } from '../src/mapAvatar.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const library = path.join(root, '../avatar-server/library');
const output = path.resolve(argument('--out', path.join(root, '../avatar-server/map-avatars')));
const only = Number(argument('--only', 0));
const catalog = JSON.parse(readFileSync(path.join(library, 'catalog.json'), 'utf8'));
const { presets } = JSON.parse(readFileSync(path.join(library, 'presets.json'), 'utf8'));
const astcenc = await fetchTools();
mkdirSync(output, { recursive: true });

const list = only ? presets.slice(0, only) : presets;
let made = 0;
for (const [i, preset] of list.entries()) {
  const key = mapAvatarKey(preset.avatar, catalog);
  if (existsSync(path.join(output, `${key}.glb`))) continue;
  const started = performance.now();
  const baked = await bakeMapAvatar(preset.avatar, { library, catalog, astcenc });
  writeFileSync(path.join(output, `${key}.ktx2`), baked.ktx2);
  writeFileSync(path.join(output, `${key}.png`), baked.png);
  writeFileSync(path.join(output, `${key}.glb`), baked.glb); // last: its presence means done
  made++;
  console.log(`${i + 1}/${list.length} ${preset.id} → ${key} ${Math.round(performance.now() - started)} ms`, JSON.stringify(baked.report));
}
console.log(`Made ${made}, ${list.length - made} already there.`);
