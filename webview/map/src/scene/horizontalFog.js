// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { FOG_CURVE, FOG_HEIGHT, HORIZON_BAND, WORLD_CURVATURE } from '../config.js';
import { look } from '../looks/index.js';
import {
  groundWeatherAlbedoFragment,
  groundWeatherParsFragment,
  groundWeatherReflectionFragment,
  groundWeatherShadowFragment,
  groundWeatherUniforms,
} from './environment/groundWeatherShader.js';

// Centre of the fog and of the world's curvature: the player. Copy its position
// here every frame (fitFarPlane reads it too).
export const fogOrigin = new THREE.Vector3();

const vec3 = ([r, g, b]) => `vec3(${r.toFixed(3)}, ${g.toFixed(3)}, ${b.toFixed(3)})`;

// Saturation of the avatars (SCENE_AVATAR_FILL) against the map's daylight grade:
// a touch richer, so the people stand out of the map without looking pasted on it
const AVATAR_SATURATION = 1.05;
// Avatars darken a little towards their feet (units above the ground, the player
// avatar is about 10 tall): they stand on the map instead of floating over it
const AVATAR_GROUNDING = { height: 4.0, shade: 0.7 };

// Colour grade of every map colour (time of day and weather): the colour is
// multiplied by `tint`, then its saturation scaled. Set by the environment each frame.
// A material with the define SCENE_TINT_AMOUNT (0–1) takes only that share of the tint.
export const sceneGrade = {
  tint: new THREE.Color(1, 1, 1),
  saturation: { value: 1 },
  // 0 by day, 1 at night: the roads light up like under street lamps (groundShader.js)
  streetLights: { value: 0 },
  // What colours turn towards with distance (the sky's hue)
  farTint: new THREE.Color(1, 1, 1),
  // Fog colour, and on the side of the sun (or moon). In the screen's sRGB like
  // three.js's fogColor: the fog chunk runs after the colour space conversion (a
  // linear colour there came out far too dark, so the haze was darker on the side
  // of the sun or moon and the end of the world showed there)
  haze: new THREE.Color(1, 1, 1),
  hazeSun: new THREE.Color(1, 1, 1),
  // Slope (tangent of the angle below the horizontal) at which the curved ground
  // drops out of sight from the camera: 2 √(camera height × curvature), main.js
  horizonSlope: { value: 0.07 },
  // Curvature of the world (config.js), fixed
  curvature: { value: WORLD_CURVATURE },
  // The avatars' own light (createPlayerAvatar.js, SCENE_AVATAR_FILL): a soft light
  // from the camera, set each frame by updateAvatarLighting
  avatarKey: new THREE.Color(0, 0, 0),
};

// Shared vertex and fragment code of every material:
//  - World curvature (Pokémon GO style): every vertex drops with the square of its
//    horizontal distance from the player, so the map bends away below the horizon
//    and its far end is never seen as an edge. Picking and physics ignore it: it
//    is under a metre within 100 m.
//  - Replaces the three.js fog (THREE.Fog). Before the fog it applies the weather
//    of the surface (cloud shadows, wet ground, snow: see
//    environment/groundWeatherShader.js), grades the colour and turns far colours
//    towards the hue of the sky (aerial perspective).
//  - Horizontal distance only (X and Z) from fogOrigin, the player: the camera
//    position and height do not move the fog, which stays on the ground. It grows
//    smoothly from fogNear to fogFar and thins out above FOG_HEIGHT, so tall
//    things stay clearer than their base.
// The world position comes from the model matrix, so it also works for
// BatchedMesh and InstancedMesh. Import this module before any material is compiled.
// Materials with their own onBeforeCompile must call addSceneUniforms(shader).
// Per-material defines: SCENE_TINT_AMOUNT, and those of groundWeatherShader.js.

