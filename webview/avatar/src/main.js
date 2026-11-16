// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { composeAvatar, disposeAvatar, keepOnDevice, loadGltf, useOptimizedLibrary } from './composeAvatar.js';
import { createTurntable } from './turntable.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { createStage } from './stage.js';
import { createOutline } from './outline.js';
import { createStudioShading } from './studioShading.js';
import { avatarClip, decodeClip } from './clips.js';
import idlePacked from '../../../assets/models/decentraland/locomotion/idle.json';

// 3D avatar viewer of the app (profile, editor), in a WebView like the map. The app
// drives it through window.avatarViewer and hears back through postMessage:
//   ready                      the page can take an avatar
//   loading / loaded / error   an avatar is being built / is shown / could not be built
//   snapshot {image}           a picture of the avatar just shown (when asked)
//   tap                        a quick touch on the avatar
//   drag {active}              the user turns it (the app pauses its own scrolling)

const post = (message) => window.ReactNativeWebView?.postMessage(JSON.stringify(message));

// Camera framings: where it looks and how much of the avatar fits the height of the
// view, as fractions of the avatar's height (`body`: all of it, with some air)
const FRAMES = {
  body: { center: 0.5, span: 1.18 },
  head: { center: 0.88, span: 0.38 },
  upper: { center: 0.68, span: 0.74 },
  lower: { center: 0.33, span: 0.7 },
  feet: { center: 0.12, span: 0.46 },
};
const IDLE_FPS = 30;

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
// A release does not read back every shader's log at its first use (a wait for the
// driver each time); the development page still reports shader errors
renderer.debug.checkShaderErrors = process.env.NODE_ENV === 'development';
renderer.setPixelRatio(window.devicePixelRatio || 1);
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x000000, 0);
renderer.toneMapping = THREE.NeutralToneMapping;
document.body.append(renderer.domElement);
// The GPU-ready avatar library (ASTC textures) where the device can sample it
// (?original in a development build: the original files, to compare)
if (!(process.env.NODE_ENV === 'development' && location.search.includes('original'))) useOptimizedLibrary(renderer);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(26, innerWidth / innerHeight, 0.05, 50);

// Studio lighting, soft and even (the plain models show their faceting under hard
// contrast): soft reflections from a room environment (materials look like cloth and
// skin, not flat plastic), a gentle key from the front-right, a generous fill from the
// front-left in the backdrop's lower colour (its light bouncing back), two rims behind
// in the stage's colour that draw the silhouette, and the studio shading on the
// avatar's materials (studioShading.js). The stage (stage.js) tints them all.
// The room's reflections take the longest part of the page's start (its shaders and
// the blurring of the room): made right after the page tells the app it is ready, while
// the app sends the avatar and its files load. Nothing is drawn or compiled before it
// (prepare, loop): the programs and the pixels are the same as when made first
let environmentReady = false;
const environmentMade = new Promise((resolve) => {
  setTimeout(() => {
    scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
    environmentReady = true;
    resolve();
    wake();
  }, 0);
});
scene.environmentIntensity = 0.55;
const hemisphere = new THREE.HemisphereLight(0xffffff, 0xd8d2c8, 1.45);
scene.add(hemisphere);
const key = new THREE.DirectionalLight(0xffffff, 1.65);
key.position.set(1.4, 2.6, 2.4);
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.95);
fill.position.set(-2, 0.8, 2.2);
scene.add(fill);
const rim = new THREE.DirectionalLight(0xdfe8ff, 1.5);
rim.position.set(-1.2, 2.2, -2.6);
scene.add(rim);
const rimRight = new THREE.DirectionalLight(0xdfe8ff, 0.8);
rimRight.position.set(1.8, 1.4, -2.4);
scene.add(rimRight);
const studio = createStudioShading();
const stage = createStage(scene, { renderer, key, fill, rim, rimRight, hemisphere, studio: studio.uniforms });
let staged = false;
// The stage's lower sky colour: what the app paints behind the view (AvatarView)
let stageBackground = null;
// The avatar's outline (outline.js): a thin even line, the same width on screen whatever
// the framing (CSS pixels), and only if the stage asks for it. Ink, barely tinted by the
// backdrop, over light backdrops, a pale one over dark backdrops (ink would vanish there).
const OUTLINE_PIXELS = 1.4;
const INK = new THREE.Color('#14131c');
const PALE_INK = new THREE.Color('#f4f3fa');
const outlineColor = new THREE.Color();
const outline = createOutline(renderer, scene, { pixels: OUTLINE_PIXELS, color: INK });
// Not around the face decals (eyes, brows and mouth are flat masks on the head)
const outlineSkip = (mesh) => /_Mask_/i.test(mesh.name);

