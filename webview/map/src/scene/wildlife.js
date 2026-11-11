// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { addSceneUniforms } from './horizontalFog.js';

// A little life in the scene, never in the way:
//  - birds: by day, in fair weather, now and then a small flock crosses the sky in
//    front of the view, far and high, flapping. One flock at a time, a few birds
//  - fireflies: at night, without rain or snow (any time of the year: nothing in the
//    scene depends on the season), around the bushes and over the lawns near the view
//    (vegetation.js), drifting and blinking
// One draw for the birds and one for the fireflies, only while there are some.

const FLOCK_SIZE = [3, 7];
// Seconds between two flocks (after one has gone)
const FLOCK_GAP = [25, 60];
// Where a flock crosses: this far in front of the view, this high, this fast (m, m/s)
const FLOCK_DISTANCE = [120, 200];
const FLOCK_HEIGHT = [32, 48];
const FLOCK_SPEED = 13;
const FLOCK_PATH = 520;
const BIRD_SPAN = 4; // wingspan, metres (the map's people are 10 m tall)

const FIREFLIES = 36;
// Around the bushes nearest the view centre, in front of the camera, a few on each
const FIREFLY_RADIUS = 110; // metres around the view centre
const FIREFLIES_PER_BUSH = 3;
const FIREFLY_REFRESH = 3; // seconds between looks for bushes nearby

const between = ([low, high]) => low + Math.random() * (high - low);

function birdGeometry() {
  // Two wings from the body: the tips (|x| = 0.5) flap in the vertex shader
  const positions = [
    0, 0, 0.1, 0, 0, -0.06, -0.5, 0, -0.16,
    0, 0, -0.06, 0, 0, 0.1, 0.5, 0, -0.16,
  ];
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  return geometry;
}

