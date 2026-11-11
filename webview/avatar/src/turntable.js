// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Turning the avatar with a finger: a horizontal drag spins it, and a spring brings
// it back to face the camera when the finger lets go (to the nearest whole turn, so a
// fling that spins it around ends facing front, not unwinding). Vertical drags are
// left to the page (CSS touch-action: pan-y), so the app's screen still scrolls.
// A quick touch without movement is a tap.

const RADIANS_PER_PIXEL = 0.012;
const STIFFNESS = 38;          // pull back to the front (1/s²)
const DAMPING_RATIO = 0.62;    // a little bounce, then still
const MAX_SPIN = 14;           // rad/s after a fling
const TAP_MOVE = 8;            // px
const TAP_TIME = 350;          // ms

export function createTurntable(element, { onTap, onDragChange } = {}) {
  const state = { angle: 0, velocity: 0, dragging: false };
  let pointer = null;
  let lastX = 0;
  let lastTime = 0;
  let downX = 0;
  let downY = 0;
  let downTime = 0;
  let moved = false;

  const onDown = (event) => {
    if (pointer !== null) return;
    pointer = event.pointerId;
    lastX = downX = event.clientX;
    downY = event.clientY;
    lastTime = downTime = performance.now();
    moved = false;
    state.velocity = 0;
  };
  const onMove = (event) => {
    if (event.pointerId !== pointer) return;
    const dx = event.clientX - lastX;
    if (!moved && Math.hypot(event.clientX - downX, event.clientY - downY) > TAP_MOVE) {
      moved = true;
      if (Math.abs(event.clientX - downX) >= Math.abs(event.clientY - downY)) {
        state.dragging = true;
        element.setPointerCapture?.(pointer);
        onDragChange?.(true);
      }
    }
    if (!state.dragging) return;
    const now = performance.now();
    const dt = Math.max((now - lastTime) / 1000, 1 / 240);
    state.angle += dx * RADIANS_PER_PIXEL;
    // Smoothed finger speed, for the fling
    state.velocity = state.velocity * 0.6 + ((dx * RADIANS_PER_PIXEL) / dt) * 0.4;
    lastX = event.clientX;
    lastTime = now;
  };
  const onUp = (event) => {
    if (event.pointerId !== pointer) return;
    pointer = null;
    if (state.dragging) {
      state.dragging = false;
      state.velocity = Math.max(-MAX_SPIN, Math.min(MAX_SPIN, state.velocity));
      onDragChange?.(false);
    } else if (!moved && performance.now() - downTime < TAP_TIME && event.type === 'pointerup') {
      onTap?.(event);
    }
  };

  element.addEventListener('pointerdown', onDown);
  element.addEventListener('pointermove', onMove);
  element.addEventListener('pointerup', onUp);
  element.addEventListener('pointercancel', onUp);

  return {
    state,
    // Advances the spring; true while it still moves
    update(deltaSeconds) {
      if (state.dragging) return true;
      const target = Math.round(state.angle / (Math.PI * 2)) * Math.PI * 2;
      const offset = state.angle - target;
      if (Math.abs(offset) < 0.0005 && Math.abs(state.velocity) < 0.001) {
        state.angle = target;
        state.velocity = 0;
        return false;
      }
      // Semi-implicit Euler in small steps: stable whatever the frame time
      let remaining = Math.min(deltaSeconds, 0.1);
      while (remaining > 0) {
        const step = Math.min(remaining, 1 / 120);
        const damping = 2 * DAMPING_RATIO * Math.sqrt(STIFFNESS);
        state.velocity += (-STIFFNESS * (state.angle - target) - damping * state.velocity) * step;
        state.angle += state.velocity * step;
        remaining -= step;
      }
      return true;
    },
  };
}