// Soft contact shadow under the feet: a blurred disc, no shadow maps
const shadowTexture = (() => {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 128;
  const context = canvas.getContext('2d');
  const gradient = context.createRadialGradient(64, 64, 0, 64, 64, 64);
  gradient.addColorStop(0, 'rgba(0,0,0,0.55)');
  gradient.addColorStop(0.55, 'rgba(0,0,0,0.18)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(canvas);
})();
const contactShadow = new THREE.Mesh(
  new THREE.PlaneGeometry(0.9, 0.55),
  new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false, opacity: 0.5 }),
);
contactShadow.rotation.x = -Math.PI / 2;
contactShadow.position.y = 0.002;
scene.add(contactShadow);

const pivot = new THREE.Group(); // the turntable turns this
scene.add(pivot);

let avatar = null;
let plan = null;
let request = 0;
let frame = 'body';
const view = { center: new THREE.Vector3(0, 0.9, 0), span: 2.1 };
const target = { center: new THREE.Vector3(0, 0.9, 0), span: 2.1 };
// Parts of the view covered by the app's own controls, in CSS pixels (e.g. the
// editor's panel over the bottom): the avatar is framed in the band left between them
const insets = { top: 0, bottom: 0 };
const insetsTarget = { top: 0, bottom: 0 };
let active = true;
// The avatar's animation: Decentraland's idle, and an emote over it now and then
// { mixer, idle, emote (the action playing, or null), settleUntil }
let motion = null;
// Seconds for the idle to hand over to an emote, and to take back over after it
const EMOTE_FADE_IN = 0.25;
const EMOTE_FADE_OUT = 0.35;
let needsRender = true;
let lastFrame = 0;

const turntable = createTurntable(renderer.domElement, {
  onTap: () => post({ type: 'tap' }),
  onDragChange: (dragging) => post({ type: 'drag', active: dragging }),
});

function setFrame(name, immediate = false) {
  frame = FRAMES[name] ? name : 'body';
  const height = avatar?.height ?? 1.75;
  target.center.set(0, height * FRAMES[frame].center, 0);
  target.span = height * FRAMES[frame].span;
  if (immediate) {
    view.center.copy(target.center);
    view.span = target.span;
  }
  needsRender = true;
  wake();
}

function placeCamera() {
  // The visible band between the insets, and how far its middle is from the view's:
  // the projection is taken from a taller virtual view whose centre falls in the
  // middle of the band (a view offset), so the avatar is framed there, undistorted
  const width = innerWidth;
  const height = innerHeight;
  // A band never too thin to frame in (the app keeps it reasonable)
  const band = Math.max(height - insets.top - insets.bottom, height * 0.1);
  const shift = (insets.bottom - insets.top) / 2;
  const fullHeight = height + 2 * Math.abs(shift);
  camera.aspect = width / fullHeight;
  if (Math.abs(shift) > 0.5) camera.setViewOffset(width, fullHeight, 0, shift > 0 ? 2 * shift : 0, width, height);
  else camera.clearViewOffset();
  camera.updateProjectionMatrix();

  // Fit `span` metres in the band's height and (for wide views) the width
  const halfTan = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2);
  const fitHeight = (view.span * fullHeight) / (2 * halfTan * band);
  const fitWidth = (view.span * 0.62 * fullHeight) / (2 * halfTan * width);
  const distance = Math.max(fitHeight, fitWidth);
  camera.position.set(0, view.center.y + view.span * 0.04, distance);
  camera.lookAt(view.center);
}

