// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { FOG_NEAR, MAP_RADIUS } from '../config.js';

// Rain and snow over the whole map: one instanced draw of small quads, animated on
// the GPU from a random start and the time (no per-drop work on the CPU). The
// intensity changes how many are drawn.
//
// Every drop lives in the world, not around the player or the camera: it falls
// along a fixed path, and walking or orbiting the camera moves past it like past
// real rain. Drops are kept in a box around the player by wrapping: one leaving the
// box on one side comes back on the other, far away and faded out. Two layers of
// boxes: many drops close by, fewer out to the end of the map. Each fall starts on
// a new random spot.
//
// Drops and flakes have their real size, so the rain has depth: near drops are
// long, thin streaks, far ones faint specks (never thinner than a pixel: below that
// they fade instead), and far away the rain melts into the haze. They fall from high
// above (out of the picture) and fade in on their way down, so no drop is ever seen
// appearing.
//
// Ripples are a second instanced draw: rings on the ground, fixed in the world like
// the drops, each slot replaying a short ring at a new random spot every cycle. A
// dark wet ring with a bright rim, so they read on light and dark ground alike.
const MAX_DROPS = 3600;
// Share of the drops in the near layer, and half the size of each layer's box (m)
const NEAR_SHARE = 0.65;
const NEAR_BOX = 75;
const FAR_BOX = MAP_RADIUS + 100;
// Distance from the player where the far layer takes over from the near one
const LAYER_BLEND = [45, 70];
// Height drops fall from: above the top of the picture
const NEAR_FALL_HEIGHT = 60;
const FAR_FALL_HEIGHT = 240;
// Real sizes in metres: a rain streak (motion blur of a falling drop), a snowflake
const RAIN_LENGTH = 0.85;
const RAIN_WIDTH = 0.03;
const SNOWFLAKE_SIZE = 0.075;
// Smallest size on screen, in radians (a phone shows about 650 px per radian)
const MIN_SCREEN_SIZE = 0.0016;

const MAX_RIPPLES = 700;
const RIPPLE_BOX = 55; // half the size of the box of ripples around the player (m)
const RIPPLE_SIZE = 1.3; // metres, final diameter of a ring
const RIPPLE_LIFE = 0.55; // share of each slot's cycle the ring is visible

const glslFloat = (value) => value.toFixed(5);

const sharedGlsl = /* glsl */ `
  float precipitationHash(float n) {
    return fract(sin(n) * 43758.5453);
  }

  // A world position kept within halfSize of the player: it moves only when it
  // leaves the box, coming back on the other side
  vec2 wrapAroundPlayer(vec2 world, vec2 player, float halfSize) {
    return player + mod(world - player + halfSize, 2.0 * halfSize) - halfSize;
  }
`;

