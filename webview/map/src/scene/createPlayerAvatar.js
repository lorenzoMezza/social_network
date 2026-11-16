// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
// The same avatar builder as the profiles (one look everywhere)
import { composeAvatar, disposeAvatar, keepOnDevice, loadGltf, setTextureLimit } from '../../../avatar/src/composeAvatar.js';
import { avatarClip } from '../../../avatar/src/clips.js';
import { PLAYER_AVATAR_SCALE } from './playerConfig.js';
import { addSceneUniforms, sceneGrade } from './horizontalFog.js';
import { createLocomotion } from './avatarLocomotion.js';
import { avatarCapsules, PLAYER_STENCIL_MASK } from './capsuleShadows.js';

const PALETTE = {
  skin: 0xd89b72,
  hair: 0x302d39,
  jacket: 0x6658e8,
  trousers: 0x253f69,
  shoes: 0xf5f3ed,
};
function writePlayerStencil(material) {
  material.stencilWrite = true;
  material.stencilFunc = THREE.AlwaysStencilFunc;
  material.stencilRef = PLAYER_STENCIL_MASK;
  material.stencilFuncMask = PLAYER_STENCIL_MASK;
  material.stencilWriteMask = PLAYER_STENCIL_MASK;
  material.stencilFail = THREE.KeepStencilOp;
  material.stencilZFail = THREE.KeepStencilOp;
  material.stencilZPass = THREE.ReplaceStencilOp;
}

// The avatar is the focus of the map: it takes only part of the time-of-day tint
// (see horizontalFog.js), so it stays readable at night
const PLAYER_TINT_AMOUNT = 0.7;

// With the sun behind an avatar its side towards the camera is in shade and reads
// almost black. A soft fill from the camera, in the colour of the sun (or moon: it
// dims with it at night), lifts only what the sun does not reach, a share of the
// direct light: like a photographer's reflector. Avatars only (SCENE_AVATAR_FILL).
const PLAYER_SHADE_FILL = 0.55;
// The avatar's own light (updateAvatarLighting): a soft white light from the camera
// on the side the user sees, its strength independent of the sun, so the avatar
// never fades into a dark map at night. Coloured by the avatar's own colours only:
// a light tinted by the sky, or a rim of light round the silhouette, washed the
// colours out and made the avatar glow, worst at night.
const AVATAR_KEY = { day: 0.12, night: 0.22 };
// The avatars a little brighter than the scene's light alone would make them: the sky's
// light (ambient) a touch, the sun's (or moon's) direct light a little more, so they
// look out in the sun. Kept light: their colours must not wash out
const AVATAR_AMBIENT_BOOST = 1.1;
const AVATAR_SUN_BOOST = 1.18;
THREE.ShaderChunk.lights_pars_begin = /* glsl */ `${THREE.ShaderChunk.lights_pars_begin}
#ifdef SCENE_AVATAR_FILL
uniform vec3 sceneAvatarKey;
#endif
`;
THREE.ShaderChunk.lights_fragment_end = /* glsl */ `${THREE.ShaderChunk.lights_fragment_end}
#ifdef SCENE_AVATAR_FILL
{
  float facing = saturate( dot( normalize( normal ), geometryViewDir ) );
  reflectedLight.indirectDiffuse += sceneAvatarKey * ( 0.4 + 0.6 * facing ) * BRDF_Lambert( material.diffuseColor );
}
#endif
#ifdef SCENE_AVATAR_FILL
reflectedLight.indirectDiffuse *= ${AVATAR_AMBIENT_BOOST.toFixed(2)};
reflectedLight.directDiffuse *= ${AVATAR_SUN_BOOST.toFixed(2)};
#endif
#if defined( SCENE_AVATAR_FILL ) && NUM_DIR_LIGHTS > 0
{
  vec3 fillNormal = normalize( normal );
  float towardsCamera = saturate( dot( fillNormal, geometryViewDir ) );
  float inShade = 1.0 - saturate( dot( fillNormal, directionalLights[ 0 ].direction ) );
  reflectedLight.indirectDiffuse += directionalLights[ 0 ].color * ( float( SCENE_AVATAR_FILL ) * inShade * ( 0.35 + 0.65 * towardsCamera ) ) * BRDF_Lambert( material.diffuseColor );
}
#endif
`;

