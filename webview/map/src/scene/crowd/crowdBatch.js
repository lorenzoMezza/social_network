// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { ATLAS, MATERIAL_TEXELS, MAX_BONES, MAX_MATERIALS } from './crowdModel.js';
import { poseInto } from './crowdPose.js';
import { ANTIALIAS } from '../createRenderer.js';

// A group of people drawn in one go: one BatchedMesh (one draw call, or one per
// person on GPUs without multi-draw, with nothing to switch between them), whatever
// each one wears. Per person (an instance) a row of skinning matrices; per avatar
// model (people may share one) its geometry, a row of its material table and a layer
// of the atlas array texture. The shader reads them by the instance's number.

// Texels per row of the skinning texture: 4 per bone, then the row's model slot
const BONE_TEXELS = MAX_BONES * 4 + 4;
const INFO_TEXEL = MAX_BONES * 4;
// Room per model at first; the batch grows when an avatar needs more
const VERTICES_PER_MODEL = 3500;
const INDICES_PER_MODEL = 12000;
// Moves the face (eyes, brows, lips) this much towards the camera in depth, in world
// units: the decals never sink into the head, wherever the camera is
const DECAL_LIFT = 0.04;

const ASTC_LEVEL_BYTES = Array.from({ length: ATLAS.levels }, (_, level) => {
  const side = ATLAS.size >> level;
  return Math.ceil(side / 6) * Math.ceil(side / 6) * 16;
});

const vertexHead = /* glsl */ `
attribute vec4 crowdJoints;
attribute vec4 crowdWeights;
attribute float crowdMaterial;
uniform highp sampler2D crowdBones;
uniform highp sampler2D crowdMaterials;
varying vec2 vCrowdUv;
// The instance's row, its model's slot, the material
flat varying vec3 vCrowd;
mat4 crowdBone(int row, float bone) {
  int x = int(bone) * 4;
  return mat4(
    texelFetch(crowdBones, ivec2(x, row), 0),
    texelFetch(crowdBones, ivec2(x + 1, row), 0),
    texelFetch(crowdBones, ivec2(x + 2, row), 0),
    texelFetch(crowdBones, ivec2(x + 3, row), 0)
  );
}
`;

const fragmentHead = /* glsl */ `
uniform highp sampler2D crowdMaterials;
uniform highp sampler2DArray crowdAtlas;
varying vec2 vCrowdUv;
flat varying vec3 vCrowd;
vec4 crowdTexel(int texel) {
  return texelFetch(crowdMaterials, ivec2(int(vCrowd.z) * ${MATERIAL_TEXELS} + texel, int(vCrowd.y)), 0);
}
`;

