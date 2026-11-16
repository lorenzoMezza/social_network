// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
// Decentraland's own idle, walk, jog and run, on the avatar's bones (Avatar_*), so
// they play on any body shape without retargeting
// (assets/models/decentraland/README.md)
import { decodeClip } from '../../../avatar/src/clips.js';
import idlePacked from '../../../../assets/models/decentraland/locomotion/idle.json';
import walkPacked from '../../../../assets/models/decentraland/locomotion/walk.json';
import jogPacked from '../../../../assets/models/decentraland/locomotion/jog.json';
import runPacked from '../../../../assets/models/decentraland/locomotion/run.json';
import { createGait } from './gait.js';

/** The gait clips, decoded once: { idle, walk, jog, run } of { clip, speed?, phase? } */
export const locomotionClips = () => ({
  idle: decodeClip(idlePacked),
  walk: decodeClip(walkPacked),
  jog: decodeClip(jogPacked),
  run: decodeClip(runPacked),
});

const gaitInfo = ({ clip, speed, phase }) => ({ duration: clip.duration, speed, phase });

/**
 * Plays the gaits on an avatar body (composeAvatar) with three.js's mixer, blended by
 * speed (gait.js). An emote (play) takes the body over once, then the gaits come back.
 */
export function createLocomotion(body) {
  const clips = locomotionClips();
  const mixer = new THREE.AnimationMixer(body);
  // Every action is driven by the gait's times, not by the mixer's clock
  const actionOf = (clip) => {
    const action = mixer.clipAction(clip);
    action.timeScale = 0;
    action.setEffectiveWeight(0);
    action.play();
    return action;
  };
  const actions = {
    idle: actionOf(clips.idle.clip),
    walk: actionOf(clips.walk.clip),
    jog: actionOf(clips.jog.clip),
    run: actionOf(clips.run.clip),
  };
  const gait = createGait({ idle: gaitInfo(clips.idle), walk: gaitInfo(clips.walk), jog: gaitInfo(clips.jog), run: gaitInfo(clips.run) });
  let emoteAction = null;

  return {
    // A clip played once over the gaits (a wave…)
    play(clip) {
      const action = mixer.clipAction(clip);
      if (emoteAction && emoteAction !== action) emoteAction.stop();
      action.reset();
      action.setLoop(THREE.LoopOnce, 1);
      action.clampWhenFinished = true;
      action.timeScale = 0;
      action.play();
      emoteAction = action;
      gait.play(clip, clip.duration);
    },
    // A real step (the user's): the nearest foot lands now
    step() {
      gait.step();
    },
    // cadence: the user's steps per second when known (0: from the speed)
    update(deltaSeconds, targetSpeed, cadence = 0) {
      const state = gait.update(deltaSeconds, targetSpeed, cadence);
      for (const name of ['idle', 'walk', 'jog', 'run']) {
        actions[name].time = state[name].time;
        actions[name].setEffectiveWeight(state[name].weight);
      }
      if (emoteAction) {
        if (state.emote) {
          emoteAction.time = state.emote.time;
          emoteAction.setEffectiveWeight(state.emote.weight);
        } else {
          emoteAction.stop();
          emoteAction = null;
        }
      }
      mixer.update(deltaSeconds);
    },
    dispose() {
      mixer.stopAllAction();
      mixer.uncacheRoot(body);
    },
  };
}
