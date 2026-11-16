// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';

// How an avatar moves, as numbers: which of Decentraland's idle, walk, jog and run
// show and how much, at which point of their cycle, and an emote over them. The
// player's avatar plays it with three.js's mixer (avatarLocomotion.js), the people
// around with their own sampler (crowd/crowdAnimator.js): both move the same way.

// Gaits by real speed (m/s), like a person: walking up to a brisk pace, then jogging,
// then running (cycling, a vehicle). The map avatar is a giant, so its cadence follows
// the speed of a person, not the speed of the map under its feet.
const MOVING = [0.15, 0.6];
const JOG = [2.2, 3.2];
const RUN = [5, 6.5];
// How far the cadence follows the speed away from each clip's own speed
const CADENCE_RANGE = [0.75, 1.35];
// The user's real cadence (steps/s, the phone's sensors) sets the stride instead:
// one cycle is two steps, within what the clips can show
const CYCLES_FROM_STEPS = [0.45, 1.9];
// On a real step the stride moves this share of the way to the nearest foot landing
const STEP_LOCK = 0.35;
// Seconds for the speed and the blend of gaits to settle
const SPEED_SMOOTHING = 0.25;
// Seconds for an emote to take over the body, and to give it back
const EMOTE_IN = 0.25;
const EMOTE_OUT = 0.35;

/**
 * clips: { idle, walk, jog, run }, each { duration, speed?, phase? } (the decoded
 * locomotion clips: speed in m/s, phase where the left foot is forward). The walk, jog
 * and run share one stride phase, so the feet never cross while they blend.
 *
 * update() answers the state to pose: { idle, walk, jog, run, emote } with
 * { weight, time } each (emote: also `clip`, or null), weights summing to one.
 */
export function createGait({ idle, walk, jog, run }) {
  const strides = [walk, jog, run].map((gait) => ({ gait, weight: 0, time: 0 }));
  const state = {
    idle: { weight: 1, time: 0 },
    walk: strides[0],
    jog: strides[1],
    run: strides[2],
    emote: null,
  };
  let speed = 0;
  // Stride phase (0–1), with the left foot forward at walk.phase
  let phase = 0;

  return {
    state,
    // A clip played once over the gaits (a wave…): `clip` is whatever the player of
    // the state uses, `duration` its length in seconds
    play(clip, duration) {
      state.emote = { clip, duration, time: 0, weight: state.emote?.weight ?? 0 };
    },
    // A real step (the user's): the nearest foot lands now
    step() {
      const half = (((phase - walk.phase) % 0.5) + 0.5) % 0.5;
      phase = (phase + (half < 0.25 ? -half : 0.5 - half) * STEP_LOCK + 1) % 1;
    },
    // targetSpeed m/s; cadence: the user's steps per second when known (0: from the speed)
    update(deltaSeconds, targetSpeed, cadence = 0) {
      speed += (targetSpeed - speed) * (1 - Math.exp(-deltaSeconds / SPEED_SMOOTHING));
      const smooth = THREE.MathUtils.smoothstep;
      const moving = smooth(speed, ...MOVING);
      const jogging = smooth(speed, ...JOG);
      const running = smooth(speed, ...RUN);
      // The emote fades in, holds, and fades out before its end
      let over = 0;
      const emote = state.emote;
      if (emote) {
        emote.time = Math.min(emote.time + deltaSeconds, emote.duration);
        const ending = emote.time >= emote.duration - EMOTE_OUT;
        const rate = deltaSeconds / (ending ? EMOTE_OUT : EMOTE_IN);
        emote.weight = THREE.MathUtils.clamp(emote.weight + (ending ? -rate : rate), 0, 1);
        over = emote.weight;
        if (ending && emote.weight <= 0) state.emote = null;
      }
      const body = 1 - over;
      state.walk.weight = moving * (1 - jogging) * body;
      state.jog.weight = moving * jogging * (1 - running) * body;
      state.run.weight = moving * jogging * running * body;
      state.idle.weight = (1 - moving) * body;
      state.idle.time = (state.idle.time + deltaSeconds) % idle.duration;

      // Cycles per second: each gait's own, nudged towards the speed
      let rate = 0;
      let total = 0;
      for (const stride of strides) {
        const own = THREE.MathUtils.clamp(Math.max(speed, 0.5) / stride.gait.speed, ...CADENCE_RANGE);
        rate += (stride.weight * own) / stride.gait.duration;
        total += stride.weight;
      }
      if (total > 0) {
        const cycles = cadence > 0 ? THREE.MathUtils.clamp(cadence / 2, ...CYCLES_FROM_STEPS) : rate / total;
        phase = (phase + cycles * deltaSeconds) % 1;
      }
      for (const stride of strides) {
        stride.time = ((phase + stride.gait.phase - walk.phase + 1) % 1) * stride.gait.duration;
      }
      return state;
    },
  };
}
