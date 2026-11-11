// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The map avatar: one user's avatar as the people around see it on the map, made once
// on the server when they save it (avatar-server: POST /v1/map-avatars) and served
// as files that never change (their name is a hash of the avatar).
//
// On the map an avatar is a figure a few hundred pixels tall at most, and there can be
// any number of them. Drawn like the profile (webview/avatar composeAvatar) each one is
// a dozen meshes, each with its own skeleton, material and draw call. Here the same
// avatar becomes:
//  - ONE mesh on ONE skeleton (the body's), every worn model rebound to it in the rest
//    pose (exactly as three.js shows them in the profile, quirks included)
//  - ONE texture: every material painted into a region of an atlas, with the colours
//    the user picked already applied (skin, hair, eyes, lips), and a small table of
//    what each material is (shine, transparency, glow, skin…) that the map's shader
//    reads per vertex. Opaque ASTC (4×4) KTX2 for the GPU, a PNG for phones without it
//  - every triangle of what is worn: the geometry is not simplified, only the vertices
//    nothing uses are dropped
// The map then draws every person at once (webview/map crowd), whatever they wear.
// There is one version only: no levels of detail that would switch as people move.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Document, Logger, NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS, EXTMeshoptCompression } from '@gltf-transform/extensions';
import { quantize, reorder } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { Color, Matrix3, Matrix4, Quaternion, Vector3 } from 'three';
import { resolveAvatar, validateAvatar } from '../../avatar-server/shared/avatarFormat.js';
import { createAtlas, decodeAt, mipLevels, pack, toLinear } from './atlas.mjs';
import { encodeLevels } from './texture.mjs';

export const MAP_AVATAR_FORMAT = 'masterkey.map-avatar';
export const MAP_AVATAR_VERSION = 1;

export const SETTINGS = {
  // The atlas: side, mip levels shipped (768 → 96: below that the regions would bleed
  // into each other), border around each region, ASTC block (one for all: they are
  // layers of one array texture on the GPU). 6×6 blocks at 768: every level a whole
  // number of blocks, and as many GPU bytes as 512 at 4×4 for 2.25× the texels
  ATLAS: 768,
  LEVELS: 4,
  PAD: 8,
  ALIGN: 6,
  BLOCK: '6x6',
  // Texels per avatar metre: one per pixel at the largest the map draws an avatar
  // (next to the player at the closest zoom: ~260 CSS px tall, 2× screens)
  DENSITY: 290,
  // The face (eyes, brows, lips) twice that: it is where people look
  FACE_DENSITY: 2,
};

await MeshoptEncoder.ready;
await MeshoptSimplifier.ready;
const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({ 'meshopt.encoder': MeshoptEncoder });

// Decentraland's body meshes, as composeAvatar names them
const BODY_PARTS = [
  ['head', /_Head_BaseMesh$/i],
  ['upper_body', /_uBody_BaseMesh$/i],
  ['lower_body', /_lBody_BaseMesh$/i],
  ['feet', /_Feet_BaseMesh$/i],
  ['hands', /_Hands_BaseMesh$/i],
];
const FACE_PARTS = [
  ['eyes', /_Mask_Eyes$/i],
  ['eyebrows', /_Mask_Eyebrows$/i],
  ['mouth', /_Mask_Mouth$/i],
];
const partOf = (names, table) => table.find(([, pattern]) => names.some((name) => pattern.test(name)))?.[0] ?? null;

const CLAMP = 33071;

/** The avatar as it is hashed: what changes the look, in a fixed order */
function canonicalAvatar(avatar) {
  return {
    bodyShape: avatar.bodyShape,
    colors: { skin: avatar.colors.skin.toUpperCase(), hair: avatar.colors.hair.toUpperCase(), eyes: avatar.colors.eyes.toUpperCase() },
    wearables: Object.fromEntries(Object.entries(avatar.wearables).sort(([a], [b]) => a.localeCompare(b))),
  };
}

/**
 * The name of an avatar's map files: the same avatar always gets the same one, until
 * what is drawn of it changes (its render plan: the files of its items and the parts
 * of the body they hide, after a library rebuild or new hiding rules)
 */
export function mapAvatarKey(avatar, catalog) {
  const { models, hiddenParts } = resolveAvatar(avatar, catalog, '');
  return createHash('sha256')
    .update(JSON.stringify({ format: MAP_AVATAR_FORMAT, version: MAP_AVATAR_VERSION, settings: SETTINGS, avatar: canonicalAvatar(avatar), models, hiddenParts }))
    .digest('hex')
    .slice(0, 32);
}