const sharedUniforms = {
  fogOrigin: { value: fogOrigin },
  sceneCurvature: sceneGrade.curvature,
  sceneTint: { value: sceneGrade.tint },
  sceneSaturation: sceneGrade.saturation,
  sceneStreetLights: sceneGrade.streetLights,
  sceneFarTint: { value: sceneGrade.farTint },
  sceneHaze: { value: sceneGrade.haze },
  sceneHazeSun: { value: sceneGrade.hazeSun },
  sceneHorizonSlope: sceneGrade.horizonSlope,
  // The same curvature for the fragment stage (a uniform shared by both stages
  // would need the same precision in both)
  sceneGroundCurvature: sceneGrade.curvature,
  // The player for the fragment stage (fogOrigin is declared for the vertex stage)
  scenePlayer: { value: fogOrigin },
  sceneAvatarKey: { value: sceneGrade.avatarKey },
  ...groundWeatherUniforms,
};

export function addSceneUniforms(shader) {
  Object.assign(shader.uniforms, sharedUniforms);
}

// Every material gets the shared uniforms (materials without fog ignore them)
const onBeforeCompile = THREE.Material.prototype.onBeforeCompile;
THREE.Material.prototype.onBeforeCompile = function (shader, renderer) {
  addSceneUniforms(shader);
  onBeforeCompile.call(this, shader, renderer);
};

// Declared for every built-in vertex shader (common is included by all of them).
// three.js defines "attribute" (as "in") in the vertex stage only.
THREE.ShaderChunk.common = `${THREE.ShaderChunk.common}
#ifdef attribute
  uniform vec3 fogOrigin;
  uniform float sceneCurvature;
#endif
`;

THREE.ShaderChunk.project_vertex = /* glsl */ `
vec4 mvPosition = vec4( transformed, 1.0 );
#ifdef USE_BATCHING
  mvPosition = batchingMatrix * mvPosition;
#endif
#ifdef USE_INSTANCING
  mvPosition = instanceMatrix * mvPosition;
#endif
vec4 sceneWorldPosition = modelMatrix * mvPosition;
#define SCENE_WORLD_POSITION
vec2 sceneFromPlayer = sceneWorldPosition.xz - fogOrigin.xz;
mvPosition = viewMatrix * vec4(
  sceneWorldPosition.x,
  sceneWorldPosition.y - dot(sceneFromPlayer, sceneFromPlayer) * sceneCurvature,
  sceneWorldPosition.z,
  1.0
);
gl_Position = projectionMatrix * mvPosition;
`;

THREE.ShaderChunk.fog_pars_vertex = /* glsl */ `
#ifdef USE_FOG
  varying vec3 vSceneWorld;
#endif
`;

THREE.ShaderChunk.fog_vertex = /* glsl */ `
#ifdef USE_FOG
  #ifdef SCENE_WORLD_POSITION
    vec3 fogWorld = sceneWorldPosition.xyz; // before the curvature
  #else
    // viewMatrix is rotation + translation: its transpose maps camera → vertex back to world space
    vec3 fogWorld = cameraPosition + transpose(mat3(viewMatrix)) * mvPosition.xyz;
  #endif
  vSceneWorld = fogWorld;
#endif
`;

THREE.ShaderChunk.fog_pars_fragment = /* glsl */ `
#ifdef USE_FOG
  uniform vec3 fogColor;
  uniform vec3 scenePlayer;
  uniform vec3 sceneTint;
  uniform float sceneSaturation;
  uniform vec3 sceneFarTint;
  uniform vec3 sceneHaze;
  uniform vec3 sceneHazeSun;
  uniform float sceneHorizonSlope;
  uniform float sceneGroundCurvature;
  varying vec3 vSceneWorld;
  ${groundWeatherParsFragment}
  #ifdef FOG_EXP2
    uniform float fogDensity;
  #else
    uniform float fogNear;
    uniform float fogFar;
  #endif
#endif
`;

