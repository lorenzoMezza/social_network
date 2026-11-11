// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { WORLD_CURVATURE } from '../config.js';
import { createBillboards } from './billboards.js';
import { PLAYER_STENCIL_MASK } from './capsuleShadows.js';
import { paintBubble, paintNameTag } from './peopleTags.js';
import { PLAYER_AVATAR_HEIGHT } from './playerConfig.js';

// The people around the user on the map, as the app sends them (window.setMapPeople):
//   [{ id, name, lat, lon, precision: 'precise'|'area', heading?, speed?, tone?, connected? }]
// `connected`: one of the user's connections (friends, made in person): a thin ring at
// their feet in their own colour (`tone`: their profile's), the app's accent around
// their name, and their name shown before strangers' in a crowd.
// All those the server sends (it decides who: 25 at most, connections first): each one
// wears their map avatar in the crowd
// (crowd/createCrowd.js: a few draw calls for everyone; the stand-in until the app
// sends their look, window.setPersonAvatar), with their name over their head, a 3D tag
// (billboards.js) the buildings can hide like anything else.
// Positions arrive every few seconds: between two, each person walks on along their
// last course, and eases into the next fix, so nobody jumps. Someone shown by area
// (their mode, mapPresence.js) stands still at the point the server chose: a moving
// avatar there would suggest a real position.
//
// The one tapped (setSelected) gets a ring at their feet and, standing, turns towards
// the player. Gestures (gesture) play an emote on the one who makes it, turned towards
// the other, with its emoji over their head; words (say) show in a speech bubble. The
// player ('me') takes part in both, and can be tapped too (pick).

const FOLLOW_RATE = 2;
const MAX_PREDICTION_SECONDS = 4;
// Faster than this between two fixes is not walking: they are placed at once
const MAX_SPEED = 15;
const SNAP_DISTANCE = 200;
// Names fade out with the distance from the camera (metres)
const TAG_FULL = 260;
const TAG_GONE = 480;
// and grow smaller with it, down to TAG_FAR_SCALE of their size
const TAG_SCALE_NEAR = 60;
const TAG_SCALE_FAR = 300;
const TAG_FAR_SCALE = 0.72;
// Names never overlap each other nor the badges of the events: nearest first (the
// selected one before all), a name with no room fades out. One already shown keeps
// its place over a slightly nearer newcomer, so names do not flicker as people move
const TAG_GAP = 4;
const TAG_KEEP = 0.85;
const TAG_FADE_RATE = 10;
// Beyond this from the view centre a person is not drawn (the fog hides it anyway)
const DRAW_RADIUS = 900;
const HEAD_CLEARANCE = 1.04;
// A figure is tapped only on the avatar itself: as wide as it is from the front (arms
// included, measured ~4.4 m) and up to the top of the hair (times the avatar height)
const HIT_HALF_WIDTH = 2.2;
const HIT_TOP = 1.15;
// How long words and gestures stay over a head (seconds)
const BUBBLE_SECONDS = 5;
const EVERYONE_BUBBLE_SECONDS = 8;
const GESTURE_SECONDS = 2.6;
// A gesture turns its author towards the other person at once, for at least this
// long (a hop, or while the clip loads), then until the clip ends
const FACE_SECONDS = 3.5;
// The app's one accent (src/theme/colors.js): the connections' rings and name tags
const FRIEND_COLOR = '#316CEE';
// A connection's name keeps its place in a crowd as if this much nearer
const FRIEND_PRIORITY = 0.6;
const MAX_FRIEND_RINGS = 64;

const ringVertex = /* glsl */ `
  varying vec2 vPosition;
  void main() {
    vPosition = position.xy;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const ringFragment = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  varying vec2 vPosition;
  void main() {
    float r = length(vPosition);
    // A steady ring, and a wave leaving it every 1.6 s
    float ring = smoothstep(0.62, 0.7, r) * (1.0 - smoothstep(0.78, 0.86, r));
    float wave = fract(uTime / 1.6);
    float pulse = (1.0 - smoothstep(0.0, 0.08, abs(r - (0.7 + wave * 0.3)))) * (1.0 - wave);
    float fill = (1.0 - smoothstep(0.0, 0.7, r)) * 0.18;
    float alpha = max(max(ring * 0.9, pulse * 0.7), fill);
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(uColor, alpha);
  }
`;

