// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { supportsAstc } from '../../../../avatar/src/astcTexture.js';
import { avatarCapsules } from '../capsuleShadows.js';
import { emoteClip, prepareAvatarMaterial } from '../createPlayerAvatar.js';
import { locomotionClips } from '../avatarLocomotion.js';
import { createGait } from '../gait.js';
import { PLAYER_AVATAR_SCALE } from '../playerConfig.js';
import { createCrowdBatch } from './crowdBatch.js';
import { loadCrowdModel } from './crowdModel.js';
import { sampleClip } from './crowdPose.js';

// The people on the map, however many: each one wears their map avatar, made by the
// server (asset-pipeline/src/mapAvatar.mjs) and drawn with everyone else's in a few
// batches (crowdBatch.js), posed by their own gait (gait.js, as the player's) without
// three.js's per-bone objects. Until their avatar has arrived they wear the stand-in,
// a map avatar too (setStandIn).
//
//   const crowd = createCrowd({ scene, renderer, shadows })
//   const person = crowd.add(name)  → { root, setLook(files), playEmote(url), setMoving,
//                                       update(time, speed), hide(), dispose() }
//   crowd.upload() once per frame, after every person's update, before the render

// People per batch: the first small (little GPU memory for a few people), then larger
const BATCH_SIZES = [8, 16, 32];
// The bones of the capsule shadows (capsuleShadows.avatarCapsules)
const SHADOW_BONES = ['Hips', 'Head', 'LeftUpLeg', 'LeftFoot', 'LeftArm', 'LeftHand', 'RightUpLeg', 'RightFoot', 'RightArm', 'RightHand'].map((name) => `Avatar_${name}`);

const gaitInfo = ({ clip, speed, phase }) => ({ duration: clip.duration, speed, phase });

