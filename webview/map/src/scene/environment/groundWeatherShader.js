// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { look } from '../../looks/index.js';

// Weather on the map surface, added to every material through the shared fog chunk
// (horizontalFog.js). A few lines of shader math per pixel and a few reads of two
// small textures:
//  - cloud shadows: light, slightly blue blobs gliding slowly over the map with the
//    wind, as many as the cloud cover (not cast by the actual clouds)
//  - wet ground: the whole map turns darker and a little richer in colour; a thin
//    film of water mirrors the sky only at grazing angles and the sun as a small
//    glint, varying slowly over hundreds of metres, never in patches
//  - snow cover: an even layer on the ground and the roofs, thinner up the walls,
//    that keeps a hint of the colour below so parks, built-up land and water stay
//    recognisable. Never on roads and water (SCENE_SNOW 0)
// Branches depend on uniforms only (no weather → skipped by every pixel at once).
//
// Per-material defines:
//   SCENE_GLOSS (0–1, default 0.5)  how glossy the surface gets when wet
//   SCENE_SHEEN (0–1, default 0)    gloss even when dry (road edges)
//   SCENE_SPARKLE (0–1)             glitter of the sun on it (water, with SCENE_SHEEN)
//   SCENE_SNOW  (0–1, default 1)    how much snow settles on it
//   SCENE_SHADE (0–1, default 1)    how much cloud shadow it takes
//   SCENE_NO_GROUND_WEATHER         cloud shadows only (the avatar)
//   SCENE_SEE_THROUGH               see-through (the glass buildings): cloud shadows
//                                   of the ground seen through it

// Metres covered by one repeat of the weather map for the cloud shadows
const SHADOW_SCALE = 520;
// The cloud shadows read the weather map through a slow warp of itself. Both
// lookups are baked once at startup into one texture (one read per pixel instead
// of two dependent ones): the warp is read at 3/8 of the scale, so the result
// repeats every SHADOW_REPEATS weather-map repeats, which the texture covers with
// the detail the shader read (level 1 of the 256² map: 128 texels a repeat).
const SHADOW_WARP_SCALE = 0.375;
const SHADOW_WARP = 0.12;
const SHADOW_REPEATS = 8;
const SHADOW_MAP_SIZE = 1024;
// Strength of the cloud shadows in full sun, and how much each channel darkens in
// them: cool shade, like the blue light of the sky (looks/: shadow)
export const CLOUD_SHADOW_STRENGTH = look.shadow.strength;
const SHADOW_COLOR = look.shadow.color;
// Wet ground darkens by this, per channel (looks/: weather.wet): cooler than grey,
// so warm colours never turn to mud
const WET_COLOR = `vec3(${look.weather.wet.map((c) => c.toFixed(3)).join(', ')})`;

export const groundWeather = {
  // x, y: cloud drift (metres) · z: level of the weather map above which the
  // shadows lie (coverageLevel of the cloud cover) · w: shadow strength
  cloudShadow: new THREE.Vector4(0, 0, 1, 0),
  // x: wetness · y: rain · z: snow cover · w: time (s)
  surface: new THREE.Vector4(),
  // Where the glint comes from (sun by day, moon at night) and its colour
  glintDirection: new THREE.Vector3(0, 1, 0),
  glint: new THREE.Color(),
  reflection: new THREE.Color(),
  weatherMap: { value: null },
  // The cloud shadows, baked from the weather map (useCloudWeatherMap)
  cloudShadowMap: { value: null },
};

