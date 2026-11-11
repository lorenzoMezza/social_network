// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';

// The effect around the avatar on its stage (stage.js): points moved and drawn by the
// GPU, one draw call whatever the effect. Each point has four random numbers; the
// vertex shader places it from them and the time (nothing per frame on the CPU, no
// buffer uploaded) and the fragment shader draws its shape (no texture). Two depths:
// near points crisp, far ones bigger, softer and dimmer, so the effect has depth
// behind the figure (the camera is about 6 m away, its view about 2.7 m tall).
export const EFFECT_MODES = {
  // a sprinkle of soft five-pointed stars turning and twinkling and thin four-rayed
  // glints flaring up and fading; far behind, only tiny faint glints (no round
  // shapes: those are the bubbles')
  sparkles: 0,
  bubbles: 1, // rising, wobbling, a bright rim and a highlight
  fireflies: 2, // warm lights wandering and pulsing
  notes: 3, // music notes rising and swaying, some two joined by a beam
  hearts: 4, // little hearts rising and swaying
  confetti: 5, // bright paper bits falling and flipping
  petals: 6, // petals falling and turning
};
// Effects that are light (they add up over a dark backdrop); the others are surfaces
const LIGHTS = new Set(['sparkles', 'fireflies']);
// A new effect replaces the old one: the old fades out, then the new fades in
const FADE_OUT = 0.15;
const FADE_IN = 0.3;
const COUNT = 110;

const vertexShader = /* glsl */ `
  attribute vec4 seed;
  uniform float uTime;
  uniform float uMode;
  uniform float uScale;
  // kind (0 near, 1 far / bright / special), brightness, its own random number
  varying vec3 vKind;
  varying float vAngle;
  void main() {
    float a = seed.x, b = seed.y, c = seed.z, d = seed.w;
    float t = uTime;
    float far = step(0.72, b); // about a quarter far back
    vec3 p = vec3((a - 0.5) * mix(3.0, 4.6, far), 0.0, mix(-0.45 - b * 1.2, -2.2 - b * 0.6, far));
    float size = 0.1;
    float bright = 1.0;
    vAngle = 0.0;
    int mode = int(uMode + 0.5);
    if (mode == 0) {
      // Each twinkles at its own rhythm while drifting slowly up: the stars (d < 0.55)
      // breathe, never quite gone; the glints flare up and vanish
      float cycle = fract(t * (0.12 + d * 0.16) + c * 7.0);
      float flare = smoothstep(0.0, 0.25, cycle) * (1.0 - smoothstep(0.45, 1.0, cycle));
      float star = step(d, 0.55);
      bright = mix(flare, 0.35 + 0.65 * flare, star);
      p.y = 0.15 + fract(c * 3.1 + t * 0.012 * (1.0 + d)) * 2.4;
      p.x += sin(t * (0.25 + d * 0.3) + b * 10.0) * 0.06;
      size = mix(mix(0.22 + d * 0.24, 0.18 + d * 0.2, star) * (0.85 + 0.15 * bright), 0.16 + d * 0.1, far);
      bright *= mix(1.0, 0.45, far);
      // A sprinkle, not a crowd: about half of the points stay unlit
      size *= step(fract(a * 13.7 + c * 3.1), 0.55);
      vAngle = t * 0.22 * (d - 0.5) + c * 6.28;
    } else if (mode == 1) {
      float rise = fract(c + t * (0.035 + d * 0.035) * (1.0 - far * 0.4));
      p.y = rise * 2.7 - 0.1;
      p.x += sin(t * (0.7 + d * 0.8) + a * 20.0) * 0.07 * (1.0 - far * 0.5);
      size = mix(0.14 + d * 0.26, 0.45 + d * 0.4, far);
      bright = smoothstep(0.0, 0.08, rise) * (1.0 - smoothstep(0.7, 1.0, rise));
    } else if (mode == 2) {
      // Wandering on slow curves, pulsing
      p.y = 0.2 + c * 2.1 + sin(t * (0.3 + d * 0.3) + a * 12.0) * 0.18;
      p.x += sin(t * (0.2 + d * 0.25) + c * 9.0) * 0.3;
      p.z += cos(t * (0.17 + d * 0.2) + b * 7.0) * 0.2;
      bright = 0.25 + 0.75 * pow(0.5 + 0.5 * sin(t * (1.1 + d * 1.6) + c * 30.0), 3.0);
      size = mix(0.26 + d * 0.16, 0.5 + d * 0.3, far);
    } else if (mode == 3) {
      // Rising and swaying like the hearts, a little tilted, rocking to a beat
      float rise = fract(c + t * (0.03 + d * 0.025));
      p.y = rise * 2.7 - 0.1;
      p.x += sin(t * (0.55 + d * 0.45) + a * 15.0) * 0.11;
      size = mix(0.3 + d * 0.2, 0.46 + d * 0.22, far);
      // The single notes (d < 0.66, fragment shader) as big as the joined ones
      size *= mix(1.35, 1.0, step(0.66, d));
      bright = smoothstep(0.0, 0.1, rise) * (1.0 - smoothstep(0.75, 1.0, rise));
      vAngle = sin(t * (1.4 + d) + a * 9.0) * 0.22 - 0.12;
    } else if (mode == 4) {
      float rise = fract(c + t * (0.03 + d * 0.03));
      p.y = rise * 2.7 - 0.1;
      p.x += sin(t * (0.6 + d * 0.5) + a * 15.0) * 0.1;
      size = mix(0.16 + d * 0.16, 0.36 + d * 0.2, far);
      bright = smoothstep(0.0, 0.1, rise) * (1.0 - smoothstep(0.75, 1.0, rise));
      vAngle = sin(t * (0.8 + d) + a * 9.0) * 0.35;
    } else if (mode == 5) {
      float fall = fract(c + t * (0.08 + d * 0.07));
      p.y = 2.7 - fall * 2.9;
      p.x += sin(t * (0.9 + d) + a * 20.0) * 0.09;
      size = mix(0.32 + d * 0.16, 0.42 + d * 0.16, far);
      bright = smoothstep(0.0, 0.04, fall) * (1.0 - smoothstep(0.94, 1.0, fall));
      vAngle = t * (1.5 + d * 3.0) + c * 6.28;
    } else {
      float fall = fract(c + t * (0.04 + d * 0.04));
      p.y = 2.7 - fall * 2.9;
      p.x += sin(t * (0.5 + d * 0.5) + a * 20.0) * 0.18;
      size = mix(0.24 + d * 0.16, 0.42 + d * 0.22, far);
      bright = smoothstep(0.0, 0.05, fall) * (1.0 - smoothstep(0.92, 1.0, fall));
      vAngle = t * (0.6 + d * 0.9) + c * 6.28;
    }
    vKind = vec3(far, bright, d);
    vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
    gl_PointSize = size * uScale / -mvPosition.z;
    gl_Position = projectionMatrix * mvPosition;
  }
`;