// Each frame, from the environment (scene/environment/): the avatars' own light.
// It is added before the time-of-day tint, which the avatar takes in part
// (SCENE_TINT_AMOUNT): divided by it here, so it reaches the screen white.
export function updateAvatarLighting(env) {
  const daylight = THREE.MathUtils.smoothstep(env.sunAltitude, -8, 10);
  const key = sceneGrade.avatarKey.setScalar(THREE.MathUtils.lerp(AVATAR_KEY.night, AVATAR_KEY.day, daylight));
  key.r /= Math.max(0.05, 1 + (sceneGrade.tint.r - 1) * PLAYER_TINT_AMOUNT);
  key.g /= Math.max(0.05, 1 + (sceneGrade.tint.g - 1) * PLAYER_TINT_AMOUNT);
  key.b /= Math.max(0.05, 1 + (sceneGrade.tint.b - 1) * PLAYER_TINT_AMOUNT);
}

function configurePlayerMaterials(object) {
  if (!object.isMesh) return;
  const materials = Array.isArray(object.material) ? object.material : [object.material];
  materials.forEach(prepareAvatarMaterial);
}

// The scene's look for an avatar's material, the player's and the people's (crowd)
export function prepareAvatarMaterial(material) {
  writePlayerStencil(material);
  // Cloud shadows yes, but no puddles or snow on the avatar; its shade lifted
  material.defines = { ...material.defines, SCENE_TINT_AMOUNT: PLAYER_TINT_AMOUNT, SCENE_AVATAR_FILL: PLAYER_SHADE_FILL, SCENE_NO_GROUND_WEATHER: '' };
  // A material with its own shader hook (the avatar's eyes) replaces the scene's
  // global one: it needs the scene's uniforms too, or its cloud-shadow sampler is
  // left unbound and WebGL reports a sampler conflict at every draw
  if (Object.hasOwn(material, 'onBeforeCompile')) {
    const own = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      addSceneUniforms(shader);
      own.call(material, shader, renderer);
    };
  }
}

function material(color) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0 });
}

function addCapsule(parent, radius, length, color, position, segments = 7) {
  const mesh = new THREE.Mesh(new THREE.CapsuleGeometry(radius, length, 3, segments), material(color));
  mesh.position.set(...position);
  parent.add(mesh);
  return mesh;
}

// A capsule of the stand-in along its local Y, for its shadow
const along = (mesh, half, radius) => ({
  a: { at: mesh, local: new THREE.Vector3(0, -half, 0) },
  b: { at: mesh, local: new THREE.Vector3(0, half, 0) },
  radius,
});
const ball = (mesh, radius) => ({ a: { at: mesh }, b: { at: mesh }, radius });

// On the map the avatar stands a hundred-odd pixels tall: its textures need no more
setTextureLimit(512);

// Emote clips by URL, shared by every avatar on the map (a wave is loaded once)
const emoteClips = new Map();
export const emoteClip = (url) => {
  if (!emoteClips.has(url)) {
    emoteClips.set(url, loadGltf(url).then((gltf) => avatarClip(gltf.animations)).catch((error) => {
      emoteClips.delete(url);
      throw error;
    }));
  }
  return emoteClips.get(url);
};

