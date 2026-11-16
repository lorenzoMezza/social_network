// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { createEffects } from './effects.js';

// What surrounds the avatar, chosen by the user for their profile (the app sends a
// theme, see the app's profile/state/profileStyle.js):
//   sky [top, bottom]     the backdrop, a vertical gradient with a soft glow behind
//   floor                 the ground it stands on, fading into the backdrop
//   light, rim            colour of the key light and of the rim light behind
//   pedestal              'none' | 'disc' | 'ring'
//   effect                'none' | an effect of effects.js EFFECT_MODES
//   outline               false: no outline around the avatar (main.js)
// The lights on the avatar take the stage's colours too. Colours ease to a new theme in a moment; the effects animate slowly (cheap points).
const DEFAULT_THEME = {
  sky: ['#EEF0F5', '#D9DCE6'],
  floor: '#E4E6EE',
  light: '#FFFFFF',
  rim: '#C9D6FF',
  pedestal: 'none',
  effect: 'none',
};
const EASE_SECONDS = 0.35;

export function createStage(scene, { renderer, key, fill, rim, rimRight, hemisphere, studio }) {
  const colors = {
    top: new THREE.Color(), bottom: new THREE.Color(), floor: new THREE.Color(),
    light: new THREE.Color(), rim: new THREE.Color(),
  };
  const targets = {
    top: new THREE.Color(), bottom: new THREE.Color(), floor: new THREE.Color(),
    light: new THREE.Color(), rim: new THREE.Color(),
  };
  let easing = 0;
  const WHITE = new THREE.Color(1, 1, 1);

  // Backdrop: a full-screen triangle behind everything, independent of the camera
  const backdrop = new THREE.Mesh(
    new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3)),
    new THREE.ShaderMaterial({
      uniforms: { uTop: { value: colors.top }, uBottom: { value: colors.bottom } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = position.xy * 0.5 + 0.5;
          gl_Position = vec4(position.xy, 0.9999, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uTop;
        uniform vec3 uBottom;
        varying vec2 vUv;
        void main() {
          vec3 color = mix(uBottom, uTop, smoothstep(0.0, 1.0, vUv.y));
          // A soft light behind the avatar, brighter towards the middle
          float glow = 1.0 - smoothstep(0.0, 0.62, distance(vUv, vec2(0.5, 0.56)));
          color = mix(color, min(color * 1.18 + 0.06, vec3(1.0)), glow * 0.55);
          gl_FragColor = vec4(color, 1.0);
          #include <colorspace_fragment>
        }
      `,
      depthWrite: false,
      depthTest: false,
      toneMapped: false,
    }),
  );
  backdrop.frustumCulled = false;
  backdrop.renderOrder = -100;
  scene.add(backdrop);

  // Floor: a wide disc of the floor colour, fading into the backdrop at its edge
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(4, 64),
    new THREE.ShaderMaterial({
      uniforms: { uColor: { value: colors.floor } },
      vertexShader: /* glsl */ `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor;
        varying vec2 vUv;
        void main() {
          float fade = 1.0 - smoothstep(0.12, 0.5, distance(vUv, vec2(0.5)));
          gl_FragColor = vec4(uColor, fade * 0.9);
          #include <colorspace_fragment>
        }
      `,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.renderOrder = -50;
  scene.add(floor);

  // Pedestals: a low round base, or a glowing ring on the floor
  const pedestalMaterial = new THREE.MeshStandardMaterial({ roughness: 0.55, metalness: 0.05 });
  const disc = new THREE.Mesh(new THREE.CylinderGeometry(0.52, 0.56, 0.08, 64), pedestalMaterial);
  // Its top just under the feet and the contact shadow
  disc.position.y = -0.044;
  scene.add(disc);
  const ringMaterial = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.85, toneMapped: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.56, 96), ringMaterial);
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.004;
  scene.add(ring);

  // The effect around the avatar (effects.js)
  const effects = createEffects(scene, renderer);
  const particles = effects.points;

  let theme = { ...DEFAULT_THEME };
  let shown = true;

  const applyShape = () => {
    disc.visible = theme.pedestal === 'disc';
    // With the pedestal the floor goes below it: the two never share a plane (no flicker)
    floor.position.y = disc.visible ? -0.09 : 0;
    ring.visible = theme.pedestal === 'ring';
    effects.set(theme.effect);
    applyParticleLook();
  };

  const applyParticleLook = () => {
    const backdropLight = colors.top.r * 0.299 + colors.top.g * 0.587 + colors.top.b * 0.114;
    effects.setColors(colors.rim, backdropLight > 0.35);
  };

  const applyColors = () => {
    key.color.copy(colors.light);
    rim.color.copy(colors.rim);
    rimRight.color.copy(colors.rim).lerp(WHITE, 0.45);
    // The backdrop's lower colour bounces back on the shaded side
    fill.color.copy(colors.bottom).lerp(WHITE, 0.55);
    // The silhouette glows in the rim colour, more over dark backdrops where the
    // figure would otherwise sink into them
    studio.uStudioRim.value.copy(colors.rim).lerp(WHITE, 0.25);
    const backdropLight = colors.top.r * 0.299 + colors.top.g * 0.587 + colors.top.b * 0.114;
    studio.uStudioRimStrength.value = THREE.MathUtils.lerp(0.42, 0.18, THREE.MathUtils.smoothstep(backdropLight, 0.05, 0.6));
    // The ambient light takes the backdrop's hues: the avatar sits in its world
    hemisphere.color.copy(colors.top).lerp(new THREE.Color(1, 1, 1), 0.55);
    hemisphere.groundColor.copy(colors.floor).lerp(new THREE.Color(0.5, 0.5, 0.5), 0.4);
    pedestalMaterial.color.copy(colors.floor).lerp(new THREE.Color(1, 1, 1), 0.35);
    ringMaterial.color.copy(colors.rim);
    applyParticleLook();
  };

  const set = (next, immediate = false) => {
    theme = { ...DEFAULT_THEME, ...next };
    if (!shown) {
      shown = true;
      backdrop.visible = true;
      floor.visible = true;
      immediate = true;
    }
    targets.top.set(theme.sky[0]);
    targets.bottom.set(theme.sky[1]);
    targets.floor.set(theme.floor);
    targets.light.set(theme.light);
    targets.rim.set(theme.rim);
    applyShape();
    if (immediate) {
      for (const name of Object.keys(colors)) colors[name].copy(targets[name]);
      easing = 0;
      applyColors();
    } else {
      easing = EASE_SECONDS;
    }
  };
  set(DEFAULT_THEME, true);
  // Nothing of the stage shows until the app sets a theme
  for (const object of [backdrop, floor, disc, ring, particles]) object.visible = false;
  shown = false;

  return {
    set,
    // Advances the colours and the effect; true while the colours ease or the effect
    // changes (otherwise it drifts slowly enough for the viewer's idle frame rate)
    update(delta, time) {
      let changing = false;
      if (easing > 0) {
        easing = Math.max(0, easing - delta);
        const amount = easing === 0 ? 1 : 1 - Math.exp(-delta * 12);
        for (const name of Object.keys(colors)) colors[name].lerp(targets[name], amount);
        applyColors();
        changing = true;
      }
      // An effect fading out or in keeps the page drawing at full rate
      if (effects.update(time, delta)) changing = true;
      return changing;
    },
  };
}
