// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';

// Shadows of the avatars on the ground: capsule shadows, drawn as a soft halo of the
// figure rather than a sharp silhouette. A few capsules
// follow the bones of each avatar (body and head, legs, arms); one fragment shader
// casts a ray from each ground point towards the light and darkens it where the ray
// passes near a capsule, with a wide falloff that grows the farther the capsule is
// from the ground. Every avatar is one instance of one quad around its shadow: all the
// shadows on the map are a single draw call of two triangles each, whatever the
// avatars wear, and as long as the low sun makes them (no shadow map: nothing to
// fit, nothing cut off, nothing that breaks on the iOS Simulator).
//
// A stencil bit keeps them off the avatars themselves, which set it when drawn.
export const PLAYER_STENCIL_MASK = 0x40;
// Room for this many avatars at first; doubled whenever more cast a shadow
const INITIAL_CASTERS = 16;
const MAX_CAPSULES = 16;
// Darkness where a shadow is full (over the old shadow map's 0.12: the wide halo
// lightens it)
const OPACITY = 0.17;
// Halo: its width as a share of each capsule's radius, and how much it widens per
// world unit between the capsule and the ground
const SOFT_RADIUS = 0.9;
const SOFTNESS = 0.11;
// The tip of a long shadow fades a little, as a real one does away from the feet
const TIP_FADE = 0.45;

const vertexShader = /* glsl */ `
  // x, z of the centre and half sizes of the quad on the ground
  attribute vec4 iBox;
  // x, ground y, z of the caster's feet; how far its shadow reaches on the ground
  attribute vec4 iOrigin;
  // row of its capsules, how many, opacity
  attribute vec3 iData;
  varying vec3 vGround;
  flat varying vec4 vOrigin;
  flat varying vec3 vData;
  void main() {
    vGround = vec3(iBox.x + position.x * iBox.z, iOrigin.y, iBox.y + position.z * iBox.w);
    vOrigin = iOrigin;
    vData = iData;
    gl_Position = projectionMatrix * viewMatrix * vec4(vGround, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uCapsules;
  uniform vec3 uLight;
  varying vec3 vGround;
  flat varying vec4 vOrigin;
  flat varying vec3 vData;
  void main() {
    int row = int(vData.x);
    int count = int(vData.y);
    float shade = 0.0;
    for (int i = 0; i < ${MAX_CAPSULES}; i++) {
      if (i >= count) break;
      vec4 a = texelFetch(uCapsules, ivec2(i * 2, row), 0);
      vec4 b = texelFetch(uCapsules, ivec2(i * 2 + 1, row), 0);
      // Closest approach of the ray (ground point towards the light) and the segment
      vec3 axis = b.xyz - a.xyz;
      vec3 offset = vGround - a.xyz;
      float along = dot(uLight, axis);
      float axisLength2 = max(dot(axis, axis), 1e-6);
      float onRay = dot(uLight, offset);
      float onAxis = dot(axis, offset);
      float u = clamp((onAxis - along * onRay) / max(axisLength2 - along * along, 1e-6), 0.0, 1.0);
      float t = max(along * u - onRay, 0.0);
      u = clamp((onAxis + along * t) / axisLength2, 0.0, 1.0);
      float gap = length(offset + uLight * t - axis * u);
      float radius = a.w;
      float soft = radius * ${SOFT_RADIUS.toFixed(2)} + t * ${SOFTNESS.toFixed(3)};
      shade = max(shade, 1.0 - smoothstep(radius - soft, radius + soft, gap));
    }
    float reach = distance(vGround.xz, vOrigin.xz) / max(vOrigin.w, 1e-3);
    float alpha = shade * vData.z * (1.0 - ${TIP_FADE.toFixed(2)} * smoothstep(0.0, 1.0, reach));
    if (alpha < 0.002) discard;
    gl_FragColor = vec4(0.0, 0.0, 0.0, alpha);
  }
`;

/**
 * capsules: [{ a: point, b: point, radius (avatar metres) }], a point being
 * { at: Object3D, local?: Vector3 (in its space), up?: metres straight up,
 *   beyond?: { from: Object3D, by: metres } (on past `at`, away from `from`) }
 */
