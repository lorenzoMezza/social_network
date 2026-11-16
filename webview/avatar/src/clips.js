// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';

// Decentraland's own idle, walk, jog and run (assets/models/decentraland/README.md),
// as three.js clips on the avatar's bones (Avatar_*): no retargeting, any body shape.
// A packed track is one value (static) or { f: frame indices, v: values }.
const cache = new Map();

/** @returns {{ clip: THREE.AnimationClip, speed?: number, phase?: number }} */
export function decodeClip(packed) {
  if (cache.has(packed)) return cache.get(packed);
  const tracks = Object.entries(packed.tracks).map(([name, track]) => {
    const quaternion = name.endsWith('.quaternion');
    const Track = quaternion ? THREE.QuaternionKeyframeTrack : THREE.VectorKeyframeTrack;
    if (Array.isArray(track)) return new Track(name, [0], track);
    return new Track(name, track.f.map((frame) => frame / packed.fps), track.v);
  });
  const decoded = { clip: new THREE.AnimationClip(packed.name, packed.duration, tracks), speed: packed.speed, phase: packed.phase };
  cache.set(packed, decoded);
  return decoded;
}

// The clip of an emote GLB that moves the avatar: some also animate props or
// particles in a clip of their own, which may come first
export function avatarClip(animations) {
  let best = null;
  let bestCount = 0;
  for (const clip of animations ?? []) {
    const count = clip.tracks.filter((track) => track.name.startsWith('Avatar_')).length;
    if (count > bestCount) {
      best = clip;
      bestCount = count;
    }
  }
  return best;
}
