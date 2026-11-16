// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { GLASS_STENCIL_BIT } from 'lm-three-geo-play';
import { look } from '../looks/index.js';
import { WORLD_CURVATURE } from '../config.js';

// Events on the map, as beacons (like the PokéStops of Pokémon GO, but light): a beam
// of light rising from the place, taller and thicker the more people are going (up to
// a limit), flaring where it leaves the ground over a pool of light, a ring on the
// ground, and a floating badge with the event's category. Waves spread from every ring,
// each at its own moment; events happening now pulse more: stronger, faster waves, and
// the beam breathes. Its organizer chooses how the beam looks (BEAM_STYLES, all in one
// shader, one draw). Everything is billboards and
// flat quads, instanced: all the beams are one draw (two with the glass, below), all
// the rings too, and all the badges one more, from one texture atlas. However many
// events there are, they cost five draw calls of almost nothing.
//
// The world is curved around the view centre (horizontalFog.js): these materials do
// not run the shared vertex chunk, so each beacon is lowered by the same amount on
// the CPU, once per frame, and faded with the same distance as the fog.
//
// Data (from the app, MapScreen): [{ id, latitude, longitude, color, beamStyle, emoji,
// crowd, live, sponsored, mine, following }]. `crowd`: how many people are going; `color`,
// `beamStyle`: the beam its organizer chose (Event.theme.beam, beamStyle), or null.
//
// The emoji says what kind of event it is. The beam, its light and the badge's rim are the
// organizer's colour, else they say what is different about the event (STATE_COLORS), and
// the moving waves that it is on now. Gold is paid for: nothing else is gold (the app never
// sends it as a colour), and a paid event is gold whatever else.

const BEAM_WIDTH = 3.4;
const BEAM_MIN_HEIGHT = 30;
const BEAM_HEIGHT_PER_DOUBLING = 16;
const BEAM_MAX_HEIGHT = 140;
// Thicker with more people: ×1 alone, about ×1.5 with 3, ×2 with 15, never over ×2.2
const BEAM_THICKNESS_PER_DOUBLING = 0.25;
const BEAM_MAX_THICKNESS = 2.2;
// The quad is this many beam widths wide, room for the flare at the base
const BEAM_QUAD = 2.6;
// How a beam can look (Event.theme.beamStyle), its number in the shader
const BEAM_STYLES = { beam: 0, pulse: 1, helix: 2, stardust: 3, veil: 4 };
// Rows of rising specks of dust along a beam (most hold one)
const SPARK_ROWS = 30;
// A new beacon rises out of the ground (seconds), then its badge pops in
const GROW_SECONDS = 0.8;
const POP_DELAY = 0.35;
const POP_SECONDS = 0.45;
const RING_SIZE = 16; // metres across
// The light it casts on the ground, metres across: part of the ring's disc and shader, so
// it costs no draw call. On the ground only: it does not light up the walls around. Its
// size is what it costs (every pixel of the disc is blended): wider costs far more
const LIGHT_SIZE = 44;
// Round, not a square: no corners blended for nothing
const LIGHT_SIDES = 24;
// The beam's foot above the ground (metres): over the flat layers (roads, parks…)
const BEAM_LIFT = 0.3;
const BADGE_HEIGHT = 15; // above the ground: over the head of the avatar (~10.7 m)
const BADGE_SIZE = 5.5;
// Past BADGE_NEAR metres from the camera badges grow less than the distance: they get
// smaller on screen the farther the event (at 300 m about half the size), like the
// names of the people
const BADGE_NEAR = 45;
const BADGE_GROWTH = 0.65;
// They show as far as the map does: they fade out over the last FADE_LENGTH metres
// before the fog is complete (update's fogFar), whatever its distance
const FADE_LENGTH = 70;
// A badge this close to the camera (metres) is gone, and whole from NEAR_FULL: an event
// under the camera, between it and the player, never covers the screen
const NEAR_HIDDEN = 14;
const NEAR_FULL = 30;
const PICK_RADIUS_PX = 26;
// Beacons drawn at most (the nearest ones)
const MAX_BEACONS = 256;
// Badge atlas: cells of BADGE_CELL px, ATLAS_CELLS per side
const BADGE_CELL = 128;
const ATLAS_CELLS = 8;
// Beacons are objects of the scene like any other: on the ground, at their true depth,
// and seen through the glass of the buildings. The buildings (three-geo-play's depth
// prepass, drawHooks.js) leave in the depth buffer their surface nearest to the
// camera and set stencil bit GLASS_STENCIL_BIT exactly where that glass was blended.
// Drawn after them, each part of a beacon is drawn twice:
//  - in front of everything: as is
//  - behind something, only where that something is glass: dimmed by the glass
//    (GLASS_TRANSMITTANCE), like everything seen through it
// Behind the avatar or anything opaque the stencil bit is clear: hidden, as it should.
// Not drawn before the buildings (renderOrder < 0, as the map's tap ripple): the glass then
// covers the beam, and a building behind it cuts it in pieces (tried, and rejected).
const GLASS_TRANSMITTANCE = 1 - (look.palette.buildingOpacity); // as the buildings (createThemeStyle.js)
// A beacon is a light: more of it comes through the glass than of the map behind it. An
// event inside a building (its beam always starts on the ground) then shows its foot and
// ring through the roof without a hard step where the building ends
const BEACON_THROUGH_GLASS = GLASS_TRANSMITTANCE + (1 - GLASS_TRANSMITTANCE) * 0.55;