const vertexShader = /* glsl */ `
  attribute vec3 aStart;
  attribute float aRandom;
  uniform float uTime;
  uniform vec3 uCenter;
  uniform vec2 uWind;
  uniform float uFallSpeed;
  uniform float uSnow;
  // From the shared scene uniforms that every material receives (horizontalFog.js)
  uniform float sceneCurvature;
  varying vec2 vUv;
  varying float vFade;
  ${sharedGlsl}

  void main() {
    bool near = aStart.x < ${glslFloat(NEAR_SHARE)};
    float box = near ? ${glslFloat(NEAR_BOX)} : ${glslFloat(FAR_BOX)};
    float fallHeight = near ? ${glslFloat(NEAR_FALL_HEIGHT)} : ${glslFloat(FAR_FALL_HEIGHT)};
    float speed = uFallSpeed * mix(0.85, 1.15, aRandom);
    float cycle = (aStart.y * fallHeight + speed * uTime) / fallHeight;
    float progress = fract(cycle); // 0 top – 1 ground
    float fallTime = progress * fallHeight / speed;

    // A new spot in the world at every fall, drifting with the wind
    float fall = floor(cycle) + aRandom * 97.13 + aStart.z * 31.7;
    vec2 spot = (vec2(precipitationHash(fall * 12.9898), precipitationHash(fall * 78.233)) * 2.0 - 1.0) * box * 4.0;
    vec2 world = spot + uWind * fallTime;
    // Snowflakes sway as they fall
    float sway = 6.2831853 * aStart.z;
    world += uSnow * vec2(sin(uTime * (0.7 + aRandom * 0.6) + sway), cos(uTime * (0.6 + aRandom * 0.5) + sway)) * 0.6;
    world = wrapAroundPlayer(world, uCenter.xz, box);
    vec2 fromPlayer = world - uCenter.xz;
    float fromPlayerDistance = length(fromPlayer);
    vec3 center = vec3(world.x, fallHeight * (1.0 - progress) - dot(fromPlayer, fromPlayer) * sceneCurvature, world.y);

    vec3 toCamera = cameraPosition - center;
    float cameraDistance = length(toCamera);
    vec3 side = normalize(vec3(toCamera.z, 0.0, -toCamera.x)); // front face towards the camera
    vec3 up = normalize(vec3(uWind.x / speed, 1.0, uWind.y / speed)); // along the fall
    vec3 viewUp = normalize(cross(toCamera / cameraDistance, side));
    up = normalize(mix(up, viewUp, uSnow));

    // Real size, never under a pixel: thinner than that, the drop fades instead
    float size = mix(0.75, 1.25, aStart.z);
    float width = mix(${glslFloat(RAIN_WIDTH)}, ${glslFloat(SNOWFLAKE_SIZE)}, uSnow) * size;
    float streakLength = mix(${glslFloat(RAIN_LENGTH)}, ${glslFloat(SNOWFLAKE_SIZE)}, uSnow) * size;
    float minimum = cameraDistance * ${glslFloat(MIN_SCREEN_SIZE)};
    float coverage = sqrt(min(width / minimum, 1.0));
    width = max(width, minimum);
    streakLength = max(streakLength, minimum * mix(3.0, 1.0, uSnow));
    vec3 position3 = center + side * position.x * width + up * position.y * streakLength;

    // Each layer only where it belongs, so the two never double up
    float layer = near
      ? 1.0 - smoothstep(${glslFloat(LAYER_BLEND[0])}, ${glslFloat(LAYER_BLEND[1])}, fromPlayerDistance)
      : smoothstep(${glslFloat(LAYER_BLEND[0])}, ${glslFloat(LAYER_BLEND[1])}, fromPlayerDistance)
        * (1.0 - smoothstep(${glslFloat(FOG_NEAR)}, ${glslFloat(FAR_BOX)}, fromPlayerDistance) * 0.8)
        * (1.0 - smoothstep(${glslFloat(FAR_BOX * 0.85)}, ${glslFloat(FAR_BOX)}, fromPlayerDistance));

    vUv = position.xy + 0.5;
    // Fade in high up, out near the camera (no drops across the lens)
    vFade = layer * coverage * smoothstep(0.0, 0.15, progress) * smoothstep(4.0, 12.0, cameraDistance);
    gl_Position = projectionMatrix * viewMatrix * vec4(position3, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uOpacity;
  uniform float uSnow;
  varying vec2 vUv;
  varying float vFade;

  void main() {
    vec2 p = vUv - 0.5;
    // Rain: a thin streak, soft along its length, fading at both ends
    float streak = (1.0 - smoothstep(0.15, 0.5, abs(p.x))) * smoothstep(0.5, 0.25, abs(p.y));
    // Snow: a soft round flake
    float flake = 1.0 - smoothstep(0.2, 0.5, length(p));
    float alpha = mix(streak, flake, uSnow) * uOpacity * vFade;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(uColor, alpha);
    #include <colorspace_fragment>
  }
`;

const rippleVertexShader = /* glsl */ `
  attribute float aRandom;
  uniform float uTime;
  uniform vec3 uCenter;
  varying vec2 vUv;
  varying float vLife;
  varying float vFade;
  ${sharedGlsl}

  void main() {
    float rate = mix(1.2, 2.2, aRandom); // rings per second in this slot
    float cycle = uTime * rate + aRandom * 17.0;
    float life = fract(cycle) / ${RIPPLE_LIFE.toFixed(2)};
    float id = floor(cycle) + aRandom * 101.0;
    // A fixed spot in the world, kept around the player
    vec2 spot = (vec2(precipitationHash(id * 1.31), precipitationHash(id * 2.17)) * 2.0 - 1.0) * ${glslFloat(RIPPLE_BOX * 4)};
    vec2 world = wrapAroundPlayer(spot, uCenter.xz, ${glslFloat(RIPPLE_BOX)});
    float fromPlayerDistance = length(world - uCenter.xz);
    vec3 ground = vec3(world.x, 0.05, world.y);
    // Outside its short life the ring collapses to nothing: no pixels drawn
    float size = life < 1.0 ? ${RIPPLE_SIZE.toFixed(2)} * mix(0.7, 1.3, precipitationHash(id * 3.7)) : 0.0;
    vec3 position3 = ground + vec3(position.x, 0.0, -position.y) * size;

    vUv = position.xy + 0.5;
    vLife = life;
    vFade = 1.0 - smoothstep(${glslFloat(RIPPLE_BOX * 0.6)}, ${glslFloat(RIPPLE_BOX)}, fromPlayerDistance);
    gl_Position = projectionMatrix * viewMatrix * vec4(position3, 1.0);
  }
`;

