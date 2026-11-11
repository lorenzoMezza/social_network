// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';

// The line around the avatar: a stroke of the figure's silhouette, drawn on screen and
// not on the model. Each frame the figure is drawn flat into a mask (a twin of every
// mesh, on a layer of its own, sharing geometry and skeleton), then every pixel near the
// figure and outside it takes the line's colour. So the line is the same width
// everywhere, whatever the polygons under it (pushing the mesh out along its normals
// drew bubbles around hair and fingers, and tore where normals split), it is round at
// the corners, smooth at its edges, and never crosses the figure.
//
// The stroke looks at many points around each pixel, but only pixels next to the figure
// do: the mask's mipmaps tell in one read that a pixel is far from it (and the mask
// itself that it is inside). On a phone that is a thin band of the screen.

const MASK_LAYER = 1;
// Mipmap level read to find pixels far from the figure: half its texel (8 px) must be
// more than the stroke's radius
const COARSE_LEVEL = 4;
// Points looked at around a pixel: at the stroke's radius, and half of it for details
// thinner than the spacing of the first ones
const OUTER_POINTS = 16;
const INNER_POINTS = 8;

const directions = (count, turn = 0) => Array.from({ length: count }, (_, i) => {
  const angle = ((i + turn) / count) * Math.PI * 2;
  return new THREE.Vector2(Math.cos(angle), Math.sin(angle));
});

export function createOutline(renderer, scene, { pixels = 1.5, color = '#17142a', opacity = 1 } = {}) {
  const mask = new THREE.WebGLRenderTarget(1, 1, {
    format: THREE.RedFormat,
    type: THREE.UnsignedByteType,
    minFilter: THREE.LinearMipmapLinearFilter,
    magFilter: THREE.LinearFilter,
    generateMipmaps: true,
    depthBuffer: false,
    stencilBuffer: false,
    samples: 4,
  });

  const uniforms = {
    uMask: { value: mask.texture },
    uColor: { value: new THREE.Color(color) },
    uOpacity: { value: opacity },
    uTexel: { value: new THREE.Vector2(1, 1) },
    uRadius: { value: 1 },
    uOuter: { value: directions(OUTER_POINTS) },
    uInner: { value: directions(INNER_POINTS, 0.5) },
  };
  const stroke = new THREE.Mesh(
    new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3)),
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: /* glsl */ `
        void main() {
          gl_Position = vec4(position.xy, 0.0, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform sampler2D uMask;
        uniform vec3 uColor;
        uniform float uOpacity;
        uniform vec2 uTexel;
        uniform float uRadius;
        uniform vec2 uOuter[${OUTER_POINTS}];
        uniform vec2 uInner[${INNER_POINTS}];
        void main() {
          vec2 uv = gl_FragCoord.xy * uTexel;
          if (textureLod(uMask, uv, ${COARSE_LEVEL.toFixed(1)}).r == 0.0) discard;
          float inside = textureLod(uMask, uv, 0.0).r;
          if (inside >= 0.999) discard;
          float near = 0.0;
          for (int i = 0; i < ${OUTER_POINTS}; i++) near = max(near, textureLod(uMask, uv + uOuter[i] * uRadius * uTexel, 0.0).r);
          for (int i = 0; i < ${INNER_POINTS}; i++) near = max(near, textureLod(uMask, uv + uInner[i] * uRadius * 0.5 * uTexel, 0.0).r);
          // Where the figure's own edge is half covered the line takes the other half
          gl_FragColor = vec4(uColor, near * (1.0 - inside) * uOpacity);
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  stroke.frustumCulled = false;
  // After the floor, the pedestal and the shadow; before the effects in front (they are
  // drawn later, effects.js)
  stroke.renderOrder = 10;
  scene.add(stroke);

  const size = new THREE.Vector2();
  let width = pixels;
  const fit = () => {
    renderer.getDrawingBufferSize(size);
    if (mask.width !== size.x || mask.height !== size.y) mask.setSize(size.x, size.y);
    uniforms.uTexel.value.set(1 / size.x, 1 / size.y);
    uniforms.uRadius.value = width * renderer.getPixelRatio();
  };

  // Every mesh of a model (but `skip`) gets a flat twin that only the mask pass draws.
  // Cut-out surfaces (leaves, lace) keep their holes through the texture's alpha, and
  // see-through ones count as part of the figure
  const mark = (root, { skip } = {}) => {
    const meshes = [];
    root.traverse((object) => {
      if (object.isMesh && !object.userData.outline && !skip?.(object)) meshes.push(object);
    });
    for (const mesh of meshes) {
      const source = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
      const material = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, depthTest: false, depthWrite: false, fog: false, toneMapped: false });
      material.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <map_fragment>',
          `#ifdef USE_MAP
            diffuseColor.a *= texture2D(map, vMapUv).a;
          #endif`,
        );
      };
      material.customProgramCacheKey = () => 'outline-mask';
      if (source?.map && (source.alphaTest > 0 || source.transparent)) {
        material.map = source.map;
        material.alphaTest = source.alphaTest > 0 ? source.alphaTest : 0.5;
      }
      const twin = mesh.isSkinnedMesh ? new THREE.SkinnedMesh(mesh.geometry, material) : new THREE.Mesh(mesh.geometry, material);
      if (mesh.isSkinnedMesh) {
        twin.bindMode = mesh.bindMode;
        twin.bind(mesh.skeleton, mesh.bindMatrix);
      }
      twin.userData.outline = true;
      twin.frustumCulled = false;
      twin.layers.set(MASK_LAYER);
      // A child of the mesh: it moves, and hides, with it
      mesh.add(twin);
    }
  };

  // The figure into the mask, before the frame. `root` alone, not the scene: its lights
  // and state stay out of it
  const clearColor = new THREE.Color();
  const update = (root, camera) => {
    stroke.visible = !!root && visible;
    if (!stroke.visible) return;
    fit();
    const clearAlpha = renderer.getClearAlpha();
    renderer.getClearColor(clearColor);
    renderer.setClearColor(0x000000, 0);
    renderer.setRenderTarget(mask);
    camera.layers.set(MASK_LAYER);
    renderer.render(root, camera);
    camera.layers.set(0);
    renderer.setRenderTarget(null);
    renderer.setClearColor(clearColor, clearAlpha);
  };

  let visible = true;
  return {
    mark,
    update,
    set color(value) {
      uniforms.uColor.value.set(value);
    },
    set opacity(value) {
      uniforms.uOpacity.value = value;
    },
    set pixels(value) {
      width = value;
    },
    set visible(value) {
      visible = value;
    },
  };
}