// Per beacon (instance): where it stands, its colour and its state
const instanceGlsl = /* glsl */ `
  attribute vec3 iCenter;
  attribute vec3 iColor;
  // live, selected, fade, beam width (or ring scale)
  attribute vec4 iState;
  flat varying vec3 vColor;
  flat varying vec3 vState;
`;
const stateGlsl = /* glsl */ `
  flat varying vec3 vColor;
  // live, selected, fade
  flat varying vec3 vState;
`;

const beamVertexShader = /* glsl */ `
  ${instanceGlsl}
  attribute float iHeight;
  attribute float iStyle;
  varying vec2 vUv;
  // Per beam: its own sparks (seed), how many quad widths tall it is, how it looks
  flat varying float vSeed;
  flat varying float vTall;
  flat varying float vStyle;
  // How much the camera looks down on it (0 from the side, 1 from high above)
  flat varying float vSteep;
  void main() {
    vUv = uv;
    vColor = iColor;
    vState = iState.xyz;
    vSeed = fract(iCenter.x * 0.137 + iCenter.z * 0.071);
    vTall = iHeight / max(iState.w * ${BEAM_QUAD.toFixed(2)}, 0.01);
    vStyle = iStyle;
    // A vertical billboard: it turns around its own axis to face the camera
    vec3 toCamera = cameraPosition - iCenter;
    vSteep = smoothstep(0.45, 0.85, normalize(toCamera).y);
    vec3 right = normalize(vec3(toCamera.z, 0.0, -toCamera.x) + vec3(1e-5, 0.0, 0.0));
    vec3 world = iCenter + right * position.x * iState.w * ${BEAM_QUAD.toFixed(2)} + vec3(0.0, position.y * iHeight, 0.0);
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const beamFragmentShader = /* glsl */ `
  ${stateGlsl}
  uniform float uTime;
  uniform float uOpacity;
  // 0 by day, 1 at night (the street lights): a beacon is a light, it shows more at night
  uniform float uNight;
  varying vec2 vUv;
  flat varying float vSeed;
  flat varying float vTall;
  flat varying float vStyle;
  flat varying float vSteep;
  void main() {
    vec3 uColor = vColor;
    float uLive = vState.x;
    float uSelected = vState.y;
    float uFade = vState.z;
    float y = vUv.y;
    // The beam flares where it leaves the ground, like light pouring out of it, and
    // narrows to its own width within the first few metres. Seen from high above, a
    // flat flare would lie on the ground as a fan: it shrinks, and the foot fades in
    // longer, into the pool of light the ring draws
    float flare = 1.0 + 1.1 * (1.0 - 0.8 * vSteep) * pow(1.0 - smoothstep(0.0, 0.1, y), 2.0);
    // Across and along the beam, in beam widths: a pattern keeps its proportions
    // whatever the height and the crowd
    float side = (vUv.x - 0.5) * ${BEAM_QUAD.toFixed(2)} / flare;
    float across = abs(side);
    float along = y * vTall * ${BEAM_QUAD.toFixed(2)};
    // One pixel, in beam widths: a thin thing far away stays a soft line, it never flickers
    float pixel = fwidth(vUv.x) * ${BEAM_QUAD.toFixed(2)};
    float core = exp(-across * across * 26.0);
    float glow = exp(-across * across * mix(6.0, 4.5, uNight)) * mix(0.62, 0.6, uNight);
    // Solid at the bottom, thinning to nothing at the top
    // (and fading in from the ground: the quad's bottom edge is never seen)
    float rise = smoothstep(0.0, mix(0.035, 0.09, vSteep), y);
    float vertical = pow(1.0 - y, 1.25) * rise;
    // A hot spot right at the ground, round and soft
    float base = exp(-y * 45.0) * exp(-across * across * 4.0) * 0.85 * rise * (1.0 - 0.65 * vSteep);
    float breathe = mix(1.0, 0.875 + 0.125 * sin(uTime * 1.5), uLive); // 100% to 75%
    // Never a hard edge: everything fades out before the sides of the quad
    float sides = 1.0 - smoothstep(0.7, 1.0, abs(vUv.x - 0.5) * 2.0);
    // The body of the beam, and how much of it runs white hot
    float body;
    float white;
    float spark = 0.0;
    if (vStyle < 0.5) {
      // Beam: a shaft of light. Light climbs it, slow and slight: it never seems to
      // flicker or go out
      body = (core + glow) * (0.94 + 0.06 * sin((y * 4.0 - uTime * (0.25 + uLive * 0.2)) * 6.2832));
      white = core * 0.3;
      // Dust rising up the beam: rows climbing with time, a speck in most of them, near
      // the core, fading out on the way up; faster when live
      float climb = y * ${SPARK_ROWS.toFixed(1)} - uTime * (0.45 + uLive * 0.45);
      float row = floor(climb);
      vec3 hash = fract(sin(vec3(row * 12.9898 + vSeed * 78.233, row * 39.346 + vSeed * 11.135, row * 73.156 + vSeed * 52.235)) * 43758.5453);
      vec2 from = vec2((vUv.x - 0.5 - (hash.x - 0.5) * 0.18) * ${BEAM_QUAD.toFixed(2)},
        (fract(climb) - 0.2 - hash.y * 0.6) / ${SPARK_ROWS.toFixed(1)} * vTall * ${BEAM_QUAD.toFixed(2)});
      spark = (1.0 - smoothstep(0.003, 0.011, length(from))) * step(hash.z, 0.7)
        * (1.0 - smoothstep(0.35, 0.85, y)) * smoothstep(0.04, 0.1, y);
    } else if (vStyle < 1.5) {
      // Pulse: lenses of light climbing a thin thread, one every few widths
      float cell = fract(along * 0.3 - uTime * (0.6 + uLive * 0.4)) - 0.5;
      float wide = 0.85 - 0.3 * y;
      float lens = cell * cell / 0.014 + across * across / (wide * wide);
      body = core * 0.36 + glow * 0.2 + exp(-lens * 1.4) * 1.05;
      white = exp(-lens * 5.0) * 0.45 + core * 0.1;
    } else if (vStyle < 2.5) {
      // Helix: two strands turning around each other, narrowing on the way up; the one
      // in front of the other is the brighter
      float turn = along * 1.5 - uTime * (1.3 + uLive * 0.6);
      float radius = 0.5 * (1.0 - 0.4 * y);
      float offset = radius * sin(turn);
      float front = cos(turn) * 0.5 + 0.5;
      float width = max(0.075, pixel * 1.1);
      float first = (side - offset) / width;
      float second = (side + offset) / width;
      float strands = max(exp(-first * first) * (0.35 + 0.65 * front), exp(-second * second) * (1.0 - 0.65 * front));
      body = strands + core * 0.12 + glow * 0.3;
      white = strands * 0.5;
    } else if (vStyle < 3.5) {
      // Stardust: hardly a beam, a cloud of specks rising and twinkling, in two layers
      float dust = 0.0;
      for (int i = 0; i < 2; i++) {
        float layer = float(i);
        float density = 1.15 + layer * 0.55;
        float climb = along * density - uTime * (0.8 + layer * 0.35 + uLive * 0.4) + layer * 17.0;
        float row = floor(climb);
        vec3 hash = fract(sin(vec3(row * 12.9898 + vSeed * 78.233 + layer, row * 39.346 + vSeed * 11.135, row * 73.156 + vSeed * 52.235)) * 43758.5453);
        vec2 from = vec2(side - (hash.x - 0.5) * 1.3, (fract(climb) - 0.25 - hash.y * 0.5) / density);
        float size = max(0.07 + hash.z * 0.07, pixel * 1.4);
        dust += (1.0 - smoothstep(size * 0.3, size, length(from))) * (0.6 + 0.4 * sin(uTime * (2.0 + hash.z * 3.0) + hash.x * 6.28));
      }
      body = core * 0.24 + glow * 0.22 + dust;
      white = dust * 0.7;
    } else {
      // Veil: a curtain of light waving in the air, in soft folds, like an aurora
      float centre = sin(along * 0.42 - uTime * 0.7 + vSeed * 6.28) * 0.36 + sin(along * 0.17 + uTime * 0.35) * 0.2;
      float off = side - centre;
      float folds = 0.78 + 0.22 * sin(off * 11.0 + along * 0.5 - uTime * 0.8);
      float curtain = exp(-off * off * 9.0) * folds;
      body = curtain * 1.05 + exp(-off * off * 2.6) * 0.22;
      white = curtain * 0.12;
    }
    float intensity = (body * vertical * (0.85 + 0.4 * uSelected) + base) * breathe * sides;
    intensity += spark * mix(0.45, 0.75, uNight);
    // Colour on a bright sky needs as much strength as light in the dark
    intensity *= mix(1.25, 1.2, uNight);
    // White hot only at the very core: the colour is what it says
    vec3 color = mix(uColor, vec3(1.0), clamp(white + base * 0.35 + spark * 0.6, 0.0, 1.0));
    gl_FragColor = vec4(color, clamp(intensity, 0.0, 1.0) * uFade * uOpacity);
    #include <colorspace_fragment>
  }