export function createCrowd({ scene, renderer, shadows }) {
  const withAstc = supportsAstc(renderer);
  const batches = [];
  const clips = locomotionClips();
  const gaits = { idle: gaitInfo(clips.idle), walk: gaitInfo(clips.walk), jog: gaitInfo(clips.jog), run: gaitInfo(clips.run) };
  let standIn = null; // files
  const members = new Set();

  // A place in a batch for someone wearing `model`: with others who wear it if possible
  const placeIn = (model) => {
    let batch = batches.find((candidate) => candidate.has(model) && candidate.canTake(model))
      ?? batches.find((candidate) => candidate.canTake(model));
    if (!batch) {
      batch = createCrowdBatch({
        scene,
        renderer,
        capacity: BATCH_SIZES[Math.min(batches.length, BATCH_SIZES.length - 1)],
        withAstc,
        prepare: prepareAvatarMaterial,
      });
      batches.push(batch);
    }
    return { batch, instance: batch.add(model) };
  };

  // A batch nobody uses any more gives its GPU memory back (the first one stays)
  const tidy = () => {
    for (let i = batches.length - 1; i > 0; i--) {
      if (batches[i].count > 0) continue;
      batches[i].dispose();
      batches.splice(i, 1);
    }
  };

  const add = (name) => {
    const root = new THREE.Group();
    root.name = name;
    root.visible = false;
    scene.add(root);
    const gait = createGait(gaits);
    let model = null;
    let wanted = null; // the files of their own look
    let wearsOwn = false;
    // A look that could not load (no network…) is tried again, ever later
    let failures = 0;
    let retryTimer = null;
    let placement = null;
    let moving = false;
    let previousTime = null;
    let disposed = false;
    // Their pose's layers (crowdPose), the samples of the clips on their skeleton
    let samples = null;
    const layers = [
      { sampled: null, weight: 0, time: 0 },
      { sampled: null, weight: 0, time: 0 },
      { sampled: null, weight: 0, time: 0 },
      { sampled: null, weight: 0, time: 0 },
      { sampled: null, weight: 0, time: 0 },
    ];
    // Model space → world, and the bones' places for the shadow
    const placeMatrix = new THREE.Matrix4();
    const modelMatrix = new THREE.Matrix4();
    let boneWorlds = null;
    const shadowBones = new Map(SHADOW_BONES.map((bone) => [bone, { matrixWorld: new THREE.Matrix4() }]));
    let shadowScale = PLAYER_AVATAR_SCALE;
    const shadow = shadows.add({ root, capsules: [], scale: () => shadowScale });
    shadow.setStrength(0);

    const wear = (next) => {
      if (disposed || next === model) return;
      if (placement) placement.batch.remove(placement.instance);
      model = next;
      placement = placeIn(model);
      tidy();
      samples = {
        idle: sampleClip(clips.idle.clip, model.rig.names),
        walk: sampleClip(clips.walk.clip, model.rig.names),
        jog: sampleClip(clips.jog.clip, model.rig.names),
        run: sampleClip(clips.run.clip, model.rig.names),
      };
      boneWorlds = new Float32Array(model.rig.count * 16);
      // Decentraland avatars face +Z; on the map forward is -Z; all as tall as the stand-in
      const scale = PLAYER_AVATAR_SCALE * (1.8 / model.height);
      modelMatrix.makeRotationY(Math.PI).scale(new THREE.Vector3(scale, scale, scale));
      shadowScale = scale;
      shadow.setCapsules(avatarCapsules(shadowBones), () => shadowScale);
      shadow.setStrength(1);
    };

    const load = (files, own) => {
      loadCrowdModel(files, withAstc).then((loaded) => {
        failures = 0;
        // Their own look wins over the stand-in, whichever arrives first
        if (own ? wanted === files : !model) {
          wear(loaded);
          wearsOwn = own;
        }
      }).catch((error) => {
        if (disposed) return;
        if (failures++ === 0) console.warn('A map avatar could not be shown:', error?.message ?? error);
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => member.retry(), Math.min(60000, 2000 * 2 ** Math.min(failures, 5)));
      });
    };
    if (standIn) load(standIn, false);
    const member = {
      root,
      // What could not load is asked again now (the network is back)
      retry() {
        clearTimeout(retryTimer);
        retryTimer = null;
        if (disposed) return;
        if (wanted && !wearsOwn) load(wanted, true);
        else if (!model && standIn) load(standIn, false);
      },
      // Their own avatar: { model, astc, png } (the app sends it once ready)
      setLook(files) {
        if (!files?.model || wanted?.model === files.model) return;
        wanted = files;
        wearsOwn = false;
        load(files, true);
      },
      standIn() {
        if (!model && standIn) load(standIn, false);
      },
      // An emote once (a wave…), over walking or standing. Answers how long it plays
      // (seconds), 0 when it does not.
      async playEmote(url) {
        if (!url) return 0;
        try {
          const clip = await emoteClip(url);
          if (!clip || disposed) return 0;
          gait.play(clip, clip.duration);
          return clip.duration;
        } catch {
          return 0;
        }
      },
      setMoving(value) {
        moving = value;
      },
      // Each frame it is on screen, after its root moved
      update(timeSeconds, speed = 0) {
        const deltaSeconds = previousTime === null ? 0 : THREE.MathUtils.clamp(timeSeconds - previousTime, 0, 0.1);
        previousTime = timeSeconds;
        const state = gait.update(deltaSeconds, moving ? speed : 0);
        if (!model) return;
        layers[0].sampled = samples.idle;
        layers[0].weight = state.idle.weight;
        layers[0].time = state.idle.time;
        layers[1].sampled = samples.walk;
        layers[1].weight = state.walk.weight;
        layers[1].time = state.walk.time;
        layers[2].sampled = samples.jog;
        layers[2].weight = state.jog.weight;
        layers[2].time = state.jog.time;
        layers[3].sampled = samples.run;
        layers[3].weight = state.run.weight;
        layers[3].time = state.run.time;
        if (state.emote) {
          layers[4].sampled = sampleClip(state.emote.clip, model.rig.names);
          layers[4].weight = state.emote.weight;
          layers[4].time = state.emote.time;
        } else {
          layers[4].weight = 0;
        }
        root.updateMatrixWorld();
        placeMatrix.multiplyMatrices(root.matrixWorld, modelMatrix);
        placement.batch.pose(placement.instance, model.rig, layers, placeMatrix, boneWorlds);
        // The shadow's bones, in the world
        model.rig.names.forEach((bone, i) => {
          const proxy = shadowBones.get(bone);
          if (proxy) proxy.matrixWorld.fromArray(boneWorlds, i * 16).premultiply(placeMatrix);
        });
      },
      // Off the screen this frame
      hide() {
        if (placement) placement.batch.hide(placement.instance);
      },
      dispose() {
        disposed = true;
        clearTimeout(retryTimer);
        members.delete(member);
        shadow.remove();
        scene.remove(root);
        if (placement) placement.batch.remove(placement.instance);
        placement = null;
        tidy();
      },
    };
    members.add(member);
    return member;
  };

  return {
    add,
    // The stand-in: { model, astc, png }, worn until someone's own avatar arrives
    setStandIn(files) {
      if (!files?.model || standIn?.model === files.model) return;
      standIn = files;
      for (const member of members) member.standIn();
    },
    upload() {
      for (const batch of batches) batch.upload();
    },
    // Everyone's look that could not load is asked again now (the network is back)
    retry() {
      for (const member of members) member.retry();
    },
    // Draw calls the people cost (one per batch), for the developer tools
    get batches() {
      return batches.length;
    },
    dispose() {
      for (const member of [...members]) member.dispose();
      for (const batch of batches) batch.dispose();
      batches.length = 0;
    },
  };
}
