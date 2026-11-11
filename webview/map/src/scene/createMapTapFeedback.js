// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';

const TAP_DISTANCE_PX = 10;
const TAP_MAX_DURATION_MS = 550;
// Holding the finger still this long is a long press (and no longer a tap)
const LONG_PRESS_MS = 600;
// The charge of a long press appears only after this, so quick taps never show it
const CHARGE_DELAY_MS = 140;
const TAP_SECONDS = 0.45;
const BURST_SECONDS = 0.6;
const CHARGE_FADE_SECONDS = 0.15;
// Size of the effect: this share of its distance from the camera, about a fingertip
// on screen whatever the zoom
const SIZE_PER_DISTANCE = 0.2;
// The modes of the shader
const TAP = 0;
const CHARGE = 1;
const BURST = 2;

const vertexShader = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

// TAP: a filled disc pops out (with a little overshoot) with a crisp rim and a thin
// wave, then fades. CHARGE: a soft disc and a ring that fills like a progress bar
// while the finger is held. BURST: the tap, larger and in the flash events' amber.
const fragmentShader = /* glsl */ `
  uniform float uMode;
  uniform float uT;
  uniform float uCharge;
  uniform float uAlpha;
  varying vec2 vUv;

  float easeOutBack(float x) {
    float c1 = 1.70158;
    float c3 = c1 + 1.0;
    return 1.0 + c3 * pow(x - 1.0, 3.0) + c1 * pow(x - 1.0, 2.0);
  }

  void main() {
    vec2 p = (vUv - 0.5) * 2.0;
    float r = length(p);
    vec3 accent = uMode > 1.5 ? vec3(1.0, 0.69, 0.13) : vec3(0.36, 0.55, 1.0);
    vec3 color;
    float alpha;

    if (abs(uMode - 1.0) < 0.5) {
      // An amber disc filling from the centre, and a ring filling clockwise from the
      // top, both reaching full as the long press completes
      float fill = 0.06 + 0.32 * uCharge;
      float disc = (1.0 - smoothstep(fill - 0.03, fill, r)) * (0.3 + 0.25 * uCharge);
      float fromRing = abs(r - 0.48);
      float track = (1.0 - smoothstep(0.045, 0.07, fromRing)) * 0.45;
      float turn = fract(atan(p.x, p.y) / 6.28318 + 1.0);
      float arc = (1.0 - step(uCharge, turn)) * (1.0 - smoothstep(0.05, 0.08, fromRing));
      vec3 amber = vec3(1.0, 0.69, 0.13);
      color = mix(vec3(1.0), amber, clamp(arc + (disc > 0.0 ? 1.0 : 0.0) * (1.0 - track), 0.0, 1.0));
      alpha = (disc + track * (1.0 - arc) + arc) * uAlpha;
    } else {
      float big = uMode > 1.5 ? 1.25 : 1.0;
      float radius = 0.4 * big * easeOutBack(clamp(uT * 2.6, 0.0, 1.0));
      float fade = 1.0 - smoothstep(0.35, 1.0, uT);
      float disc = 1.0 - smoothstep(radius - 0.035, radius, r);
      float centre = 1.0 - 0.45 * clamp(r / max(radius, 0.001), 0.0, 1.0);
      float rim = 1.0 - smoothstep(0.0, 0.03, abs(r - radius));
      float waveRadius = radius + uT * 0.5;
      float wave = (1.0 - smoothstep(0.0, 0.025, abs(r - waveRadius))) * (1.0 - uT);
      color = mix(accent, vec3(1.0), rim * 0.7);
      alpha = (disc * centre * 0.55 + rim * 0.75) * fade + wave * 0.45;
    }
    alpha *= 1.0 - smoothstep(0.92, 1.0, r);
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0));
    #include <colorspace_fragment>
  }
`;

/**
 * One pooled, low-cost ripple that marks the exact map point tapped, and the map's
 * gestures: `onTap(clientX, clientY, bounds)` may claim a tap (return true: no ripple,
 * e.g. an event was tapped); `onLongPress(point)` gets the ground point held.
 */
