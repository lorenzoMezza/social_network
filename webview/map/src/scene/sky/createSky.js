// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { GROUND_STENCIL_BIT } from 'lm-three-geo-play';
import { vertexShader, fragmentShader } from './skyShader.js';
import { sceneGrade } from '../horizontalFog.js';
import { look } from '../../looks/index.js';

// How high the horizon haze climbs above the map's edge (sine of the elevation;
// at this height about half of it is left): a low band on clear days, a little
// higher in fog and rain (the fog distance on the map never changes)
const HAZE_HEIGHT = look.horizon.haze;
const HAZE_HEIGHT_FOG = HAZE_HEIGHT + 0.014;
// Far hills: the haze, in the look's shade (aerial perspective)
const HILLS_SHADE = new THREE.Color(...look.hills);

export function createSky(scene, renderer) {
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uZenith: { value: new THREE.Color() },
      uHorizon: { value: new THREE.Color() },
      uHaze: { value: new THREE.Color() },
      uHazeSun: { value: new THREE.Color() },
      // Where the haze takes its sun-side colour: the sun or the moon, as on the map
      uGlowDirection: { value: new THREE.Vector3(0, 1, 0) },
      uHazeHeight: { value: HAZE_HEIGHT },
      // Where the curved map drops out of sight, below the true horizon (main.js)
      uHorizonSlope: sceneGrade.horizonSlope,
      uHills: { value: new THREE.Color() },
      uHillsLight: { value: new THREE.Color() },
      uSunDirection: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color() },
      uSunVisibility: { value: 1 },
      uMoonDirection: { value: new THREE.Vector3(0, -1, 0) },
      uMoonVisibility: { value: 0 },
      uMoonIllumination: { value: 0 },
      uStars: { value: 0 },
      uTime: { value: 0 },
      uFlash: { value: 0 },
      uBolt: { value: new THREE.Vector3() },
      uClouds: { value: null },
      uCloudsVisible: { value: false },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uInverseViewProjection: { value: new THREE.Matrix4() },
    },
    depthTest: false,
    depthWrite: false,
    fog: false,
    // Only where the map's ground is not (three-geo-play marks it in the stencil, drawing
    // it first): the ground covers the rest of the screen, and those pixels of sky were
    // shaded for nothing (a sixth of the frame's GPU time at 3× density)
    stencilWrite: true,
    stencilWriteMask: 0,
    stencilRef: 0,
    stencilFuncMask: GROUND_STENCIL_BIT,
    stencilFunc: THREE.EqualStencilFunc,
  });

  // One triangle covering the screen (skyShader.js), before everything else but the
  // map's ground depth
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
  const mesh = new THREE.Mesh(geometry, material);
  mesh.renderOrder = -10000;
  mesh.frustumCulled = false;
  scene.add(mesh);

  return {
    mesh,
    // Call after the camera has moved for this frame
    update(camera, env, clouds) {
      const u = material.uniforms;
      camera.updateMatrixWorld();
      u.uInverseViewProjection.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
      u.uZenith.value.copy(env.zenith);
      u.uHorizon.value.copy(env.horizon);
      u.uHaze.value.copy(env.haze);
      u.uHazeSun.value.copy(env.hazeSun);
      u.uGlowDirection.value.copy(env.sunVisibility >= env.moonVisibility ? env.sunDirection : env.moonDirection);
      u.uHazeHeight.value = THREE.MathUtils.lerp(HAZE_HEIGHT, HAZE_HEIGHT_FOG, env.mist);
      u.uHills.value.copy(env.haze).multiply(HILLS_SHADE).lerp(env.zenith, 0.12);
      // Sunlit tops of the hills
      u.uHillsLight.value.copy(env.sunColor).multiplyScalar(0.06 * env.sunVisibility);
      u.uSunDirection.value.copy(env.sunDirection);
      u.uSunColor.value.copy(env.sunColor);
      u.uSunVisibility.value = env.sunVisibility;
      u.uMoonDirection.value.copy(env.moonDirection);
      u.uMoonVisibility.value = env.moonVisibility;
      u.uMoonIllumination.value = env.moonIllumination;
      u.uStars.value = env.stars;
      u.uTime.value = env.time;
      u.uFlash.value = env.flash;
      u.uBolt.value.copy(env.bolt);
      u.uCloudsVisible.value = clouds.visible;
      u.uClouds.value = clouds.visible ? clouds.texture : null;
      renderer.getDrawingBufferSize(u.uResolution.value);
    },
  };
}