function createMaterial({ bones, materials, atlas, prepare }) {
  const material = new THREE.MeshStandardMaterial({ side: THREE.DoubleSide, alphaToCoverage: ANTIALIAS });
  material.name = 'crowd';
  // See-through parts by coverage (alpha to coverage, smooth with MSAA): the fragment's
  // alpha decides how many samples it covers, but must not reach the canvas, or the
  // page would show through those pixels. Colour written as it is, alpha left alone
  // (the scene behind is opaque). Without MSAA they are cut at half opacity instead
  if (!ANTIALIAS) material.defines = { CROWD_CUT_SEE_THROUGH: '' };
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.ZeroFactor;
  material.blendSrcAlpha = THREE.ZeroFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.crowdBones = { value: bones };
    shader.uniforms.crowdMaterials = { value: materials };
    shader.uniforms.crowdAtlas = { value: atlas };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${vertexHead}`)
      .replace('#include <beginnormal_vertex>', /* glsl */ `#include <beginnormal_vertex>
        int crowdRow = int(getIndirectIndex(gl_DrawID));
        float crowdModel = texelFetch(crowdBones, ivec2(${INFO_TEXEL}, crowdRow), 0).x;
        vCrowd = vec3(float(crowdRow), crowdModel, crowdMaterial);
        vCrowdUv = uv;
        mat4 crowdSkin = crowdWeights.x * crowdBone(crowdRow, crowdJoints.x)
          + crowdWeights.y * crowdBone(crowdRow, crowdJoints.y)
          + crowdWeights.z * crowdBone(crowdRow, crowdJoints.z)
          + crowdWeights.w * crowdBone(crowdRow, crowdJoints.w);
        objectNormal = normalize(mat3(crowdSkin) * objectNormal);`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed = (crowdSkin * vec4(transformed, 1.0)).xyz;`)
      .replace('#include <project_vertex>', /* glsl */ `#include <project_vertex>
        // The face's decals, a little nearer in depth (on screen where they are)
        if (texelFetch(crowdMaterials, ivec2(int(crowdMaterial) * ${MATERIAL_TEXELS} + 5, int(crowdModel)), 0).w > 0.5) {
          vec4 crowdLifted = mvPosition;
          crowdLifted.xyz -= normalize(crowdLifted.xyz) * ${DECAL_LIFT.toFixed(3)};
          vec4 crowdClip = projectionMatrix * crowdLifted;
          gl_Position.z = crowdClip.z / crowdClip.w * gl_Position.w;
        }`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragmentHead}`)
      .replace('#include <map_fragment>', /* glsl */ `
        vec4 crowdBase = crowdTexel(0);
        vec4 crowdMode = crowdTexel(3);
        vec4 crowdWindow = crowdTexel(6);
        vec4 crowdFlags = crowdTexel(5);
        vec4 crowdSurface = crowdTexel(4);
        // Where in the region: within the picture's window, or repeating
        vec2 crowdScale = crowdMode.w > 0.5 ? 1.0 / max(crowdWindow.zw, vec2(1e-6)) : vec2(1.0);
        vec2 crowdLocal = crowdMode.w > 0.5 ? clamp((vCrowdUv - crowdWindow.xy) * crowdScale, 0.0, 1.0) : fract(vCrowdUv);
        // Filtering from the coordinates' own slopes (fract and clamp break them)
        vec2 crowdDx = dFdx(vCrowdUv) * crowdScale;
        vec2 crowdDy = dFdy(vCrowdUv) * crowdScale;
        vec4 crowdColor = crowdTexel(1);
        if (crowdBase.z > 0.0) {
          crowdColor *= textureGrad(crowdAtlas, vec3(crowdBase.xy + crowdLocal * crowdBase.zw, vCrowd.y), crowdDx * crowdBase.zw, crowdDy * crowdBase.zw);
        }
        diffuseColor *= crowdColor;
        // Pieces shown from one side only
        if (crowdFlags.z > 0.5 && !gl_FrontFacing) discard;`)
      .replace('#include <alphatest_fragment>', /* glsl */ `
        // Opaque; cut out at the material's threshold; or see-through by coverage
        if (crowdFlags.x < 0.5) diffuseColor.a = 1.0;
        else if (crowdFlags.x < 1.5) {
          float crowdEdge = max(fwidth(diffuseColor.a), 1e-4);
          diffuseColor.a = smoothstep(crowdSurface.w - crowdEdge, crowdSurface.w + crowdEdge, diffuseColor.a);
        }
        #ifdef CROWD_CUT_SEE_THROUGH
          else if (diffuseColor.a < 0.5) discard;
        #endif
        if (diffuseColor.a < 0.02) discard;`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = crowdSurface.x;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = crowdSurface.y;')
      .replace('#include <emissivemap_fragment>', /* glsl */ `
        vec4 crowdGlowRegion = crowdTexel(2);
        vec3 crowdGlow = crowdMode.rgb;
        if (crowdGlowRegion.z > 0.0) {
          crowdGlow *= textureGrad(crowdAtlas, vec3(crowdGlowRegion.xy + crowdLocal * crowdGlowRegion.zw, vCrowd.y), crowdDx * crowdGlowRegion.zw, crowdDy * crowdGlowRegion.zw).rgb;
        }
        totalEmissiveRadiance = crowdGlow;`)
      .replace('#include <lights_physical_fragment>', /* glsl */ `#include <lights_physical_fragment>
        // The material's own shine (the skin has none: KHR_materials_specular)
        material.specularColor *= crowdSurface.z;
        material.specularF90 = mix(crowdSurface.z, 1.0, metalnessFactor);`)
      .replace('#include <tonemapping_fragment>', /* glsl */ `
        if (crowdFlags.y > 0.5) {
          // Skin: no tone mapping, highlights rolled off (composeAvatar skinShading)
          float crowdPeak = max(max(gl_FragColor.r, gl_FragColor.g), gl_FragColor.b);
          if (crowdPeak > 0.6) gl_FragColor.rgb *= (0.6 + 0.4 * (1.0 - exp(-(crowdPeak - 0.6) / 0.4))) / crowdPeak;
        } else {
          #include <tonemapping_fragment>
        }`);
  };
  material.customProgramCacheKey = () => 'crowd-avatar';
  // The scene's look for avatars (stencil for the shadows, tint, fill light)
  prepare(material);
  return material;
}

/**
 * A batch for up to `capacity` people. withAstc: atlases in ASTC (else RGBA from the
 * PNGs). prepare(material): the map's setup of avatar materials. renderer: where the
 * poses are sent each frame (upload).
 */
export function createCrowdBatch({ scene, renderer, capacity, withAstc, prepare }) {
  const boneData = new Float32Array(BONE_TEXELS * 4 * capacity);
  const bones = new THREE.DataTexture(boneData, BONE_TEXELS, capacity, THREE.RGBAFormat, THREE.FloatType);
  const materialData = new Float32Array(MAX_MATERIALS * MATERIAL_TEXELS * 4 * capacity);
  const materials = new THREE.DataTexture(materialData, MAX_MATERIALS * MATERIAL_TEXELS, capacity, THREE.RGBAFormat, THREE.FloatType);
  for (const texture of [bones, materials]) {
    texture.minFilter = THREE.NearestFilter;
    texture.magFilter = THREE.NearestFilter;
    texture.needsUpdate = true;
  }

  let atlas;
  if (withAstc) {
    const mipmaps = ASTC_LEVEL_BYTES.map((bytes, level) => ({
      data: new Uint8Array(bytes * capacity),
      width: ATLAS.size >> level,
      height: ATLAS.size >> level,
    }));
    atlas = new THREE.CompressedArrayTexture(mipmaps, ATLAS.size, ATLAS.size, capacity, THREE.RGBA_ASTC_6x6_Format, THREE.UnsignedByteType);
    atlas.minFilter = THREE.LinearMipmapLinearFilter;
    atlas.generateMipmaps = false;
  } else {
    const side = ATLAS.fallbackSize;
    atlas = new THREE.DataArrayTexture(new Uint8Array(side * side * 4 * capacity), side, side, capacity);
    atlas.minFilter = THREE.LinearMipmapLinearFilter;
    atlas.generateMipmaps = true;
  }
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.magFilter = THREE.LinearFilter;
  atlas.wrapS = THREE.ClampToEdgeWrapping;
  atlas.wrapT = THREE.ClampToEdgeWrapping;
  atlas.anisotropy = 4;

  const material = createMaterial({ bones, materials, atlas, prepare });
  const mesh = new THREE.BatchedMesh(capacity, capacity * VERTICES_PER_MODEL, capacity * INDICES_PER_MODEL, material);
  mesh.name = 'crowd';
  // Culled per person by the caller (skinned figures move past their rest bounds)
  mesh.frustumCulled = false;
  mesh.perObjectFrustumCulled = false;
  mesh.sortObjects = false;
  // For the developer tools: what the shader reads
  mesh.userData.crowd = { bones, materials, atlas };
  scene.add(mesh);

  // model key → { slot, geometryId, users }
  const models = new Map();
  const freeSlots = Array.from({ length: capacity }, (_, i) => i);
  // instance → model key
  const instances = new Map();
  // Rows of the bone texture posed this frame (an instance is a row): only the block
  // from the first to the last of them goes to the GPU, people out of view and empty
  // rows past them are not sent again for nothing
  let firstRow = Infinity;
  let lastRow = -1;

  const placeModel = (model) => {
    const { geometry } = model;
    const vertices = geometry.attributes.position.count;
    const indices = geometry.index.count;
    // Room: first what removed avatars left, then more
    if (mesh.unusedVertexCount < vertices || mesh.unusedIndexCount < indices) mesh.optimize();
    if (mesh.unusedVertexCount < vertices || mesh.unusedIndexCount < indices) {
      mesh.setGeometrySize(
        Math.ceil((mesh._maxVertexCount - mesh.unusedVertexCount + vertices) * 1.5),
        Math.ceil((mesh._maxIndexCount - mesh.unusedIndexCount + indices) * 1.5),
      );
    }
    const geometryId = mesh.addGeometry(geometry);
    const slot = freeSlots.shift();
    materialData.fill(0, slot * MAX_MATERIALS * MATERIAL_TEXELS * 4, (slot + 1) * MAX_MATERIALS * MATERIAL_TEXELS * 4);
    materialData.set(model.materials, slot * MAX_MATERIALS * MATERIAL_TEXELS * 4);
    materials.needsUpdate = true;
    if (withAstc) {
      atlas.mipmaps.forEach((level, i) => level.data.set(model.atlas.levels[i], slot * ASTC_LEVEL_BYTES[i]));
    } else {
      const bytes = ATLAS.fallbackSize * ATLAS.fallbackSize * 4;
      atlas.image.data.set(model.atlas.pixels, slot * bytes);
    }
    atlas.addLayerUpdate(slot);
    atlas.needsUpdate = true;
    const entry = { slot, geometryId, users: 0 };
    models.set(model.key, entry);
    return entry;
  };

  return {
    mesh,
    capacity,
    get count() {
      return instances.size;
    },
    // Whether this batch can take one more person wearing `model`
    canTake(model) {
      return instances.size < capacity && (models.has(model.key) || freeSlots.length > 0);
    },
    has(model) {
      return models.has(model.key);
    },
    /** A new person wearing `model`: answers their instance */
    add(model) {
      const entry = models.get(model.key) ?? placeModel(model);
      const instance = mesh.addInstance(entry.geometryId);
      entry.users++;
      instances.set(instance, model.key);
      boneData[(instance * BONE_TEXELS + INFO_TEXEL) * 4] = entry.slot;
      mesh.setVisibleAt(instance, false); // until its first pose
      return instance;
    },
    remove(instance) {
      const key = instances.get(instance);
      if (key === undefined) return;
      instances.delete(instance);
      mesh.deleteInstance(instance);
      const entry = models.get(key);
      if (--entry.users > 0) return;
      models.delete(key);
      mesh.deleteGeometry(entry.geometryId);
      freeSlots.push(entry.slot);
    },
    /**
     * This frame's pose (crowdPose.poseInto layers) and place (`matrix`: model → world),
     * the bones' world matrices into `boneWorlds` when given
     */
    pose(instance, rig, layers, matrix, boneWorlds) {
      poseInto(boneData, instance * BONE_TEXELS * 4, rig, layers, boneWorlds);
      mesh.setMatrixAt(instance, matrix);
      mesh.setVisibleAt(instance, true);
      firstRow = Math.min(firstRow, instance);
      lastRow = Math.max(lastRow, instance);
    },
    hide(instance) {
      if (instances.has(instance)) mesh.setVisibleAt(instance, false);
    },
    // Before the frame is drawn: this frame's poses to the GPU, the rows posed (each with
    // its info texel: the model's slot, written when the person was added). One upload
    // of whole rows, straight to the texture once it exists: three's partial updates
    // read the pixel-store state back each time (synchronous calls, slow in a WebView)
    upload() {
      if (lastRow < 0) return;
      const texture = renderer.properties.get(bones).__webglTexture;
      if (!texture) {
        bones.needsUpdate = true; // not on the GPU yet: three sends it whole
      } else {
        const gl = renderer.getContext();
        renderer.state.bindTexture(gl.TEXTURE_2D, texture);
        // As three sends a float texture (it sets these before each of its own uploads)
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, firstRow, BONE_TEXELS, lastRow - firstRow + 1, gl.RGBA, gl.FLOAT, boneData, firstRow * BONE_TEXELS * 4);
      }
      firstRow = Infinity;
      lastRow = -1;
    },
    dispose() {
      scene.remove(mesh);
      mesh.dispose();
      material.dispose();
      bones.dispose();
      materials.dispose();
      atlas.dispose();
    },
  };
}