// The player on the map: a simple stand-in figure (capsules) until the app sends the
// user's own avatar (setLook), the same one as on their profile. shadows:
// capsuleShadows.js. The people nearby are made the same way (nearbyPeople.js), their
// stand-in in their own colour (`jacket`).
export function createPlayerAvatar(scene, shadows, { name = 'player-avatar', jacket, waitForLook = false } = {}) {
  const AVATAR_PALETTE = { ...PALETTE, ...(jacket != null ? { jacket } : {}) };
  const root = new THREE.Group();
  root.name = name;
  const motionRig = new THREE.Group();
  motionRig.name = 'avatar-motion-rig';
  motionRig.scale.setScalar(PLAYER_AVATAR_SCALE);
  root.add(motionRig);
  const fallback = new THREE.Group();
  motionRig.add(fallback);
  const fallbackCapsules = [];

  const torso = new THREE.Group();
  torso.position.y = 1.15;
  fallback.add(torso);
  fallbackCapsules.push(along(addCapsule(torso, 0.245, 0.48, AVATAR_PALETTE.jacket, [0, 0.13, 0]), 0.24, 0.245));

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.075, 0.085, 0.13, 8), material(AVATAR_PALETTE.skin));
  neck.position.y = 0.48;
  torso.add(neck);

  const head = new THREE.Group();
  head.position.set(0, 0.72, -0.015);
  torso.add(head);
  const face = new THREE.Mesh(new THREE.SphereGeometry(0.2, 12, 9), material(AVATAR_PALETTE.skin));
  face.scale.set(0.91, 1.08, 0.88);
  head.add(face);
  fallbackCapsules.push(ball(face, 0.21));

  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.205, 12, 7, 0, Math.PI * 2, 0, Math.PI * 0.58), material(AVATAR_PALETTE.hair));
  hair.position.y = 0.045;
  head.add(hair);

  const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0x273140 });
  for (const side of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.018, 6, 5), eyeMaterial);
    eye.position.set(side * 0.067, -0.005, -0.17);
    head.add(eye);
  }

  const armPivots = [];
  for (const side of [-1, 1]) {
    const armPivot = new THREE.Group();
    armPivot.position.set(side * 0.29, 0.35, 0);
    torso.add(armPivot);
    const arm = addCapsule(armPivot, 0.085, 0.32, AVATAR_PALETTE.jacket, [0, -0.2, 0]);
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.073, 7, 6), material(AVATAR_PALETTE.skin));
    hand.position.y = -0.43;
    armPivot.add(hand);
    fallbackCapsules.push(along(arm, 0.16, 0.085), ball(hand, 0.073));
    armPivots.push(armPivot);
  }

  const legPivots = [];
  for (const side of [-1, 1]) {
    const legPivot = new THREE.Group();
    legPivot.position.set(side * 0.12, 0.53, 0);
    fallback.add(legPivot);
    const leg = addCapsule(legPivot, 0.105, 0.36, AVATAR_PALETTE.trousers, [0, -0.23, 0]);
    const shoe = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.105, 0.27), material(AVATAR_PALETTE.shoes));
    shoe.position.set(0, -0.48, -0.045);
    legPivot.add(shoe);
    fallbackCapsules.push(along(leg, 0.18, 0.105), {
      a: { at: shoe, local: new THREE.Vector3(0, 0, -0.09) },
      b: { at: shoe, local: new THREE.Vector3(0, 0, 0.09) },
      radius: 0.055,
    });
    legPivots.push(legPivot);
  }

  // The fallback avatar is visible before the GLB modules finish loading.
  fallback.traverse((object) => {
    if (object.isMesh) configurePlayerMaterials(object);
  });
  // Its shadow: capsules of the stand-in, then of the user's avatar (scale: world
  // units per avatar metre)
  // waitForLook: nobody at all until the real avatar comes (revealStandIn: it did not, in time)
  fallback.visible = !waitForLook;
  const shadow = shadows.add({ root, capsules: waitForLook ? [] : fallbackCapsules, scale: () => PLAYER_AVATAR_SCALE });

  scene.add(root);
  let moving = false;
  // The user's own avatar (setLook): { avatar (composeAvatar), model, locomotion }.
  // On the map it has no outline and no greeting: it stands, walks, jogs and runs.
  let user = null;
  let request = 0;
  let previousTime = null;

  // Shows the user's avatar instead of the stand-in: built like the profile's
  // (webview/avatar composeAvatar) from the render plan the app sends
  // (avatarFormat.resolveAvatar). Answers false when it could not be shown (its files
  // did not load), true when shown or replaced by a newer look meanwhile
  const setLook = async (plan) => {
    const id = ++request;
    try {
      const next = await composeAvatar(plan);
      if (id !== request) {
        disposeAvatar(next);
        return true;
      }
      // The user's own: its files stay on the device (avatar/src/fileCache.js)
      keepOnDevice(next);
      const model = new THREE.Group();
      model.name = 'user-avatar';
      model.add(next.root);
      // Decentraland avatars face +Z; on the map forward is -Z. Same height as the stand-in.
      model.rotation.y = Math.PI;
      model.scale.setScalar(1.8 / (next.height || 1.8));
      next.root.traverse((object) => {
        if (object.isMesh) configurePlayerMaterials(object);
      });
      motionRig.add(model);
      shadow.setCapsules(avatarCapsules(next.bones), () => PLAYER_AVATAR_SCALE * model.scale.x);
      if (user) {
        motionRig.remove(user.model);
        user.locomotion.dispose();
        disposeAvatar(user.avatar);
      }
      fallback.visible = false;
      motionRig.position.set(0, 0, 0);
      motionRig.rotation.set(0, 0, 0);
      user = { avatar: next, model, locomotion: createLocomotion(next.body) };
      return true;
    } catch (error) {
      console.warn('The avatar could not be shown on the map:', error?.message ?? error);
      return id !== request;
    }
  };

  const dispose = () => {
    request++;
    shadow.remove();
    scene.remove(root);
    if (user) {
      user.locomotion.dispose();
      disposeAvatar(user.avatar);
      user = null;
    }
    fallback.traverse((object) => {
      if (!object.isMesh) return;
      object.geometry.dispose();
      object.material.dispose();
    });
  };

  // An emote once (a wave…), over walking or standing; the stand-in hops instead.
  // Answers how long it plays (seconds, its fade out included); 0 when only a hop.
  let hop = 0;
  const playEmote = async (url) => {
    if (!user || !url) {
      hop = 1;
      return 0;
    }
    try {
      const clip = await emoteClip(url);
      if (!clip || !user) return 0;
      user.locomotion.play(clip);
      return clip.duration;
    } catch {
      hop = 1;
      return 0;
    }
  };

  return {
    root,
    setLook,
    playEmote,
    dispose,
    // Whether its own avatar replaced the stand-in
    hasLook: () => !!user,
    revealStandIn() {
      if (user) return;
      fallback.visible = true;
      shadow.setCapsules(fallbackCapsules, () => PLAYER_AVATAR_SCALE);
    },
    setMoving(value) {
      moving = value;
    },
    // A real step of the user: the stride lands a foot
    step() {
      user?.locomotion.step();
    },
    // speed: how fast the player goes (m/s); cadence: their steps per second, when the
    // phone's sensors know it (0: from the speed)
    update(timeSeconds, speed = 0, cadence = 0) {
      const deltaSeconds = previousTime === null ? 0 : THREE.MathUtils.clamp(timeSeconds - previousTime, 0, 0.1);
      previousTime = timeSeconds;
      if (user) {
        user.locomotion.update(deltaSeconds, moving ? speed : 0, moving ? cadence : 0);
        user.avatar.syncPose();
        return;
      }

      // A hop for a gesture the stand-in cannot play
      hop = Math.max(0, hop - deltaSeconds * 1.6);
      fallback.position.y = Math.sin(hop * Math.PI) * 0.35;
      const strideFrequency = 7 + Math.min(Math.max(speed, 0), 2) * 0.7;
      const stride = moving ? Math.sin(timeSeconds * strideFrequency) : 0;
      const idleBreath = Math.sin(timeSeconds * 1.7);
      motionRig.position.y = moving ? Math.abs(stride) * 0.08 : 0.045 + idleBreath * 0.035;
      motionRig.rotation.x = moving ? 0.09 : Math.sin(timeSeconds * 0.85) * 0.025;
      motionRig.rotation.z = moving
        ? Math.sin(timeSeconds * strideFrequency) * 0.035
        : Math.sin(timeSeconds * 0.65) * 0.025;
      legPivots[0].rotation.x = moving ? stride * 0.68 : 0;
      legPivots[1].rotation.x = moving ? -stride * 0.68 : 0;
      armPivots[0].rotation.x = moving ? -stride * 0.42 : 0;
      armPivots[1].rotation.x = moving ? stride * 0.42 : 0;
      torso.position.y = 1.15 + (moving ? Math.abs(stride) * 0.025 : 0);
      head.rotation.z = moving ? Math.sin(timeSeconds * 4.5) * 0.04 : Math.sin(timeSeconds * 0.8) * 0.025;
    },
  };
}
