// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Classifies the Decentraland avatar assets (source/, see fetch-source.mjs) into
// library/, the folder the avatar server serves:
//
//   library/catalog.json                      every item, in the format of shared/avatarFormat.js
//   library/presets.json                      ready-made avatars (Decentraland default profiles),
//                                             with a face picture in library/items/presets/
//   library/items/emotes/<emote>/<shape>.glb  a few emotes (wave, clap…) to bring avatars to life
//   library/items/<category>/<id>/            the files of one item, with plain names:
//       thumbnail.png
//       model.glb | male.glb + female.glb     (model items: one file, or one per body shape)
//       texture.png [+ texture_mask.png]      (face items: eyes, eyebrows, mouth;
//                                              male/female.png when they differ)
//
// Files are hard-linked from source/ (no second copy of ~640 MB). Run it again after
// updating source/:  npm --prefix avatar-server run build
import { existsSync } from 'node:fs';
import { copyFile, link, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AVATAR_FORMAT, AVATAR_VERSION, BODY_SHAPES, CATALOG_FORMAT, CATALOG_VERSION, CATEGORIES, PALETTES, categoryInfo, validateAvatar,
} from '../shared/avatarFormat.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = path.join(root, 'source');
const library = path.join(root, 'library');
const REPOSITORY = 'https://github.com/decentraland/avatar-assets';
const LICENSE = 'Apache-2.0';
// Typos and old names in the source metadata
const CATEGORY_ALIASES = { hairs: 'hair' };
const BODY_SLOTS = new Set(['upper_body', 'lower_body', 'feet']);

if (!existsSync(path.join(source, 'assets'))) {
  console.error('source/ is missing: run `make setup` first.');
  process.exit(1);
}

async function* findAssetFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* findAssetFiles(full);
    else if (entry.name === 'asset.json') yield full;
  }
}

// "dcl://base-avatars/BaseFemale", "urn:decentraland:off-chain:base-avatars:basefemale" → our body shape id
const bodyShapeOf = (type) => (/basemale$/i.test(type) ? BODY_SHAPES.male : /basefemale$/i.test(type) ? BODY_SHAPES.female : null);
const slug = (id) => id.replace(/[^a-z0-9_-]+/gi, '__');
const readJson = async (file) => JSON.parse((await readFile(file)).toString('utf8').replace(/^﻿/, ''));

async function place(from, to) {
  await mkdir(path.dirname(to), { recursive: true });
  try {
    await link(from, to);
  } catch {
    await copyFile(from, to);
  }
}

// The parts of the bare body (avatarFormat BODY_PARTS) a model has its own geometry
// for, so the body's part can go under it without leaving a hole: each vertex counts
// for the bone that moves it most (Avatar_[Left|Right]<bone>). Hands need the palm and
// four of the five fingers: a ring or a watch is no hand. Null when the geometry is
// compressed (not read here); throws when the file is not a valid GLB.
function bodyPartsOf(glb) {
  if (glb.readUInt32LE(0) !== 0x46546c67) throw new Error('no GLB header');
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength));
  if (json.extensionsRequired?.some((name) => /compression/i.test(name))) return null;
  const binary = 20 + jsonLength + 8;
  const accessor = (index) => {
    const { bufferView, byteOffset = 0, componentType, type, count } = json.accessors[index];
    const view = json.bufferViews[bufferView];
    const bytes = { 5121: 1, 5123: 2, 5125: 4, 5126: 4 }[componentType];
    const read = { 5121: 'readUInt8', 5123: 'readUInt16LE', 5125: 'readUInt32LE', 5126: 'readFloatLE' }[componentType];
    const stride = view.byteStride || bytes * { VEC4: 4 }[type];
    const start = binary + (view.byteOffset ?? 0) + byteOffset;
    return { count, get: (vertex, component) => glb[read](start + vertex * stride + component * bytes) };
  };
  const bones = {};
  for (const node of json.nodes ?? []) {
    if (node.mesh === undefined || node.skin === undefined) continue;
    const names = json.skins[node.skin].joints.map((joint) => (json.nodes[joint].name ?? '').replace(/^Avatar_/, '').replace(/^(Left|Right)/, ''));
    for (const primitive of json.meshes[node.mesh].primitives) {
      if (primitive.attributes.JOINTS_0 === undefined || primitive.attributes.WEIGHTS_0 === undefined) continue;
      const joints = accessor(primitive.attributes.JOINTS_0);
      const weights = accessor(primitive.attributes.WEIGHTS_0);
      for (let vertex = 0; vertex < joints.count; vertex++) {
        let most = 0;
        for (let k = 1; k < 4; k++) if (weights.get(vertex, k) > weights.get(vertex, most)) most = k;
        const bone = names[joints.get(vertex, most)];
        bones[bone] = (bones[bone] ?? 0) + 1;
      }
    }
  }
  const count = (pattern) => Object.entries(bones).reduce((sum, [bone, n]) => sum + (pattern.test(bone) ? n : 0), 0);
  const fingers = ['Thumb', 'Index', 'Middle', 'Ring', 'Pinky'].filter((finger) => count(new RegExp(`^Hand${finger}`)) >= 8);
  const parts = [];
  if (count(/^Head$/) >= 100) parts.push('head');
  if (count(/^Spine/) >= 24 && count(/^(Arm|ForeArm)$/) >= 24) parts.push('upper_body');
  if (count(/^UpLeg$/) >= 24 && count(/^Leg$/) >= 24) parts.push('lower_body');
  if (count(/^(Foot|ToeBase)$/) >= 40) parts.push('feet');
  if (count(/^Hand$/) >= 16 && fingers.length >= 4) parts.push('hands');
  return parts;
}

