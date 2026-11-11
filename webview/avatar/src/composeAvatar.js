// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { AstcTextureLoader, supportsAstc } from './astcTexture.js';
import { avatarFileBytes, avatarFiles } from './fileCache.js';

// Builds a 3D avatar from a render plan (avatar-server/shared/avatarFormat.js
// resolveAvatar): the bare body, the worn models, the face textures and the colours.
//
// Every model of the Decentraland avatars is rigged on the same skeleton (Avatar_Hips…
// Avatar_Head) in the same rest pose, so a worn model is simply added next to the body
// with its own copy of the skeleton; each frame the body's bone transforms are copied
// onto the others (syncPose), so they move together whatever animates the body.

const loader = new GLTFLoader();
loader.setCrossOrigin('anonymous');
// The optimised library (asset-pipeline/) compresses geometry and animations with meshopt
loader.setMeshoptDecoder(MeshoptDecoder);
const astcLoader = new AstcTextureLoader();
astcLoader.setCrossOrigin('anonymous');

// The optimised library: the same files under /v1/files-astc/, models with ASTC
// textures (they stay compressed on the GPU, 9–16× less memory) and face textures as
// .ktx2. Only where the GPU samples ASTC (every phone from 2021 on); a file missing
// there falls back to the original.
let optimized = false;
export function useOptimizedLibrary(renderer) {
  optimized = supportsAstc(renderer);
  if (optimized) loader.setKTX2Loader(astcLoader);
  return optimized;
}
const optimizedUrl = (url, extension) => {
  if (!optimized || !url.includes('/v1/files/')) return null;
  const moved = url.replace('/v1/files/', '/v1/files-astc/');
  return extension ? moved.replace(/\.png$/i, extension) : moved;
};
const textureLoader = new THREE.TextureLoader();
textureLoader.setCrossOrigin('anonymous');

// Every file comes through the cache on the device (fileCache.js)
const downloadGltf = async (url) => loader.parseAsync(await avatarFileBytes(url), THREE.LoaderUtils.extractUrlBase(url));
const downloadAstc = async (url) => astcLoader.parse(await avatarFileBytes(url));
async function downloadImage(url) {
  const local = URL.createObjectURL(new Blob([await avatarFileBytes(url)]));
  try {
    return await textureLoader.loadAsync(local);
  } finally {
    URL.revokeObjectURL(local);
  }
}

// The user's own avatar: its files stay on the device whatever else is shown
export function keepOnDevice(avatar) {
  const urls = avatar.urls.flatMap((url) => [url, optimizedUrl(url), optimizedUrl(url, '.ktx2')]).filter(Boolean);
  avatarFiles.pin('own', urls);
}

// Downloads are shared: changing one item in the editor reloads nothing else. What an
// avatar on show uses stays (counted per URL); of the rest only the latest
// IDLE_KEPT stay, for going back and forth in the editor, and older ones are freed
// (geometries, textures): trying item after item would otherwise fill the page's
// memory until the system kills it.
const gltfCache = new Map();
const textureCache = new Map();
const IDLE_KEPT = 16;
const uses = new Map(); // url → avatars using it
const idle = new Set(); // urls no avatar uses, oldest first

// Textures larger than this are scaled down once loaded (setTextureLimit): the models
// ship some at 2048 px (the feet) for a figure a few hundred pixels tall
let textureLimit = 1024;
export function setTextureLimit(pixels) {
  textureLimit = pixels;
}

const TEXTURE_SLOTS = ['map', 'normalMap', 'emissiveMap', 'alphaMap', 'roughnessMap', 'metalnessMap', 'aoMap', 'specularColorMap', 'specularIntensityMap'];
const texturesOf = (material) => TEXTURE_SLOTS.map((slot) => material[slot]).filter(Boolean);

