// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { AstcTextureLoader } from '../../../../avatar/src/astcTexture.js';
import { avatarFileBytes } from '../../../../avatar/src/fileCache.js';

// A map avatar as the server made it (asset-pipeline/src/mapAvatar.mjs): one skinned
// mesh, its skeleton, the table of its materials and its atlas. Loaded once per file
// (several people may wear the same one: the presets), turned into the plain arrays
// the crowd draws from. Nothing is remade here: the file is used as it comes.

export const MAP_AVATAR_FORMAT = 'masterkey.map-avatar';
export const MAP_AVATAR_VERSION = 1;
// What the crowd's textures hold, as the server makes it (mapAvatar.mjs SETTINGS)
export const ATLAS = { size: 768, levels: 4, fallbackSize: 384 };
export const MATERIAL_TEXELS = 7;
export const MAX_MATERIALS = 64;
export const MAX_BONES = 64;

const loader = new GLTFLoader();
loader.setCrossOrigin('anonymous');
loader.setMeshoptDecoder(MeshoptDecoder);
const astc = new AstcTextureLoader();

const models = new Map(); // key → Promise<model>

/**
 * files: { model, astc, png } URLs (the .glb, the ASTC atlas, the PNG one);
 * withAstc: whether the GPU samples ASTC (else the PNG atlas)
 */
export function loadCrowdModel(files, withAstc) {
  const key = files.model;
  if (!models.has(key)) {
    const promise = parse(files, withAstc);
    promise.catch(() => models.delete(key)); // tried again next time
    models.set(key, promise);
  }
  return models.get(key);
}

// The attributes in the one layout every model of a batch shares
function canonicalGeometry(source) {
  const count = source.attributes.position.count;
  const read = (name) => source.getAttribute(name);
  const position = new Float32Array(count * 3);
  const normal = new Int8Array(count * 3);
  const uv = new Float32Array(count * 2);
  const joints = new Uint8Array(count * 4);
  const weights = new Uint8Array(count * 4);
  const material = new Uint8Array(count);
  const p = read('position');
  const n = read('normal');
  const t = read('uv');
  const j = read('skinIndex');
  const w = read('skinWeight');
  const m = read('_material');
  if (!p || !n || !t || !j || !w || !m) throw new Error('map avatar without its attributes');
  for (let i = 0; i < count; i++) {
    position[i * 3] = p.getX(i);
    position[i * 3 + 1] = p.getY(i);
    position[i * 3 + 2] = p.getZ(i);
    normal[i * 3] = Math.round(THREE.MathUtils.clamp(n.getX(i), -1, 1) * 127);
    normal[i * 3 + 1] = Math.round(THREE.MathUtils.clamp(n.getY(i), -1, 1) * 127);
    normal[i * 3 + 2] = Math.round(THREE.MathUtils.clamp(n.getZ(i), -1, 1) * 127);
    uv[i * 2] = t.getX(i);
    uv[i * 2 + 1] = t.getY(i);
    for (let k = 0; k < 4; k++) {
      joints[i * 4 + k] = j.getComponent(i, k);
      weights[i * 4 + k] = Math.round(THREE.MathUtils.clamp(w.getComponent(i, k), 0, 1) * 255);
    }
    material[i] = m.getX(i);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(position, 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(normal, 3, true));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setAttribute('crowdJoints', new THREE.BufferAttribute(joints, 4));
  geometry.setAttribute('crowdWeights', new THREE.BufferAttribute(weights, 4, true));
  geometry.setAttribute('crowdMaterial', new THREE.BufferAttribute(material, 1));
  const index = source.index.array;
  geometry.setIndex(new THREE.BufferAttribute(index instanceof Uint32Array ? index : new Uint32Array(index), 1));
  return geometry;
}

// The skeleton as arrays: parents first (order), rest pose, inverse binds
function rigOf(skinned, scene) {
  scene.updateMatrixWorld(true);
  const bones = skinned.skeleton.bones;
  if (bones.length > MAX_BONES) throw new Error('map avatar with too many bones');
  const count = bones.length;
  const parents = new Int16Array(count);
  const restPosition = new Float32Array(count * 3);
  const restRotation = new Float32Array(count * 4);
  const restScale = new Float32Array(count * 3);
  const inverseBind = new Float32Array(count * 16);
  bones.forEach((bone, i) => {
    parents[i] = bones.indexOf(bone.parent);
    bone.position.toArray(restPosition, i * 3);
    bone.quaternion.toArray(restRotation, i * 4);
    bone.scale.toArray(restScale, i * 3);
    skinned.skeleton.boneInverses[i].toArray(inverseBind, i * 16);
  });
  // What holds the skeleton (the armature node), in the model's space
  const root = bones[parents.indexOf(-1)];
  const armature = new Float32Array(root.parent ? root.parent.matrixWorld.elements : new THREE.Matrix4().elements);
  // Parents before children
  const order = [];
  const placed = new Uint8Array(count);
  const visit = (i) => {
    if (placed[i]) return;
    if (parents[i] >= 0) visit(parents[i]);
    placed[i] = 1;
    order.push(i);
  };
  for (let i = 0; i < count; i++) visit(i);
  return {
    count,
    names: bones.map((bone) => bone.name),
    parents,
    order: Int16Array.from(order),
    restPosition,
    restRotation,
    restScale,
    inverseBind,
    armature,
  };
}

async function loadAtlas(files, withAstc) {
  if (withAstc && files.astc) {
    const texture = await astc.parse(await avatarFileBytes(files.astc));
    const levels = texture.mipmaps.map((level) => level.data);
    if (texture.format !== THREE.RGBA_ASTC_6x6_Format || texture.image.width !== ATLAS.size || levels.length !== ATLAS.levels) {
      throw new Error('atlas in another format');
    }
    return { kind: 'astc', levels };
  }
  // The PNG one: its pixels as they are
  const bitmap = await createImageBitmap(new Blob([await avatarFileBytes(files.png)]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  if (bitmap.width !== ATLAS.fallbackSize || bitmap.height !== ATLAS.fallbackSize) throw new Error('atlas in another size');
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { kind: 'rgba', pixels: new Uint8Array(context.getImageData(0, 0, ATLAS.fallbackSize, ATLAS.fallbackSize).data.buffer) };
}

async function parse(files, withAstc) {
  // Both from the device when seen before (avatar/src/fileCache.js)
  const [gltf, atlas] = await Promise.all([
    avatarFileBytes(files.model).then((bytes) => loader.parseAsync(bytes, '')),
    loadAtlas(files, withAstc),
  ]);
  const info = gltf.scene.userData ?? {};
  if (info.format !== MAP_AVATAR_FORMAT || info.version !== MAP_AVATAR_VERSION) throw new Error('not a map avatar of this version');
  let skinned = null;
  gltf.scene.traverse((object) => {
    if (object.isSkinnedMesh) skinned ??= object;
  });
  if (!skinned) throw new Error('map avatar without its mesh');
  const materials = Float32Array.from(info.materials ?? []);
  if (materials.length % (MATERIAL_TEXELS * 4) || materials.length / (MATERIAL_TEXELS * 4) > MAX_MATERIALS) throw new Error('map avatar materials');
  const model = {
    key: files.model,
    geometry: canonicalGeometry(skinned.geometry),
    rig: rigOf(skinned, gltf.scene),
    materials,
    atlas,
    height: info.height || 1.8,
    radius: info.radius || 1,
    bodyShape: info.bodyShape ?? null,
  };
  skinned.geometry.dispose();
  return model;
}
