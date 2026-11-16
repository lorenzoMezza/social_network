// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { startupMark, startupMarks } from './startupTimeline.js';
import { createShaderGate } from './scene/shaderGate.js';
import * as THREE from 'three';
import { fogOrigin, sceneGrade } from './scene/horizontalFog.js';
import { createRenderer } from './scene/createRenderer.js';
import { createCamera } from './scene/createCamera.js';
import { createMapTapFeedback } from './scene/createMapTapFeedback.js';
import { createEventBeacons } from './scene/eventBeacons.js';
import { createPlayerAvatar, updateAvatarLighting } from './scene/createPlayerAvatar.js';
import { createNearbyPeople } from './scene/nearbyPeople.js';
import { createCrowd } from './scene/crowd/createCrowd.js';
import { useOptimizedLibrary } from '../../avatar/src/composeAvatar.js';
import { avatarFiles } from '../../avatar/src/fileCache.js';
import { createCapsuleShadows } from './scene/capsuleShadows.js';
import { addLights } from './scene/addLights.js';
import { handleResize } from './scene/handleResize.js';
import { fitFarPlane } from './scene/fitFarPlane.js';
import { createSky } from './scene/sky/createSky.js';
import { createClouds } from './scene/clouds/createClouds.js';
import { coverageLevel } from './scene/clouds/cloudNoise.js';
import { createPrecipitation } from './scene/createPrecipitation.js';
import { createVegetation } from './scene/vegetation.js';
import { createWildlife } from './scene/wildlife.js';
import { createEnvironment } from './scene/environment/createEnvironment.js';
import { createAdaptiveResolution } from './scene/adaptiveResolution.js';
import { CLOUD_SHADOW_STRENGTH, groundWeather, useCloudWeatherMap } from './scene/environment/groundWeatherShader.js';
import { MAX_SEGMENT_METERS, createMap, moveMapOrigin } from './map/createMap.js';
import { createDebugStats } from './ui/debugStats.js';
import { createDevPlayerControls } from './ui/devPlayerControls.js';
import { createScenePanel } from './ui/scenePanel.js';
import { createTeleportPanel } from './ui/teleportPanel.js';
import { createTestPanel } from './ui/testPanel.js';
import { createDevTest } from './ui/devTest.js';
import { BACKGROUND_FPS, MAP_RADIUS, MAX_FPS, WORLD_CURVATURE } from './config.js';

// Follow the timestamp-based GPS prediction quickly enough to avoid a visible
// trailing avatar, while keeping small GPS corrections from snapping the model.
const PLAYER_POSITION_FOLLOW_RATE = 2.5;
const MAX_GPS_PREDICTION_SECONDS = 5;
// While the GPS sees the user moving, the avatar goes on along the GPS's own speed and
// course for at most this long after a fix, then waits for the next
const MAX_SENSOR_PREDICTION_SECONDS = 1.2;
// The gait never looks slower than this while the user walks (m/s)
const MIN_WALKING_GAIT_SPEED = 0.7;
const MAX_GPS_DERIVED_SPEED = 55;
// Virtual player at full stick (m/s): fast, to cross a city while testing
const DEV_PLAYER_SPEED = 72;
// Leaving the virtual player farther than this from the GPS position jumps back
const TELEPORT_SNAP_DISTANCE = 300;
// The GPU computes in 32-bit floats: far from the world origin positions lose
// precision (half a metre at the 7,000 km of a teleport from Rome to New York), and
// the vertices of neighbouring roads stop meeting (cracks across the streets). The
// origin moves under the player when they get farther than this (1 mm precision
// there); rarely, since a few ground patterns follow world coordinates and jump a bit
const REANCHOR_DISTANCE = 10000;
// Cloud shadows glide over the map much slower than the clouds drift in the sky
const CLOUD_SHADOW_DRIFT = 0.15;

startupMark('imports');
const scene = new THREE.Scene();
const renderer = createRenderer();
startupMark('renderer');
// The GPU-ready avatar library (ASTC textures) where the device can sample it
useOptimizedLibrary(renderer);
const cameraRig = createCamera(renderer.domElement);
const { camera } = cameraRig;

const sun = addLights(scene);
handleResize(camera, renderer);

// The shadows of every avatar on the map, in one draw call
const avatarShadows = createCapsuleShadows(scene);
const playerAvatar = createPlayerAvatar(scene, avatarShadows, { waitForLook: true });
const player = playerAvatar.root;
// Without a fresh GPS fix, show the avatar on the map's own background layer. No
// geographic origin is selected and no map tiles are requested until a valid fix.
player.position.set(0, 0, 0);
player.visible = true;
const targetPosition = new THREE.Vector3();
const gpsVelocity = new THREE.Vector3();
const predictedPosition = new THREE.Vector3();
let targetHeading = 0;
let playerSpeed = 0;
// The app's motion (usePlayerLocation): whether the user moves (GPS, with the steps to
// confirm a walk), at what cadence (steps/s), and how many steps so far (each new one of
// a walk lands a foot). Sensors never move the avatar: only GPS positions do.
let sensorMotion = false;
let sensorMoving = false;
let stepCadence = 0;
let lastStepCount = null;
let hasReceivedLocation = false;
let worldOriginAnchoredToPlayer = false;
let lastGpsLatLon = null;
let lastGpsFixTimestamp = null;
let lastGpsFixReceivedAt = null;
let lastGpsFixAgeSeconds = 0;
const previousPlayerPosition = new THREE.Vector3();
const playerMovement = new THREE.Vector3();
const devForward = new THREE.Vector3();
const devRight = new THREE.Vector3();
const devMove = new THREE.Vector3();