const rippleFragmentShader = /* glsl */ `
  uniform vec3 uDark;
  uniform vec3 uLight;
  uniform float uOpacity;
  varying vec2 vUv;
  varying float vLife;
  varying float vFade;

  void main() {
    float radius = length(vUv - 0.5) * 2.0;
    // The ring opens fast then slows down, thinning and fading
    float open = 1.0 - (1.0 - vLife) * (1.0 - vLife);
    float width = mix(0.16, 0.08, vLife);
    float wet = 1.0 - smoothstep(0.0, width, abs(radius - open));
    // A bright rim just inside it catches the sky
    float rim = 1.0 - smoothstep(0.0, width * 0.6, abs(radius - (open - width * 1.3)));
    float fade = (1.0 - vLife) * uOpacity * vFade;
    float alpha = max(wet * 0.8, rim) * fade;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(mix(uDark, uLight, rim / max(wet * 0.8 + rim, 0.001)), alpha);
    #include <colorspace_fragment>
  }
`;

function instancedQuads(base, attributes) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index;
  geometry.setAttribute('position', base.getAttribute('position'));
  for (const [name, attribute] of Object.entries(attributes)) geometry.setAttribute(name, attribute);
  geometry.instanceCount = 0;
  return geometry;
}

const randomAttribute = (count, size) =>
  new THREE.InstancedBufferAttribute(new Float32Array(count * size).map(() => Math.random()), size);

export function createPrecipitation(scene) {
  const base = new THREE.PlaneGeometry(1, 1);

  const dropGeometry = instancedQuads(base, {
    aStart: randomAttribute(MAX_DROPS, 3),
    aRandom: randomAttribute(MAX_DROPS, 1),
  });
  const dropMaterial = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector3() },
      uWind: { value: new THREE.Vector2() },
      uFallSpeed: { value: 9 },
      uSnow: { value: 0 },
      uColor: { value: new THREE.Color() },
      uOpacity: { value: 0.5 },
    },
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const drops = new THREE.Mesh(dropGeometry, dropMaterial);
  drops.frustumCulled = false;
  drops.renderOrder = 900; // after the glass buildings
  drops.visible = false;
  scene.add(drops);

  const rippleGeometry = instancedQuads(base, { aRandom: randomAttribute(MAX_RIPPLES, 1) });
  const rippleMaterial = new THREE.ShaderMaterial({
    vertexShader: rippleVertexShader,
    fragmentShader: rippleFragmentShader,
    uniforms: {
      uTime: { value: 0 },
      uCenter: { value: new THREE.Vector3() },
      uDark: { value: new THREE.Color() },
      uLight: { value: new THREE.Color() },
      uOpacity: { value: 0.6 },
    },
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  const ripples = new THREE.Mesh(rippleGeometry, rippleMaterial);
  ripples.frustumCulled = false;
  ripples.renderOrder = 899;
  ripples.visible = false;
  scene.add(ripples);

  return {
    update(camera, env, playerPosition) {
      const amount = Math.max(env.rain, env.snow);
      drops.visible = amount > 0.01;
      const snow = env.snow > env.rain ? 1 : 0;
      ripples.visible = drops.visible && !snow;
      if (!drops.visible) return;

      const u = dropMaterial.uniforms;
      dropGeometry.instanceCount = Math.round(MAX_DROPS * amount);
      u.uTime.value = env.time;
      u.uCenter.value.copy(playerPosition);
      // Rain falls straight down, whatever the wind; snowflakes drift with it
      if (snow) u.uWind.value.copy(env.wind).multiplyScalar(0.4);
      else u.uWind.value.set(0, 0);
      u.uSnow.value = snow;
      u.uFallSpeed.value = snow ? 0.9 : 10;
      if (snow) {
        // Flakes: white, lit by the sky
        u.uColor.value.copy(env.lightColor).lerp(env.haze, 0.5).multiplyScalar(1.15);
        u.uOpacity.value = 0.95;
      } else {
        // Streaks: the light of the sky through water, a little lighter than the haze
        u.uColor.value.copy(env.haze).lerp(env.lightColor, 0.3).multiplyScalar(1.12);
        u.uOpacity.value = 0.5 + env.rain * 0.25;
      }

      if (ripples.visible) {
        const r = rippleMaterial.uniforms;
        rippleGeometry.instanceCount = Math.round(MAX_RIPPLES * env.rain);
        r.uTime.value = env.time;
        r.uCenter.value.copy(playerPosition);
        // Dark wet ring and a rim catching the sky: they read on any ground
        r.uDark.value.copy(env.tint).multiplyScalar(0.3);
        r.uLight.value.copy(env.reflection).multiplyScalar(1.5);
        r.uLight.value.setRGB(Math.min(r.uLight.value.r, 1), Math.min(r.uLight.value.g, 1), Math.min(r.uLight.value.b, 1));
        r.uOpacity.value = 0.35 + env.rain * 0.25;
      }
    },
  };
}