function setInsets(top = 0, bottom = 0, immediate = false) {
  insetsTarget.top = Math.max(0, top);
  insetsTarget.bottom = Math.max(0, bottom);
  if (immediate) Object.assign(insets, insetsTarget);
  needsRender = true;
  wake();
}

// The models rest in a T-pose: Decentraland's idle stands them up and keeps them
// breathing (the same as on the map)
function createMotion(body) {
  const mixer = new THREE.AnimationMixer(body);
  const idle = mixer.clipAction(decodeClip(idlePacked).clip);
  idle.play();
  mixer.update(0); // standing from the very first frame
  const state = { mixer, idle, emote: null, settleUntil: 0 };
  mixer.addEventListener('finished', (event) => {
    if (event.action !== state.emote) return;
    // The idle takes over again, blending out of the emote's last pose
    idle.reset().play();
    event.action.crossFadeTo(idle, EMOTE_FADE_OUT, false);
    state.emote = null;
    state.settleUntil = performance.now() + EMOTE_FADE_OUT * 1000;
  });
  return state;
}

function disposeMotion(state, body) {
  state.mixer.stopAllAction();
  state.mixer.uncacheRoot(body);
}

async function playEmote(url) {
  if (!avatar || !url) return;
  try {
    const gltf = await loadGltf(url);
    const clip = avatarClip(gltf.animations);
    if (clip) playClip(clip);
  } catch {
    // An emote that does not load is simply not played
  }
}

// Plays a clip once over the idle, then the idle takes over again
function playClip(clip) {
  if (!motion) return;
  const action = motion.mixer.clipAction(clip);
  const from = motion.emote ?? motion.idle;
  if (from === action) action.stop();
  action.reset();
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true; // held until the idle has blended back in
  action.play();
  if (from !== action) from.crossFadeTo(action, EMOTE_FADE_IN, false);
  motion.emote = action;
  needsRender = true;
  wake();
}

async function show(nextPlan, options = {}) {
  const id = ++request;
  plan = nextPlan;
  post({ type: 'loading' });
  try {
    const next = await composeAvatar(nextPlan);
    if (id !== request) {
      disposeAvatar(next);
      return;
    }
    studio.apply(next.root, next.height);
    outline.mark(next.root, { skip: outlineSkip });
    // Its shaders ready before it is drawn, and those of the stage set meanwhile (see
    // prepare). Its textures go to the GPU while they compile, not in the first frame
    const compiled = Promise.all([prepare(next.root, scene), prepare(scene)]);
    next.root.traverse((object) => {
      if (!object.isMesh) return;
      for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
        for (const value of Object.values(material)) if (value?.isTexture) renderer.initTexture(value);
      }
    });
    await compiled;
    if (id !== request) {
      disposeAvatar(next);
      return;
    }
    // The previous avatar stays until the new one is ready: no empty frame in between
    if (avatar) {
      pivot.remove(avatar.root);
      disposeMotion(motion, avatar.body);
      disposeAvatar(avatar);
    }
    avatar = next;
    motion = createMotion(next.body);
    if (process.env.NODE_ENV === 'development') Object.assign(window, { avatarDebug: next, studioDebug: studio.uniforms, playPackedDebug: (packed) => playClip(decodeClip(packed).clip) }); // tests in a browser
    pivot.add(avatar.root);
    setFrame(options.frame ?? frame, !options.keepCamera);
    renderFrame();
    post({ type: 'loaded', failed: next.failed });
    // The real avatar holds the shared shaders now: the warm-up's can go
    endWarmUp();
    if (options.keep) keepOnDevice(next);
    // A picture of it, for the app to show at once next time (before the 3D is ready)
    if (options.snapshot) post({ type: 'snapshot', snapshotKey: options.snapshotKey, image: snapshot(options.snapshot) });
    if (options.emote) playEmote(options.emote);
  } catch (error) {
    if (id === request) post({ type: 'error', message: String(error?.message ?? error) });
  }
}