THREE.ShaderChunk.fog_fragment = /* glsl */ `
#ifdef USE_FOG
  // Distance from the player, for each pixel: the position interpolates exactly
  // across a triangle, a distance does not (inside a long triangle it would come out
  // far too large, and the pixel shaded as far away)
  float sceneDistance = length(vSceneWorld.xz - scenePlayer.xz);
  ${groundWeatherAlbedoFragment}
  #ifndef SCENE_NO_GROUND_WEATHER
    // Painted look: the flat colours of the map drift a little over a few hundred
    // metres, a touch warmer here and cooler there, like broad brush strokes
    float scenePaint = textureLod(sceneWeatherMap, vSceneWorld.xz / 760.0 + 0.61, 1.0).g - 0.5;
    gl_FragColor.rgb *= 1.0 + scenePaint * ${vec3(look.paint.drift)};
    // One read for two patterns of a couple of hundred metres (looks/: paint):
    // neighbourhoods of different plaster, a second hue (paint.hue, from the cloud
    // mask channel), and washes, broad soft patches a little darker or lighter (paint.wash)
    vec2 scenePatches = textureLod(sceneWeatherMap, vSceneWorld.xz / 300.0 + vec2(0.17, 0.43), 0.0).rg - 0.5;
    gl_FragColor.rgb *= 1.0 + scenePatches.x * ${vec3(look.paint.hue)};
    gl_FragColor.rgb *= 1.0 + scenePatches.y * ${look.paint.wash.toFixed(3)};
  #endif
  #ifdef SCENE_TINT_AMOUNT
    vec3 graded = gl_FragColor.rgb * mix(vec3(1.0), sceneTint, float(SCENE_TINT_AMOUNT));
  #else
    vec3 graded = gl_FragColor.rgb * sceneTint;
  #endif
  float luma = dot(graded, vec3(0.2126, 0.7152, 0.0722));
  // Vibrance: muted colours gain some saturation, vivid ones keep theirs.
  // Stylised aerial perspective: with the distance from the player colours grow a
  // little richer and drift towards the hue of the sky; around the player they stay
  // true. Measured from the player, not the camera: zooming and turning never change them
  float sceneChroma = max(max(graded.r, graded.g), graded.b) - min(min(graded.r, graded.g), graded.b);
  float sceneVibrance = 0.22 * (1.0 - smoothstep(0.0, 0.35, sceneChroma));
  // From the camera to this point (the horizon band; reflections take its direction)
  vec3 sceneView = vSceneWorld - cameraPosition;
  float sceneDepth = smoothstep(30.0, 750.0, sceneDistance);
  #ifdef SCENE_AVATAR_FILL
    // The avatars keep vivid colours at any hour: only the map greys at night
    float sceneSaturationHere = max(sceneSaturation, 1.0) * ${AVATAR_SATURATION.toFixed(2)};
  #else
    float sceneSaturationHere = sceneSaturation;
  #endif
  gl_FragColor.rgb = max(mix(vec3(luma), graded, sceneSaturationHere * (1.0 + sceneVibrance + 0.3 * sceneDepth)), 0.0);
  #ifdef SCENE_AVATAR_FILL
    gl_FragColor.rgb *= mix(${AVATAR_GROUNDING.shade.toFixed(2)}, 1.0, smoothstep(0.0, ${AVATAR_GROUNDING.height.toFixed(1)}, vSceneWorld.y - scenePlayer.y));
  #endif
  gl_FragColor.rgb = mix(gl_FragColor.rgb, gl_FragColor.rgb * sceneFarTint, sceneDepth * ${look.aerial.depth.toFixed(3)});
  // Foreground: between the camera and the player the map is a little deeper and
  // richer, framing the scene like the near plane of a painting (looks/: aerial.foreground)
  float sceneFore = 1.0 - length(sceneView) / max(length(cameraPosition - scenePlayer), 1.0);
  sceneFore = smoothstep(0.0, 1.0, sceneFore);
  gl_FragColor.rgb *= 1.0 - sceneFore * ${look.aerial.foreground.toFixed(3)};
  ${groundWeatherReflectionFragment}
  #ifdef SCENE_LAMP
    // Street lamps (roads, groundShader.js): emitted light, above the night grade
    gl_FragColor.rgb = mix(gl_FragColor.rgb, sceneLampColor, sceneLampMix);
  #endif
  // Light of the sun (or moon) scattered in the air: on the side of the sun the far
  // map glows warm, golden at sunset. Seen from a fixed eye above the player, so it
  // stays put on the map when the camera turns or zooms
  if (sceneGlint.r + sceneGlint.g + sceneGlint.b > 0.0) {
    vec3 sceneFromEye = normalize(vSceneWorld - scenePlayer - vec3(0.0, 30.0, 0.0));
    float sceneTowardsLight = max(dot(sceneFromEye, sceneGlintDirection), 0.0);
    sceneTowardsLight *= sceneTowardsLight;
    gl_FragColor.rgb += sceneGlint * (sceneTowardsLight * sceneTowardsLight * 0.14 * sceneDepth);
  }

  #ifdef FOG_EXP2
    float fogFactor = 1.0 - exp(-fogDensity * fogDensity * sceneDistance * sceneDistance);
  #else
    // 0 at fogNear, growing slowly at first, then faster, exactly 1 at fogFar
    // (beyond it nothing is visible, see fitFarPlane)
    float fogT = clamp((sceneDistance - fogNear) / (fogFar - fogNear), 0.0, 1.0);
    float fogFactor = pow(fogT, ${FOG_CURVE.toFixed(2)});
  #endif
  // Air: a light haze from a few steps away, so even the near map has depth (looks/: aerial.air)
  fogFactor = max(fogFactor, ${look.aerial.air.toFixed(3)} * sqrt(clamp((sceneDistance - 40.0) / (fogFar - 40.0), 0.0, 1.0)));
  // Banks of mist drifting slowly over the far map: thicker here, thinner there, so
  // the distance reads as layers of air (looks/: aerial.mist); only where the fog is
  // partial, never thinner where it is complete
  float sceneMist = textureLod(sceneWeatherMap, vSceneWorld.xz / 640.0 + vec2(0.71, 0.29) + sceneSurface.w * vec2(0.0004, 0.00025), 1.0).g;
  fogFactor += ${look.aerial.mist.toFixed(3)} * (sceneMist - 0.5) * 4.0 * fogFactor * (1.0 - fogFactor);
  fogFactor *= exp(-max(vSceneWorld.y, 0.0) / ${FOG_HEIGHT.toFixed(1)});
  // Far away the ground is squeezed into a few rows of pixels: a narrow band of
  // haze measured on the view angle, just below where the curved ground drops out
  // of sight, keeps the horizon soft on screen (the sky's haze goes on above it)
  float bentHeight = vSceneWorld.y - sceneDistance * sceneDistance * sceneGroundCurvature;
  float viewSlope = (cameraPosition.y - bentHeight) / max(length(sceneView.xz), 1.0);
  float horizonBand = 1.0 - smoothstep(sceneHorizonSlope, sceneHorizonSlope + ${HORIZON_BAND.toFixed(4)}, viewSlope);
  fogFactor = max(fogFactor, horizonBand * horizonBand);
  // The haze is warmer (or of the look's colour) on the side of the sun
  vec2 sceneLook = normalize(sceneView.xz + vec2(1e-4, 0.0));
  vec2 sceneSun = normalize(sceneGlintDirection.xz + vec2(1e-4, 0.0));
  float sceneSunSide = dot(sceneLook, sceneSun) * 0.5 + 0.5;
  gl_FragColor.rgb = mix(gl_FragColor.rgb, mix(sceneHaze, sceneHazeSun, sceneSunSide * sceneSunSide), fogFactor);
  ${groundWeatherShadowFragment}
#endif
`;