const capped = new WeakSet();
function capTexture(texture) {
  const image = texture.image;
  if (!image?.width || capped.has(texture.source)) return;
  capped.add(texture.source);
  // Compressed (the optimised library): its smaller mip levels are already there
  if (texture.isCompressedTexture) {
    while (texture.mipmaps.length > 1 && Math.max(texture.mipmaps[0].width, texture.mipmaps[0].height) > textureLimit) {
      texture.mipmaps.shift();
    }
    texture.image = { width: texture.mipmaps[0].width, height: texture.mipmaps[0].height };
    texture.needsUpdate = true;
    return;
  }
  const scale = textureLimit / Math.max(image.width, image.height);
  if (scale >= 1) return;
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.width * scale));
  canvas.height = Math.max(1, Math.round(image.height * scale));
  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  image.close?.(); // an ImageBitmap: free its pixels now
  texture.image = canvas;
  texture.needsUpdate = true;
}

export function loadGltf(url) {
  if (!gltfCache.has(url)) {
    const fast = optimizedUrl(url);
    const download = fast ? downloadGltf(fast).catch(() => downloadGltf(url)) : downloadGltf(url);
    const promise = download.then((gltf) => {
      gltf.scene.traverse((object) => {
        if (object.isMesh) for (const material of materialsOf(object)) texturesOf(material).forEach(capTexture);
      });
      return gltf;
    });
    promise.catch(() => gltfCache.delete(url)); // a failed download is tried again next time
    gltfCache.set(url, promise);
  }
  return gltfCache.get(url);
}

// The eyes are never compressed (asset-pipeline optimize-avatars LOSSLESS): their PNG
const LOSSLESS = /\/items\/eyes\//;
function loadTexture(url) {
  if (!textureCache.has(url)) {
    const fast = LOSSLESS.test(url) ? null : optimizedUrl(url, '.ktx2');
    const download = fast ? downloadAstc(fast).catch(() => downloadImage(url)) : downloadImage(url);
    const promise = download.then((texture) => {
      texture.flipY = false; // glTF texture convention, like the body's own textures
      texture.colorSpace = THREE.SRGBColorSpace;
      texture.anisotropy = 4;
      capTexture(texture);
      return texture;
    });
    promise.catch(() => textureCache.delete(url));
    textureCache.set(url, promise);
  }
  return textureCache.get(url);
}

function retain(urls) {
  for (const url of urls) {
    uses.set(url, (uses.get(url) ?? 0) + 1);
    idle.delete(url);
  }
}

function release(urls) {
  for (const url of urls) {
    const count = (uses.get(url) ?? 1) - 1;
    if (count > 0) {
      uses.set(url, count);
      continue;
    }
    uses.delete(url);
    idle.delete(url);
    idle.add(url); // the most recent at the end
  }
  while (idle.size > IDLE_KEPT) {
    const url = idle.values().next().value;
    idle.delete(url);
    const entry = gltfCache.get(url) ?? textureCache.get(url);
    gltfCache.delete(url);
    textureCache.delete(url);
    entry?.then(freeLoaded, () => {});
  }
}

// Everything a download brought to memory (no avatar uses it any more)
function freeLoaded(loaded) {
  if (loaded?.isTexture) {
    loaded.dispose();
    return;
  }
  loaded?.scene?.traverse((object) => {
    if (!object.isMesh) return;
    object.geometry.dispose();
    for (const material of materialsOf(object)) {
      texturesOf(material).forEach((texture) => texture.dispose());
      material.dispose();
    }
  });
}

// Bare body meshes, by the part of the body they show
const BODY_PART_MESHES = [
  ['head', /_Head_BaseMesh$/i],
  ['upper_body', /_uBody_BaseMesh$/i],
  ['lower_body', /_lBody_BaseMesh$/i],
  ['feet', /_Feet_BaseMesh$/i],
  ['hands', /_Hands_BaseMesh$/i],
];
const FACE_MESHES = [
  ['eyes', /_Mask_Eyes$/i],
  ['eyebrows', /_Mask_Eyebrows$/i],
  ['mouth', /_Mask_Mouth$/i],
];