// Time of day and weather drive the sky, clouds, light, fog and precipitation
const environment = createEnvironment();
const sky = createSky(scene, renderer);
const clouds = createClouds(renderer);
startupMark('sky+clouds');
const precipitation = createPrecipitation(scene);
// The centre of the view: the player, or the place the camera flew to (an event).
// Tiles load around it, and the fog and the curvature of the world are centred on it,
// so a place the camera looks at is clear and flat like the player's surroundings.
const viewCenter = new THREE.Object3D();
const geo = createMap(scene, camera, renderer, viewCenter, { startImmediately: false });
const backgroundLayer = geo.getMapStyle().backgroundLayer;
startupMark('map object');
const postToApp = (message) => window.ReactNativeWebView?.postMessage(JSON.stringify(message));
// The drawing context taken away (iOS short of memory, a GPU reset): the app loads the
// page again, which builds the scene again from what it sends
renderer.domElement.addEventListener('webglcontextlost', (event) => {
  event.preventDefault();
  postToApp({ type: 'map-lost' });
});
// Bushes and little trees where the map has woods, scrub, parks and gardens
const vegetation = createVegetation({ scene, map: geo });
// Birds by day, fireflies on summer nights
const wildlife = createWildlife({ scene, vegetation });
// Events on the map (the app sends them: window.setMapEvents)
const beacons = createEventBeacons({
  scene,
  camera,
  map: geo,
  groundHeight: backgroundLayer.Y,
});
// The player turns to someone for a gesture, until it ends, whatever the compass:
// () => the heading towards them, followed while either walks
let faceHeading = () => 0;
let faceUntil = 0;
// The people around (the app sends them: window.setMapPeople), with their names, their
// gestures and their words in the scene
// Everyone else on the map, drawn together (their map avatars: the server makes them)
const crowd = createCrowd({ scene, renderer, shadows: avatarShadows });
const people = createNearbyPeople({
  scene,
  camera,
  map: geo,
  crowd,
  // Names keep clear of the events' badges (drawn this frame, before the people)
  obstacles: (viewport) => beacons.badgeCircles(viewport),
  groundHeight: backgroundLayer.Y,
  player: {
    root: player,
    avatar: playerAvatar,
    face: (towards, seconds) => {
      faceHeading = towards;
      faceUntil = performance.now() + seconds * 1000;
    },
  },
});
// Test events and people of the developer panel, shown with the app's (ui/devTest.js)
const devTest = createDevTest({
  beacons,
  people,
  geo,
  camera,
  player,
  environment,
  wildlife,
  select: {
    event: (id) => window.focusMapEvent(id),
    person: (id) => window.setSelectedPerson(id),
  },
});
// What the camera looks at, away from the player: an event, or someone tapped
let focus = null;
const drawingSize = new THREE.Vector2();
const mapTapFeedback = createMapTapFeedback({
  scene,
  camera,
  domElement: renderer.domElement,
  map: geo,
  groundHeight: backgroundLayer.Y,
  // A tap on someone or on an event opens it; anywhere else it closes what is open
  onTap: (clientX, clientY, bounds) => {
    const person = people.pick(clientX, clientY, bounds);
    // Test things (developer panel) are selected here: the app does not know them
    if (devTest.tap(person, beacons.pick(clientX, clientY, bounds))) return true;
    if (person === 'me') {
      postToApp({ type: 'player-tap' });
      return true;
    }
    if (person) {
      postToApp({ type: 'person-tap', id: person });
      return true;
    }
    const id = beacons.pick(clientX, clientY, bounds);
    postToApp(id ? { type: 'event-tap', id } : { type: 'map-tap' });
    return !!id;
  },
  // Holding a finger on the map: a new event right there; the player's place too (the
  // app makes flash events only near it)
  onLongPress: (point) => {
    // A new event is placed from where the user really is: not before the GPS says so
    if (!worldOriginAnchoredToPlayer || !hasReceivedLocation) return;
    const { lat, lon } = geo.worldToLatLon(point.x, point.z);
    const at = geo.worldToLatLon(player.position.x, player.position.z);
    postToApp({ type: 'map-long-press', latitude: lat, longitude: lon, playerLatitude: at.lat, playerLongitude: at.lon });
  },
});
// Split like the map, so it bends with the curved world (createMap.js)
const fallbackSegments = Math.ceil((MAP_RADIUS * 2) / MAX_SEGMENT_METERS);
const fallbackGround = new THREE.Mesh(
  new THREE.PlaneGeometry(MAP_RADIUS * 2, MAP_RADIUS * 2, fallbackSegments, fallbackSegments),
  backgroundLayer.material,
);
fallbackGround.name = 'gps-fallback-ground';
fallbackGround.rotation.x = -Math.PI / 2;
fallbackGround.position.y = backgroundLayer.Y;
fallbackGround.renderOrder = backgroundLayer.renderingOrder;
fallbackGround.receiveShadow = backgroundLayer.receiveShadow;
fallbackGround.castShadow = backgroundLayer.castShadow;
scene.add(fallbackGround);
cameraRig.centerOn(player.position, targetHeading);