const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uMode;
  uniform float uLightBackdrop;
  uniform float uFade;
  varying vec3 vKind;
  varying float vAngle;

  vec2 turn(vec2 q, float angle) {
    float s = sin(angle), c = cos(angle);
    return vec2(c * q.x - s * q.y, s * q.x + c * q.y);
  }

  // Signed distance to a five-pointed star of radius r, inner radius r * rf
  // (Inigo Quilez, MIT)
  float star5(vec2 p, float r, float rf) {
    const vec2 k1 = vec2(0.809016994375, -0.587785252292);
    const vec2 k2 = vec2(-k1.x, k1.y);
    p.x = abs(p.x);
    p -= 2.0 * max(dot(k1, p), 0.0) * k1;
    p -= 2.0 * max(dot(k2, p), 0.0) * k2;
    p.x = abs(p.x);
    p.y -= r;
    vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
    float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
    return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
  }

  void main() {
    // Point coordinates are y down: q.y up
    vec2 q = vec2(gl_PointCoord.x, 1.0 - gl_PointCoord.y) * 2.0 - 1.0;
    float r = length(q);
    vec3 color = uColor;
    float alpha = 0.0;
    int mode = int(uMode + 0.5);
    if (mode == 0) {
      if (vKind.z < 0.55 && vKind.x < 0.5) {
        // A star: plump rounded points, a light heart and a soft glow; a few golden
        float d = star5(turn(q, vAngle), 0.6, 0.5) - 0.07;
        float fill = 1.0 - smoothstep(-0.03, 0.03, d);
        float glow = exp(-max(d, 0.0) * 10.0) * 0.28 * (1.0 - smoothstep(0.75, 1.0, r));
        float heart = 1.0 - smoothstep(0.0, 0.32, r);
        vec3 tint = fract(vKind.z * 9.7) < 0.3 ? vec3(1.0, 0.82, 0.4) : uColor;
        alpha = (fill * 0.85 + glow) * vKind.y * (1.0 + uLightBackdrop * 0.4);
        color = mix(tint, vec3(1.0), heart * 0.6 * (1.0 - uLightBackdrop * 0.6));
      } else {
        vec2 k = turn(q, vAngle);
        float rays = exp(-abs(k.x) * 22.0) * (1.0 - smoothstep(0.15, 1.0, abs(k.y)))
          + exp(-abs(k.y) * 22.0) * (1.0 - smoothstep(0.15, 1.0, abs(k.x)));
        float core = exp(-r * r * 30.0);
        float halo = exp(-r * r * 9.0) * 0.18;
        alpha = (rays * 0.85 + core + halo) * vKind.y * (1.0 + uLightBackdrop * 0.5);
        color = mix(uColor, vec3(1.0), core * (1.0 - uLightBackdrop * 0.6));
      }
    } else if (mode == 1) {
      float rim = smoothstep(0.7, 0.93, r) * (1.0 - smoothstep(0.93, 1.0, r));
      float inside = (1.0 - smoothstep(0.9, 1.0, r)) * 0.12;
      vec2 h = q - vec2(-0.38, 0.4);
      float light = exp(-dot(h, h) * 30.0);
      alpha = (rim * 0.9 + inside + light * 0.95) * vKind.y * mix(1.0, 0.6, vKind.x);
      color = mix(uColor, vec3(1.0), light * 0.8 + rim * 0.3);
    } else if (mode == 2) {
      float core = exp(-r * r * 26.0);
      float glow = exp(-r * r * 4.0) * 0.55;
      alpha = (core + glow) * vKind.y * mix(1.0, 0.7, vKind.x);
      color = mix(uColor, vec3(1.0, 0.94, 0.62), 0.6) + core * 0.3 * (1.0 - uLightBackdrop);
    } else if (mode == 3) {
      // A music note: a tilted oval head, its stem and a flag (a quaver); about a third
      // two quavers joined by a beam. In the stage's colour with a highlight, like the
      // hearts
      vec2 k = turn(q, vAngle);
      float twin = step(0.66, vKind.z);
      vec2 o = k - vec2(mix(-0.12, -0.42, twin), -0.52);
      vec2 h = turn(o, 0.45) / vec2(0.33, 0.24);
      float head = 1.0 - smoothstep(0.88, 1.04, length(h));
      float stemX = mix(0.13, -0.15, twin);
      float stem = (1.0 - smoothstep(0.06, 0.09, abs(k.x - stemX))) * step(-0.52, k.y) * step(k.y, 0.6);
      float flag = 0.0;
      if (twin > 0.5) {
        // The second note, its stem and the beam across the tops
        vec2 o2 = k - vec2(0.3, -0.38);
        float head2 = 1.0 - smoothstep(0.88, 1.04, length(turn(o2, 0.45) / vec2(0.33, 0.24)));
        float stem2 = (1.0 - smoothstep(0.06, 0.09, abs(k.x - 0.57))) * step(-0.38, k.y) * step(k.y, 0.72);
        float beamY = mix(0.6, 0.72, clamp((k.x + 0.15) / 0.72, 0.0, 1.0));
        float beam = (1.0 - smoothstep(0.07, 0.1, abs(k.y - beamY + 0.06))) * step(-0.18, k.x) * step(k.x, 0.6);
        flag = max(max(head2, stem2), beam);
      } else {
        // The flag: a stroke from the top of the stem, down and out, thinning to its tip
        vec2 f = k - vec2(stemX, 0.6);
        vec2 tip = vec2(0.3, -0.4);
        float along = clamp(dot(f, tip) / dot(tip, tip), 0.0, 1.0);
        float width = mix(0.12, 0.04, along);
        flag = 1.0 - smoothstep(width - 0.03, width, length(f - tip * along));
      }
      float inside = max(max(head, stem), flag);
      vec2 light = h - vec2(-0.35, 0.35);
      alpha = inside * vKind.y * mix(0.95, 0.6, vKind.x);
      color = mix(uColor, vec3(1.0), exp(-dot(light, light) * 6.0) * head * 0.6);
    } else if (mode == 4) {
      // A heart: (x² + y² − 1)³ − x²y³ ≤ 0, with a highlight
      vec2 k = turn(q, vAngle) * 1.25 + vec2(0.0, 0.2);
      float x2 = k.x * k.x;
      float v = pow(x2 + k.y * k.y - 1.0, 3.0) - x2 * k.y * k.y * k.y;
      float inside = 1.0 - smoothstep(-0.03, 0.03, v);
      vec2 h = k - vec2(-0.35, 0.35);
      float light = exp(-dot(h, h) * 18.0);
      alpha = inside * vKind.y * mix(0.95, 0.6, vKind.x);
      color = mix(uColor, vec3(1.0), light * 0.6);
    } else if (mode == 5) {
      // A paper bit flipping: a rectangle whose width turns with it; its own colour
      vec2 k = turn(q, vAngle);
      float width = 0.12 + 0.45 * abs(cos(vAngle * 1.7));
      float inside = (1.0 - smoothstep(width - 0.06, width, abs(k.x))) * (1.0 - smoothstep(0.2, 0.26, abs(k.y)));
      float pick = floor(vKind.z * 5.0);
      vec3 paper = pick < 1.0 ? vec3(1.0, 0.36, 0.46) : pick < 2.0 ? vec3(1.0, 0.8, 0.2)
        : pick < 3.0 ? vec3(0.3, 0.8, 1.0) : pick < 4.0 ? vec3(0.55, 0.95, 0.45) : uColor;
      alpha = inside * vKind.y * mix(1.0, 0.65, vKind.x);
      color = paper * mix(0.75, 1.0, abs(cos(vAngle * 1.7)));
    } else {
      // A petal: a pointed oval, lighter at its base
      vec2 k = turn(q, vAngle);
      float v = (k.x * k.x) / 0.16 + pow(abs(k.y), 1.6);
      float inside = 1.0 - smoothstep(0.85, 1.0, v);
      alpha = inside * vKind.y * mix(0.95, 0.6, vKind.x);
      color = mix(uColor, vec3(1.0), 0.35 + 0.3 * smoothstep(0.4, -0.8, k.y));
    }
    alpha *= uFade;
    if (alpha < 0.004) discard;
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
    #include <colorspace_fragment>
  }
