// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';

// Distance of the directional light from the player, along the light direction
const LIGHT_DISTANCE = 56;

export function addLights(scene) {
  const hemisphere = new THREE.HemisphereLight(0xffffff, 0x77736b, 0.9);
  scene.add(hemisphere);

  // No shadow map: the avatars' shadows are capsule shadows (capsuleShadows.js)
  const sun = new THREE.DirectionalLight(0xffffff, 1.8);
  scene.add(sun);
  scene.add(sun.target);
  return {
    light: sun,
    // Sun by day, moon by night, from the environment (scene/environment/)
    update(position, env) {
      sun.position.copy(position).addScaledVector(env.lightDirection, LIGHT_DISTANCE);
      sun.target.position.copy(position);
      sun.color.copy(env.lightColor);
      sun.intensity = env.lightIntensity;
      hemisphere.color.copy(env.ambientSky);
      hemisphere.groundColor.copy(env.ambientGround);
      hemisphere.intensity = env.ambientIntensity;
    },
  };
}