export function createCapsuleShadows(scene) {
  const quad = new THREE.PlaneGeometry(2, 2).rotateX(-Math.PI / 2);
  // The capsules (a row per avatar) and the instanced quads, for `capacity` avatars
  let capacity = 0;
  let data;
  let capsuleTexture;
  let geometry;
  let box;
  let origin;
  let info;
  const allocate = (casters) => {
    capacity = casters;
    capsuleTexture?.dispose();
    geometry?.dispose();
    data = new Float32Array(MAX_CAPSULES * 2 * capacity * 4);
    capsuleTexture = new THREE.DataTexture(data, MAX_CAPSULES * 2, capacity, THREE.RGBAFormat, THREE.FloatType);
    capsuleTexture.minFilter = THREE.NearestFilter;
    capsuleTexture.magFilter = THREE.NearestFilter;
    geometry = new THREE.InstancedBufferGeometry();
    geometry.index = quad.index;
    geometry.setAttribute('position', quad.getAttribute('position'));
    box = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    origin = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4).setUsage(THREE.DynamicDrawUsage);
    info = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('iBox', box);
    geometry.setAttribute('iOrigin', origin);
    geometry.setAttribute('iData', info);
    geometry.instanceCount = 0;
  };
  allocate(INITIAL_CASTERS);

  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uCapsules: { value: capsuleTexture },
      uLight: { value: new THREE.Vector3(0, 1, 0) },
    },
    transparent: true,
    depthTest: false,
    depthWrite: false,
    // Not over the avatars (they set the bit), the stencil left as it is
    stencilWrite: true,
    stencilWriteMask: 0,
    stencilRef: 0,
    stencilFuncMask: PLAYER_STENCIL_MASK,
    stencilFunc: THREE.EqualStencilFunc,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.KeepStencilOp,
  });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = 'capsule-shadows';
  mesh.frustumCulled = false;
  mesh.renderOrder = 1000; // on the ground, after the buildings, under nothing
  scene.add(mesh);

  const casters = new Set();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const from = new THREE.Vector3();
  const away = new THREE.Vector3();
  const feet = new THREE.Vector3();
  const light = material.uniforms.uLight.value;

  const place = (point, scale, out) => {
    if (point.local) out.copy(point.local).applyMatrix4(point.at.matrixWorld);
    else out.setFromMatrixPosition(point.at.matrixWorld);
    if (point.up) out.y += point.up * scale;
    if (point.beyond) {
      from.setFromMatrixPosition(point.beyond.from.matrixWorld);
      away.subVectors(out, from);
      const length = away.length();
      if (length > 1e-6) out.addScaledVector(away, (point.beyond.by * scale) / length);
    }
    return out;
  };

  return {
    /**
     * An avatar that casts a shadow. root: its ground point (and the subtree to
     * update); scale(): world units per avatar metre.
     */
    add({ root, capsules, scale }) {
      const caster = { root, capsules, scale, strength: 1 };
      casters.add(caster);
      return {
        setCapsules(next, nextScale = scale) {
          caster.capsules = next;
          caster.scale = nextScale;
        },
        setStrength(value) {
          caster.strength = value;
        },
        remove() {
          casters.delete(caster);
        },
      };
    },

    // Once per frame, before the render: lightDirection points towards the sun or
    // moon, strength 0–1
    update(lightDirection, strength) {
      light.copy(lightDirection).normalize();
      const lightY = Math.max(light.y, 0.05);
      // Every avatar on screen casts its shadow: more room when they are more
      let shown = 0;
      for (const caster of casters) if (caster.root.visible && caster.capsules.length) shown++;
      if (shown > capacity) {
        let next = capacity;
        while (next < shown) next *= 2;
        allocate(next);
        mesh.geometry = geometry;
        material.uniforms.uCapsules.value = capsuleTexture;
      }
      let instance = 0;
      for (const caster of casters) {
        if (!caster.root.visible || !caster.capsules.length) continue;
        // The bones as this frame's animation left them
        caster.root.updateWorldMatrix(true, true);
        caster.root.getWorldPosition(feet);
        const ground = feet.y + 0.03;
        const scale = caster.scale();
        let minX = feet.x;
        let maxX = feet.x;
        let minZ = feet.z;
        let maxZ = feet.z;
        let margin = 0;
        let reach = scale * 0.5;
        let count = 0;
        for (const capsule of caster.capsules) {
          if (count >= MAX_CAPSULES) break;
          place(capsule.a, scale, a);
          place(capsule.b, scale, b);
          const radius = capsule.radius * scale;
          const offset = (instance * MAX_CAPSULES * 2 + count * 2) * 4;
          a.toArray(data, offset);
          data[offset + 3] = radius;
          b.toArray(data, offset + 4);
          data[offset + 7] = radius;
          // Where both ends fall on the ground, along the light
          for (const end of [a, b]) {
            const drop = Math.max(end.y - ground, 0) / lightY;
            const x = end.x - light.x * drop;
            const z = end.z - light.z * drop;
            minX = Math.min(minX, x, end.x);
            maxX = Math.max(maxX, x, end.x);
            minZ = Math.min(minZ, z, end.z);
            maxZ = Math.max(maxZ, z, end.z);
            margin = Math.max(margin, radius * (1 + SOFT_RADIUS) + drop * SOFTNESS);
            reach = Math.max(reach, Math.hypot(x - feet.x, z - feet.z));
          }
          count++;
        }
        box.setXYZW(instance, (minX + maxX) / 2, (minZ + maxZ) / 2, (maxX - minX) / 2 + margin, (maxZ - minZ) / 2 + margin);
        origin.setXYZW(instance, feet.x, ground, feet.z, reach);
        info.setXYZ(instance, instance, count, OPACITY * strength * caster.strength);
        instance++;
      }
      geometry.instanceCount = instance;
      mesh.visible = instance > 0 && strength > 0;
      // Only the casters drawn go to the GPU (nothing when there are none)
      if (!mesh.visible) return;
      for (const attribute of [box, origin, info]) {
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(0, instance * attribute.itemSize);
        attribute.needsUpdate = true;
      }
      capsuleTexture.needsUpdate = true;
    },

    dispose() {
      scene.remove(mesh);
      geometry.dispose();
      quad.dispose();
      material.dispose();
      capsuleTexture.dispose();
    },
  };
}

// The capsules of a Decentraland avatar (composeAvatar bones), in avatar metres: the
// broad shape of the figure, enough for a soft halo (and five tests per pixel)
export function avatarCapsules(bones) {
  const bone = (name) => bones.get(`Avatar_${name}`);
  const at = (name, extra) => ({ at: bone(name), ...extra });
  const list = [[at('Hips'), at('Head', { up: 0.16 }), 0.19]];
  for (const side of ['Left', 'Right']) {
    list.push(
      [at(`${side}UpLeg`), at(`${side}Foot`), 0.1],
      [at(`${side}Arm`), at(`${side}Hand`), 0.07],
    );
  }
  return list
    .filter(([start, end]) => start.at && end.at)
    .map(([start, end, radius]) => ({ a: start, b: end, radius }));
}
