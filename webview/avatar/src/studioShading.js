// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';

// Two touches on the avatar's lit materials that make the plain Decentraland models
// read better in the profile's little studio, for a few instructions per pixel:
//  - a rim of the stage's colour where the surface turns away from the camera,
//    stronger on the sides that face up (the light of the backdrop wrapping round the
//    silhouette): the avatar belongs to its world and stands out of it
//  - a soft darkening towards the feet (light bounced less near the floor): the
//    figure is grounded and gains depth that the flat textures lack
// The colour follows the stage (stage.js); the map's avatar does not use this.
const RIM_POWER = 3;
const FOOT_SHADE = 0.88; // light left at the feet
const FOOT_FADE = 0.42; // share of the height over which it comes back

export function createStudioShading() {
  const uniforms = {
    uStudioRim: { value: new THREE.Color(0.8, 0.85, 1) },
    uStudioRimStrength: { value: 0.35 },
    uStudioHeight: { value: 1.75 },
    uStudioFoot: { value: FOOT_SHADE },
  };

  const shade = (material) => {
    // Every lit surface, cut-outs and see-through skins included (a sandal's bare foot
    // must shade like the leg above it), but not the decals laid over them (the face
    // masks: transparent, writing no depth), which take the light of what they cover
    const decal = material.transparent && !material.depthWrite;
    if (!material.isMeshStandardMaterial || decal || material.userData.studio) return;
    material.userData.studio = true;
    const previous = Object.hasOwn(material, 'onBeforeCompile') ? material.onBeforeCompile : null;
    const previousKey = material.customProgramCacheKey.bind(material);
    material.onBeforeCompile = (shader, renderer) => {
      previous?.call(material, shader, renderer);
      Object.assign(shader.uniforms, uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vStudioHeight;')
        .replace('#include <project_vertex>', `#include <project_vertex>
          vStudioHeight = (modelMatrix * vec4(transformed, 1.0)).y;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform vec3 uStudioRim;
          uniform float uStudioRimStrength;
          uniform float uStudioHeight;
          uniform float uStudioFoot;
          varying float vStudioHeight;`)
        .replace('#include <opaque_fragment>', `
          float studioFacing = saturate(dot(normal, normalize(vViewPosition)));
          float studioUp = dot(normal, normalize((viewMatrix * vec4(0.0, 1.0, 0.0, 0.0)).xyz)) * 0.5 + 0.5;
          outgoingLight += uStudioRim * pow(1.0 - studioFacing, ${RIM_POWER.toFixed(1)}) * uStudioRimStrength * (0.55 + 0.45 * studioUp);
          outgoingLight *= mix(uStudioFoot, 1.0, smoothstep(0.0, ${FOOT_FADE.toFixed(2)}, vStudioHeight / uStudioHeight));
          #include <opaque_fragment>`);
    };
    material.customProgramCacheKey = () => `${previousKey()}|studio`;
    material.needsUpdate = true;
  };

  return {
    uniforms,
    // Every lit material under `root`; height: the avatar's (metres), unless it is not the
    // one on show (main.js warmUp: its shaders only)
    apply(root, height) {
      if (height !== undefined) uniforms.uStudioHeight.value = height;
      root.traverse((object) => {
        if (!object.isMesh) return;
        for (const material of Array.isArray(object.material) ? object.material : [object.material]) shade(material);
      });
    },
  };
}