const WHITE = new THREE.Color(1, 1, 1);
const meshPart = (name, table) => table.find(([, pattern]) => pattern.test(name))?.[0] ?? null;

// Each instance gets its own materials: colours are per avatar. Vertex colours are
// left out, as Decentraland's shader does: the artists' tools leave them in, often
// black (frog fins, slides and ankles would render near black; the items' own
// thumbnails show them in their texture's colours).
function ownMaterials(root) {
  const own = (material) => {
    const copy = material.clone();
    copy.vertexColors = false;
    return copy;
  };
  root.traverse((object) => {
    if (!object.isMesh) return;
    object.material = Array.isArray(object.material) ? object.material.map(own) : own(object.material);
    object.castShadow = false;
    object.receiveShadow = false;
    object.frustumCulled = false; // skinned bounds do not follow the pose
  });
}

const materialsOf = (object) => (Array.isArray(object.material) ? object.material : [object.material]);

const isSkin = (material) => /skin/i.test(material.name);

// Skin is drawn without the scene's tone mapping: the neutral curve crushes the
// smallest channel of dark colours, so a deep brown turned orange, and by a different
// amount where the light is stronger (the feet and ankles, facing up, no longer
// matched the legs). Its own curve only rolls the highlights off, scaling the three
// channels together: every part of the skin keeps the hue that was picked, and light
// skin does not burn to white under the key light.
function skinShading(material) {
  material.toneMapped = false;
  material.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <tonemapping_fragment>',
      `#include <tonemapping_fragment>
      float skinPeak = max(max(gl_FragColor.r, gl_FragColor.g), gl_FragColor.b);
      if (skinPeak > 0.6) {
        float rolled = 0.6 + 0.4 * (1.0 - exp(-(skinPeak - 0.6) / 0.4));
        gl_FragColor.rgb *= rolled / skinPeak;
      }`,
    );
  };
  material.customProgramCacheKey = () => 'avatar-skin';
}

// Decentraland convention: materials named "skin" take the skin colour, "hair" the hair colour
function tint(root, colors) {
  root.traverse((object) => {
    if (!object.isMesh) return;
    for (const material of materialsOf(object)) {
      if (isSkin(material)) {
        material.color.set(colors.skin);
        skinShading(material);
      }
      else if (/hair/i.test(material.name)) material.color.set(colors.hair);
    }
  });
}

// The skin a worn model shows (bare ankles above a shoe, legs under shorts, arms out of
// a vest) must look like the body's own. The models disagree: the body's skin has no
// specular reflection (KHR_materials_specular, black), theirs the default shine (lighter,
// greyer ankles). Each worn skin material becomes the body's, with its own texture
// and transparency.
function matchSkin(root, bodySkin) {
  if (!bodySkin) return;
  root.traverse((object) => {
    if (!object.isMesh) return;
    const replace = (material) => {
      if (!isSkin(material)) return material;
      const skin = bodySkin.clone();
      skin.name = material.name;
      skin.map = material.map;
      skin.transparent = material.transparent;
      skin.opacity = material.opacity;
      skin.alphaTest = material.alphaTest;
      skin.depthWrite = material.depthWrite;
      skin.side = material.side;
      material.dispose();
      return skin;
    };
    object.material = Array.isArray(object.material) ? object.material.map(replace) : replace(object.material);
  });
}