`;

export function createEffects(scene, renderer) {
  const seeds = new Float32Array(COUNT * 4);
  for (let i = 0; i < seeds.length; i++) seeds[i] = Math.random();
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(COUNT * 3), 3));
  geometry.setAttribute('seed', new THREE.BufferAttribute(seeds, 4));
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uColor: { value: new THREE.Color() },
      uTime: { value: 0 },
      uMode: { value: 0 },
      uLightBackdrop: { value: 0 },
      uFade: { value: 0 },
      uScale: { value: 500 }, // half the drawing buffer's height, as for THREE.Points
    },
    transparent: true,
    depthWrite: false,
    toneMapped: false,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  points.visible = false;
  scene.add(points);
  const white = new THREE.Color(1, 1, 1);
  const warm = new THREE.Color(1, 0.85, 0.55);
  const u = material.uniforms;
  let effect = 'none';
  let pending = null; // the effect that takes over once the current one has faded
  let fade = 0;
  let look = null; // the colours last asked for, applied again to a new effect

  const apply = (next) => {
    effect = next;
    points.visible = effect !== 'none';
    u.uMode.value = EFFECT_MODES[effect] ?? 0;
    if (look) colorize(...look);
  };
  // Over a dark backdrop light adds up, in pale tints of the rim colour; over a light
  // one it would vanish, so everything is laid over it in the rim colour itself,
  // deepened. Surfaces (bubbles, notes…) are always laid over.
  const colorize = (rim, lightBackdrop) => {
    u.uLightBackdrop.value = lightBackdrop ? 1 : 0;
    material.blending = LIGHTS.has(effect) && !lightBackdrop ? THREE.AdditiveBlending : THREE.NormalBlending;
    const color = u.uColor.value.copy(rim);
    if (effect === 'fireflies') color.lerp(warm, 0.6);
    if (lightBackdrop) color.multiplyScalar(effect === 'bubbles' ? 0.95 : 0.72);
    else color.lerp(white, effect === 'bubbles' ? 0.55 : 0.3);
  };

  return {
    points,
    set(next) {
      const target = EFFECT_MODES[next] === undefined ? 'none' : next;
      if (target === (pending ?? effect)) return;
      if (effect === 'none' || fade <= 0) {
        apply(target);
        pending = null;
        fade = 0;
      } else pending = target; // fade the current one out first
    },
    setColors(rim, lightBackdrop) {
      look = [rim.clone(), lightBackdrop];
      colorize(rim, lightBackdrop);
    },
    // True while an effect fades out or in (the page keeps drawing every frame)
    update(time, delta) {
      let changing = false;
      if (pending !== null) {
        fade = Math.max(0, fade - delta / FADE_OUT);
        if (fade === 0) {
          apply(pending);
          pending = null;
        }
        changing = true;
      } else if (points.visible && fade < 1) {
        fade = Math.min(1, fade + delta / FADE_IN);
        changing = true;
      }
      u.uFade.value = fade;
      if (points.visible) {
        u.uTime.value = time;
        u.uScale.value = renderer.domElement.height / 2;
      }
      return changing;
    },
  };
}