// Shaders of `root` compiled without blocking the page, and their uniforms read: resolves
// once every program can draw. They compile all at once on the driver's threads where
// the browser can (KHR_parallel_shader_compile); else the first frame would wait for each
// in turn. One look per program (materials share a handful of them) every few
// milliseconds: in WebKit each look, and each uniform read, is a call to its GPU process,
// and the first frame would otherwise make several hundred of them
// `cancelled()`: true once it is not needed any more (its programs may be gone)
async function prepare(root, targetScene = null, cancelled = () => false) {
  await environmentMade;
  const programs = new Set();
  for (const material of renderer.compile(root, camera, targetScene)) {
    const program = renderer.properties.get(material).currentProgram;
    if (program) programs.add(program);
  }
  return new Promise((resolve) => {
    const check = () => {
      if (cancelled()) {
        resolve();
        return;
      }
      for (const program of programs) {
        if (!program.isReady()) continue;
        program.getUniforms();
        programs.delete(program);
      }
      if (programs.size) setTimeout(check, 8);
      else resolve();
    };
    check();
  });
}

// While the page waits for the avatar to show (the app fetching someone's look), the
// shaders every avatar shares (skin, eyes, hair, clothes, outline: a handful of
// programs) are made ready with another avatar the app hands right after 'ready'
// (avatarViewer.warmUp: the user's own look, its files on the device). It is never
// drawn; its materials keep the programs in use until the avatar on show has them too.
// The same programs, so the same pixels: only sooner
let warmUp = null;
async function startWarmUp(warmPlan) {
  if (avatar || warmUp || !warmPlan) return;
  const ghost = { avatar: null, cancelled: false };
  warmUp = ghost;
  try {
    const next = await composeAvatar(warmPlan);
    if (ghost.cancelled) {
      disposeAvatar(next);
      return;
    }
    studio.apply(next.root);
    outline.mark(next.root, { skip: outlineSkip });
    ghost.avatar = next;
    await prepare(next.root, scene, () => ghost.cancelled);
  } catch {
    // Nothing gained, nothing lost: the avatar on show compiles its own
  }
}

function endWarmUp() {
  if (!warmUp) return;
  warmUp.cancelled = true;
  if (warmUp.avatar) disposeAvatar(warmUp.avatar);
  warmUp = null;
}

function draw() {
  placeCamera();
  outline.update(avatar?.root, camera);
  renderer.render(scene, camera);
}

function renderFrame() {
  pivot.rotation.y = turntable.state.angle;
  avatar?.syncPose();
  draw();
}

// The current view as a data URL, at most `maxSize` pixels on its long side. On a
// stage, a JPEG over the colour the app paints behind the view (opaque like what the
// user sees, and a fraction of a PNG's size at full resolution); else a PNG, which
// keeps the transparency.
function snapshot(maxSize = 512) {
  const canvas = renderer.domElement;
  const scale = Math.min(1, maxSize / Math.max(canvas.width, canvas.height));
  const output = document.createElement('canvas');
  output.width = Math.round(canvas.width * scale);
  output.height = Math.round(canvas.height * scale);
  renderFrame(); // the drawing buffer is only readable in the task that drew it
  const context = output.getContext('2d');
  if (stageBackground) {
    context.fillStyle = stageBackground;
    context.fillRect(0, 0, output.width, output.height);
  }
  context.drawImage(canvas, 0, 0, output.width, output.height);
  return stageBackground ? output.toDataURL('image/jpeg', 0.88) : output.toDataURL('image/png');
}

// Frame scheduling. While something moves (a drag, an emote, the camera or the colours
// easing) every display frame is drawn. At rest the page sleeps between the idle
// frames (the breath, the drifting effects) instead of waking at every display
// refresh: a requestAnimationFrame at 60 Hz costs the page, WebKit and the app work
// at each wake-up even when nothing is drawn. Off screen it sleeps until woken.
let frameRequest = 0;
let sleepTimer = 0;

function schedule(mode) {
  if (frameRequest || sleepTimer) return;
  if (mode === 'busy') frameRequest = requestAnimationFrame(loop);
  else if (mode === 'idle') {
    sleepTimer = setTimeout(() => {
      sleepTimer = 0;
      frameRequest = requestAnimationFrame(loop);
    }, 1000 / IDLE_FPS - 4);
  }
}