await rm(library, { recursive: true, force: true });
const items = [];
const skipped = [];

for await (const file of findAssetFiles(path.join(source, 'assets'))) {
  const dir = path.dirname(file);
  const relative = path.relative(path.join(source, 'assets'), dir);
  const collection = relative.split(path.sep)[0];
  let meta;
  try {
    meta = await readJson(file);
  } catch (error) {
    skipped.push(`${relative}: unreadable asset.json (${error.message})`);
    continue;
  }
  const declared = CATEGORY_ALIASES[meta.category] ?? meta.category;
  // A few files contradict their folder about which body slot they fill (tech_tribal's
  // shoes and poncho say lower_body): the folder, which matches their geometry, wins
  const sourceFolder = relative.split(path.sep)[1];
  const category = BODY_SLOTS.has(declared) && BODY_SLOTS.has(sourceFolder) ? sourceFolder : declared;
  const info = categoryInfo(category);
  if (!info) {
    skipped.push(`${relative}: unknown category "${meta.category}"`);
    continue;
  }
  const id = `${collection}:${meta.name}`;
  const folder = path.join('items', category, slug(id));
  const representations = {};
  // Body shape(s) of each file: one file is often shared by both
  const shapesByFile = new Map();
  for (const entry of meta.main ?? []) {
    const shape = bodyShapeOf(entry.type);
    if (shape) shapesByFile.set(entry.model, [...(shapesByFile.get(entry.model) ?? []), shape]);
  }
  const distinct = shapesByFile.size > 1;
  for (const [model, shapes] of shapesByFile) {
    const sourceFile = path.join(dir, model);
    if (!existsSync(sourceFile)) {
      skipped.push(`${relative}: missing ${model}`);
      continue;
    }
    let representation;
    if (info.kind === 'texture') {
      if (!/\.png$/i.test(model)) {
        skipped.push(`${relative}: ${info.id} must be a PNG, not ${model}`);
        continue;
      }
      const mask = path.join(dir, model.replace(/\.png$/i, '_mask.png'));
      const name = distinct ? (shapes[0] === BODY_SHAPES.male ? 'male' : 'female') : 'texture';
      await place(sourceFile, path.join(library, folder, `${name}.png`));
      representation = { texture: `${folder}/${name}.png` };
      if (existsSync(mask)) {
        await place(mask, path.join(library, folder, `${name}_mask.png`));
        representation.mask = `${folder}/${name}_mask.png`;
      }
    } else {
      let parts;
      try {
        parts = bodyPartsOf(await readFile(sourceFile));
      } catch (error) {
        skipped.push(`${relative}: ${model} is not a valid GLB (${error.message.slice(0, 60)})`);
        continue;
      }
      const name = distinct ? `${shapes[0] === BODY_SHAPES.male ? 'male' : 'female'}.glb` : 'model.glb';
      await place(sourceFile, path.join(library, folder, name));
      representation = { model: `${folder}/${name}` };
      // Only where the slot hides parts of the bare body (avatarFormat resolveAvatar)
      if (info.covers && parts) representation.parts = parts;
    }
    for (const shape of shapes) representations[shape] = representation;
  }
  if (Object.keys(representations).length === 0) continue;
  const thumbnail = path.join(dir, 'thumbnail.png');
  if (existsSync(thumbnail)) await place(thumbnail, path.join(library, folder, 'thumbnail.png'));

  const clean = (list) => [...new Set((list ?? []).map((name) => CATEGORY_ALIASES[name] ?? name).filter(Boolean))];
  items.push({
    id,
    name: meta.i18n?.en ?? meta.name,
    category,
    collection,
    tags: [...new Set((meta.tags ?? []).map((tag) => String(tag).toLowerCase()))],
    thumbnail: existsSync(thumbnail) ? `${folder}/thumbnail.png` : null,
    representations,
    hides: clean(meta.hides),
    replaces: clean(meta.replaces),
    removesDefaultHiding: clean(meta.removesDefaultHiding),
    license: LICENSE,
    source: { repository: REPOSITORY, path: `assets/${relative.split(path.sep).join('/')}`, urn: `urn:decentraland:off-chain:${collection}:${meta.name}` },
  });
}

