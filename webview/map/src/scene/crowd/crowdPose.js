// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';

// The poses of the people on the map, computed in plain arrays: three.js's mixer and
// bone objects cost too much per person when there are many. Clips are sampled once
// per skeleton (30 frames a second); each frame a person's gait state (gait.js)
// blends them into the skinning matrices the crowd's shader reads.

const FPS = 30;

// clip → skeleton signature → sampled
const sampled = new WeakMap();

/**
 * A three.js clip on a skeleton (its bone names): per bone the rotation and position
 * at every frame, or null where the clip leaves the bone alone.
 */
export function sampleClip(clip, names) {
  let bySkeleton = sampled.get(clip);
  if (!bySkeleton) {
    bySkeleton = new Map();
    sampled.set(clip, bySkeleton);
  }
  const signature = names.join(',');
  if (bySkeleton.has(signature)) return bySkeleton.get(signature);
  const frames = Math.max(2, Math.round(clip.duration * FPS) + 1);
  const index = new Map(names.map((name, i) => [name, i]));
  const rotations = new Array(names.length).fill(null);
  const positions = new Array(names.length).fill(null);
  for (const track of clip.tracks) {
    const { nodeName, propertyName } = THREE.PropertyBinding.parseTrackName(track.name);
    const bone = index.get(nodeName);
    if (bone === undefined || (propertyName !== 'quaternion' && propertyName !== 'position')) continue;
    const size = propertyName === 'quaternion' ? 4 : 3;
    const values = new Float32Array(frames * size);
    const interpolant = track.createInterpolant();
    for (let f = 0; f < frames; f++) {
      const result = interpolant.evaluate((f / (frames - 1)) * clip.duration);
      values.set(result.subarray ? result.subarray(0, size) : result.slice(0, size), f * size);
    }
    (size === 4 ? rotations : positions)[bone] = values;
  }
  const result = { duration: clip.duration, frames, rotations, positions };
  bySkeleton.set(signature, result);
  return result;
}

// Scratch, reused by every person (poses are computed one after the other)
const world = new Float32Array(64 * 16);
const local = new Float32Array(16);
const rotation = new Float32Array(4);
const position = new Float32Array(3);
const sample = new Float32Array(4);

// out = a · b (column-major 4×4)
function multiply(out, outOffset, a, aOffset, b, bOffset) {
  for (let column = 0; column < 4; column++) {
    const b0 = b[bOffset + column * 4];
    const b1 = b[bOffset + column * 4 + 1];
    const b2 = b[bOffset + column * 4 + 2];
    const b3 = b[bOffset + column * 4 + 3];
    for (let row = 0; row < 4; row++) {
      out[outOffset + column * 4 + row] = a[aOffset + row] * b0 + a[aOffset + 4 + row] * b1 + a[aOffset + 8 + row] * b2 + a[aOffset + 12 + row] * b3;
    }
  }
}

function compose(out, p, q, s, sOffset) {
  const [x, y, z, w] = q;
  const x2 = x + x;
  const y2 = y + y;
  const z2 = z + z;
  const xx = x * x2;
  const xy = x * y2;
  const xz = x * z2;
  const yy = y * y2;
  const yz = y * z2;
  const zz = z * z2;
  const wx = w * x2;
  const wy = w * y2;
  const wz = w * z2;
  const sx = s[sOffset];
  const sy = s[sOffset + 1];
  const sz = s[sOffset + 2];
  out[0] = (1 - (yy + zz)) * sx;
  out[1] = (xy + wz) * sx;
  out[2] = (xz - wy) * sx;
  out[3] = 0;
  out[4] = (xy - wz) * sy;
  out[5] = (1 - (xx + zz)) * sy;
  out[6] = (yz + wx) * sy;
  out[7] = 0;
  out[8] = (xz + wy) * sz;
  out[9] = (yz - wx) * sz;
  out[10] = (1 - (xx + yy)) * sz;
  out[11] = 0;
  out[12] = p[0];
  out[13] = p[1];
  out[14] = p[2];
  out[15] = 1;
}

// One clip's value for a bone at a time (linear between its frames)
function read(values, size, frames, duration, time, out) {
  const at = THREE.MathUtils.clamp(duration > 0 ? time / duration : 0, 0, 1) * (frames - 1);
  const i0 = Math.floor(at);
  const i1 = Math.min(i0 + 1, frames - 1);
  const f = at - i0;
  let flip = 1;
  if (size === 4) {
    const dot = values[i0 * 4] * values[i1 * 4] + values[i0 * 4 + 1] * values[i1 * 4 + 1] + values[i0 * 4 + 2] * values[i1 * 4 + 2] + values[i0 * 4 + 3] * values[i1 * 4 + 3];
    if (dot < 0) flip = -1;
  }
  for (let k = 0; k < size; k++) out[k] = values[i0 * size + k] * (1 - f) + values[i1 * size + k] * f * flip;
}

/**
 * The skinning matrices of one person into `out` (16 floats per bone from `offset`),
 * and their bones' world matrices (in the model's space) into `bones` when given.
 * layers: [{ sampled (sampleClip), weight, time }], weights summing to one at most;
 * what they leave over shows the rest pose, as three.js's mixer does.
 */
export function poseInto(out, offset, rig, layers, bones = null) {
  const { count, order, parents, restPosition, restRotation, restScale, inverseBind, armature } = rig;
  for (let n = 0; n < count; n++) {
    const i = order[n];
    // Rotation: the clips' weighted, on one side of the sphere, normalised
    rotation[0] = rotation[1] = rotation[2] = rotation[3] = 0;
    position[0] = position[1] = position[2] = 0;
    let rotationWeight = 0;
    let positionWeight = 0;
    for (const layer of layers) {
      if (!(layer.weight > 0)) continue;
      const { sampled: clip } = layer;
      const r = clip.rotations[i];
      if (r) {
        read(r, 4, clip.frames, clip.duration, layer.time, sample);
        const sign = rotation[0] * sample[0] + rotation[1] * sample[1] + rotation[2] * sample[2] + rotation[3] * sample[3] < 0 ? -1 : 1;
        for (let k = 0; k < 4; k++) rotation[k] += sample[k] * layer.weight * sign;
        rotationWeight += layer.weight;
      }
      const p = clip.positions[i];
      if (p) {
        read(p, 3, clip.frames, clip.duration, layer.time, sample);
        for (let k = 0; k < 3; k++) position[k] += sample[k] * layer.weight;
        positionWeight += layer.weight;
      }
    }
    if (rotationWeight < 1) {
      const rest = 1 - rotationWeight;
      const sign = rotation[0] * restRotation[i * 4] + rotation[1] * restRotation[i * 4 + 1] + rotation[2] * restRotation[i * 4 + 2] + rotation[3] * restRotation[i * 4 + 3] < 0 ? -1 : 1;
      for (let k = 0; k < 4; k++) rotation[k] += restRotation[i * 4 + k] * rest * sign;
    }
    const length = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3]) || 1;
    for (let k = 0; k < 4; k++) rotation[k] /= length;
    if (positionWeight < 1) for (let k = 0; k < 3; k++) position[k] += restPosition[i * 3 + k] * (1 - positionWeight);

    compose(local, position, rotation, restScale, i * 3);
    if (parents[i] >= 0) multiply(world, i * 16, world, parents[i] * 16, local, 0);
    else multiply(world, i * 16, armature, 0, local, 0);
    multiply(out, offset + i * 16, world, i * 16, inverseBind, i * 16);
  }
  if (bones) bones.set(world.subarray(0, count * 16));
}