// Something changed: draw at the next display frame
function wake() {
  if (sleepTimer) {
    clearTimeout(sleepTimer);
    sleepTimer = 0;
  }
  schedule('busy');
}

function loop(time) {
  frameRequest = 0;
  if (!environmentReady) return; // drawn once the room's reflections are made
  const delta = lastFrame ? Math.min((time - lastFrame) / 1000, 0.1) : 1 / 60;
  lastFrame = time;
  // A theme fading in moves at full rate, also while the app has the view in the
  // background (e.g. under the sheet that picks it)
  const stageChanging = staged && stage.update(delta, time / 1000);
  // An emote playing (e.g. the greeting picked in that sheet) runs to its end too
  const emoting = !!motion && (!!motion.emote || time < motion.settleUntil);
  if (!active && !stageChanging && !needsRender && !emoting) {
    lastFrame = 0;
    return; // asleep until woken
  }
  const moving = turntable.update(delta);
  const easing = 1 - Math.exp(-delta * 8);
  const cameraMoving = view.center.distanceTo(target.center) > 0.0005 || Math.abs(view.span - target.span) > 0.0005
    || Math.abs(insets.top - insetsTarget.top) > 0.5 || Math.abs(insets.bottom - insetsTarget.bottom) > 0.5;
  view.center.lerp(target.center, easing);
  view.span += (target.span - view.span) * easing;
  insets.top += (insetsTarget.top - insets.top) * easing;
  insets.bottom += (insetsTarget.bottom - insets.bottom) * easing;
  const busy = moving || cameraMoving || emoting || needsRender || stageChanging;
  needsRender = false;

  pivot.rotation.y = turntable.state.angle;
  motion?.mixer.update(delta);
  avatar?.syncPose();
  draw();
  schedule(busy ? 'busy' : 'idle');
}
wake();
// A touch on the avatar starts the full frame rate at once (the drag follows the finger)
renderer.domElement.addEventListener('pointerdown', wake);

window.addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  needsRender = true;
  wake();
});

window.avatarViewer = {
  // plan: avatarFormat.resolveAvatar(...) with absolute URLs.
  // options: { frame: 'body'|'head'|'upper'|'lower'|'feet', emote: url played once
  // shown, keepCamera,
  // snapshot: max size (px) of a picture posted once shown,
  // keep: the user's own avatar, whose files stay on the device (fileCache.js) }
  show,
  setFrame: (name) => setFrame(name),
  // What surrounds the avatar (stage.js); without one the view is transparent
  setStage: (theme, immediate = false) => {
    staged = true;
    stageBackground = theme.sky?.[1] ?? null;
    stage.set(theme, immediate);
    const sky = new THREE.Color(theme.sky?.[0] ?? '#ffffff');
    const darkSky = sky.r * 0.299 + sky.g * 0.587 + sky.b * 0.114 < 0.3;
    outlineColor.copy(darkSky ? PALE_INK : INK).lerp(sky, darkSky ? 0.1 : 0.012); // linear: a little goes far
    outline.color = outlineColor;
    outline.opacity = darkSky ? 0.55 : 0.82;
    outline.visible = theme.outline !== false;
    // A new pedestal or effect: its shaders compile in the background, not in a frame
    prepare(scene);
    needsRender = true;
    wake();
  },
  // Parts of the view (CSS px) covered by the app's controls: the camera eases to
  // frame the avatar in the band between them
  setInsets,
  playEmote,
  // Another look whose shaders are made ready while this page waits for its own (above)
  warmUp: (warmPlan) => startWarmUp(warmPlan),
  // Off screen the page stops drawing (and the GPU rests)
  setActive: (value) => {
    active = value !== false;
    lastFrame = 0;
    needsRender = true;
    wake();
  },
  get plan() {
    return plan;
  },
};
camera.aspect = innerWidth / innerHeight;
camera.updateProjectionMatrix();
placeCamera();
// The stage's shaders, and those every avatar shares, while the app sends the avatar
prepare(scene);
post({ type: 'ready' });