// The weather map the clouds are shaped by (2D, RG): read by the ground for snow
// drifts and wet patches, and baked once, on the GPU, into the cloud shadow
// texture: the same two dependent reads the ground would do per pixel, done once
// for every texel. Answers the bake as a pass for the shader gate (shaderGate.js): it
// must not wait for its shader, and until it is done the ground just has no cloud shadows
export function useCloudWeatherMap(renderer, weatherMap) {
  groundWeather.weatherMap.value = weatherMap;
  const target = new THREE.WebGLRenderTarget(SHADOW_MAP_SIZE, SHADOW_MAP_SIZE, {
    format: THREE.RedFormat,
    type: THREE.UnsignedByteType,
    wrapS: THREE.RepeatWrapping,
    wrapT: THREE.RepeatWrapping,
    magFilter: THREE.LinearFilter,
    minFilter: THREE.LinearMipmapLinearFilter,
    generateMipmaps: true,
    depthBuffer: false,
  });
  const material = new THREE.ShaderMaterial({
    uniforms: { uWeatherMap: { value: weatherMap } },
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      void main() {
        vUv = position.xy * 0.5 + 0.5;
        gl_Position = vec4(position.xy, 0.0, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform sampler2D uWeatherMap;
      varying vec2 vUv;
      void main() {
        vec2 drifted = vUv * ${SHADOW_REPEATS.toFixed(1)};
        vec2 warp = textureLod(uWeatherMap, drifted * ${SHADOW_WARP_SCALE} + 0.5, 1.0).rg - 0.5;
        gl_FragColor = vec4(textureLod(uWeatherMap, drifted + warp * ${SHADOW_WARP}, 1.0).r, 0.0, 0.0, 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  });
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const quad = new THREE.Mesh(geometry, material);
  quad.frustumCulled = false;
  const camera = new THREE.OrthographicCamera();
  // On its own target, as it will be drawn: a shader is made for where it draws
  const onTarget = (run) => {
    const previousTarget = renderer.getRenderTarget();
    renderer.setRenderTarget(target);
    run();
    renderer.setRenderTarget(previousTarget);
  };
  return {
    material,
    compile: () => onTarget(() => renderer.compile(quad, camera)),
    onReady() {
      onTarget(() => renderer.render(quad, camera));
      material.dispose();
      geometry.dispose();
      groundWeather.cloudShadowMap.value = target.texture;
    },
  };
}

export const groundWeatherUniforms = {
  sceneCloudShadow: { value: groundWeather.cloudShadow },
  sceneSurface: { value: groundWeather.surface },
  sceneGlintDirection: { value: groundWeather.glintDirection },
  sceneGlint: { value: groundWeather.glint },
  sceneReflection: { value: groundWeather.reflection },
  sceneWeatherMap: groundWeather.weatherMap,
  sceneCloudShadowMap: groundWeather.cloudShadowMap,
};

export const groundWeatherParsFragment = /* glsl */ `
  uniform vec4 sceneCloudShadow;
  uniform vec4 sceneSurface;
  uniform vec3 sceneGlintDirection;
  uniform vec3 sceneGlint;
  uniform vec3 sceneReflection;
  uniform sampler2D sceneWeatherMap;
  uniform sampler2D sceneCloudShadowMap;

  #ifndef SCENE_GLOSS
    #define SCENE_GLOSS 0.5
  #endif
  #ifndef SCENE_SNOW
    #define SCENE_SNOW 1.0
  #endif
  #ifndef SCENE_SHADE
    #define SCENE_SHADE 1.0
  #endif

  // 0 in the sun, 1 in the shade of a cloud. Not cast by the clouds of the sky:
  // soft blobs the size of a few blocks gliding slowly over the map with the wind,
  // more of them the more the sky is clouded (the clouds' weather map, read finer)
  float sceneCloudCover(vec3 world) {
    // The weather map through a slow warp of itself, which keeps the outlines
    // soft and organic: baked in one texture (useCloudWeatherMap)
    vec2 drifted = (world.xz + sceneCloudShadow.xy) / ${(SHADOW_SCALE * SHADOW_REPEATS).toFixed(1)};
    float weather = texture2D(sceneCloudShadowMap, drifted).r;
    return smoothstep(sceneCloudShadow.z - 0.1, sceneCloudShadow.z + 0.1, weather);
  }

  // 1 on the ground and roofs, less up the walls
  float sceneFlatness() {
    return 1.0 - smoothstep(0.05, 1.2, vSceneWorld.y) * 0.6;
  }
`;

// Before the colour grade: shading of the surface itself
export const groundWeatherAlbedoFragment = /* glsl */ `
  {
    #ifndef SCENE_NO_GROUND_WEATHER
      if (sceneSurface.x > 0.0) {
        // Wet: darker and a little richer in colour, like soaked stone and grass
        float wetAmount = sceneSurface.x * mix(0.65, 1.0, float(SCENE_GLOSS)) * sceneFlatness();
        float wetLuma = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
        vec3 soaked = max(mix(vec3(wetLuma), gl_FragColor.rgb, 1.25), 0.0) * ${WET_COLOR};
        gl_FragColor.rgb = mix(gl_FragColor.rgb, soaked, wetAmount);
      }
      if (sceneSurface.z > 0.0 && float(SCENE_SNOW) > 0.0) {
        // Slow drifts over hundreds of metres, no patches
        float drift = textureLod(sceneWeatherMap, vSceneWorld.xz / 900.0, 2.0).g;
        float cover = clamp(sceneSurface.z * (0.9 + drift * 0.2), 0.0, 1.0) * float(SCENE_SNOW) * sceneFlatness();
        float groundLuma = max(dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.04);
        // Snow keeps a hint of the hue and of the texture below
        vec3 hue = gl_FragColor.rgb / groundLuma;
        vec3 snow = vec3(0.9, 0.93, 0.97) * mix(vec3(1.0), hue, 0.32) * (0.84 + groundLuma * 0.22);
        gl_FragColor.rgb = mix(gl_FragColor.rgb, snow, cover * 0.88);
      }
    #endif
  }
`;

// After the fog: cloud shadows, so they also show far away, across the whole map
// (only the thickest haze at the horizon softens them)
export const groundWeatherShadowFragment = /* glsl */ `
  if (sceneCloudShadow.w > 0.0) {
    #ifdef SCENE_SEE_THROUGH
      // Glass shows the ground behind it: shaded as that ground, else the shadows
      // on the roof and those seen through it, metres apart far away, would slide
      // over each other as the camera moves (like a reflection of the clouds)
      vec3 sceneRay = sceneView - vec3(0.0, sceneDistance * sceneDistance * sceneGroundCurvature, 0.0);
      vec3 sceneShaded = vSceneWorld;
      sceneShaded.xz += sceneRay.xz * (max(vSceneWorld.y, 0.0) / max(-sceneRay.y, 1.0));
    #else
      vec3 sceneShaded = vSceneWorld;
    #endif
    // Cool shade, like the blue light of the sky filling it
    float shade = sceneCloudShadow.w * sceneCloudCover(sceneShaded) * (1.0 - fogFactor * 0.7) * float(SCENE_SHADE);
    gl_FragColor.rgb *= 1.0 - shade * vec3(${SHADOW_COLOR.map((c) => c.toFixed(3)).join(', ')});
  }
`;

// After the colour grade: light reflected by glossy surfaces (already in the
// colours of the sky). Wet ground, and road edges always a little.
// Needs sceneView (camera → surface), from the fog chunk. Only glossy surfaces and
// wet ground get here: the view direction is not computed for the rest.
export const groundWeatherReflectionFragment = /* glsl */ `
  #ifndef SCENE_NO_GROUND_WEATHER
  #ifdef SCENE_SHEEN
    bool sceneGlossy = true;
  #else
    bool sceneGlossy = sceneSurface.x > 0.0;
  #endif
  if (sceneGlossy && vSceneWorld.y < 0.5) {
    vec3 toCamera = -normalize(sceneView);
    float grazing = 1.0 - clamp(toCamera.y, 0.0, 1.0);
    float facing = max(normalize(sceneGlintDirection + toCamera).y, 0.0);
    #ifdef SCENE_SHEEN
      // Dry gloss (road edges, water): the sky at grazing angles, a broad glint
      float sheen = float(SCENE_SHEEN);
      gl_FragColor.rgb = mix(gl_FragColor.rgb, sceneReflection, sheen * (0.06 + 0.94 * pow(grazing, 3.5)) * 0.8);
      gl_FragColor.rgb += sceneGlint * (pow(facing, 40.0) * 0.55 + pow(facing, 6.0) * 0.07) * sheen;
      #ifdef SCENE_SPARKLE
        // Glitter (water): tiny points twinkling one by one, many along the path of
        // the sun's (or moon's) reflection, a few elsewhere. One point at a random
        // spot of each cell of a few metres; gone far away, where a point would be
        // smaller than a pixel and only flicker
        vec2 sparkleCell = floor(vSceneWorld.xz / 2.4);
        vec2 sparkleSeed = fract(sin(vec2(dot(sparkleCell, vec2(127.1, 311.7)), dot(sparkleCell, vec2(269.5, 183.3)))) * 43758.5453);
        vec2 sparkleAt = fract(vSceneWorld.xz / 2.4) - 0.2 - sparkleSeed * 0.6;
        float sparklePoint = 1.0 - smoothstep(0.03, 0.1, length(sparkleAt));
        float sparkleBeat = pow(max(sin(sceneSurface.w * (1.2 + sparkleSeed.y * 1.6) + sparkleSeed.x * 6.2832), 0.0), 14.0);
        float sparkleNear = 1.0 - smoothstep(110.0, 280.0, length(sceneView));
        gl_FragColor.rgb += sceneGlint * sparklePoint * sparkleBeat * sparkleNear * (0.08 + 0.92 * pow(facing, 3.0)) * float(SCENE_SPARKLE);
      #endif
    #endif
    if (sceneSurface.x > 0.0) {
      // Wet ground: a thin film of water mirrors the sky only at grazing angles,
      // more on smooth surfaces and in some areas than others, and the sun as a
      // small sharp glint. Seen from above it stays the colour of the ground.
      float variation = textureLod(sceneWeatherMap, vSceneWorld.xz / 1300.0 + 0.37, 2.0).g;
      float film = sceneSurface.x * float(SCENE_GLOSS) * mix(0.5, 1.0, smoothstep(0.3, 0.7, variation));
      gl_FragColor.rgb = mix(gl_FragColor.rgb, sceneReflection, film * pow(grazing, 5.0) * 0.5);
      gl_FragColor.rgb += sceneGlint * pow(facing, 90.0) * 0.4 * film;
    }
  }
  #endif
`;