`;

const ringVertexShader = /* glsl */ `
  ${instanceGlsl}
  // The centre of the world's curve
  uniform vec2 uCurveCenter;
  varying vec2 vUv;
  // Each ring's waves at their own moment: they never all beat together
  flat varying float vPhase;
  void main() {
    vUv = uv;
    vColor = iColor;
    vState = iState.xyz;
    vPhase = fract(iCenter.x * 0.137 + iCenter.z * 0.071);
    vec3 world = iCenter + position * iState.w;
    // iCenter is lowered with the curved world (update): so wide a quad follows it across
    // its own width too, or its near side would sink under the ground far away
    vec2 fromCenter = iCenter.xz - uCurveCenter;
    vec2 fromVertex = world.xz - uCurveCenter;
    world.y -= (dot(fromVertex, fromVertex) - dot(fromCenter, fromCenter)) * ${WORLD_CURVATURE.toFixed(10)};
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;

const ringFragmentShader = /* glsl */ `
  ${stateGlsl}
  uniform float uTime;
  uniform float uOpacity;
  // 0 by day, 1 at night (the street lights): a beacon is a light, it shows more at night
  uniform float uNight;
  varying vec2 vUv;
  flat varying float vPhase;
  void main() {
    vec3 uColor = vColor;
    float uLive = vState.x;
    float uSelected = vState.y;
    float uFade = vState.z;
    float reach = length(vUv - 0.5) * 2.0;
    float r = reach * ${(LIGHT_SIZE / RING_SIZE).toFixed(2)};
    // The light it casts around it, stronger at night
    float glowAround = 1.0 - min(reach, 1.0);
    float light = glowAround * glowAround * mix(0.14, 0.38, uNight);
    // A pool of light on the ground under the beam, brighter at its foot (and at night)
    float pool = exp(-r * r * 7.0) * (0.42 + 0.04 * uLive * sin(uTime * 1.5)) * mix(0.9, 1.4, uNight);
    float disc = (1.0 - smoothstep(0.2, 0.42, r)) * 0.18 + pool;
    float rim = 1.0 - smoothstep(0.015, 0.05, abs(r - 0.42));
    // A wave spreads from the rim, every 3.2 s; on now, every 2.2 s and stronger
    float progress = fract(uTime / mix(3.2, 2.2, uLive) + vPhase);
    float waveRadius = 0.42 + progress * 0.56;
    float wave = mix(0.6, 1.0, uLive) * (1.0 - smoothstep(0.01, 0.05, abs(r - waveRadius))) * (1.0 - progress);
    float alpha = (disc + rim * (0.75 + 0.25 * uSelected) + wave * 0.8) * (1.0 - smoothstep(0.96, 1.0, r)) + light;
    vec3 color = mix(uColor, vec3(1.0), rim * 0.35);
    gl_FragColor = vec4(color, clamp(alpha, 0.0, 1.0) * uFade * uOpacity);
    #include <colorspace_fragment>
  }
`;

// The badges: camera-facing quads, each showing its cell of the atlas
const badgeVertexShader = /* glsl */ `
  attribute vec3 iCenter;
  // size, opacity, atlas cell x, y (from the top)
  attribute vec4 iBadge;
  varying vec2 vUv;
  flat varying float vOpacity;
  void main() {
    vUv = vec2((iBadge.z + uv.x) / ${ATLAS_CELLS.toFixed(1)}, 1.0 - (iBadge.w + 1.0 - uv.y) / ${ATLAS_CELLS.toFixed(1)});
    vOpacity = iBadge.y;
    vec4 view = viewMatrix * vec4(iCenter, 1.0);
    view.xy += position.xy * iBadge.x;
    gl_Position = projectionMatrix * view;
  }
`;

const badgeFragmentShader = /* glsl */ `
  uniform sampler2D uAtlas;
  varying vec2 vUv;
  flat varying float vOpacity;
  void main() {
    vec4 texel = texture2D(uAtlas, vUv);
    gl_FragColor = vec4(texel.rgb, texel.a * vOpacity);
    #include <colorspace_fragment>
  }
`;

// What is different about an event, the first that applies, and its colour. Yours is the
// app's accent, on now the app's green.
const STATE_COLORS = {
  sponsored: '#FFB300',
  yours: '#4F86FF',
  live: '#2FD07C',
  plain: '#FFFFFF',
};
const stateOf = (data) => {
  if (data.sponsored) return 'sponsored';
  if (data.draft || data.mine || data.following) return 'yours';
  return data.live ? 'live' : 'plain';
};

// The beam, its light and the badge's rim: gold when paid for, else the organizer's colour,
// else its state
const rimOf = (data) => {
  const state = stateOf(data);
  return state !== 'sponsored' && data.color ? data.color : STATE_COLORS[state];
};
const colorOf = (data) => new THREE.Color(rimOf(data));

// The badge: a white disc with the event's emoji and its rim (metallic for gold), drawn
// once per look into a cell of the atlas
function drawBadge(context, x, y, rim, emoji) {
  const size = BADGE_CELL;
  context.clearRect(x, y, size, size);
  context.save();
  context.translate(x, y);
  context.shadowColor = 'rgba(0, 0, 0, 0.35)';
  context.shadowBlur = 8;
  context.shadowOffsetY = 3;
  context.beginPath();
  context.arc(size / 2, size / 2 - 2, 52, 0, Math.PI * 2);
  if (rim === STATE_COLORS.sponsored) {
    const gold = context.createLinearGradient(0, size / 2 - 54, 0, size / 2 + 50);
    gold.addColorStop(0, '#FFE58A');
    gold.addColorStop(0.5, '#F7B722');
    gold.addColorStop(1, '#C8890F');
    context.fillStyle = gold;
  } else {
    context.fillStyle = rim;
  }
  context.fill();
  context.shadowColor = 'transparent';
  context.beginPath();
  context.arc(size / 2, size / 2 - 2, 43, 0, Math.PI * 2);
  context.fillStyle = rim === STATE_COLORS.sponsored ? '#FFF9E8' : '#FFFFFF';
  context.fill();
  context.font = '52px "Apple Color Emoji", "Noto Color Emoji", "Segoe UI Emoji", sans-serif';
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillText(emoji || '📍', size / 2, size / 2 + 1);
  context.restore();
}

const doublings = (crowd) => Math.log2(1 + Math.max(0, crowd || 0));
const beamHeightOf = (crowd) => Math.min(BEAM_MAX_HEIGHT, BEAM_MIN_HEIGHT + doublings(crowd) * BEAM_HEIGHT_PER_DOUBLING);
const beamThicknessOf = (crowd) => Math.min(BEAM_MAX_THICKNESS, 1 + doublings(crowd) * BEAM_THICKNESS_PER_DOUBLING);

// A beacon part where nothing is in front of it
function visibleMaterial(vertexShader, fragmentShader, uniforms, options = {}) {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: { ...uniforms, uOpacity: { value: 1 } },
    transparent: true,
    depthWrite: false,
    ...options,
  });
}