// Base items first (the free basics everyone has), then by category and name
items.sort((a, b) => (a.collection !== 'base-avatars') - (b.collection !== 'base-avatars')
  || CATEGORIES.findIndex((c) => c.id === a.category) - CATEGORIES.findIndex((c) => c.id === b.category)
  || a.name.localeCompare(b.name));

// Emotes: whole-body animations on the same skeleton (one file per body shape). The
// app greets with them (profileStyle.js GREETINGS): only one-shot emotes that need no
// props (the looping ones never end cleanly; the props of the others are not drawn:
// headexplode is a giant head without its particles), on the 62-bone rig (raiseHand's
// own rig lifts the avatar and bares its knees)
// From base-emotes and base-scene-emotes (the ones scenes trigger: of those only the
// punch reads as a greeting without its scene)
const EMOTES = ['wave', 'fistpump', 'handsair', 'shrug', 'dab', 'dontsee', 'punch'];
const emotes = [];
for (const name of EMOTES) {
  const dir = ['base-emotes', 'base-scene-emotes']
    .map((folder) => path.join(source, 'emotes', folder, name))
    .find((candidate) => existsSync(path.join(candidate, 'asset.json')));
  if (!dir) continue;
  const meta = await readJson(path.join(dir, 'asset.json'));
  const files = {};
  for (const entry of meta.main ?? []) {
    const shape = bodyShapeOf(entry.type);
    if (!shape || !/\.glb$/i.test(entry.model) || !existsSync(path.join(dir, entry.model))) continue;
    const target = `emotes/${name}/${shape === BODY_SHAPES.male ? 'male' : 'female'}.glb`;
    await place(path.join(dir, entry.model), path.join(library, 'items', target));
    files[shape] = `items/${target}`;
  }
  if (Object.keys(files).length) emotes.push({ id: name, name: meta.i18n?.en ?? name, loop: meta.loop === true, files });
}

const catalog = {
  format: CATALOG_FORMAT,
  version: CATALOG_VERSION,
  generatedAt: new Date().toISOString(),
  attribution: `Avatar assets by Decentraland (${REPOSITORY}), ${LICENSE}`,
  bodyShapes: Object.values(BODY_SHAPES),
  categories: CATEGORIES,
  palettes: PALETTES,
  emotes,
  items,
};

// Presets: the Decentraland default profiles, converted to our format
const hex = ({ r, g, b }) => `#${[r, g, b].map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
const byUrn = new Map(items.map((item) => [item.source.urn.toLowerCase(), item]));
const presets = [];
const profilesDir = path.join(source, 'default-profiles');
for (const name of existsSync(profilesDir) ? (await readdir(profilesDir)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })) : []) {
  try {
    const profile = await readJson(path.join(profilesDir, name, 'profile.json'));
    const dcl = profile.avatars?.[0]?.avatar;
    if (!dcl) continue;
    const shapeUrn = dcl.bodyShape.toLowerCase();
    const wearables = {};
    for (const urn of dcl.wearables ?? []) {
      const item = byUrn.get(urn.toLowerCase());
      if (item) wearables[item.category] = item.id;
    }
    const { ok, avatar, errors } = validateAvatar({
      format: AVATAR_FORMAT,
      version: AVATAR_VERSION,
      bodyShape: bodyShapeOf(shapeUrn),
      colors: { skin: hex(dcl.skin.color), hair: hex(dcl.hair.color), eyes: hex(dcl.eyes.color) },
      wearables,
      updatedAt: null,
    }, catalog);
    // Faces of a few profiles point at items that are not in the repository: the
    // repaired avatar (defaults in those slots) is still a good preset
    if (ok || errors.every((error) => error.startsWith('missing required slot'))) {
      const face = path.join(profilesDir, name, 'face256.png');
      const image = `items/presets/${name}.png`;
      if (existsSync(face)) await place(face, path.join(library, image));
      presets.push({ id: name, image: existsSync(face) ? image : null, avatar });
    }
    else skipped.push(`default-profiles/${name}: ${errors.join('; ')}`);
  } catch (error) {
    skipped.push(`default-profiles/${name}: ${error.message}`);
  }
}

await mkdir(library, { recursive: true });
await writeFile(path.join(library, 'catalog.json'), JSON.stringify(catalog));
await writeFile(path.join(library, 'presets.json'), JSON.stringify({ format: 'masterkey.avatar-presets', version: 1, presets }));

const perCategory = Object.fromEntries(CATEGORIES.map((c) => [c.id, items.filter((item) => item.category === c.id).length]));
console.log(`library/: ${items.length} items, ${emotes.length} emotes, ${presets.length} presets`);
console.log(perCategory);
if (skipped.length) {
  console.log(`${skipped.length} skipped:`);
  for (const line of skipped.slice(0, 20)) console.log(`  ${line}`);
  if (skipped.length > 20) console.log(`  … and ${skipped.length - 20} more`);
}
