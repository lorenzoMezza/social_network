// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { addSceneUniforms } from '../../scene/horizontalFog.js';

// A tiny repeating noise map is generated once on the CPU. The fragment shader
// then needs one filtered texture lookup instead of evaluating several noise
// octaves for every ground pixel.
const NOISE_SIZE = 128;

function hashNoise(x, y, seed = 0) {
  const value = Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453;
  return value - Math.floor(value);
}

function periodicNoise(x, y, cells, seed = 0) {
  const px = x * cells;
  const py = y * cells;
  const x0 = Math.floor(px);
  const y0 = Math.floor(py);
  const fx = px - x0;
  const fy = py - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const sample = (ix, iy) => hashNoise((ix + cells) % cells, (iy + cells) % cells, seed);
  const top = sample(x0, y0) * (1 - sx) + sample(x0 + 1, y0) * sx;
  const bottom = sample(x0, y0 + 1) * (1 - sx) + sample(x0 + 1, y0 + 1) * sx;
  return top * (1 - sy) + bottom * sy;
}

function createNoiseTexture() {
  const data = new Uint8Array(NOISE_SIZE * NOISE_SIZE);
  for (let y = 0; y < NOISE_SIZE; y += 1) {
    for (let x = 0; x < NOISE_SIZE; x += 1) {
      const u = x / NOISE_SIZE;
      const v = y / NOISE_SIZE;
      // Fine-grain pigment variation dominates; the low-frequency component
      // only keeps the surface from looking like uniform static.
      const noise = periodicNoise(u, v, 5) * 0.08
        + periodicNoise(u, v, 14) * 0.39
        + periodicNoise(u, v, 30) * 0.53;
      const value = Math.round(noise * 255);
      data[y * NOISE_SIZE + x] = value;
    }
  }

  const texture = new THREE.DataTexture(data, NOISE_SIZE, NOISE_SIZE, THREE.RedFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.NearestMipmapNearestFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

const GROUND_NOISE = createNoiseTexture();

// Smooth noise for the water (the ground's is grainy): two independent channels
// of soft blobs, a few per repeat
const WATER_NOISE_SIZE = 128;

function createWaterNoiseTexture() {
  const size = WATER_NOISE_SIZE;
  const data = new Uint8Array(size * size * 2);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      for (let channel = 0; channel < 2; channel += 1) {
        const seed = 1 + channel * 2;
        const noise = periodicNoise(x / size, y / size, 4, seed) * 0.62
          + periodicNoise(x / size, y / size, 9, seed + 1) * 0.38;
        data[(y * size + x) * 2 + channel] = Math.round(noise * 255);
      }
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGFormat);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.magFilter = THREE.LinearFilter;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  return texture;
}

const WATER_NOISE = createWaterNoiseTexture();

const GROUND_SHADER = /* glsl */ `
  varying vec2 vGroundPosition;
  uniform sampler2D uGroundNoise;
  uniform vec3 uGrassDark;
  uniform vec3 uGrassLight;
  uniform vec3 uSoil;
  uniform float uScale;

  vec3 mottledGroundColor() {
    float pattern = texture2D(uGroundNoise, vGroundPosition * uScale).r;
    float grassTone = 0.1 + pattern * 0.8;
    vec3 grass = mix(uGrassDark, uGrassLight, grassTone);

    // Blend earth through the fine grain everywhere, rather than outlining
    // separate brown regions with a mask.
    float soilAmount = 0.03 + pattern * 0.24;
    return mix(grass, uSoil, soilAmount);
  }
`;

// Stylised water, Pokémon GO style, kept simple: a deep, saturated blue drifting
// slowly towards a lighter blue over hundreds of metres, and soft swells tens of
// metres wide gliding over it, with a light band along their crests. Everything is
// broad and smooth, so it reads from the player to the horizon (far away the
// texture's mipmaps blend it gently instead of flickering), and two noises at
// scales and angles that never line up keep a lake or the sea from repeating.
const WATER_SHADER = /* glsl */ `
  varying vec2 vGroundPosition;
  uniform sampler2D uWaterNoise;
  uniform vec3 uWaterDeep;
  uniform vec3 uWaterLight;
  uniform vec3 uWaterCrest;
  // How much the swells show (0 for small pools)
  uniform float uWaves;
  // w: time in seconds (the scene's ground weather state)
  uniform vec4 uWaterSurface;

  vec3 waterColor() {
    vec2 p = vGroundPosition;
    float t = uWaterSurface.w;
    const mat2 turn = mat2(0.8, -0.6, 0.6, 0.8);

    // Deeper and lighter water over hundreds of metres
    float tone = texture2D(uWaterNoise, p * 0.0021 + vec2(0.13, 0.71)).r * 0.6
      + texture2D(uWaterNoise, turn * p * 0.00083).g * 0.4;
    vec3 color = mix(uWaterDeep, uWaterLight, smoothstep(0.3, 0.75, tone) * 0.6);

    // Swells: two smooth noises gliding in different directions
    float swell = texture2D(uWaterNoise, p * 0.011 + vec2(t * 0.011, t * 0.006)).r * 0.55
      + texture2D(uWaterNoise, turn * p * 0.016 - vec2(t * 0.007, -t * 0.01)).g * 0.45;
    color = mix(color, uWaterLight, smoothstep(0.5, 0.72, swell) * 0.45 * uWaves);
    // A light band along the crests
    float crest = smoothstep(0.64, 0.7, swell) * (1.0 - smoothstep(0.72, 0.8, swell));
    return mix(color, uWaterCrest, crest * 0.28 * uWaves);
  }
`;

// A flat colour under the street lamps (roads and their edges): at night it emits the
// lamps' light, above the night grade (horizontalFog.js SCENE_LAMP); with
// SCENE_LAMP_POOLS in pools a little brighter and dimmer along the street
const LAMP_SHADER = /* glsl */ `
  varying vec2 vGroundPosition;
  uniform sampler2D uGroundNoise;
  uniform float sceneStreetLights;
  uniform vec4 uLamp;
  vec3 sceneLampColor = vec3(0.0);
  float sceneLampMix = 0.0;

  vec3 lampColor() {
    sceneLampColor = uLamp.rgb;
    #ifdef SCENE_LAMP_POOLS
      float pool = texture2D(uGroundNoise, vGroundPosition * 0.018).r;
      sceneLampColor *= 0.95 + 0.1 * smoothstep(0.25, 0.75, pool);
    #endif
    sceneLampMix = sceneStreetLights * uLamp.w;
    return diffuse;
  }
`;

function addWorldPositionToShader(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', '#include <common>\nvarying vec2 vGroundPosition;')
    .replace(
      '#include <begin_vertex>',
      `#include <begin_vertex>
vec4 groundPosition = vec4(transformed, 1.0);
#ifdef USE_BATCHING
groundPosition = batchingMatrix * groundPosition;
#endif
#ifdef USE_INSTANCING
groundPosition = instanceMatrix * groundPosition;
#endif
vGroundPosition = (modelMatrix * groundPosition).xz;`,
    );
}

function createUnlitTexturedMaterial(uniforms, fragmentCode, colorFunction) {
  const material = new THREE.MeshBasicMaterial({ color: 0xffffff });
  material.customProgramCacheKey = () => colorFunction;
  material.onBeforeCompile = (shader) => {
    addSceneUniforms(shader); // this replaces the shared fog/grade hook of every material
    Object.assign(shader.uniforms, uniforms);
    addWorldPositionToShader(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${fragmentCode}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\ndiffuseColor.rgb = ${colorFunction}();`);
  };
  return material;
}

export function createMottledGroundMaterial({ dark, light, soil, scale = 0.01 }) {
  const uniforms = {
    uGroundNoise: { value: GROUND_NOISE },
    uGrassDark: { value: new THREE.Color(dark) },
    uGrassLight: { value: new THREE.Color(light) },
    uSoil: { value: new THREE.Color(soil) },
    uScale: { value: scale },
  };
  return createUnlitTexturedMaterial(uniforms, GROUND_SHADER, 'mottledGroundColor');
}

// `surface`: the scene's ground weather state (groundWeather.surface), for the time
export function createWaterMaterial({ deep, light, crest, waves = 1 }, surface) {
  const uniforms = {
    uWaterNoise: { value: WATER_NOISE },
    uWaves: { value: waves },
    uWaterDeep: { value: new THREE.Color(deep) },
    uWaterLight: { value: new THREE.Color(light) },
    uWaterCrest: { value: new THREE.Color(crest) },
    uWaterSurface: { value: surface },
  };
  return createUnlitTexturedMaterial(uniforms, WATER_SHADER, 'waterColor');
}

// `lamp`: { color: [r, g, b], amount }: the light of the street lamps, emitted at
// night; `pools`: brighter and dimmer along the street
export function createLampMaterial(color, lamp, { pools = false } = {}) {
  const uniforms = {
    uGroundNoise: { value: GROUND_NOISE },
    uLamp: { value: new THREE.Vector4(...lamp.color, lamp.amount) },
  };
  const material = createUnlitTexturedMaterial(uniforms, LAMP_SHADER, 'lampColor');
  material.color.set(color);
  material.defines = { ...material.defines, SCENE_LAMP: '', ...(pools ? { SCENE_LAMP_POOLS: '' } : {}) };
  return material;
}