// The same part where it is behind the glass of a building: only there (stencil),
// dimmed by the glass, the stencil left as it is
function throughGlassMaterial(vertexShader, fragmentShader, uniforms, options = {}) {
  return new THREE.ShaderMaterial({
    vertexShader,
    fragmentShader,
    uniforms: { ...uniforms, uOpacity: { value: BEACON_THROUGH_GLASS } },
    transparent: true,
    depthWrite: false,
    depthFunc: THREE.GreaterDepth,
    stencilWrite: true, // turns the stencil test on; nothing is written (mask 0)
    stencilWriteMask: 0,
    stencilRef: GLASS_STENCIL_BIT,
    stencilFuncMask: GLASS_STENCIL_BIT,
    stencilFunc: THREE.EqualStencilFunc,
    stencilFail: THREE.KeepStencilOp,
    stencilZFail: THREE.KeepStencilOp,
    stencilZPass: THREE.KeepStencilOp,
    ...options,
  });
}

// Instance attributes of one kind of part, for up to MAX_BEACONS beacons
function instanced(base, attributes) {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.index = base.index;
  for (const name of ['position', 'uv']) geometry.setAttribute(name, base.getAttribute(name));
  for (const [name, size] of Object.entries(attributes)) {
    geometry.setAttribute(name, new THREE.InstancedBufferAttribute(new Float32Array(MAX_BEACONS * size), size).setUsage(THREE.DynamicDrawUsage));
  }
  geometry.instanceCount = 0;
  return geometry;
}