// Shaders: nothing waits for them (shaderGate.js). What the user sees most comes first
startupMark('objects');
const PRIORITY = { sky: 0, ground: 1, flatLayers: 2, buildings: 3, player: 4, clouds: 5, cloudShadows: 6, others: 7 };
const isPartOfPlayer = (object) => {
  for (let parent = object; parent; parent = parent.parent) if (parent === player) return true;
  return false;
};
const shaders = createShaderGate(renderer, scene, camera, {
  priorityOf: (object) => {
    if (object === sky.mesh) return PRIORITY.sky;
    if (object === fallbackGround || object.name === 'ThreeGeoPlayGround') return PRIORITY.ground;
    if (object.userData.threeGeoPlay) return object.userData.kind === 'building' ? PRIORITY.buildings : PRIORITY.flatLayers;
    return isPartOfPlayer(object) ? PRIORITY.player : PRIORITY.others;
  },
});
let cloudPassesWaiting = clouds.passes.length;
for (const pass of clouds.passes) {
  shaders.addPass({ ...pass, priority: PRIORITY.clouds, onReady: () => { cloudPassesWaiting--; } });
}
shaders.addPass({ ...useCloudWeatherMap(renderer, clouds.weatherMap), priority: PRIORITY.cloudShadows });
// The first ones at once: the compiler starts on them while the page finishes loading
shaders.begin();
shaders.end();
startupMark('shaders asked');

let stats = null;
let devPlayerControls = null;
let scenePanel = null;
let teleportPanel = null;
let testPanel = null;
let devPlayerMode = false;
let devPlayerHeading = 0;
let debugStatsEnabled = false;
let devToolsAvailable = false;
let devToolsTapCount = 0;
let devToolsLastTapAt = 0;
let devToolsTapStart = null;

const DEV_TOOLS_TAP_COUNT = 6;
const DEV_TOOLS_TAP_GAP_MS = 650;
const DEV_TOOLS_TAP_MAX_DURATION_MS = 500;
const DEV_TOOLS_TAP_MAX_MOVEMENT_PX = 14;

window.setMapDebugStatsEnabled = (enabled) => {
  const shouldEnable = enabled === true;
  if (shouldEnable && !devToolsAvailable) return;
  if (shouldEnable === debugStatsEnabled) return;
  debugStatsEnabled = shouldEnable;
  if (shouldEnable) {
    stats = createDebugStats(renderer, geo);
    devPlayerControls = createDevPlayerControls((enabled) => {
      devPlayerMode = enabled;
      devPlayerHeading = player.rotation.y;
      // Back to GPS after a teleport: jump back to the real position at once
      if (!enabled && lastGpsLatLon && player.position.distanceTo(targetPosition) > TELEPORT_SNAP_DISTANCE) {
        placePlayer(lastGpsLatLon.latitude, lastGpsLatLon.longitude);
      }
    });
    scenePanel = createScenePanel(environment);
    teleportPanel = createTeleportPanel(({ latitude, longitude }) => {
      // The virtual player keeps the GPS from pulling the avatar back
      devPlayerControls.setEnabled(true);
      placePlayer(latitude, longitude);
    });
    testPanel = createTestPanel(devTest.actions);
    // Console access for testing the scene: mapDebug.environment.setTimeOverride(18)…
    Object.assign(window.mapDebug, { environment, cameraRig, player, groundWeather, renderer, scene, clouds, crowd, beacons, people, vegetation, wildlife, adaptiveResolution, devTest });
  } else {
    // Return to GPS before disposing the virtual-player control and its callback.
    devPlayerControls?.setEnabled(false);
    stats?.dispose();
    stats = null;
    devPlayerControls?.dispose();
    devPlayerControls = null;
    scenePanel?.dispose();
    scenePanel = null;
    teleportPanel?.dispose();
    teleportPanel = null;
    testPanel?.dispose();
    testPanel = null;
    devPlayerMode = false;
  }
};

const resetDevToolsTapSequence = () => {
  devToolsTapCount = 0;
  devToolsLastTapAt = 0;
  devToolsTapStart = null;
};

const isDevToolsControl = (target) => target instanceof Element && !!target.closest(
  'button, input, select, textarea, [role="application"], .scene-panel, #debug-stats',
);

const onDevToolsPointerDown = (event) => {
  if (!devToolsAvailable || event.button !== 0 || event.isPrimary === false || isDevToolsControl(event.target)) {
    resetDevToolsTapSequence();
    devToolsTapStart = null;
    return;
  }
  devToolsTapStart = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    at: performance.now(),
    moved: false,
  };
};

const onDevToolsPointerMove = (event) => {
  if (!devToolsTapStart || devToolsTapStart.pointerId !== event.pointerId) return;
  if (Math.hypot(event.clientX - devToolsTapStart.x, event.clientY - devToolsTapStart.y) > DEV_TOOLS_TAP_MAX_MOVEMENT_PX) {
    devToolsTapStart.moved = true;
  }
};