// Library files read once and kept for the next avatars (most share their body and
// many items)
const documents = new Map();
const KEPT_DOCUMENTS = 96;
function readDocument(file) {
  if (documents.has(file)) {
    const document = documents.get(file);
    documents.delete(file);
    documents.set(file, document);
    return document;
  }
  const document = io.read(file);
  document.catch(() => documents.delete(file));
  documents.set(file, document);
  while (documents.size > KEPT_DOCUMENTS) documents.delete(documents.keys().next().value);
  return document;
}

const matrix = (array) => new Matrix4().fromArray(Array.from(array));
const linearColor = (hex) => new Color(hex); // three converts sRGB hex to linear

// ---------------------------------------------------------------------------------

/**
 * @param {object} avatar        a saved avatar (avatar-server/shared/avatarFormat.js)
 * @param {{ library: string, catalog: object, astcenc: string, threads?: number }} options
 *   library: avatar-server/library
 * @returns {Promise<{ key: string, glb: Uint8Array, ktx2: Uint8Array, png: Buffer, report: object }>}
 */
export async function bakeMapAvatar(avatar, { library, catalog, astcenc, threads = 2 }) {
  const { avatar: clean } = validateAvatar(avatar, catalog);
  const key = mapAvatarKey(clean, catalog);
  const plan = resolveAvatar(clean, catalog, '');
  const file = (relative) => path.join(library, relative);
  const hidden = new Set(plan.hiddenParts);
  const colors = { skin: linearColor(plan.colors.skin), hair: linearColor(plan.colors.hair), eyes: linearColor(plan.colors.eyes) };

  // --- The skeleton: the body's ---
  const body = await readDocument(file(plan.body.model));
  const bodySkin = body.getRoot().listSkins()[0];
  if (!bodySkin) throw new Error('the body has no skeleton');
  const joints = bodySkin.listJoints();
  const boneNames = joints.map((joint) => joint.getName());
  const boneIndex = new Map(boneNames.map((name, index) => [name, index]));
  const restWorld = joints.map((joint) => matrix(joint.getWorldMatrix()));
  const jointSet = new Set(joints);
  const parentOf = (node) => {
    for (let parent = node.getParentNode(); parent; parent = parent.getParentNode()) if (jointSet.has(parent)) return parent;
    return null;
  };
  const parents = joints.map((joint) => {
    const parent = parentOf(joint);
    return parent ? joints.indexOf(parent) : -1;
  });
  // What holds the skeleton (the armature): the world of the first root bone's parent
  const rootIndex = parents.indexOf(-1);
  const holder = joints[rootIndex].getParentNode();
  const armature = holder ? matrix(holder.getWorldMatrix()) : new Matrix4();
  const armatureInverse = armature.clone().invert();
  const restLocal = joints.map((_, i) => (parents[i] >= 0
    ? restWorld[parents[i]].clone().invert().multiply(restWorld[i])
    : armatureInverse.clone().multiply(restWorld[i])));

  // A joint of another model → the body's bone of that name, or its nearest ancestor
  // that the body has (extra bones of an item never move: they follow their parent)
  const canonicalOf = (node) => {
    for (let at = node; at; at = at.getParentNode()) {
      const index = boneIndex.get(at.getName());
      if (index !== undefined) return index;
    }
    return rootIndex;
  };

  // --- Materials ---
  let bodySkinMaterial = null;
  for (const mesh of body.getRoot().listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const material = primitive.getMaterial();
      if (material && /skin/i.test(material.getName())) bodySkinMaterial ??= material;
    }
  }
  const surfaceOf = (material) => {
    const specular = material?.getExtension('KHR_materials_specular');
    const strength = specular ? specular.getSpecularFactor() * Math.max(...specular.getSpecularColorFactor()) : 1;
    return {
      roughness: material?.getRoughnessFactor() ?? 1,
      metalness: material?.getMetallicFactor() ?? 0,
      specular: Math.min(Math.max(strength, 0), 1),
    };
  };
  const imageHash = (bytes) => createHash('sha1').update(bytes).digest('hex').slice(0, 16);
  const materials = [];
  const materialIndex = new Map();
  // One material of the avatar: what it paints and how it shades
  const addMaterial = (description) => {
    const id = JSON.stringify({ ...description, base: { ...description.base, image: description.base.imageId }, glow: { ...description.glow, image: description.glow.imageId } });
    if (materialIndex.has(id)) return materialIndex.get(id);
    const index = materials.length;
    if (index > 255) throw new Error('too many materials');
    materials.push({ ...description, area: 0, uvArea: 0, uvMin: [Infinity, Infinity], uvMax: [-Infinity, -Infinity] });
    materialIndex.set(id, index);
    return index;
  };

  const describe = (material, { decal = null, faceTexture = null } = {}) => {
    const name = material?.getName() ?? '';
    const skin = /skin/i.test(name) || decal === 'mouth';
    const hair = !skin && /hair/i.test(name);
    const own = material ?? null;
    // Worn skin takes the body's skin, with its own picture and transparency
    // (composeAvatar matchSkin); skin and hair take the user's colours (tint)
    const shading = /skin/i.test(name) ? surfaceOf(bodySkinMaterial ?? own) : surfaceOf(own);
    const factor = own?.getBaseColorFactor() ?? [1, 1, 1, 1];
    let color = [factor[0], factor[1], factor[2]];
    if (/skin/i.test(name)) color = colors.skin.toArray();
    else if (hair || decal === 'eyebrows') color = colors.hair.toArray();
    if (decal === 'mouth') color = colors.skin.clone().lerp(new Color(1, 1, 1), 0.2).toArray();
    const texture = faceTexture ? null : own?.getBaseColorTexture();
    const info = own?.getBaseColorTextureInfo();
    const image = faceTexture?.image ?? texture?.getImage() ?? null;
    const alphaMode = decal ? 'BLEND' : (own?.getAlphaMode() ?? 'OPAQUE');
    const emissiveTexture = own?.getEmissiveTexture();
    const strength = own?.getExtension('KHR_materials_emissive_strength')?.getEmissiveStrength() ?? 1;
    const emissive = (own?.getEmissiveFactor() ?? [0, 0, 0]).map((value) => value * strength);
    const glowing = emissive.some((value) => value > 0.001);
    return {
      base: {
        image,
        imageId: image ? imageHash(image) : null,
        mask: faceTexture?.mask ?? null,
        maskId: faceTexture?.mask ? imageHash(faceTexture.mask) : null,
        iris: decal === 'eyes' && faceTexture?.mask ? colors.eyes.toArray() : null,
        color,
        alpha: factor[3],
        wrap: !info || info.getWrapS() !== CLAMP || info.getWrapT() !== CLAMP,
      },
      glow: {
        image: glowing ? emissiveTexture?.getImage() ?? null : null,
        imageId: glowing && emissiveTexture?.getImage() ? imageHash(emissiveTexture.getImage()) : null,
        color: glowing ? emissive : [0, 0, 0],
      },
      texCoord: info?.getTexCoord() ?? 0,
      alphaMode: alphaMode === 'OPAQUE' ? 0 : alphaMode === 'MASK' ? 1 : 2,
      cutoff: alphaMode === 'MASK' ? (own?.getAlphaCutoff() ?? 0.5) : 0,
      skin,
      singleSided: decal ? false : !(own?.getDoubleSided() ?? false),
      decal: !!decal,
      ...shading,
    };
  };

  // --- Geometry: every visible piece, rebound to the body's skeleton ---
  const positions = [];
  const normals = [];
  const uvs = [];
  const vertexMaterial = [];
  const vertexJoints = [];
  const vertexWeights = [];
  const vertexPiece = [];
  const indices = [];
  let pieces = 0;

  const addNode = (node, decal, faceTexture) => {
    const mesh = node.getMesh();
    const skin = node.getSkin();
    const meshWorld = matrix(node.getWorldMatrix());
    // Per joint of the piece: its body bone, and where it puts a vertex at rest. As
    // three.js shows it in the profile (GLTFLoader binds with the identity, and the
    // mesh node's own transform cancels out): world = Σ w · joint world · inverse bind · vertex
    let jointInfo;
    if (skin) {
      const ibm = skin.getInverseBindMatrices()?.getArray();
      jointInfo = skin.listJoints().map((joint, j) => {
        const place = matrix(joint.getWorldMatrix()).multiply(ibm ? matrix(ibm.slice(j * 16, j * 16 + 16)) : new Matrix4());
        return { bone: canonicalOf(joint), place, normal: new Matrix3().getNormalMatrix(place) };
      });
    } else {
      // A rigid piece: it follows the bone it hangs from
      const bone = canonicalOf(node);
      jointInfo = [{ bone, place: meshWorld, normal: new Matrix3().getNormalMatrix(meshWorld) }];
    }
    for (const primitive of mesh.listPrimitives()) {
      if (primitive.getMode() !== 4) continue; // triangles only
      const material = primitive.getMaterial();
      const description = describe(material, { decal, faceTexture });
      const index = addMaterial(description);
      const position = primitive.getAttribute('POSITION');
      const normal = primitive.getAttribute('NORMAL');
      const uv = primitive.getAttribute(`TEXCOORD_${description.texCoord}`) ?? primitive.getAttribute('TEXCOORD_0');
      const jointAttribute = skin ? primitive.getAttribute('JOINTS_0') : null;
      const weightAttribute = skin ? primitive.getAttribute('WEIGHTS_0') : null;
      const base = positions.length / 3;
      const p = new Vector3();
      const n = new Vector3();
      const sumP = new Vector3();
      const sumN = new Vector3();
      const tmp = new Vector3();
      const jj = [0, 0, 0, 0];
      const ww = [1, 0, 0, 0];
      const pv = [0, 0, 0];
      const nv = [0, 1, 0];
      const uvv = [0, 0];
      for (let v = 0; v < position.getCount(); v++) {
        position.getElement(v, pv);
        p.fromArray(pv);
        if (normal) normal.getElement(v, nv);
        n.fromArray(nv);
        if (jointAttribute) {
          jointAttribute.getElement(v, jj);
          weightAttribute.getElement(v, ww);
        }
        sumP.set(0, 0, 0);
        sumN.set(0, 0, 0);
        const byBone = new Map();
        let total = 0;
        for (let k = 0; k < 4; k++) {
          const w = jointAttribute ? ww[k] : k === 0 ? 1 : 0;
          if (!(w > 0)) continue;
          const info = jointInfo[jointAttribute ? jj[k] : 0];
          if (!info) continue;
          sumP.addScaledVector(tmp.copy(p).applyMatrix4(info.place), w);
          sumN.addScaledVector(tmp.copy(n).applyMatrix3(info.normal), w);
          byBone.set(info.bone, (byBone.get(info.bone) ?? 0) + w);
          total += w;
        }
        if (total <= 0) {
          sumP.copy(p).applyMatrix4(meshWorld);
          sumN.copy(n);
          byBone.set(rootIndex, 1);
          total = 1;
        }
        sumP.divideScalar(total);
        sumN.normalize();
        positions.push(sumP.x, sumP.y, sumP.z);
        normals.push(sumN.x, sumN.y, sumN.z);
        if (uv) uv.getElement(v, uvv);
        else uvv[0] = uvv[1] = 0;
        uvs.push(uvv[0], uvv[1]);
        vertexMaterial.push(index);
        const strongest = [...byBone].sort((a, b) => b[1] - a[1]).slice(0, 4);
        const kept = strongest.reduce((sum, [, w]) => sum + w, 0);
        for (let k = 0; k < 4; k++) {
          vertexJoints.push(strongest[k]?.[0] ?? 0);
          vertexWeights.push(strongest[k] ? strongest[k][1] / kept : 0);
        }
        vertexPiece.push(pieces);
      }
      const primitiveIndices = primitive.getIndices();
      const count = primitiveIndices ? primitiveIndices.getCount() : position.getCount();
      const material_ = materials[index];
      const a = new Vector3();
      const b = new Vector3();
      const c = new Vector3();
      for (let t = 0; t + 2 < count; t += 3) {
        const i0 = primitiveIndices ? primitiveIndices.getScalar(t) : t;
        const i1 = primitiveIndices ? primitiveIndices.getScalar(t + 1) : t + 1;
        const i2 = primitiveIndices ? primitiveIndices.getScalar(t + 2) : t + 2;
        indices.push(base + i0, base + i1, base + i2);
        // How much body this material covers, and how much of its picture
        a.fromArray(positions, (base + i0) * 3);
        b.fromArray(positions, (base + i1) * 3);
        c.fromArray(positions, (base + i2) * 3);
        material_.area += b.sub(a).cross(c.sub(a)).length() / 2;
        const u0 = uvs[(base + i0) * 2];
        const v0 = uvs[(base + i0) * 2 + 1];
        material_.uvArea += Math.abs((uvs[(base + i1) * 2] - u0) * (uvs[(base + i2) * 2 + 1] - v0) - (uvs[(base + i2) * 2] - u0) * (uvs[(base + i1) * 2 + 1] - v0)) / 2;
        for (const corner of [i0, i1, i2]) {
          for (let k = 0; k < 2; k++) {
            const value = uvs[(base + corner) * 2 + k];
            material_.uvMin[k] = Math.min(material_.uvMin[k], value);
            material_.uvMax[k] = Math.max(material_.uvMax[k], value);
          }
        }
      }
      pieces++;
    }
  };

  // The body: its parts not covered, its face where the avatar has one
  const faceImages = {};
  for (const [slot, face] of Object.entries(plan.face)) {
    faceImages[slot] = {
      image: await readFile(file(face.texture)),
      mask: face.mask ? await readFile(file(face.mask)) : null,
    };
  }
  for (const node of body.getRoot().listNodes()) {
    if (!node.getMesh()) continue;
    const names = [node.getName(), node.getMesh().getName()];
    const part = partOf(names, BODY_PARTS);
    if (part && hidden.has(part)) continue;
    const face = partOf(names, FACE_PARTS);
    if (face) {
      if (!faceImages[face] || hidden.has('head')) continue;
      addNode(node, face, faceImages[face]);
      continue;
    }
    addNode(node, null, null);
  }
  const failed = [];
  for (const model of plan.models) {
    let document;
    try {
      document = await readDocument(file(model.model));
    } catch {
      failed.push(model.id);
      continue;
    }
    for (const node of document.getRoot().listNodes()) if (node.getMesh()) addNode(node, null, null);
  }

  // Skin pieces from different models meet at seams: one normal there, the average
  // (composeAvatar weldSkinSeams)
  const SEAM_GRID = 2000;
  const seams = new Map();
  const vertexCount = positions.length / 3;
  const keyOf = (v) => `${Math.round(positions[v * 3] * SEAM_GRID)}|${Math.round(positions[v * 3 + 1] * SEAM_GRID)}|${Math.round(positions[v * 3 + 2] * SEAM_GRID)}`;
  for (let v = 0; v < vertexCount; v++) {
    if (!materials[vertexMaterial[v]].skin || materials[vertexMaterial[v]].decal) continue;
    const key = keyOf(v);
    const place = seams.get(key) ?? { sum: new Vector3(), pieces: new Set(), vertices: [] };
    place.sum.x += normals[v * 3];
    place.sum.y += normals[v * 3 + 1];
    place.sum.z += normals[v * 3 + 2];
    place.pieces.add(vertexPiece[v]);
    place.vertices.push(v);
    seams.set(key, place);
  }
  for (const place of seams.values()) {
    if (place.pieces.size < 2) continue;
    place.sum.normalize();
    for (const v of place.vertices) place.sum.toArray(normals, v * 3);
  }

  // --- Geometry: every triangle kept; the vertices nothing uses dropped and the rest
  // renumbered in order of use (remap: old number → new, ~0 for the dropped ones) ---
  const finalIndices = new Uint32Array(indices);
  const [remap, used] = MeshoptSimplifier.compactMesh(finalIndices);
  const order = new Int32Array(used);
  for (let v = 0; v < remap.length; v++) if (remap[v] !== 0xFFFFFFFF) order[remap[v]] = v;

  const outPositions = new Float32Array(used * 3);
  const outNormals = new Float32Array(used * 3);
  const outUvs = new Float32Array(used * 2);
  const outMaterial = new Uint8Array(used);
  const outJoints = new Uint8Array(used * 4);
  const outWeights = new Float32Array(used * 4);
  for (let n = 0; n < used; n++) {
    const v = order[n];
    for (let k = 0; k < 3; k++) {
      outPositions[n * 3 + k] = positions[v * 3 + k];
      outNormals[n * 3 + k] = normals[v * 3 + k];
    }
    outUvs[n * 2] = uvs[v * 2];
    outUvs[n * 2 + 1] = uvs[v * 2 + 1];
    outMaterial[n] = vertexMaterial[v];
    for (let k = 0; k < 4; k++) {
      outJoints[n * 4 + k] = vertexJoints[v * 4 + k];
      outWeights[n * 4 + k] = vertexWeights[v * 4 + k];
    }
  }

  // --- The atlas ---
  const { ATLAS, PAD, ALIGN, DENSITY, FACE_DENSITY } = SETTINGS;
  const align = (value) => Math.max(ALIGN, Math.ceil(value / ALIGN) * ALIGN);
  const regions = [];
  for (const material of materials) {
    // The part of its picture a material uses: a repeating picture (coordinates past
    // 0–1) whole, wrapped in the shader; otherwise only the window its coordinates
    // reach (many items paint with a few swatches of a large palette texture), a
    // texel wider on each side for filtering
    const tiles = material.uvMin[0] < -0.001 || material.uvMin[1] < -0.001 || material.uvMax[0] > 1.001 || material.uvMax[1] > 1.001;
    material.windowed = !tiles || !material.base.wrap;
    material.window = [0, 0, 1, 1];
    for (const kind of ['base', 'glow']) {
      const layer = material[kind];
      if (!layer.image) continue;
      const meta = await sharp(layer.image).metadata();
      let crop = { left: 0, top: 0, width: meta.width, height: meta.height };
      if (!tiles && Number.isFinite(material.uvMin[0])) {
        const left = Math.max(0, Math.floor(material.uvMin[0] * meta.width) - 1);
        const top = Math.max(0, Math.floor(material.uvMin[1] * meta.height) - 1);
        const right = Math.min(meta.width, Math.ceil(material.uvMax[0] * meta.width) + 1);
        const bottom = Math.min(meta.height, Math.ceil(material.uvMax[1] * meta.height) + 1);
        crop = { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
        // Both layers read the same coordinates: the window is the base picture's
        if (kind === 'base' || !material.base.image) material.window = [left / meta.width, top / meta.height, crop.width / meta.width, crop.height / meta.height];
      }
      const density = DENSITY * (material.decal ? FACE_DENSITY : 1);
      // Texels the picture needs: as many as its share of the body shows at the
      // density (a repeating picture shows several times: one copy suffices), never
      // more than the picture has
      const share = (crop.width * crop.height) / (meta.width * meta.height);
      const texels = material.uvArea > 1e-9 ? (density * density * material.area * share) / material.uvArea : 16;
      const aspect = crop.width / crop.height;
      const height = Math.min(crop.height, Math.sqrt(texels / aspect));
      const width = Math.min(crop.width, height * aspect);
      regions.push({ material, kind, layer, crop, want: { width, height } });
      if (process.env.ATLAS_DEBUG) console.log(kind, material.decal, 'area', material.area.toFixed(4), 'uv', material.uvArea.toFixed(4), 'crop', crop.width, crop.height, 'want', Math.round(width), Math.round(height));
    }
  }
  let scale = 1;
  let placed = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    for (const region of regions) {
      region.width = align(region.want.width * scale);
      region.height = align(region.want.height * scale);
    }
    placed = pack(regions.map((region) => ({ width: region.width + PAD * 2, height: region.height + PAD * 2 })), ATLAS);
    if (placed) break;
    scale *= 0.92;
  }
  if (!placed) throw new Error('the atlas cannot hold this avatar');
  const atlas = createAtlas(ATLAS);
  for (const [i, region] of regions.entries()) {
    region.x = placed[i].x;
    region.y = placed[i].y;
    const { layer, kind } = region;
    const opaque = kind === 'glow' || region.material.alphaMode === 0;
    const pixels = await decodeAt(layer.image, region.width, region.height, region.crop, !opaque);
    const mask = layer.mask ? await decodeAt(layer.mask, region.width, region.height, region.crop, true) : null;
    const [r, g, b] = layer.color;
    const iris = layer.iris;
    atlas.paint({ x: region.x, y: region.y, width: region.width, height: region.height, pad: PAD, wrap: !region.material.windowed }, (i_, j, out) => {
      const o = (j * region.width + i_) * 4;
      let red = toLinear(pixels[o]) * r;
      let green = toLinear(pixels[o + 1]) * g;
      let blue = toLinear(pixels[o + 2]) * b;
      if (iris && mask) {
        // composeAvatar irisMaterial: the iris (dark in the mask) takes the eye colour
        const amount = 1 - mask[o] / 255;
        red += (red * iris[0] * 2.2 - red) * amount;
        green += (green * iris[1] * 2.2 - green) * amount;
        blue += (blue * iris[2] * 2.2 - blue) * amount;
      }
      out[0] = red;
      out[1] = green;
      out[2] = blue;
      out[3] = opaque ? 1 : (pixels[o + 3] / 255) * (kind === 'base' ? layer.alpha : 1);
    });
    if (!opaque) atlas.bleed({ x: region.x, y: region.y, width: region.width + PAD * 2, height: region.height + PAD * 2 });
  }
  const levels = await mipLevels(atlas.data, ATLAS, SETTINGS.LEVELS);
  const ktx2 = await encodeLevels(levels, { block: SETTINGS.BLOCK, srgb: true, astcenc, threads });
  const png = await sharp(levels[1].data, { raw: { width: levels[1].width, height: levels[1].height, channels: 4 } }).png({ compressionLevel: 9 }).toBuffer();

  // The table the shader reads per material: 7 RGBA texels (crowd MATERIAL_TEXELS on
  // the map):
  //   0 base region (x, y, width, height in the atlas; width 0: a plain colour)
  //   1 base colour (linear RGB, alpha) when plain, else 1
  //   2 glow region, 3 glow colour when plain (else 1) and whether the coordinates
  //     stay in their window (1) or repeat (0)
  //   4 roughness, metalness, specular, alpha cutoff
  //   5 alpha mode (0 opaque, 1 mask, 2 blend), skin, single-sided, face decal
  //   6 the window of the picture the region holds (u, v, width, height)
  const rect = (material, kind) => {
    const region = regions.find((entry) => entry.material === material && entry.kind === kind);
    return region ? [(region.x + PAD) / ATLAS, (region.y + PAD) / ATLAS, region.width / ATLAS, region.height / ATLAS] : [0, 0, 0, 0];
  };
  const round = (value) => Math.round(value * 1e5) / 1e5;
  const table = materials.flatMap((material) => {
    const base = rect(material, 'base');
    const glow = rect(material, 'glow');
    const solid = base[2] === 0;
    return [
      ...base,
      ...(solid ? material.base.color : [1, 1, 1]), solid ? material.base.alpha : 1,
      ...glow,
      ...(glow[2] > 0 ? [1, 1, 1] : material.glow.color), material.windowed ? 1 : 0,
      material.roughness, material.metalness, material.specular, material.cutoff,
      material.alphaMode, material.skin ? 1 : 0, material.singleSided ? 1 : 0, material.decal ? 1 : 0,
      ...material.window,
    ].map(round);
  });

  // --- The file ---
  let radius = 0;
  const middle = new Vector3();
  for (let v = 0; v < used; v++) middle.add(new Vector3().fromArray(outPositions, v * 3));
  middle.divideScalar(Math.max(used, 1));
  for (let v = 0; v < used; v++) radius = Math.max(radius, middle.distanceTo(new Vector3().fromArray(outPositions, v * 3)));
  // The bare body's height, as composeAvatar measures it (every mesh of the body, at
  // rest, skinned) to scale every avatar alike
  let bodyMin = Infinity;
  let bodyMax = -Infinity;
  for (const node of body.getRoot().listNodes()) {
    const mesh = node.getMesh();
    const nodeSkin = node.getSkin();
    if (!mesh || !nodeSkin) continue;
    const ibm = nodeSkin.getInverseBindMatrices()?.getArray();
    const places = nodeSkin.listJoints().map((joint, j) => matrix(joint.getWorldMatrix()).multiply(ibm ? matrix(ibm.slice(j * 16, j * 16 + 16)) : new Matrix4()));
    for (const primitive of mesh.listPrimitives()) {
      const bounds = primitive.getAttribute('POSITION');
      const jointsOf = primitive.getAttribute('JOINTS_0');
      const weightsOf = primitive.getAttribute('WEIGHTS_0');
      if (!jointsOf || !weightsOf) continue;
      const point = new Vector3();
      const sum = new Vector3();
      const values = [0, 0, 0];
      const jj = [0, 0, 0, 0];
      const ww = [0, 0, 0, 0];
      for (let v = 0; v < bounds.getCount(); v++) {
        bounds.getElement(v, values);
        jointsOf.getElement(v, jj);
        weightsOf.getElement(v, ww);
        sum.set(0, 0, 0);
        for (let k = 0; k < 4; k++) if (ww[k] > 0 && places[jj[k]]) sum.addScaledVector(point.fromArray(values).applyMatrix4(places[jj[k]]), ww[k]);
        bodyMin = Math.min(bodyMin, sum.y);
        bodyMax = Math.max(bodyMax, sum.y);
      }
    }
  }

  const document = new Document();
  const buffer = document.createBuffer();
  const accessor = (array, type) => document.createAccessor().setArray(array).setType(type).setBuffer(buffer);
  const primitive = document.createPrimitive()
    .setIndices(accessor(used > 65535 ? new Uint32Array(finalIndices) : new Uint16Array(finalIndices), 'SCALAR'))
    .setAttribute('POSITION', accessor(outPositions, 'VEC3'))
    .setAttribute('NORMAL', accessor(outNormals, 'VEC3'))
    .setAttribute('TEXCOORD_0', accessor(outUvs, 'VEC2'))
    .setAttribute('JOINTS_0', accessor(outJoints, 'VEC4'))
    .setAttribute('WEIGHTS_0', accessor(outWeights, 'VEC4'))
    .setAttribute('_MATERIAL', accessor(outMaterial, 'SCALAR'));
  const mesh = document.createMesh('avatar').addPrimitive(primitive);
  const position = new Vector3();
  const rotation = new Quaternion();
  const size = new Vector3();
  armature.decompose(position, rotation, size);
  const holderNode = document.createNode('Armature').setTranslation(position.toArray()).setRotation(rotation.toArray()).setScale(size.toArray());
  const nodes = joints.map((_, i) => {
    restLocal[i].decompose(position, rotation, size);
    return document.createNode(boneNames[i]).setTranslation(position.toArray()).setRotation(rotation.toArray()).setScale(size.toArray());
  });
  nodes.forEach((node, i) => (parents[i] >= 0 ? nodes[parents[i]] : holderNode).addChild(node));
  // The inverse binds from the nodes as written (their rounding included)
  const written = new Array(joints.length);
  const worldOf = (i) => {
    if (written[i]) return written[i];
    const node = nodes[i];
    const local = new Matrix4().compose(new Vector3(...node.getTranslation()), new Quaternion(...node.getRotation()), new Vector3(...node.getScale()));
    const parent = parents[i] >= 0 ? worldOf(parents[i]) : new Matrix4().compose(new Vector3(...holderNode.getTranslation()), new Quaternion(...holderNode.getRotation()), new Vector3(...holderNode.getScale()));
    written[i] = parent.clone().multiply(local);
    return written[i];
  };
  const ibm = new Float32Array(joints.length * 16);
  joints.forEach((_, i) => ibm.set(worldOf(i).clone().invert().toArray(), i * 16));
  const skin = document.createSkin('skeleton').setSkeleton(holderNode).setInverseBindMatrices(accessor(ibm, 'MAT4'));
  for (const node of nodes) skin.addJoint(node);
  const meshNode = document.createNode('avatar').setMesh(mesh).setSkin(skin);
  const report = {
    sourceTriangles: indices.length / 3,
    triangles: finalIndices.length / 3,
    vertices: used,
    materials: materials.length,
    regions: regions.length,
    atlasScale: Number(scale.toFixed(3)),
    failed,
  };
  document.createScene('avatar').addChild(holderNode).addChild(meshNode).setExtras({
    format: MAP_AVATAR_FORMAT,
    version: MAP_AVATAR_VERSION,
    key,
    bodyShape: plan.bodyShape,
    height: Number((bodyMax - bodyMin || 1.8).toFixed(4)),
    radius: Number(radius.toFixed(4)),
    center: middle.toArray().map(round),
    materials: table,
    atlas: { size: ATLAS, levels: SETTINGS.LEVELS, block: SETTINGS.BLOCK },
  });
  document.getRoot().getAsset().generator = 'masterkey asset-pipeline mapAvatar';

  document.setLogger(new Logger(Logger.Verbosity.WARN));
  await document.transform(
    reorder({ encoder: MeshoptEncoder, target: 'size' }),
    // Normals and weights to bytes; positions and texture coordinates stay float
    // (repeating pictures have coordinates far outside 0–1)
    quantize({ pattern: /^(NORMAL|WEIGHTS)(_\d+)?$/, quantizeNormal: 8, quantizeWeight: 8 }),
  );
  document.createExtension(EXTMeshoptCompression).setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
  const glb = await io.writeBinary(document);
  return { key, glb, ktx2, png, report };
}