export function createEventBeacons({ scene, camera, map, groundHeight = 0, onAdded }) {
  const group = new THREE.Group();
  group.name = 'event-beacons';
  group.visible = false; // until the map has its origin (the first GPS fix)
  scene.add(group);

  const time = { value: 0 };
  // x from -0.5 to 0.5, y from 0 to 1: scaled in the shader
  const beamBase = new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0);
  const ringBase = new THREE.CircleGeometry(LIGHT_SIZE / 2, LIGHT_SIDES).rotateX(-Math.PI / 2);
  const badgeBase = new THREE.PlaneGeometry(1, 1);
  const beams = instanced(beamBase, { iCenter: 3, iColor: 3, iState: 4, iHeight: 1, iStyle: 1 });
  const rings = instanced(ringBase, { iCenter: 3, iColor: 3, iState: 4 });
  const badges = instanced(badgeBase, { iCenter: 3, iBadge: 4 });

  const atlasCanvas = document.createElement('canvas');
  atlasCanvas.width = BADGE_CELL * ATLAS_CELLS;
  atlasCanvas.height = BADGE_CELL * ATLAS_CELLS;
  const atlasContext = atlasCanvas.getContext('2d');
  const atlas = new THREE.CanvasTexture(atlasCanvas);
  atlas.colorSpace = THREE.SRGBColorSpace;
  atlas.anisotropy = 4;
  const atlasCells = new Map(); // look → cell index

  const night = { value: 0 };
  const beamUniforms = { uTime: time, uNight: night };
  const curveCenter = { value: new THREE.Vector2() };
  const ringUniforms = { ...beamUniforms, uCurveCenter: curveCenter };
  const parts = [
    [beams, visibleMaterial(beamVertexShader, beamFragmentShader, beamUniforms, { side: THREE.DoubleSide }), 2],
    [beams, throughGlassMaterial(beamVertexShader, beamFragmentShader, beamUniforms, { side: THREE.DoubleSide }), 2],
    // On the ground, just above the flat map layers (roads, parks…) so they never
    // fight with them; drawn after the buildings (GLASS_STENCIL_BIT)
    [rings, visibleMaterial(ringVertexShader, ringFragmentShader, ringUniforms), 1],
    [rings, throughGlassMaterial(ringVertexShader, ringFragmentShader, ringUniforms), 1],
    [badges, new THREE.ShaderMaterial({
      vertexShader: badgeVertexShader,
      fragmentShader: badgeFragmentShader,
      uniforms: { uAtlas: { value: atlas } },
      depthTest: false,
      depthWrite: false,
      transparent: true,
    }), 10],
  ];
  const meshes = parts.map(([geometry, material, renderOrder]) => {
    const mesh = new THREE.Mesh(geometry, material);
    // Their vertices are placed in the shader: the bounds of the quad say nothing
    mesh.frustumCulled = false;
    mesh.renderOrder = renderOrder;
    group.add(mesh);
    return mesh;
  });

  const beacons = new Map(); // id → beacon
  let selectedId = null;
  let draft = null;
  let elapsed = 0;

  // The atlas cell of a badge look, drawn the first time it is needed. When the atlas
  // is full it is drawn again with only the looks still on the map
  const cellOf = (data) => {
    const look = [rimOf(data), data.emoji];
    const key = look.join('|');
    if (atlasCells.has(key)) return atlasCells.get(key);
    if (atlasCells.size >= ATLAS_CELLS * ATLAS_CELLS) {
      atlasCells.clear();
      for (const beacon of beacons.values()) beacon.cell = null;
    }
    const cell = atlasCells.size;
    atlasCells.set(key, cell);
    drawBadge(atlasContext, (cell % ATLAS_CELLS) * BADGE_CELL, Math.floor(cell / ATLAS_CELLS) * BADGE_CELL, ...look);
    atlas.needsUpdate = true;
    return cell;
  };

  const makeBeacon = (data) => ({
    data,
    color: colorOf(data),
    cell: null,
    world: new THREE.Vector3(),
    lowered: 0,
    badgeY: BADGE_HEIGHT,
    selected: 0,
    fade: 1,
    near: 1,
    visible: false,
    distance: 0,
    scale: BADGE_SIZE,
    thickness: beamThicknessOf(data.crowd),
    // Seconds since it appeared (it rises, then its badge pops in)
    age: 0,
  });

  const place = (beacon) => {
    const { x, z } = map.latLonToWorld(beacon.data.latitude, beacon.data.longitude);
    beacon.world.set(x, 0, z);
  };

  const refresh = (beacon, data) => {
    const previous = beacon.data;
    beacon.data = data;
    beacon.thickness = beamThicknessOf(data.crowd);
    if (stateOf(previous) !== stateOf(data) || previous.color !== data.color) {
      beacon.color = colorOf(data);
      beacon.cell = null;
    }
    if (previous.emoji !== data.emoji) beacon.cell = null;
    if (previous.latitude !== data.latitude || previous.longitude !== data.longitude) place(beacon);
  };

  const remove = (id) => {
    beacons.delete(id);
  };

  const set = (list) => {
    const seen = new Set();
    let added = false;
    for (const data of Array.isArray(list) ? list : []) {
      if (!data?.id || !Number.isFinite(data.latitude) || !Number.isFinite(data.longitude)) continue;
      seen.add(data.id);
      const existing = beacons.get(data.id);
      if (existing) refresh(existing, data);
      else {
        const beacon = makeBeacon(data);
        beacons.set(data.id, beacon);
        place(beacon);
        added = true;
      }
    }
    for (const id of [...beacons.keys()]) if (id !== '__draft' && !seen.has(id)) remove(id);
    if (selectedId && !beacons.has(selectedId)) selectedId = null;
    if (added) onAdded?.();
  };

  // The place chosen for a new event (long press), until it is created or dropped
  const setDraft = (point) => {
    remove('__draft');
    draft = point && Number.isFinite(point.latitude) ? point : null;
    if (!draft) return;
    const beacon = makeBeacon({ id: '__draft', ...draft, emoji: '⚡', live: true, draft: true, crowd: 0 });
    beacons.set('__draft', beacon);
    place(beacon);
    onAdded?.();
  };

  // Every beacon again from its coordinates (after the map origin moved)
  const relayout = () => {
    for (const beacon of beacons.values()) place(beacon);
  };

  const setVisible = (visible) => {
    group.visible = visible;
  };

  const setSelected = (id) => {
    selectedId = id && beacons.has(id) ? id : null;
  };

  const drawn = [];
  const position = new THREE.Vector3();
  // `center`: the centre of the fog and of the curvature (fogOrigin); `fogFar`: where
  // the fog is complete
  // `nightness`: 0 by day, 1 at night (env.streetLights)
  const update = (deltaSeconds, center, fogFar, nightness = 0) => {
    night.value = nightness;
    curveCenter.value.set(center.x, center.z);
    elapsed += deltaSeconds;
    time.value = elapsed;
    drawn.length = 0;
    for (const [id, beacon] of beacons) {
      const dx = beacon.world.x - center.x;
      const dz = beacon.world.z - center.z;
      const distanceSquared = dx * dx + dz * dz;
      const distance = Math.sqrt(distanceSquared);
      beacon.distance = distance;
      beacon.visible = distance < fogFar;
      const selected = id === selectedId ? 1 : 0;
      beacon.selected += (selected - beacon.selected) * Math.min(1, deltaSeconds * 8);
      beacon.age += deltaSeconds;
      if (!beacon.visible) continue;
      // Lowered with the curved world, faded with the fog
      beacon.lowered = -distanceSquared * WORLD_CURVATURE;
      beacon.fade = 1 - THREE.MathUtils.smoothstep(distance, fogFar - FADE_LENGTH, fogFar);
      // A beam's size is the crowd's alone (beamThicknessOf, beamHeightOf): a real thing
      // in the city, smaller the farther it is. Only the badges grow a little far away,
      // to stay readable (BADGE_GROWTH)
      position.set(beacon.world.x, beacon.lowered, beacon.world.z);
      beacon.cameraDistance = camera.position.distanceTo(position);
      const far = Math.max(1, beacon.cameraDistance / BADGE_NEAR);
      beacon.scale = BADGE_SIZE * far ** BADGE_GROWTH * (1 + 0.22 * beacon.selected);
      beacon.width = BEAM_WIDTH * beacon.thickness;
      beacon.badgeY = BADGE_HEIGHT + beacon.scale * 0.35 + Math.sin(elapsed * 1.6 + beacon.world.x * 0.05) * 0.5;
      position.y = beacon.lowered + beacon.badgeY;
      beacon.near = THREE.MathUtils.smoothstep(camera.position.distanceTo(position), NEAR_HIDDEN, NEAR_FULL);
      beacon.cell ??= cellOf(beacon.data);
      drawn.push(beacon);
    }
    // The nearest ones if there are too many; drawn far to near (they blend)
    drawn.sort((a, b) => b.cameraDistance - a.cameraDistance);
    if (drawn.length > MAX_BEACONS) drawn.splice(0, drawn.length - MAX_BEACONS);
    const attributes = (geometry) => geometry.attributes;
    const beam = attributes(beams);
    const ring = attributes(rings);
    const badge = attributes(badges);
    drawn.forEach((beacon, i) => {
      const { x, z } = beacon.world;
      const live = beacon.data.live ? 1 : 0;
      // Always from the ground (an event in a building too: its beam shows through the
      // glass), just above the map's flat layers: never cutting through them, where
      // they would slice its foot differently each frame from high up
      beam.iCenter.setXYZ(i, x, beacon.lowered + groundHeight + BEAM_LIFT, z);
      beam.iColor.setXYZ(i, beacon.color.r, beacon.color.g, beacon.color.b);
      beam.iState.setXYZW(i, live, beacon.selected, beacon.fade * beacon.near, beacon.width);
      // Rising out of the ground when new (eased out)
      const grown = 1 - (1 - Math.min(1, beacon.age / GROW_SECONDS)) ** 3;
      beam.iHeight.setX(i, beamHeightOf(beacon.data.crowd) * grown);
      beam.iStyle.setX(i, BEAM_STYLES[beacon.data.beamStyle] ?? BEAM_STYLES.beam);
      ring.iCenter.setXYZ(i, x, beacon.lowered + groundHeight + 0.25, z);
      ring.iColor.setXYZ(i, beacon.color.r, beacon.color.g, beacon.color.b);
      // The ring and its pool of light widen with the beam
      ring.iState.setXYZW(i, live, beacon.selected, beacon.fade * beacon.near, beacon.thickness ** 0.75);
      badge.iCenter.setXYZ(i, x, beacon.lowered + beacon.badgeY, z);
      // …then the badge pops in, a little past its size and back
      const p = THREE.MathUtils.clamp((beacon.age - POP_DELAY) / POP_SECONDS, 0, 1);
      const pop = p >= 1 ? 1 : 1 + 2.2 * (p - 1) ** 3 + 1.2 * (p - 1) ** 2;
      badge.iBadge.setXYZW(i, beacon.scale * pop, Math.max(beacon.fade, 0.35) * beacon.near * Math.min(1, p * 3), beacon.cell % ATLAS_CELLS, Math.floor(beacon.cell / ATLAS_CELLS));
    });
    for (const geometry of [beams, rings, badges]) {
      geometry.instanceCount = drawn.length;
      // Only the beacons drawn go to the GPU (nothing when there are none)
      if (!drawn.length) continue;
      for (const attribute of Object.values(geometry.attributes)) {
        if (!attribute.isInstancedBufferAttribute) continue;
        attribute.clearUpdateRanges();
        attribute.addUpdateRange(0, drawn.length * attribute.itemSize);
        attribute.needsUpdate = true;
      }
    }
    for (const mesh of meshes) mesh.visible = drawn.length > 0;
  };

  // The event under a tap (screen point), or null: the badge, or along the beam
  const projected = new THREE.Vector3();
  const base = new THREE.Vector2();
  const top = new THREE.Vector2();
  const toScreen = (vector, bounds, out) => {
    projected.copy(vector).project(camera);
    if (projected.z > 1) return null;
    return out.set(bounds.left + (projected.x + 1) / 2 * bounds.width, bounds.top + (1 - projected.y) / 2 * bounds.height);
  };
  const badgeWorld = new THREE.Vector3();
  const baseWorld = new THREE.Vector3();
  const pick = (clientX, clientY, bounds) => {
    if (!group.visible) return null;
    let best = null;
    let bestDistance = Infinity;
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    for (const [id, beacon] of beacons) {
      if (id === '__draft' || !beacon.visible || beacon.fade < 0.15 || beacon.near < 0.3) continue;
      badgeWorld.set(beacon.world.x, beacon.lowered + beacon.badgeY, beacon.world.z);
      beaconBase(beacon, baseWorld);
      if (!toScreen(badgeWorld, bounds, top) || !toScreen(baseWorld, bounds, base)) continue;
      const depth = Math.max(camera.position.distanceTo(badgeWorld), 1);
      const badgeRadius = (beacon.scale / 2) / (depth * tan) * (bounds.height / 2);
      const toBadge = Math.hypot(clientX - top.x, clientY - top.y) - Math.max(badgeRadius, PICK_RADIUS_PX);
      // Along the beam, from the ground to the badge
      const segment = top.clone().sub(base);
      const t = THREE.MathUtils.clamp(((clientX - base.x) * segment.x + (clientY - base.y) * segment.y) / Math.max(segment.lengthSq(), 1), 0, 1);
      const toBeam = Math.hypot(clientX - (base.x + segment.x * t), clientY - (base.y + segment.y * t)) - PICK_RADIUS_PX * 0.7;
      const score = Math.min(toBadge, toBeam);
      if (score <= 0 && score + depth * 0.001 < bestDistance) {
        bestDistance = score + depth * 0.001;
        best = id;
      }
    }
    return best;
  };

  // The badges drawn this frame as circles on screen (CSS px, viewport { width, height }):
  // the names of the people keep clear of them (nearbyPeople.js)
  const badgeCircles = (viewport, out = []) => {
    out.length = 0;
    const tan = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    for (const beacon of drawn) {
      if (beacon.fade * beacon.near < 0.3) continue;
      badgeWorld.set(beacon.world.x, beacon.lowered + beacon.badgeY, beacon.world.z);
      projected.copy(badgeWorld).project(camera);
      if (projected.z > 1) continue;
      const depth = Math.max(camera.position.distanceTo(badgeWorld), 1);
      out.push({
        x: ((projected.x + 1) / 2) * viewport.width,
        y: ((1 - projected.y) / 2) * viewport.height,
        r: ((beacon.scale / 2) / (depth * tan)) * (viewport.height / 2),
      });
    }
    return out;
  };

  const beaconBase = (beacon, out) => out.set(beacon.world.x, beacon.lowered + groundHeight, beacon.world.z);

  // Where the camera looks when the event is chosen (its ground, flat world)
  const positionOf = (id) => {
    const beacon = beacons.get(id);
    return beacon ? beacon.world.clone() : null;
  };

  const dispose = () => {
    beacons.clear();
    for (const mesh of meshes) mesh.material.dispose();
    for (const geometry of [beams, rings, badges, beamBase, ringBase, badgeBase]) geometry.dispose();
    atlas.dispose();
    scene.remove(group);
  };

  // For the developer tools and the benchmark: the events received, and those drawn
  // this frame (in the fog's radius)
  const stats = () => ({ events: [...beacons.keys()].filter((id) => id !== '__draft').length, drawn: drawn.length });

  return { set, setDraft, relayout, badgeCircles, setVisible, setSelected, update, pick, positionOf, stats, dispose };
}