const onDevToolsPointerUp = (event) => {
  const start = devToolsTapStart;
  devToolsTapStart = null;
  if (!start || start.pointerId !== event.pointerId) return;

  const now = performance.now();
  const moved = Math.hypot(event.clientX - start.x, event.clientY - start.y);
  if (now - start.at > DEV_TOOLS_TAP_MAX_DURATION_MS || start.moved || moved > DEV_TOOLS_TAP_MAX_MOVEMENT_PX) {
    resetDevToolsTapSequence();
    return;
  }

  if (now - devToolsLastTapAt > DEV_TOOLS_TAP_GAP_MS) devToolsTapCount = 0;
  devToolsTapCount += 1;
  devToolsLastTapAt = now;
  if (devToolsTapCount < DEV_TOOLS_TAP_COUNT) return;

  resetDevToolsTapSequence();
  window.setMapDebugStatsEnabled(!debugStatsEnabled);
};

const onDevToolsPointerCancel = (event) => {
  if (devToolsTapStart?.pointerId === event.pointerId) resetDevToolsTapSequence();
};

window.setMapDevToolsAvailable = (available) => {
  const shouldBeAvailable = available === true;
  if (shouldBeAvailable === devToolsAvailable) return;
  devToolsAvailable = shouldBeAvailable;
  resetDevToolsTapSequence();
  if (devToolsAvailable) {
    document.addEventListener('pointerdown', onDevToolsPointerDown, true);
    document.addEventListener('pointermove', onDevToolsPointerMove, true);
    document.addEventListener('pointerup', onDevToolsPointerUp, true);
    document.addEventListener('pointercancel', onDevToolsPointerCancel, true);
  } else {
    document.removeEventListener('pointerdown', onDevToolsPointerDown, true);
    document.removeEventListener('pointermove', onDevToolsPointerMove, true);
    document.removeEventListener('pointerup', onDevToolsPointerUp, true);
    document.removeEventListener('pointercancel', onDevToolsPointerCancel, true);
    window.setMapDebugStatsEnabled(false);
  }
};

// The first position anchors the map: its geographic origin, and the start of
// tile loading. MAP_CONFIG.originLatLon must never place the player.
const anchorWorldOrigin = (latitude, longitude) => {
  if (worldOriginAnchoredToPlayer) return;
  fallbackGround.removeFromParent();
  moveMapOrigin(geo, latitude, longitude);
  geo.start();
  worldOriginAnchoredToPlayer = true;
  beacons.relayout();
  beacons.setVisible(true);
  people.relayout();
};

// The first GPS fix. From nothing the view starts there. From where the phone last was: a few
// metres are walked (the usual easing), more are a jump, with the view keeping its angle and zoom
const GLIDE_FROM_PROVISIONAL_M = 25;
const firstFixShift = new THREE.Vector3();
function arriveAtFirstFix() {
  if (hasReceivedLocation) return;
  hasReceivedLocation = true;
  startupMark('first position');
  player.visible = true;
  if (devPlayerMode) return;
  if (!provisionalShown) {
    player.position.copy(targetPosition);
    player.rotation.y = -targetHeading;
    cameraRig.centerOn(player.position, targetHeading);
    return;
  }
  firstFixShift.subVectors(targetPosition, player.position);
  firstFixShift.y = 0;
  if (firstFixShift.length() <= GLIDE_FROM_PROVISIONAL_M) return;
  player.position.add(firstFixShift);
  previousPlayerPosition.copy(player.position);
  predictedPosition.copy(player.position);
  cameraRig.shift(firstFixShift);
}