// The connections' rings: thin and steady (the selected one's pulses), one draw for all
const friendRingVertex = /* glsl */ `
  varying vec2 vPosition;
  varying vec3 vTone;
  void main() {
    vPosition = position.xy;
    vTone = vec3(1.0);
    #ifdef USE_INSTANCING_COLOR
      vTone = instanceColor;
    #endif
    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0);
  }
`;
const friendRingFragment = /* glsl */ `
  varying vec2 vPosition;
  varying vec3 vTone;
  void main() {
    float r = length(vPosition);
    float alpha = smoothstep(0.66, 0.72, r) * (1.0 - smoothstep(0.78, 0.84, r)) * 0.75
      + (1.0 - smoothstep(0.0, 0.72, r)) * 0.08;
    if (alpha < 0.01) discard;
    gl_FragColor = vec4(vTone, alpha);
  }
`;

export function createNearbyPeople({ scene, camera, map, crowd, groundHeight = 0, player, obstacles = () => [] }) {
  const people = new Map();
  const tags = createBillboards({ scene, slotWidth: 200, slotHeight: 40, columns: 4, rows: 4, renderOrder: 1100 });
  const bubbles = createBillboards({ scene, slotWidth: 250, slotHeight: 110, columns: 4, rows: 2, renderOrder: 1101 });
  // Who has a bubble ('me' or a person's id) → { slot, start, until }
  const spoken = new Map();
  let anchored = false;
  let selected = null;
  let clock = 0;
  const head = new THREE.Vector3();
  const feet = new THREE.Vector3();
  const side = new THREE.Vector3();
  const cameraRight = new THREE.Vector3();
  const viewport = { width: 1, height: 1 };

  // The selection ring, in the selected person's colour: a disc in its own x, y
  // (what the shader reads), laid flat on the ground by the mesh
  const ring = new THREE.Mesh(
    new THREE.CircleGeometry(1, 48),
    new THREE.ShaderMaterial({
      vertexShader: ringVertex,
      fragmentShader: ringFragment,
      uniforms: { uColor: { value: new THREE.Color('#5b6475') }, uTime: { value: 0 } },
      transparent: true,
      // Like the avatars' shadows (capsuleShadows.js): over the ground and what is
      // drawn on it (blocks, parks), never over an avatar (their stencil bit)
      depthTest: false,
      depthWrite: false,
      stencilWrite: true,
      stencilWriteMask: 0,
      stencilRef: 0,
      stencilFuncMask: PLAYER_STENCIL_MASK,
      stencilFunc: THREE.EqualStencilFunc,
    }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.name = 'person-selection';
  ring.renderOrder = 1000;
  ring.visible = false;
  ring.scale.setScalar(PLAYER_AVATAR_HEIGHT * 0.42);
  scene.add(ring);

  // The connections' rings: the same disc, drawn the same way, one instance each
  const friendRings = new THREE.InstancedMesh(
    ring.geometry,
    new THREE.ShaderMaterial({
      vertexShader: friendRingVertex,
      fragmentShader: friendRingFragment,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      stencilWrite: true,
      stencilWriteMask: 0,
      stencilRef: 0,
      stencilFuncMask: PLAYER_STENCIL_MASK,
      stencilFunc: THREE.EqualStencilFunc,
    }),
    MAX_FRIEND_RINGS,
  );
  friendRings.name = 'friend-rings';
  friendRings.renderOrder = 999;
  friendRings.frustumCulled = false;
  friendRings.count = 0;
  scene.add(friendRings);
  const friendMatrix = new THREE.Matrix4();
  const friendTurn = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
  const friendAt = new THREE.Vector3();
  const friendSize = new THREE.Vector3().setScalar(PLAYER_AVATAR_HEIGHT * 0.36);
  const friendTone = new THREE.Color();
  friendRings.setColorAt(0, friendTone.set(FRIEND_COLOR));

  const worldOf = (person) => {
    const world = map.latLonToWorld(person.lat, person.lon);
    return new THREE.Vector3(world.x, 0, world.z);
  };

  const drawTag = (entry) => {
    const { data } = entry;
    const look = data.id === selected ? 'selected' : data.precision === 'area' ? 'area' : 'plain';
    const friend = data.connected === true;
    const key = `${data.name}|${data.tone}|${look}|${friend}`;
    if (entry.tagKey === key) return;
    entry.tagKey = key;
    tags.draw(entry.tag, paintNameTag({ name: data.name, tone: data.tone, look, friend: friend ? FRIEND_COLOR : null }));
  };

  const create = (data) => {
    const avatar = crowd.add(`person-${data.id}`);
    avatar.root.visible = false;
    const entry = {
      data,
      avatar,
      tag: tags.acquire(),
      tagKey: null,
      target: new THREE.Vector3(),
      velocity: new THREE.Vector3(),
      fixAt: 0,
      placed: false,
      heading: 0,
      speed: 0,
      faceUntil: 0,
      // Whom their gesture is for (an avatar root), while it lasts
      faceTarget: null,
    };
    drawTag(entry);
    return entry;
  };

  // A new fix: the velocity between the last two predicts the next seconds
  const place = (entry, now) => {
    if (!anchored) return;
    const next = worldOf(entry.data);
    const area = entry.data.precision === 'area';
    if (!entry.placed || area) {
      entry.target.copy(next);
      entry.velocity.set(0, 0, 0);
      if (!entry.placed) entry.avatar.root.position.copy(next);
      entry.placed = true;
    } else {
      const seconds = Math.max((now - entry.fixAt) / 1000, 0.5);
      const distance = next.distanceTo(entry.target);
      if (distance > SNAP_DISTANCE || distance / seconds > MAX_SPEED) {
        entry.avatar.root.position.copy(next);
        entry.velocity.set(0, 0, 0);
      } else {
        entry.velocity.subVectors(next, entry.target).divideScalar(seconds);
      }
      entry.target.copy(next);
    }
    if (Number.isFinite(entry.data.heading)) entry.heading = -THREE.MathUtils.degToRad(entry.data.heading);
    entry.fixAt = now;
  };

  const silence = (who) => {
    const bubble = spoken.get(who);
    if (!bubble) return;
    bubbles.release(bubble.slot);
    spoken.delete(who);
  };

  const remove = (id) => {
    const entry = people.get(id);
    if (!entry) return;
    entry.avatar.dispose();
    tags.release(entry.tag);
    silence(id);
    people.delete(id);
    if (selected === id) {
      selected = null;
      ring.visible = false;
    }
  };

  const set = (list) => {
    const now = performance.now();
    const next = new Map((Array.isArray(list) ? list : [])
      .filter((person) => person && typeof person.id === 'string' && Number.isFinite(person.lat) && Number.isFinite(person.lon))
      .map((person) => [person.id, person]));
    for (const id of [...people.keys()]) if (!next.has(id)) remove(id);
    for (const [id, data] of next) {
      let entry = people.get(id);
      const moved = !entry || entry.data.lat !== data.lat || entry.data.lon !== data.lon;
      if (!entry) {
        entry = create(data);
        people.set(id, entry);
      } else {
        entry.data = data;
        drawTag(entry);
      }
      if (moved) place(entry, now);
    }
  };

  // The first GPS fix fixed the map's origin: places can be computed from now on
  const relayout = () => {
    anchored = true;
    const now = performance.now();
    for (const entry of people.values()) {
      entry.placed = false;
      place(entry, now);
    }
  };

  // Their map avatar's files: { model, astc, png }
  const setLook = (id, files) => {
    const entry = people.get(id);
    if (entry && files) entry.avatar.setLook(files);
  };

  const setSelected = (id) => {
    selected = id && people.has(id) ? id : null;
    for (const entry of people.values()) drawTag(entry);
    const entry = selected ? people.get(selected) : null;
    ring.visible = !!entry;
    if (entry) ring.material.uniforms.uColor.value.set(entry.data.tone ?? '#5b6475');
  };

  const rootOf = (who) => (who === 'me' ? player.root : people.get(who)?.avatar.root ?? null);
  const headingTowards = (from, to) => -Math.atan2(to.x - from.x, -(to.z - from.z));

  // Words over someone's head ('me' or a person), for a few seconds; said to everyone
  // around (everyone: true) they stay longer, in a bubble of their own
  const say = ({ from, text, seconds, everyone = false }) => {
    if (!text || !rootOf(from)) return;
    silence(from);
    const slot = bubbles.acquire();
    if (slot === null) return;
    seconds ??= everyone ? EVERYONE_BUBBLE_SECONDS : BUBBLE_SECONDS;
    bubbles.draw(slot, paintBubble(String(text), { everyone }));
    spoken.set(from, { slot, start: clock, until: clock + seconds });
  };

  // A gesture: `from` plays it (an emote URL; the stand-in hops), turned towards `to`,
  // its emoji over their head
  const gesture = ({ from, to, url, emoji }) => {
    const source = rootOf(from);
    if (!source) return;
    const target = to ? rootOf(to) : null;
    // Turned towards them at once, and until the gesture is over, however long its
    // clip: only then does the phone's heading (the compass) turn them back
    const heading = target ? headingTowards(source.position, target.position) : null;
    if (from === 'me') {
      const towards = () => headingTowards(source.position, target.position);
      if (target) player.face(towards, FACE_SECONDS);
      player.avatar.playEmote(url).then((seconds) => {
        if (target && seconds > 0) player.face(towards, seconds);
      });
    } else {
      const entry = people.get(from);
      if (target) {
        entry.heading = heading;
        entry.faceTarget = target;
        entry.faceUntil = clock + FACE_SECONDS;
      }
      entry.avatar.playEmote(url).then((seconds) => {
        if (target && seconds > 0 && people.get(from) === entry) entry.faceUntil = clock + seconds;
      });
    }
    if (emoji) say({ from, text: emoji, seconds: GESTURE_SECONDS });
  };

  const predicted = new THREE.Vector3();
  const previous = new THREE.Vector3();
  const lastCenter = new THREE.Vector3();
  // Skinned avatars are never culled by three (their bounds move with the bones): off
  // the screen they are hidden here, or each one costs its draw calls for nothing
  const frustum = new THREE.Frustum();
  const viewProjection = new THREE.Matrix4();
  const bounds = new THREE.Sphere();
  // Where a head is, in the curved world (horizontalFog.js)
  const headOf = (root, center, out) => {
    const fromCenter = Math.hypot(root.position.x - center.x, root.position.z - center.z);
    return out.set(root.position.x, -fromCenter * fromCenter * WORLD_CURVATURE + PLAYER_AVATAR_HEIGHT * HEAD_CLEARANCE, root.position.z);
  };
  // The name over a head (its height on screen), so a bubble goes above it
  const tagHeights = new Map();
  const candidates = [];
  const placed = [];
  const projectedHead = new THREE.Vector3();
  // The names of this frame (candidates): nearest first, each where it has room
  const placeTags = (deltaSeconds) => {
    const order = (c) => (c.id === selected
      ? -1
      : c.distance * ((c.entry.tagShown ?? 0) > 0.5 ? TAG_KEEP : 1) * (c.entry.data.connected === true ? FRIEND_PRIORITY : 1));
    candidates.sort((a, b) => order(a) - order(b));
    const circles = obstacles(viewport);
    placed.length = 0;
    for (const { id, entry, opacity, scale } of candidates) {
      const box = tags.sizeOf(entry.tag);
      projectedHead.copy(entry.head).project(camera);
      let room = false;
      if (box && projectedHead.z < 1) {
        const cx = ((projectedHead.x + 1) / 2) * viewport.width;
        const bottom = ((1 - projectedHead.y) / 2) * viewport.height;
        const rect = { left: cx - (box.width * scale) / 2, right: cx + (box.width * scale) / 2, top: bottom - box.height * scale, bottom };
        room = id === selected || (!placed.some((other) => rect.left < other.right + TAG_GAP && rect.right > other.left - TAG_GAP
          && rect.top < other.bottom + TAG_GAP && rect.bottom > other.top - TAG_GAP)
          && !circles.some(({ x, y, r }) => Math.hypot(x - THREE.MathUtils.clamp(x, rect.left, rect.right), y - THREE.MathUtils.clamp(y, rect.top, rect.bottom)) < r));
        if (room) placed.push(rect);
      }
      entry.tagShown = THREE.MathUtils.lerp(entry.tagShown ?? 0, room ? 1 : 0, Math.min(1, deltaSeconds * TAG_FADE_RATE));
      const shown = opacity * entry.tagShown;
      if (shown <= 0.01) continue;
      tags.push(entry.tag, entry.head, { opacity: shown, scale }, camera, viewport);
      tagHeights.set(id, (box?.height ?? 0) * scale);
    }
    candidates.length = 0;
  };

  const update = (deltaSeconds, timeSeconds, center, size) => {
    clock = timeSeconds;
    lastCenter.copy(center);
    viewport.width = size.width;
    viewport.height = size.height;
    camera.updateMatrixWorld();
    viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    frustum.setFromProjectionMatrix(viewProjection);
    const now = performance.now();
    tags.begin(size.width, size.height);
    tagHeights.clear();
    let ringShown = false;
    friendRings.count = 0;

    for (const [id, entry] of people) {
      const root = entry.avatar.root;
      if (!entry.placed) {
        root.visible = false;
        continue;
      }
      const age = Math.min((now - entry.fixAt) / 1000, MAX_PREDICTION_SECONDS);
      predicted.copy(entry.target).addScaledVector(entry.velocity, age);
      previous.copy(root.position);
      root.position.lerp(predicted, 1 - Math.exp(-deltaSeconds * FOLLOW_RATE));
      const step = previous.distanceTo(root.position);
      entry.speed += (step / Math.max(deltaSeconds, 0.001) - entry.speed) * Math.min(1, deltaSeconds * 4);
      const standing = entry.speed < 0.3;
      // Facing where they go; turned to whom their gesture is for (the player…) until
      // it ends, wherever either of them walks and whatever course the server sends;
      // the selected one, standing, looks at the player
      if (clock < entry.faceUntil) {
        if (entry.faceTarget) entry.heading = headingTowards(root.position, entry.faceTarget.position);
      } else {
        entry.faceTarget = null;
        if (id === selected && standing) entry.heading = headingTowards(root.position, player.root.position);
        // Where their phone says they face (set on each fix); only without it, the way
        // the avatar moves. The movement is not where they look: easing back after a
        // prediction that ran ahead, or GPS drift, would turn them round
        else if (step > 0.01 && !Number.isFinite(entry.data.heading)) entry.heading = -Math.atan2(root.position.x - previous.x, -(root.position.z - previous.z));
      }
      const turn = THREE.MathUtils.euclideanModulo(entry.heading - root.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
      root.rotation.y += turn * Math.min(1, deltaSeconds * 5);

      const fromCenter = Math.hypot(root.position.x - center.x, root.position.z - center.z);
      const lowered = -fromCenter * fromCenter * WORLD_CURVATURE;
      // The figure and its shadow (which reaches a few heights away at a low sun)
      bounds.center.set(root.position.x, lowered + PLAYER_AVATAR_HEIGHT / 2, root.position.z);
      bounds.radius = PLAYER_AVATAR_HEIGHT * 2;
      root.visible = fromCenter < DRAW_RADIUS && frustum.intersectsSphere(bounds);
      if (!root.visible) {
        entry.avatar.hide();
        continue;
      }
      entry.avatar.setMoving(!standing);
      entry.avatar.update(timeSeconds, entry.speed);

      entry.head ??= new THREE.Vector3();
      headOf(root, center, entry.head);
      const distance = camera.position.distanceTo(entry.head);
      const opacity = id === selected ? 1 : 1 - THREE.MathUtils.smoothstep(distance, TAG_FULL, TAG_GONE);
      if (opacity > 0.01) {
        const scale = id === selected ? 1 : THREE.MathUtils.lerp(1, TAG_FAR_SCALE, THREE.MathUtils.smoothstep(distance, TAG_SCALE_NEAR, TAG_SCALE_FAR));
        candidates.push({ id, entry, distance, opacity, scale });
      } else entry.tagShown = 0;

      if (id === selected) {
        ring.position.set(root.position.x, lowered + groundHeight + 0.3, root.position.z);
        ringShown = true;
      } else if (entry.data.connected === true && friendRings.count < MAX_FRIEND_RINGS) {
        friendMatrix.compose(friendAt.set(root.position.x, lowered + groundHeight + 0.28, root.position.z), friendTurn, friendSize);
        friendRings.setMatrixAt(friendRings.count, friendMatrix);
        friendRings.setColorAt(friendRings.count++, friendTone.set(entry.data.tone ?? FRIEND_COLOR));
      }
    }
    placeTags(deltaSeconds);
    tags.end();
    // Everyone's pose to the GPU at once
    crowd.upload();
    ring.visible = ringShown;
    ring.material.uniforms.uTime.value = timeSeconds;
    friendRings.instanceMatrix.needsUpdate = friendRings.count > 0;
    friendRings.instanceColor.needsUpdate = friendRings.count > 0;

    // Bubbles: they pop in, then fade out
    bubbles.begin(size.width, size.height);
    for (const [who, bubble] of spoken) {
      if (clock > bubble.until) {
        silence(who);
        continue;
      }
      const root = rootOf(who);
      if (!root || (who !== 'me' && !root.visible)) continue;
      headOf(root, center, head);
      const shown = clock - bubble.start;
      const pop = shown < 0.22 ? THREE.MathUtils.lerp(0.6, 1.06, shown / 0.22) : shown < 0.32 ? THREE.MathUtils.lerp(1.06, 1, (shown - 0.22) / 0.1) : 1;
      const fade = 1 - THREE.MathUtils.smoothstep(clock, bubble.until - 0.4, bubble.until);
      // Over the name (the player has none: right over the head)
      const y = Math.max((tagHeights.get(who) ?? 0) - 8, 0);
      bubbles.push(bubble.slot, head, { y, scale: pop, opacity: fade }, camera, viewport);
    }
    bubbles.end();
  };

  // A tap: a name first (what the finger aims at), then a figure; 'me' for the player
  const pick = (clientX, clientY, area) => {
    const tagSlot = tags.hit(clientX - area.left, clientY - area.top);
    if (tagSlot !== null) {
      for (const [id, entry] of people) if (entry.tag === tagSlot) return id;
    }
    let best = null;
    let bestDepth = Infinity;
    const figures = [...people].map(([id, entry]) => [id, entry.avatar.root]);
    figures.push(['me', player.root]);
    cameraRight.setFromMatrixColumn(camera.matrixWorld, 0);
    for (const [id, root] of figures) {
      if (!root.visible) continue;
      const fromCamera = camera.position.distanceTo(root.position);
      const fromCenter = Math.hypot(root.position.x - lastCenter.x, root.position.z - lastCenter.z);
      const lowered = -fromCenter * fromCenter * WORLD_CURVATURE;
      feet.set(root.position.x, lowered, root.position.z);
      side.copy(feet).addScaledVector(cameraRight, HIT_HALF_WIDTH).project(camera);
      feet.project(camera);
      head.set(root.position.x, lowered + PLAYER_AVATAR_HEIGHT * HIT_TOP, root.position.z).project(camera);
      if (feet.z > 1 || head.z > 1) continue;
      const footY = area.top + ((1 - feet.y) / 2) * area.height;
      const headY = area.top + ((1 - head.y) / 2) * area.height;
      const x = area.left + ((feet.x + 1) / 2) * area.width;
      const halfWidth = Math.abs(side.x - feet.x) / 2 * area.width;
      const inside = Math.abs(clientX - x) < halfWidth && clientY > headY && clientY < footY;
      // The figure nearest the finger wins, then the nearest to the camera
      const score = Math.abs(clientX - x) + fromCamera * 0.01;
      if (inside && score < bestDepth) {
        bestDepth = score;
        best = id;
      }
    }
    return best;
  };

  const positionOf = (id) => people.get(id)?.avatar.root.position.clone() ?? null;

  const dispose = () => {
    for (const id of [...people.keys()]) remove(id);
    silence('me');
    tags.dispose();
    bubbles.dispose();
    scene.remove(ring);
    ring.geometry.dispose();
    ring.material.dispose();
    scene.remove(friendRings);
    friendRings.material.dispose();
  };

  // For the developer tools and the benchmark: the people received, placed on the map,
  // and drawn this frame (in view)
  const stats = () => {
    let placed = 0;
    let drawn = 0;
    for (const entry of people.values()) {
      if (entry.placed) placed++;
      if (entry.avatar.root.visible) drawn++;
    }
    return { people: people.size, placed, drawn };
  };

  return { set, setLook, setSelected, relayout, update, pick, positionOf, gesture, say, stats, dispose };
}