export function createMapTapFeedback({ scene, camera, domElement, map, groundHeight = 0, onTap, onLongPress }) {
  const geometry = new THREE.PlaneGeometry(1, 1);
  const material = new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: {
      uMode: { value: TAP },
      uT: { value: 0 },
      uCharge: { value: 0 },
      uAlpha: { value: 1 },
    },
    transparent: true,
    depthWrite: false,
    // Opaque scene objects such as the player occlude the ripple; buildings
    // still tint it because their transparent pass is drawn afterwards.
    depthTest: true,
    side: THREE.DoubleSide,
  });
  const ripple = new THREE.Mesh(geometry, material);
  ripple.name = 'map-tap-feedback';
  ripple.rotation.x = -Math.PI / 2;
  // Transparent map buildings draw later and tint the ripple like real glass.
  ripple.renderOrder = -1;
  ripple.visible = false;
  scene.add(ripple);

  const raycaster = new THREE.Raycaster();
  const pointer = new THREE.Vector2();
  const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -groundHeight);
  const groundPoint = new THREE.Vector3();
  let pointerStart = null;
  // What is shown: { mode, elapsed } for TAP and BURST; CHARGE follows the press
  let effect = null;

  // The map point under a screen point (the feature hit, or the ground)
  const pointAt = (clientX, clientY, bounds) => {
    pointer.set(
      ((clientX - bounds.left) / bounds.width) * 2 - 1,
      -((clientY - bounds.top) / bounds.height) * 2 + 1,
    );
    raycaster.setFromCamera(pointer, camera);
    const picked = map.pickFeature(raycaster);
    return picked?.intersection?.point ?? raycaster.ray.intersectPlane(groundPlane, groundPoint);
  };

  // Places the effect at a map point, at a fingertip's size on screen
  const placeAt = (point) => {
    ripple.position.set(point.x, point.y + 0.045, point.z);
    ripple.scale.setScalar(Math.max(camera.position.distanceTo(point) * SIZE_PER_DISTANCE, 2));
    ripple.visible = true;
  };

  const play = (point, mode) => {
    placeAt(point);
    effect = { mode, elapsed: 0 };
    material.uniforms.uMode.value = mode;
    material.uniforms.uT.value = 0;
    material.uniforms.uAlpha.value = 1;
  };
  const showRipple = (point) => play(point, TAP);

  const startRippleAt = (clientX, clientY) => {
    const bounds = domElement.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    if (onTap?.(clientX, clientY, bounds)) return;
    const point = pointAt(clientX, clientY, bounds);
    if (point) showRipple(point);
  };

  // Long press: the finger stays still (a second finger, or moving, cancels it). After
  // CHARGE_DELAY_MS a ring fills under the finger until LONG_PRESS_MS, then bursts.
  let longPressTimer = null;
  let chargeTimer = null;
  let longPressed = false;
  const cancelLongPress = () => {
    clearTimeout(longPressTimer);
    clearTimeout(chargeTimer);
    longPressTimer = null;
    chargeTimer = null;
    // A charge left unfinished fades away
    if (effect?.mode === CHARGE) effect = { mode: CHARGE, fading: 0, charge: material.uniforms.uCharge.value };
  };
  const armLongPress = (clientX, clientY) => {
    cancelLongPress();
    longPressed = false;
    if (!onLongPress) return;
    const pressedAt = performance.now();
    chargeTimer = setTimeout(() => {
      chargeTimer = null;
      const bounds = domElement.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const point = pointAt(clientX, clientY, bounds);
      if (!point) return;
      placeAt(point);
      // A little larger than a tap: it has to be seen around the finger
      ripple.scale.multiplyScalar(1.5);
      effect = { mode: CHARGE, from: pressedAt + CHARGE_DELAY_MS };
      material.uniforms.uMode.value = CHARGE;
      material.uniforms.uCharge.value = 0;
      material.uniforms.uAlpha.value = 1;
    }, CHARGE_DELAY_MS);
    longPressTimer = setTimeout(() => {
      longPressTimer = null;
      clearTimeout(chargeTimer);
      chargeTimer = null;
      const bounds = domElement.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const point = pointAt(clientX, clientY, bounds);
      if (!point) return;
      longPressed = true;
      play(point, BURST);
      onLongPress(point.clone());
    }, LONG_PRESS_MS);
  };

  const onPointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    // A second finger: a pinch, not a tap nor a long press
    if (pointerStart && pointerStart.id !== event.pointerId) {
      pointerStart = null;
      cancelLongPress();
      return;
    }
    armLongPress(event.clientX, event.clientY);
    pointerStart = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      time: event.timeStamp,
    };
  };

  const onPointerMove = (event) => {
    if (!pointerStart || pointerStart.id !== event.pointerId || !longPressTimer) return;
    if (Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > TAP_DISTANCE_PX) cancelLongPress();
  };

  const onPointerUp = (event) => {
    cancelLongPress();
    if (!pointerStart || pointerStart.id !== event.pointerId) return;
    const start = pointerStart;
    pointerStart = null;
    if (longPressed) return;
    const distance = Math.hypot(event.clientX - start.x, event.clientY - start.y);
    if (distance <= TAP_DISTANCE_PX && event.timeStamp - start.time <= TAP_MAX_DURATION_MS) {
      startRippleAt(event.clientX, event.clientY);
    }
  };

  const onPointerCancel = () => {
    pointerStart = null;
    cancelLongPress();
  };

  domElement.addEventListener('pointerdown', onPointerDown);
  domElement.addEventListener('pointermove', onPointerMove);
  domElement.addEventListener('pointerup', onPointerUp);
  domElement.addEventListener('pointercancel', onPointerCancel);

  // Older WebViews without Pointer Events still get the same tap-only feedback.
  let onTouchStart;
  let onTouchEnd;
  let onMouseDown;
  let onMouseUp;
  if (!('PointerEvent' in window)) {
    onTouchStart = (event) => {
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      pointerStart = { id: touch.identifier, x: touch.clientX, y: touch.clientY, time: event.timeStamp };
    };
    onTouchEnd = (event) => {
      if (!pointerStart || event.changedTouches.length !== 1) return;
      const start = pointerStart;
      pointerStart = null;
      const touch = event.changedTouches[0];
      if (touch.identifier !== start.id) return;
      if (Math.hypot(touch.clientX - start.x, touch.clientY - start.y) <= TAP_DISTANCE_PX
        && event.timeStamp - start.time <= TAP_MAX_DURATION_MS) {
        startRippleAt(touch.clientX, touch.clientY);
      }
    };
    onMouseDown = (event) => {
      if (event.button === 0) pointerStart = { id: 0, x: event.clientX, y: event.clientY, time: event.timeStamp };
    };
    onMouseUp = (event) => {
      if (!pointerStart || pointerStart.id !== 0) return;
      const start = pointerStart;
      pointerStart = null;
      if (Math.hypot(event.clientX - start.x, event.clientY - start.y) <= TAP_DISTANCE_PX
        && event.timeStamp - start.time <= TAP_MAX_DURATION_MS) {
        startRippleAt(event.clientX, event.clientY);
      }
    };
    domElement.addEventListener('touchstart', onTouchStart, { passive: true });
    domElement.addEventListener('touchend', onTouchEnd, { passive: true });
    domElement.addEventListener('mousedown', onMouseDown);
    domElement.addEventListener('mouseup', onMouseUp);
  }

  return {
    update(deltaSeconds) {
      if (!ripple.visible || !effect) return;
      const step = Math.min(deltaSeconds, 0.1);
      if (effect.mode === CHARGE) {
        if (effect.fading !== undefined) {
          effect.fading += step;
          material.uniforms.uAlpha.value = Math.max(0, 1 - effect.fading / CHARGE_FADE_SECONDS);
          if (effect.fading >= CHARGE_FADE_SECONDS) {
            ripple.visible = false;
            effect = null;
          }
        } else {
          material.uniforms.uCharge.value = Math.min(1, (performance.now() - effect.from) / (LONG_PRESS_MS - CHARGE_DELAY_MS));
        }
        return;
      }
      effect.elapsed += step;
      const duration = effect.mode === BURST ? BURST_SECONDS : TAP_SECONDS;
      material.uniforms.uT.value = Math.min(1, effect.elapsed / duration);
      if (effect.elapsed >= duration) {
        ripple.visible = false;
        effect = null;
      }
    },
    dispose() {
      cancelLongPress();
      domElement.removeEventListener('pointerdown', onPointerDown);
      domElement.removeEventListener('pointermove', onPointerMove);
      domElement.removeEventListener('pointerup', onPointerUp);
      domElement.removeEventListener('pointercancel', onPointerCancel);
      if (onTouchStart) {
        domElement.removeEventListener('touchstart', onTouchStart);
        domElement.removeEventListener('touchend', onTouchEnd);
        domElement.removeEventListener('mousedown', onMouseDown);
        domElement.removeEventListener('mouseup', onMouseUp);
      }
      scene.remove(ripple);
      geometry.dispose();
      material.dispose();
    },
  };
}