function birdMaterial(clock) {
  // Small dark silhouettes against the sky: outside the map's haze (it would wash
  // them out at this distance) and its grade (they only fly by day)
  const material = new THREE.MeshBasicMaterial({ color: 0x3a3d63, side: THREE.DoubleSide, fog: false });
  material.onBeforeCompile = (shader) => {
    addSceneUniforms(shader);
    shader.uniforms.uBirdClock = clock;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uBirdClock;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        // Each bird on its own beat (from where it is), the tips of the wings up and down
        float birdBeat = uBirdClock * 7.0 + instanceMatrix[3].x * 0.7 + instanceMatrix[3].z * 0.3;
        transformed.y += abs(position.x) * 0.45 * sin(birdBeat);`);
  };
  return material;
}

const fireflyVertexShader = /* glsl */ `
  uniform vec3 fogOrigin;
  uniform float sceneCurvature;
  uniform float uPixelRatio;
  uniform float uViewportHeight;
  attribute float aGlow;
  varying float vGlow;
  void main() {
    vGlow = aGlow;
    // The world bends away from the player (horizontalFog.js): lowered as the map is
    vec2 fromPlayer = position.xz - fogOrigin.xz;
    vec3 world = vec3(position.x, position.y - dot(fromPlayer, fromPlayer) * sceneCurvature, position.z);
    vec4 view = viewMatrix * vec4(world, 1.0);
    gl_Position = projectionMatrix * view;
    // About half a metre of glow, never under 2 px
    gl_PointSize = max(0.6 * projectionMatrix[1][1] * 0.5 * uViewportHeight / -view.z, 2.0 * uPixelRatio);
  }
`;

const fireflyFragmentShader = /* glsl */ `
  varying float vGlow;
  void main() {
    float r = length(gl_PointCoord - 0.5) * 2.0;
    float light = (1.0 - smoothstep(0.0, 0.35, r)) + exp(-r * r * 6.0) * 0.45;
    gl_FragColor = vec4(vec3(1.0, 0.92, 0.45) * light * vGlow, 1.0);
  }
`;

export function createWildlife({ scene, vegetation }) {
  const clock = { value: 0 };

  // Birds
  const maxBirds = FLOCK_SIZE[1];
  const birds = new THREE.InstancedMesh(birdGeometry(), birdMaterial(clock), maxBirds);
  birds.name = 'birds';
  birds.count = 0;
  birds.frustumCulled = false;
  scene.add(birds);
  let flock = null; // { start, heading, age, members: [{ offset, height }] }
  let nextFlock = between([5, 15]);
  let flockAsked = false;
  const matrix = new THREE.Matrix4();
  const turn = new THREE.Quaternion();
  const at = new THREE.Vector3();
  const size = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  const startFlock = (camera, center) => {
    const forward = camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
    const right = new THREE.Vector3(-forward.z, 0, forward.x);
    // Across the view, a little slanted, from either side
    const heading = right.clone().applyAxisAngle(up, (Math.random() - 0.5) * 0.9).multiplyScalar(Math.random() < 0.5 ? 1 : -1);
    const middle = center.clone().addScaledVector(forward, between(FLOCK_DISTANCE));
    const height = between(FLOCK_HEIGHT);
    const count = Math.round(between(FLOCK_SIZE));
    flock = {
      start: middle.addScaledVector(heading, -FLOCK_PATH / 2),
      heading,
      age: 0,
      members: Array.from({ length: count }, (_, i) => ({
        // A loose V behind the first one
        back: i * 5 + Math.random() * 4,
        side: (i % 2 ? 1 : -1) * Math.ceil(i / 2) * (5 + Math.random() * 3),
        height: height + (Math.random() - 0.5) * 6,
      })),
    };
  };

  const updateBirds = (deltaSeconds, env, camera, center) => {
    const fair = env.sunAltitude > 4 && env.rain < 0.2 && env.snow < 0.2;
    if (!flock) {
      birds.count = 0;
      nextFlock -= deltaSeconds;
      if (flockAsked || (nextFlock <= 0 && fair)) startFlock(camera, center);
      flockAsked = false;
      return;
    }
    flock.age += deltaSeconds;
    const travelled = flock.age * FLOCK_SPEED;
    if (travelled > FLOCK_PATH + 60) {
      flock = null;
      nextFlock = between(FLOCK_GAP);
      birds.count = 0;
      return;
    }
    const side = new THREE.Vector3(-flock.heading.z, 0, flock.heading.x);
    turn.setFromUnitVectors(new THREE.Vector3(0, 0, 1), flock.heading);
    flock.members.forEach((bird, i) => {
      at.copy(flock.start)
        .addScaledVector(flock.heading, travelled - bird.back)
        .addScaledVector(side, bird.side);
      at.y = bird.height + Math.sin(flock.age * 0.8 + i) * 1.5;
      matrix.compose(at, turn, size.setScalar(BIRD_SPAN));
      birds.setMatrixAt(i, matrix);
    });
    birds.count = flock.members.length;
    birds.instanceMatrix.needsUpdate = true;
  };

  // Fireflies
  const fireflyPositions = new Float32Array(FIREFLIES * 3);
  const fireflyGlow = new Float32Array(FIREFLIES);
  const fireflyGeometry = new THREE.BufferGeometry();
  fireflyGeometry.setAttribute('position', new THREE.BufferAttribute(fireflyPositions, 3));
  fireflyGeometry.setAttribute('aGlow', new THREE.BufferAttribute(fireflyGlow, 1));
  const pixelRatio = { value: 1 };
  const fireflyMaterial = new THREE.ShaderMaterial({
    vertexShader: fireflyVertexShader,
    fragmentShader: fireflyFragmentShader,
    uniforms: { uPixelRatio: pixelRatio, uViewportHeight: { value: 1 } },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const fireflies = new THREE.Points(fireflyGeometry, fireflyMaterial);
  fireflies.name = 'fireflies';
  fireflies.frustumCulled = false;
  fireflies.visible = false;
  scene.add(fireflies);
  // Each one: the bush it flies around, its own path and beat
  let swarm = [];
  let lookAgain = 0;
  let shown = 0; // 0–1: fades in at nightfall, out at dawn

  const forward = new THREE.Vector3();
  const updateFireflies = (deltaSeconds, env, camera, center, viewportHeight, ratio) => {
    const wanted = env.sunAltitude < -4 && env.rain < 0.1 && env.snow < 0.05 && env.snowCover < 0.1 ? 1 : 0;
    // About a second to come or go (also when the time is changed in the developer panel)
    shown += (wanted - shown) * Math.min(1, deltaSeconds * 2.5);
    if (wanted === 0 && shown < 0.05) shown = 0;
    if (shown < 0.01) {
      fireflies.visible = false;
      swarm = [];
      return;
    }
    lookAgain -= deltaSeconds;
    if (lookAgain <= 0) {
      lookAgain = FIREFLY_REFRESH;
      camera.getWorldDirection(forward).setY(0).normalize();
      const ahead = (p) => (p.x - center.x) * forward.x + (p.z - center.z) * forward.z > -20;
      const near = (p) => Math.hypot(p.x - center.x, p.z - center.z);
      // Around bushes, else over lawns and other greens
      const bushes = [...vegetation.plantsNear(center, FIREFLY_RADIUS, 2000), ...vegetation.spotsNear(center, FIREFLY_RADIUS, 2000)]
        .filter(ahead)
        .sort((a, b) => near(a) - near(b));
      // Keep those still near and in view, add more around the nearest other bushes
      swarm = swarm.filter((f) => near(f.home) < FIREFLY_RADIUS && ahead(f.home));
      const taken = new Set(swarm.map((f) => `${f.home.x},${f.home.z}`));
      for (const home of bushes) {
        if (swarm.length >= FIREFLIES) break;
        if (taken.has(`${home.x},${home.z}`)) continue;
        for (let k = 0; k < FIREFLIES_PER_BUSH && swarm.length < FIREFLIES; k++) {
          swarm.push({ home, phase: Math.random() * 100, speed: 0.3 + Math.random() * 0.4, beat: 2 + Math.random() * 3 });
        }
      }
    }
    const t = clock.value;
    swarm.forEach((f, i) => {
      const a = t * f.speed + f.phase;
      fireflyPositions[i * 3] = f.home.x + Math.sin(a) * 1.8 + Math.sin(a * 2.3) * 0.6;
      fireflyPositions[i * 3 + 1] = 0.8 + Math.sin(a * 1.7) * 0.5 + (Math.sin(a * 0.5) + 1) * 0.6;
      fireflyPositions[i * 3 + 2] = f.home.z + Math.cos(a * 0.9) * 1.8;
      // A short glow every few seconds
      const pulse = ((t + f.phase) % f.beat) / f.beat;
      fireflyGlow[i] = THREE.MathUtils.smoothstep(pulse, 0, 0.1) * (1 - THREE.MathUtils.smoothstep(pulse, 0.25, 0.5)) * shown;
    });
    fireflyGeometry.setDrawRange(0, swarm.length);
    fireflyGeometry.attributes.position.needsUpdate = true;
    fireflyGeometry.attributes.aGlow.needsUpdate = true;
    fireflyMaterial.uniforms.uViewportHeight.value = viewportHeight;
    pixelRatio.value = ratio;
    fireflies.visible = swarm.length > 0;
  };

  // center: the view centre (the player, or where the camera flew); viewportHeight in
  // pixels of the drawing (CSS height × ratio)
  const update = (deltaSeconds, env, camera, center, viewportHeight, ratio) => {
    clock.value += deltaSeconds;
    updateBirds(deltaSeconds, env, camera, center);
    updateFireflies(deltaSeconds, env, camera, center, viewportHeight, ratio);
  };

  const stats = () => ({ birds: birds.count, fireflies: fireflies.visible ? swarm.length : 0 });

  // Developer panel: a flock crosses now, whatever the weather (the one flying goes)
  const flockNow = () => {
    flock = null;
    flockAsked = true;
  };

  return { update, stats, flockNow, meshes: [birds, fireflies] };
}