// Where the phone last was, before the first GPS fix (usePlayerLocation): the map draws around
// it. Nothing is decided on it: the app acts, and tells the server, only on GPS fixes
let provisionalShown = false;
window.setMapProvisionalLocation = ({ latitude, longitude } = {}) => {
  if (hasReceivedLocation || provisionalShown || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
  provisionalShown = true;
  startupMark('provisional position');
  anchorWorldOrigin(latitude, longitude);
  environment.setLocation(latitude, longitude);
  const world = geo.latLonToWorld(latitude, longitude);
  for (const position of [player.position, targetPosition, predictedPosition, previousPlayerPosition]) position.set(world.x, 0, world.z);
  cameraRig.centerOn(player.position, targetHeading);
};

// Moves the world origin to a place: the tiles follow by themselves (three-geo-play),
// the events and the people are laid out again from their coordinates
const moveWorldOrigin = (latitude, longitude) => {
  moveMapOrigin(geo, latitude, longitude);
  beacons.relayout();
  people.relayout();
};

// Keeps the origin near the player as they travel (see REANCHOR_DISTANCE): everything
// in world coordinates moves by the same step, so nothing jumps on screen
const reanchorShift = new THREE.Vector3();
const keepWorldOriginNear = () => {
  if (!worldOriginAnchoredToPlayer || cameraRig.isAway()) return;
  if (Math.hypot(player.position.x, player.position.z) < REANCHOR_DISTANCE) return;
  const { lat, lon } = geo.worldToLatLon(player.position.x, player.position.z);
  moveWorldOrigin(lat, lon);
  const world = geo.latLonToWorld(lat, lon);
  reanchorShift.set(world.x - player.position.x, 0, world.z - player.position.z);
  for (const position of [player.position, targetPosition, predictedPosition, previousPlayerPosition]) position.add(reanchorShift);
  cameraRig.shift(reanchorShift);
};

// Puts the avatar and the camera at a place at once (developer teleport)
const placePlayer = (latitude, longitude) => {
  anchorWorldOrigin(latitude, longitude);
  // A teleport far away: the origin goes with it
  const destination = geo.latLonToWorld(latitude, longitude);
  if (Math.hypot(destination.x, destination.z) > REANCHOR_DISTANCE) moveWorldOrigin(latitude, longitude);
  const world = geo.latLonToWorld(latitude, longitude);
  player.position.set(world.x, 0, world.z);
  player.visible = true;
  environment.setLocation(latitude, longitude);
  cameraRig.centerOn(player.position, -player.rotation.y);
};

// The app's state: where the user is (GPS), where they face, and whether they move. The
// avatar goes on along the GPS velocity between two fixes, and stands still when they
// do, whatever the GPS wanders. The app also sends turns and steps between two fixes:
// those do not restart the time since the fix.
const velocityAhead = new THREE.Vector3();
const applyFusedLocation = ({ latitude, longitude, heading, speed, timestamp, moving, velocity, cadence, steps }) => {
  sensorMotion = true;
  anchorWorldOrigin(latitude, longitude);
  lastGpsLatLon = { latitude, longitude };
  if (!devPlayerMode) environment.setLocation(latitude, longitude);
  if (Number.isFinite(heading) && heading >= 0) targetHeading = THREE.MathUtils.degToRad(heading);
  const world = geo.latLonToWorld(latitude, longitude);
  targetPosition.set(world.x, 0, world.z);
  sensorMoving = moving;
  playerSpeed = Number.isFinite(speed) ? Math.max(speed, 0) : 0;
  stepCadence = moving && Number.isFinite(cadence) ? cadence : 0;
  // Metres per second east and north, as a world velocity
  if (moving && velocity && Number.isFinite(velocity.east) && Number.isFinite(velocity.north)) {
    const ahead = geo.latLonToWorld(
      latitude + velocity.north / 111320,
      longitude + velocity.east / (111320 * Math.cos(THREE.MathUtils.degToRad(latitude))),
    );
    gpsVelocity.copy(velocityAhead.set(ahead.x - world.x, 0, ahead.z - world.z));
  } else {
    gpsVelocity.set(0, 0, 0);
  }
  if (Number.isFinite(steps)) {
    if (moving && lastStepCount !== null && steps > lastStepCount) playerAvatar.step();
    lastStepCount = steps;
  }
  const fixTimestamp = Number.isFinite(timestamp) ? timestamp : Date.now();
  if (fixTimestamp !== lastGpsFixTimestamp) {
    lastGpsFixTimestamp = fixTimestamp;
    lastGpsFixReceivedAt = performance.now();
    lastGpsFixAgeSeconds = 0;
  }
  arriveAtFirstFix();
};

// Native Expo sends filtered foreground GPS fixes through the WebView bridge.
// Keep geographic projection and every 3D movement inside this renderer.
window.updatePlayerLocation = ({ latitude, longitude, heading, speed, accuracy, timestamp, moving, velocity, cadence, steps }) => {
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
  if (typeof moving === 'boolean') {
    applyFusedLocation({ latitude, longitude, heading, speed, timestamp, moving, velocity, cadence, steps });
    return;
  }
  if (Number.isFinite(heading) && heading >= 0) targetHeading = THREE.MathUtils.degToRad(heading);
  const fixTimestamp = Number.isFinite(timestamp) ? timestamp : Date.now();
  const isNewGpsFix = lastGpsFixTimestamp === null || fixTimestamp > lastGpsFixTimestamp;
  if (isNewGpsFix) {
    // The first fresh GPS fix is the geographic origin. The fallback plane is
    // scene-space only.
    anchorWorldOrigin(latitude, longitude);
    lastGpsLatLon = { latitude, longitude };
    // A teleported virtual player keeps the place it was moved to
    if (!devPlayerMode) environment.setLocation(latitude, longitude);
    const worldPosition = geo.latLonToWorld(latitude, longitude);
    if (lastGpsFixTimestamp !== null) {
      const elapsedSeconds = (fixTimestamp - lastGpsFixTimestamp) / 1000;
      const deltaX = worldPosition.x - targetPosition.x;
      const deltaZ = worldPosition.z - targetPosition.z;
      const distance = Math.hypot(deltaX, deltaZ);
      const jitterThreshold = Math.max(2, Math.min(8, (accuracy ?? 0) * 0.35));
      const measuredSpeed = elapsedSeconds > 0 ? distance / elapsedSeconds : Infinity;

      if (distance > jitterThreshold && measuredSpeed <= MAX_GPS_DERIVED_SPEED) {
        gpsVelocity.set(deltaX / elapsedSeconds, 0, deltaZ / elapsedSeconds);
      } else {
        gpsVelocity.set(0, 0, 0);
      }
    }

    targetPosition.set(worldPosition.x, 0, worldPosition.z);
    lastGpsFixTimestamp = fixTimestamp;
    lastGpsFixReceivedAt = performance.now();
    lastGpsFixAgeSeconds = Math.max(0, (Date.now() - fixTimestamp) / 1000);

    arriveAtFirstFix();
  }

  playerSpeed = Number.isFinite(speed) ? Math.max(speed, 0) : 0;
};

// The browser calls the loop at the display rate (60, 120 Hz…): frames come at most
// every 1/MAX_FPS s. The schedule advances by whole intervals, so the average is MAX_FPS.
// Off screen only the simulation runs, BACKGROUND_FPS times a second.
const frameInterval = 1000 / MAX_FPS;
const backgroundFrameInterval = 1000 / BACKGROUND_FPS;
const adaptiveResolution = createAdaptiveResolution(renderer, {
  targetFrameIntervalMs: frameInterval,
  isBusy: () => {
    const tiles = geo.getTileStats();
    return tiles.loading > 0 || tiles.rebuilding > 0;
  },
});
let nextFrame = 0;
let previousFrame = 0;
let nativeScreenActive = false;
let pageVisible = document.visibilityState !== 'hidden';
let renderingEnabled = false;

const renderFrame = (time) => {
  // Every call of the browser's loop, drawn or not: the display's own rate (adaptiveResolution.js)
  if (renderingEnabled) adaptiveResolution.displayTick(time);
  const interval = renderingEnabled ? frameInterval : backgroundFrameInterval;
  // A little early is on time: display refreshes jitter around the cap, and a
  // frame skipped for a fraction of a millisecond would halve the frame rate
  if (time < nextFrame - interval * 0.15) return;
  const frameStart = performance.now();
  // Late by more than a frame (tab in background, slow frame): restart the schedule from now
  nextFrame = time - nextFrame > interval ? time + interval : nextFrame + interval;

  const deltaSeconds = previousFrame
    ? Math.min((time - previousFrame) / 1000, renderingEnabled ? 0.1 : 1 / BACKGROUND_FPS)
    : 1 / MAX_FPS;
  previousFrame = time;
  let worldSpeed = 0;
  if (devPlayerMode && devPlayerControls) {
    const input = devPlayerControls.getInput();
    camera.getWorldDirection(devForward);
    devForward.y = 0;
    devForward.normalize();
    devRight.set(-devForward.z, 0, devForward.x);
    devMove.copy(devRight).multiplyScalar(input.x)
      .addScaledVector(devForward, -input.y);
    const inputMagnitude = Math.min(devMove.length(), 1);
    if (inputMagnitude > 0) {
      devMove.normalize();
      // Squared: half the stick walks, a full push runs (avatarLocomotion.js gaits)
      playerMovement.copy(devMove).multiplyScalar(DEV_PLAYER_SPEED * inputMagnitude ** 2 * deltaSeconds);
      player.position.add(playerMovement);
      devPlayerHeading = -Math.atan2(playerMovement.x, -playerMovement.z);
      worldSpeed = playerMovement.length() / Math.max(deltaSeconds, 0.001);
    } else {
      playerMovement.set(0, 0, 0);
    }
  } else {
    // GPS continues to update in the background, but only drives the avatar
    // while the virtual-player dev control is switched off.
    const smoothing = 1 - Math.exp(-deltaSeconds * PLAYER_POSITION_FOLLOW_RATE);
    const gpsAgeSeconds = lastGpsFixTimestamp === null
      ? 0
      : Math.min(
        lastGpsFixAgeSeconds + (time - lastGpsFixReceivedAt) / 1000,
        sensorMotion ? MAX_SENSOR_PREDICTION_SECONDS : MAX_GPS_PREDICTION_SECONDS,
      );
    predictedPosition.copy(targetPosition).addScaledVector(gpsVelocity, gpsAgeSeconds);
    previousPlayerPosition.copy(player.position);
    player.position.lerp(predictedPosition, smoothing);
    playerMovement.subVectors(player.position, previousPlayerPosition);
    worldSpeed = playerMovement.length() / Math.max(deltaSeconds, 0.001);
  }
  // Translate the camera rig with GPS movement while preserving its yaw
  // and zoom distance.
  cameraRig.followMovement(playerMovement);
  const avatarHeading = performance.now() < faceUntil ? faceHeading() : devPlayerMode ? devPlayerHeading : -targetHeading;
  const headingDelta = THREE.MathUtils.euclideanModulo(avatarHeading - player.rotation.y + Math.PI, Math.PI * 2) - Math.PI;
  player.rotation.y += headingDelta * Math.min(1, deltaSeconds * 5);
  // Walking: the user's steps (sensors), else the GPS speed and the avatar's own motion
  const moving = devPlayerMode ? worldSpeed > 0.12 : sensorMotion ? sensorMoving : playerSpeed > 0.35 || worldSpeed > 0.12;
  const gaitSpeed = !devPlayerMode && sensorMotion ? (sensorMoving ? Math.max(playerSpeed, MIN_WALKING_GAIT_SPEED) : 0) : worldSpeed;
  playerAvatar.setMoving(moving);
  playerAvatar.update(time / 1000, gaitSpeed, devPlayerMode ? 0 : stepCadence);

  keepWorldOriginNear();
  cameraRig.update(deltaSeconds);
  viewCenter.position.copy(cameraRig.isAway() ? cameraRig.target : player.position);
  const env = environment.update(deltaSeconds);
  sun.update(player.position, env);
  fogOrigin.copy(viewCenter.position);
  beacons.update(deltaSeconds, fogOrigin, env.fogFar, env.streetLights);
  renderer.getSize(drawingSize);
  people.update(deltaSeconds, time / 1000, fogOrigin, { width: drawingSize.x, height: drawingSize.y });
  // After everyone moved and took this frame's pose
  avatarShadows.update(env.lightDirection, env.shadowStrength);
  scene.fog.color.copy(env.haze);
  sceneGrade.haze.copy(env.haze).convertLinearToSRGB();
  sceneGrade.hazeSun.copy(env.hazeSun).convertLinearToSRGB();
  // The fog and the curvature of the world are fixed, whatever the camera does. The
  // horizon melts into the haze through a band measured on the view angle
  // (horizontalFog.js) at the slope where the curved ground drops out of sight
  // from the camera: plain geometry of the fixed world, seen from the camera's height
  const cameraHeight = Math.max(camera.position.y - player.position.y, 1);
  sceneGrade.horizonSlope.value = 2 * Math.sqrt(cameraHeight * WORLD_CURVATURE);
  scene.fog.near = env.fogNear;
  scene.fog.far = env.fogFar;
  fitFarPlane(camera, scene.fog);
  sceneGrade.tint.copy(env.tint);
  updateAvatarLighting(env);
  sceneGrade.saturation.value = env.saturation;
  sceneGrade.streetLights.value = env.streetLights;
  groundWeather.cloudShadow.set(
    env.cloudOffset.x * CLOUD_SHADOW_DRIFT,
    env.cloudOffset.y * CLOUD_SHADOW_DRIFT,
    coverageLevel(clouds.weatherMap, env.cloudCover),
    CLOUD_SHADOW_STRENGTH * env.cloudShadowStrength,
  );
  groundWeather.surface.set(env.wetness, env.rain, env.snowCover, env.time);
  groundWeather.glintDirection.copy(env.sunVisibility >= env.moonVisibility ? env.sunDirection : env.moonDirection);
  groundWeather.glint.copy(env.glint);
  groundWeather.reflection.copy(env.reflection);
  sceneGrade.farTint.copy(env.farTint);
  precipitation.update(camera, env, player.position);
  vegetation.update();
  if (worldOriginAnchoredToPlayer) {
    const pixelRatio = renderer.getPixelRatio();
    wildlife.update(deltaSeconds, env, camera, viewCenter.position, drawingSize.y * pixelRatio, pixelRatio);
  }
  mapTapFeedback.update(deltaSeconds);
  geo.onFrameUpdate();
  // A few frames are left undrawn while the display's own rate is heard (about a tenth of a
  // second, before the resolution would be lowered): the world went on, the picture stays
  const drawing = renderingEnabled && !adaptiveResolution.probing;
  if (drawing) {
    adaptiveResolution.frameStarting();
    stats?.frameStarting();
    if (!cloudPassesWaiting) clouds.render(camera, env, deltaSeconds);
  }
  sky.update(camera, env, clouds);
  if (drawing) {
    shaders.begin();
    renderer.render(scene, camera);
    shaders.end();
    startupMark('first frame');
    adaptiveResolution.frameRendered(time);
    stats?.update(frameStart, cameraRig.takeInputStats);
    if (!allTilesMarked) markTiles();
    if (!viewShown) checkViewReady();
  }
};

// The app keeps the map under a cover (MapWebView) until the scene can be seen as it is: the
// map around the user and their own avatar, drawn, under the sky and the clouds. Seeing an
// avatar being put together is ugly. What matters less (events, birds…) comes after. A cover
// that never lifts would be worse than anything under it: without a position, or with no
// avatar sent (the avatar server down), it goes after NOTHING_COMING_TIMEOUT_MS, in any case
// after COVER_TIMEOUT_MS (no tiles, a very slow phone).
const NOTHING_COMING_TIMEOUT_MS = 10000;
const COVER_TIMEOUT_MS = 20000;
// Frames drawn complete before it goes: the last one must have reached the screen
const VIEW_READY_FRAMES = 2;
const pageStart = performance.now();
let viewShown = false;
let completeFrames = 0;
let avatarSettled = false;
let allTilesMarked = false;
function markTiles() {
  const tiles = geo.getTileStats();
  if (tiles.ready > 0) startupMark('first tile');
  if (tiles.total > 0 && tiles.loading === 0 && tiles.rebuilding === 0) {
    startupMark('all tiles');
    allTilesMarked = true;
  }
}
function checkViewReady() {
  const tiles = geo.getTileStats();
  const located = hasReceivedLocation || provisionalShown;
  const complete = located && avatarSettled && tiles.total > 0 && tiles.loading === 0 && tiles.rebuilding === 0
    && !cloudPassesWaiting && shaders.drewUpTo(PRIORITY.clouds);
  completeFrames = complete ? completeFrames + 1 : 0;
  const waited = performance.now() - pageStart;
  const expecting = located && avatarSettled;
  if (completeFrames < VIEW_READY_FRAMES && waited < (expecting ? COVER_TIMEOUT_MS : NOTHING_COMING_TIMEOUT_MS)) return;
  viewShown = true;
  startupMark('view');
  // Nobody at all would be worse: the stand-in, if the avatar is not there by now
  playerAvatar.revealStandIn();
  postToApp({ type: 'view-ready' });
}

const syncRenderingState = () => {
  renderingEnabled = nativeScreenActive && pageVisible;
  if (renderingEnabled) {
    nextFrame = 0; // draw at once, not at the end of a background interval
  }
};

// What the app knows of the display (MapWebView): the most frames a second it shows now
// (30 on an iPhone in Low Power Mode), or null when it knows of no limit. The frame rate
// asked for stays the same; only what counts as "too slow" follows (adaptiveResolution.js)
window.setMapDisplayLimit = (fps) => adaptiveResolution.setDisplayLimit(Number.isFinite(fps) ? fps : 0);

window.setMapActive = (active) => {
  nativeScreenActive = active === true;
  syncRenderingState();
};

window.addEventListener('pagehide', () => {
  mapTapFeedback.dispose();
  people.dispose();
  cameraRig.dispose();
});

document.addEventListener('visibilitychange', () => {
  pageVisible = document.visibilityState !== 'hidden';
  syncRenderingState();
});

// Keep the simulation and animation clocks alive (slowly) when the map is not on
// screen, but skip WebGL draw calls until it is visible again.
renderer.setAnimationLoop(renderFrame);
// The user's own avatar on the map (the app sends it: see MapWebView)
// Settled once the latest look asked for is shown, or could not be (the stand-in
// stays, and the look is asked again, ever later: the network may be back). An
// earlier request ends as soon as a newer one starts: it settles nothing.
let avatarRequest = 0;
let playerLook = null;
let playerLookFailures = 0;
let playerLookRetry = null;
const showPlayerLook = (plan) => {
  const id = ++avatarRequest;
  clearTimeout(playerLookRetry);
  playerLookRetry = null;
  return playerAvatar.setLook(plan).then((shown) => {
    if (id !== avatarRequest) return;
    if (shown) {
      playerLookFailures = 0;
      return;
    }
    playerAvatar.revealStandIn();
    playerLookFailures++;
    playerLookRetry = setTimeout(() => showPlayerLook(plan), Math.min(60000, 2000 * 2 ** Math.min(playerLookFailures, 5)));
  }).finally(() => {
    if (id === avatarRequest) {
      avatarSettled = true;
      startupMark('avatar');
    }
  });
};
window.setPlayerAvatar = (plan) => {
  playerLook = plan;
  playerLookFailures = 0;
  return showPlayerLook(plan);
};
// Whatever could not load is asked again at once: the tiles and the avatars. The page does it when the browser says it is online again, and the app
// when its own network check sees it come back (MapWebView)
const retryLoading = () => {
  geo.retryDownloads();
  crowd.retry();
  if (playerLookFailures > 0 && playerLook) showPlayerLook(playerLook);
};
window.retryMapLoading = retryLoading;
addEventListener('online', retryLoading);
// The events around (eventBeacons.js for the fields)
window.setMapEvents = (events) => devTest.setAppEvents(events);
// The live weather at the player: { data (Open-Meteo's answer), fetchedAt } (the app
// asks for it: the page makes no request of its own but the tiles and avatar files)
window.setMapWeather = (weather) => environment.setLiveWeather(weather);
// Flies the view to an event and marks it, or (null) back to the player
window.focusMapEvent = (id) => {
  const point = id ? beacons.positionOf(id) : null;
  if (point) {
    beacons.setSelected(id);
    cameraRig.flyTo(point);
    focus = 'event';
  } else {
    beacons.setSelected(null);
    if (focus === 'event') {
      cameraRig.flyBack(player.position);
      focus = null;
    }
  }
};
// The place of an event being created (long press), or null
window.setMapDraftPin = (point) => beacons.setDraft(point);
// The people around (nearbyPeople.js for the fields), the look of one of them (a
// render plan, like setPlayerAvatar's) and the one whose card is open (or null)
window.setMapPeople = (list) => devTest.setAppPeople(list);
// Someone's map avatar, as the server made it: { model, astc, png } (file URLs)
window.setPersonAvatar = (id, files) => people.setLook(id, files);
// The map avatar people wear until theirs has arrived: { model, astc, png }
window.setPeopleStandIn = (files) => crowd.setStandIn(files);
// The map avatars of the user's connections ([{ model, astc, png }]): kept on the
// device after everyone else's (avatar/src/fileCache.js), so friends show at once
window.keepPeopleAvatars = (list) => avatarFiles.pin('connections', list.flatMap((files) => [files.model, files.astc, files.png]).filter(Boolean), { rank: 1 });
// The one whose card is open (or null): the camera flies to them and comes close, as
// to an event (the place sits above the card), and follows them while they walk
window.setSelectedPerson = (id) => {
  people.setSelected(id);
  if (id && people.positionOf(id)) {
    cameraRig.flyTo(() => people.positionOf(id));
    focus = 'person';
  } else if (focus === 'person') {
    cameraRig.flyBack(player.position);
    focus = null;
  }
};
// A gesture: { from: 'me' | id, to: 'me' | id | null, url (emote), emoji }
window.playMapGesture = (gesture) => people.gesture(gesture);
// Words over someone's head: { from: 'me' | id, text, seconds?, everyone? (said to
// everyone around: a megaphone bubble) }
window.showMapBubble = (bubble) => people.say(bubble);
startupMark('map-ready');
window.mapStartupMarks = startupMarks;
postToApp({ type: 'map-ready' });