// Eyes: the iris (dark in the mask) takes the eye colour
function irisMaterial(material, texture, mask, color) {
  material.map = texture;
  material.transparent = true;
  material.alphaTest = 0.01;
  material.depthWrite = false;
  if (!mask) return material;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uIrisMask = { value: mask };
    shader.uniforms.uIrisColor = { value: new THREE.Color(color) };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D uIrisMask;\nuniform vec3 uIrisColor;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        float iris = 1.0 - texture2D(uIrisMask, vMapUv).r;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uIrisColor * 2.2, iris);`);
  };
  material.customProgramCacheKey = () => 'avatar-iris';
  return material;
}

// The skin of a modular avatar is cut in pieces from different models (a leg from the
// shorts, the foot from the sandals): where two pieces meet, each has its own normals
// and the light breaks into a hard line at the seam. The normals of skin vertices that
// sit at the same place in different pieces are averaged (once, in the rest pose), so
// the light flows across the seam as over one body. Shared geometries are copied first
// (the loader caches them for every avatar).
const SEAM_GRID = 2000; // positions matched to half a millimetre
function weldSkinSeams(root) {
  root.updateMatrixWorld(true);
  const pieces = [];
  root.traverse((object) => {
    if (object.isMesh && object.visible && materialsOf(object).some(isSkin) && object.geometry.attributes.normal) pieces.push(object);
  });
  if (pieces.length < 2) return;
  const normalMatrix = new THREE.Matrix3();
  const point = new THREE.Vector3();
  const normal = new THREE.Vector3();
  // Place → { sum of world normals, meshes there }
  const places = new Map();
  const keys = pieces.map((mesh, index) => {
    const position = mesh.geometry.attributes.position;
    const normals = mesh.geometry.attributes.normal;
    normalMatrix.getNormalMatrix(mesh.matrixWorld);
    const meshKeys = new Array(position.count);
    for (let i = 0; i < position.count; i++) {
      point.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
      const key = `${Math.round(point.x * SEAM_GRID)}|${Math.round(point.y * SEAM_GRID)}|${Math.round(point.z * SEAM_GRID)}`;
      meshKeys[i] = key;
      normal.fromBufferAttribute(normals, i).applyMatrix3(normalMatrix).normalize();
      const place = places.get(key) ?? { sum: new THREE.Vector3(), meshes: new Set() };
      place.sum.add(normal);
      place.meshes.add(index);
      places.set(key, place);
    }
    return meshKeys;
  });
  const inverse = new THREE.Matrix3();
  pieces.forEach((mesh, index) => {
    let geometry = null;
    normalMatrix.getNormalMatrix(mesh.matrixWorld);
    inverse.copy(normalMatrix).invert();
    keys[index].forEach((key, i) => {
      const place = places.get(key);
      if (place.meshes.size < 2) return; // not on a seam
      if (!geometry) {
        geometry = mesh.geometry.clone();
        geometry.userData.ownCopy = true; // disposed with the avatar
        mesh.geometry = geometry;
      }
      normal.copy(place.sum).normalize().applyMatrix3(inverse).normalize();
      geometry.attributes.normal.setXYZ(i, normal.x, normal.y, normal.z);
    });
  });
}

function bonesByName(root) {
  const bones = new Map();
  root.traverse((object) => {
    if (object.isBone) bones.set(object.name, object);
  });
  return bones;
}

/**
 * @returns {Promise<{ root: THREE.Group, body: THREE.Object3D, bones: Map, syncPose(): void, height: number, failed: string[] }>}
 */
export async function composeAvatar(plan) {
  // Everything it downloads stays in memory while it is on show (disposeAvatar)
  const urls = [plan.body.model, ...plan.models.map((model) => model.model)];
  for (const face of Object.values(plan.face)) urls.push(face.texture, ...(face.mask ? [face.mask] : []));
  retain(urls);
  try {
    return await build(plan, urls);
  } catch (error) {
    release(urls);
    throw error;
  }
}

async function build(plan, urls) {
  const failed = [];
  // The models and the face textures all at once (from the device or the network)
  const facesLoaded = Promise.all(Object.entries(plan.face).map(async ([slot, face]) => {
    try {
      const [texture, mask] = await Promise.all([loadTexture(face.texture), face.mask ? loadTexture(face.mask) : null]);
      if (mask) mask.colorSpace = THREE.NoColorSpace;
      return [slot, { texture, mask }];
    } catch {
      failed.push(face.id);
      return [slot, null];
    }
  }));
  const [bodyGltf, ...worn] = await Promise.all([
    loadGltf(plan.body.model),
    ...plan.models.map((model) => loadGltf(model.model).catch(() => {
      failed.push(model.id);
      return null;
    })),
  ]);
  const faces = Object.fromEntries(await facesLoaded);

  const root = new THREE.Group();
  root.name = 'avatar';
  const body = cloneSkinned(bodyGltf.scene);
  ownMaterials(body);
  // The bare body under what is worn; a model that could not be loaded hides nothing
  // (the body shows there instead of a hole). Plans without per-model `hides`: as given.
  const hidden = new Set(plan.models.every((model) => model.hides)
    ? plan.models.filter((model, index) => worn[index]).flatMap((model) => model.hides)
    : plan.hiddenParts);
  body.traverse((object) => {
    if (!object.isMesh) return;
    const part = meshPart(object.name, BODY_PART_MESHES);
    if (part) object.visible = !hidden.has(part);
    const facePart = meshPart(object.name, FACE_MESHES);
    if (facePart) {
      const face = faces[facePart];
      object.visible = !!face && !hidden.has('head');
      if (!face) return;
      const material = object.material;
      if (facePart === 'eyes') irisMaterial(material, face.texture, face.mask, plan.colors.eyes);
      else {
        material.map = face.texture;
        material.transparent = true;
        material.alphaTest = 0.01;
        material.depthWrite = false;
        // Eyebrows match the hair; the lips take a lighter shade of the skin
        if (facePart === 'eyebrows') material.color.set(plan.colors.hair);
        else {
          material.color.set(plan.colors.skin).lerp(WHITE, 0.2);
          skinShading(material); // like the skin around them
        }
      }
      // The masks lie a hair's breadth off the face: pulled towards the camera in
      // depth, the head never shows through them in patches as it moves
      material.polygonOffset = true;
      material.polygonOffsetFactor = -1;
      material.polygonOffsetUnits = -4;
      // Flat decals: one pass (three draws double-sided transparent materials twice,
      // back faces then front, for shapes that can overlap themselves)
      material.forceSinglePass = true;
      material.needsUpdate = true;
    }
  });
  let bodySkin = null;
  body.traverse((object) => {
    if (object.isMesh) bodySkin ??= materialsOf(object).find(isSkin) ?? null;
  });
  tint(body, plan.colors);
  root.add(body);

  const bones = bonesByName(body);
  const pairs = [];
  worn.forEach((gltf) => {
    if (!gltf) return;
    const model = cloneSkinned(gltf.scene);
    ownMaterials(model);
    matchSkin(model, bodySkin);
    tint(model, plan.colors);
    const own = bonesByName(model);
    for (const [name, bone] of own) {
      const source = bones.get(name);
      if (source) pairs.push([source, bone]);
    }
    root.add(model);
  });
  weldSkinSeams(root);

  body.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(body, true);
  return {
    root,
    body,
    bones,
    height: box.max.y - box.min.y || 1.8,
    failed,
    urls,
    syncPose() {
      for (const [source, target] of pairs) {
        target.position.copy(source.position);
        target.quaternion.copy(source.quaternion);
        target.scale.copy(source.scale);
      }
    },
  };
}

export function disposeAvatar(avatar) {
  if (!avatar || avatar.disposed) return;
  avatar.disposed = true;
  avatar.root.traverse((object) => {
    if (!object.isMesh) return;
    for (const material of materialsOf(object)) material.dispose(); // geometries and textures stay cached
    if (object.geometry.userData.ownCopy) object.geometry.dispose(); // but not the welded copies
  });
  release(avatar.urls); // the downloads may now be freed
}
