// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { PLAYER_AVATAR_HEIGHT, PLAYER_CAMERA_INITIAL_DISTANCE } from './playerConfig.js';

// How quickly the view glides after someone it flew to while they walk (1/s)
const FOLLOW_RATE = 3;

// Motion and framing values translated from PlayerCameraController in the ZIP.
// The reference player is about 0.0333 units tall after its 0.0185 model scale;
// this map avatar is 9 units tall, so its distances and target offset are scaled.
const CAMERA_SETTINGS = Object.freeze({
  fieldOfView: 75,
  near: 0.5,
  far: 1650,
  avatarHeight: PLAYER_AVATAR_HEIGHT,
  referenceAvatarHeight: 0.0333,
  referenceDistance: Object.freeze({
    initial: 0.03,
    min: 0.075,
    max: 0.28,
  }),
  zoomSensitivity: 1.4,
  // Raise the aim point gradually as the camera zooms out. Close zoom keeps
  // enough room below the avatar for its feet to remain visible.
  referenceHeightOffsetAtMinZoom: 0.027,
  referenceHeightOffset: 0.05,
  lookAheadAvatarHeights: 0.35,
  horizontalFactor: 0.9,
  // Keep zoom-out movement close to the requested 4:1 rise-to-retreat ratio.
  zoomOutHorizontalProgress: 0.052,
  zoomOutRisePerUnit: 0.12,
  // One finger turns the view like a plate under it, around the point it orbits (the
  // avatar): the angle the finger sweeps around it on screen is the angle the view
  // turns, so circling the avatar keeps turning the same way, and the same move of the
  // finger turns it much faster near the avatar's feet than far from them (like
  // Pokémon GO). Closer to them than this (px) it turns no faster than at this
  // distance: no jumps when the finger passes over them.
  rotationMinRadius: 30,
  // A little faster than the finger: a quarter turn of it turns the view a bit more
  rotationGain: 1.1,
  orbitVelocityResponse: 22,
  // Touches do not come in step with the frames: one frame gets none, the next two. Drawn as
  // they come, the view stops for a frame and then jumps, at any frame rate. So a touch says
  // where the view is going, and every frame it moves part of the way (time constants, s):
  // never still, never a jump, at the price of following the finger this much later. The
  // zoom more than the turn: two fingers shake more, and it is not tied to a point of the map
  orbitSmoothing: 0.03,
  zoomSmoothing: 0.07,
  // Past this many world units beyond the starting zoom the camera has turned from moving
  // back to rising: gradually, or its path has a corner the fingers feel
  zoomOutEase: 12,
  // The release carries on at the speed the finger had, dying out fast: no step down when
  // the finger lifts. A finger that stopped before lifting has no speed left to give
  orbitFriction: 24,
  maxOrbitVelocity: 5.6,
  releaseStillMs: 60,
  // Keep the wider map framing requested earlier; source zoom behavior is
  // preserved while these values are expressed in map-world units.
  initialDistance: PLAYER_CAMERA_INITIAL_DISTANCE,
});

/** Owns the fixed-orientation player-follow camera and pinch zoom. */
export function createCamera(domElement, overrides = {}) {
  const settings = { ...CAMERA_SETTINGS, ...overrides };
  const reference = settings.referenceDistance;
  const worldScale = settings.avatarHeight / settings.referenceAvatarHeight;
  const minDistance = reference.min * worldScale;
  const maxDistance = reference.max * worldScale;
  const lookAheadDistance = settings.avatarHeight * settings.lookAheadAvatarHeights;
  // `target` follows the avatar's ground position; `lookTarget` is offset
  // ahead along the view ray so the avatar sits below the visual center.
  const target = new THREE.Vector3(0, 0, 0);
  const lookTarget = new THREE.Vector3();
  const camera = new THREE.PerspectiveCamera(
    settings.fieldOfView,
    innerWidth / innerHeight,
    settings.near,
    settings.far,
  );
  const pointers = new Map();
  let orbitAngle = Math.PI / 2;
  const startingDistance = THREE.MathUtils.clamp(settings.initialDistance, minDistance, maxDistance);
  let distance = startingDistance;
  // Where the view is drawn: moving towards orbitAngle and distance, every frame
  let viewAngle = orbitAngle;
  let viewDistance = distance;
  // Touches since the last frame, and the frames a finger was down with none: what a phone
  // really delivers, for the developer overlay
  const input = { samples: 0, frames: 0, empty: 0, lastSampleAt: 0, ageTotal: 0 };
  // The camera's zoom-out with its corner rounded: 0 at the starting zoom, the same at the
  // farthest, so the framings at both ends stay as they are
  const zoomOutReach = maxDistance - startingDistance;
  const easedZoomOut = (raw) => {
    if (raw <= 0) return 0;
    const ease = settings.zoomOutEase;
    const eased = raw < ease ? (raw * raw) / (2 * ease) : raw - ease / 2;
    return eased * (zoomOutReach / Math.max(zoomOutReach - ease / 2, 1));
  };
  let previousDragX = 0;
  let previousDragY = 0;
  let dragBounds = null;
  // The orbit's centre (the avatar) on screen
  const pivotWorld = new THREE.Vector3();
  let previousDragTime = 0;
  let orbitVelocity = 0;
  let initialPinchDistance = 0;
  let initialZoomDistance = distance;
  // A flight of the view: from the pose it had to a goal, a fixed one (an event) or a
  // moving one (people walking, the player going back), eased, longer and arched when far:
  // { from: { target, distance, lead }, goal: () => pose, elapsed, seconds, arc }
  let flight = null;
  // Away from the player: looking at an event, or at someone
  let focused = false;
  // Someone the view flew to and follows while they walk: () => their ground point
  let following = null;
  // The zoom the user had before going away, restored on the way back
  let homeDistance = distance;
  // While looking at a place the view stands this far in front of it (towards the
  // camera, whatever the orbit), so the place sits higher on screen, clear of the card
  // at the bottom; the orbit still turns around the place itself
  let lead = 0;

  const pointerDistance = () => {
    const [first, second] = pointers.values();
    return Math.hypot(second.x - first.x, second.y - first.y);
  };

  // Puts `view` where the rig stands for a ground point `center`, a zoom distance, an
  // orbit angle and a lead (the source controller's equations)
  const placeCamera = (view, center, cameraDistance, angle, ahead) => {
    const referenceDistance = cameraDistance / worldScale;
    const zoomProgress = THREE.MathUtils.clamp(
      (cameraDistance - minDistance) / (maxDistance - minDistance),
      0,
      1,
    );
    const heightOffset = THREE.MathUtils.lerp(
      settings.referenceHeightOffsetAtMinZoom,
      settings.referenceHeightOffset,
      zoomProgress,
    );
    const targetHeight = settings.avatarHeight * heightOffset / settings.referenceAvatarHeight;
    const proximity = reference.min
      + THREE.MathUtils.clamp(referenceDistance, 0, 1) ** 4 * (reference.max - reference.min);

    // These are the source controller's camera equations, scaled into map units.
    const zoomOutDistance = easedZoomOut(cameraDistance - startingDistance);
    const horizontal = (cameraDistance - zoomOutDistance) * settings.horizontalFactor
      + zoomOutDistance * settings.horizontalFactor * settings.zoomOutHorizontalProgress;
    // Keep the distance-dependent pitch while leaving more sky in frame.
    const sourceVertical = (cameraDistance - (proximity * worldScale) / 2) * 0.42;
    const zoomOutRise = zoomOutDistance * settings.zoomOutRisePerUnit;
    const vertical = sourceVertical + zoomOutRise;
    const pivotX = center.x + Math.cos(angle) * ahead;
    const pivotZ = center.z + Math.sin(angle) * ahead;
    view.position.set(
      pivotX + Math.cos(angle) * horizontal,
      center.y + targetHeight + vertical,
      pivotZ + Math.sin(angle) * horizontal,
    );
    lookTarget.set(
      pivotX - Math.cos(angle) * lookAheadDistance,
      center.y + targetHeight,
      pivotZ - Math.sin(angle) * lookAheadDistance,
    );
    view.lookAt(lookTarget);
  };
  const updateCameraPose = () => placeCamera(camera, target, viewDistance, viewAngle, lead);

  // The point the view orbits around, in client px: the target itself (the player, or
  // the person or event it flew to). With a lead the camera stands farther along the
  // same ray, so it still turns around the target, not around placeCamera's pivot
  const pivotOnScreen = () => {
    const bounds = dragBounds ?? domElement.getBoundingClientRect();
    pivotWorld.copy(target).project(camera);
    return {
      x: bounds.left + ((pivotWorld.x + 1) / 2) * bounds.width,
      y: bounds.top + ((1 - pivotWorld.y) / 2) * bounds.height,
    };
  };

  const handlePointerDown = (event) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    orbitVelocity = 0;
    if (event.pointerType !== 'touch') domElement.setPointerCapture?.(event.pointerId);
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (pointers.size === 1) {
      previousDragX = event.clientX;
      previousDragY = event.clientY;
      previousDragTime = event.timeStamp;
      dragBounds = domElement.getBoundingClientRect();
    }
    if (pointers.size === 2) {
      initialPinchDistance = pointerDistance();
      initialZoomDistance = distance;
    }
  };

  const handlePointerMove = (event) => {
    if (!pointers.has(event.pointerId)) return;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    input.samples++;
    input.lastSampleAt = performance.now();

    if (pointers.size === 1) {
      const coalescedSamples = event.getCoalescedEvents?.();
      const samples = coalescedSamples?.length ? coalescedSamples : [event];
      const pivot = pivotOnScreen();
      for (const sample of samples) {
        const deltaTime = (sample.timeStamp - previousDragTime) / 1000;
        // From the pivot to the finger, and the finger's move: the angle swept around
        // the pivot (screen y points down: a move to the right below the avatar turns
        // the view the way it always did)
        const fromX = previousDragX - pivot.x;
        const fromY = previousDragY - pivot.y;
        const radius = Math.hypot(fromX, fromY);
        const swept = fromX * (sample.clientY - previousDragY) - fromY * (sample.clientX - previousDragX);
        const angleDelta = radius > 0 ? -swept * settings.rotationGain / (radius * Math.max(radius, settings.rotationMinRadius)) : 0;
        orbitAngle += angleDelta;
        if (deltaTime > 0 && deltaTime < 0.12) {
          const measuredVelocity = THREE.MathUtils.clamp(
            angleDelta / deltaTime,
            -settings.maxOrbitVelocity,
            settings.maxOrbitVelocity,
          );
          const velocityBlend = 1 - Math.exp(-deltaTime * settings.orbitVelocityResponse);
          orbitVelocity = THREE.MathUtils.lerp(orbitVelocity, measuredVelocity, velocityBlend);
        } else if (deltaTime >= 0.12) {
          // It had stopped: what it did before says nothing about now
          orbitVelocity = 0;
        }
        previousDragX = sample.clientX;
        previousDragY = sample.clientY;
        previousDragTime = sample.timeStamp;
      }
    } else if (pointers.size === 2 && initialPinchDistance > 0) {
      const currentPinchDistance = Math.max(pointerDistance(), 1);
      const pinch = (initialPinchDistance / currentPinchDistance) ** settings.zoomSensitivity;
      distance = THREE.MathUtils.clamp(initialZoomDistance * pinch, minDistance, maxDistance);
    }
  };

  const handlePointerEnd = (event) => {
    pointers.delete(event.pointerId);
    if (pointers.size === 0 && event.timeStamp - previousDragTime > settings.releaseStillMs) orbitVelocity = 0;
    if (pointers.size === 1) {
      const remaining = pointers.values().next().value;
      previousDragX = remaining.x;
      previousDragY = remaining.y;
      previousDragTime = event.timeStamp;
      dragBounds = domElement.getBoundingClientRect();
      orbitVelocity = 0;
    }
    if (pointers.size < 2) initialPinchDistance = 0;
  };

  // Use native Touch Events for fingers in WKWebView/Android WebView. They
  // preserve the browser's touch samples directly; Pointer Events remain the
  // path for mouse input on desktop. This avoids handling the same finger via
  // both event systems and keeps the drag synchronous with the touch stream.
  const onPointerDown = (event) => {
    if (event.pointerType !== 'touch') handlePointerDown(event);
  };
  const onPointerMove = (event) => {
    if (event.pointerType !== 'touch') handlePointerMove(event);
  };
  const onPointerEnd = (event) => {
    if (event.pointerType !== 'touch') handlePointerEnd(event);
  };
  const touchAsPointer = (touch, timeStamp) => ({
    pointerType: 'touch',
    pointerId: touch.identifier,
    clientX: touch.clientX,
    clientY: touch.clientY,
    timeStamp,
  });
  const forEachChangedTouch = (event, callback) => {
    for (let index = 0; index < event.changedTouches.length; index += 1) {
      callback(event.changedTouches.item(index), event.timeStamp);
    }
  };
  const onTouchStart = (event) => {
    event.preventDefault();
    forEachChangedTouch(event, (touch, timeStamp) => handlePointerDown(touchAsPointer(touch, timeStamp)));
  };
  // Passive: the canvas has touch-action none, so nothing can scroll or zoom the page, and the
  // browser need not wait for this code before going on with a touch
  const onTouchMove = (event) => {
    forEachChangedTouch(event, (touch, timeStamp) => handlePointerMove(touchAsPointer(touch, timeStamp)));
  };
  const onTouchEnd = (event) => {
    event.preventDefault();
    forEachChangedTouch(event, (touch, timeStamp) => handlePointerEnd(touchAsPointer(touch, timeStamp)));
  };

  domElement.style.touchAction = 'none';
  domElement.addEventListener('pointerdown', onPointerDown);
  domElement.addEventListener('pointermove', onPointerMove);
  domElement.addEventListener('pointerup', onPointerEnd);
  domElement.addEventListener('pointercancel', onPointerEnd);
  domElement.addEventListener('touchstart', onTouchStart, { passive: false });
  domElement.addEventListener('touchmove', onTouchMove, { passive: true });
  domElement.addEventListener('touchend', onTouchEnd, { passive: false });
  domElement.addEventListener('touchcancel', onTouchEnd, { passive: false });

  const centerOn = (position, heading = 0) => {
    flight = null;
    focused = false;
    following = null;
    lead = 0;
    target.set(position.x, position.y, position.z);
    // Keep the view behind the avatar while matching the source's orbit-angle
    // convention (camera x = cos(angle), z = sin(angle)).
    orbitAngle = Math.PI / 2 + heading;
    distance = startingDistance;
    viewAngle = orbitAngle;
    viewDistance = distance;
    updateCameraPose();
  };

  // The view follows the player, except while it looks at (or flies to) a place
  const followMovement = (movement) => {
    if (!focused && !flight) target.add(movement);
  };

  // The world origin moved under the player (main.js): everything moves with it.
  // Only while the view follows the player (a flight holds world positions of its own)
  const shift = (delta) => {
    target.add(delta);
    updateCameraPose();
  };

  // A flight lasts longer the farther it goes, and rises in an arc on long ones (the
  // view lifts to take in the way, then comes down where it lands)
  const FLIGHT_SECONDS = 1.1;
  const FLIGHT_SECONDS_MAX = 1.8;
  const FLIGHT_METRES_PER_EXTRA_SECOND = 400;
  const FLIGHT_ARC = 0.3;
  const FLIGHT_ARC_MAX = 80;
  // How far in front of an event the view stops: the place then sits higher on
  // screen, its foot clear of the card the app shows at the bottom
  const FOCUS_LEAD = 22;
  const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  // Going away from the player: the user's zoom is kept for the way back. Not when a
  // flight back is still on its way (an event closed and a person opened at once):
  // the kept one is still right.
  const leaveHome = () => {
    if (!focused && !flight) homeDistance = distance;
    focused = true;
    orbitVelocity = 0;
  };
  // goal() → { target, distance, lead }, read every frame (it may move)
  const startFlight = (goal) => {
    const travel = goal().target.distanceTo(target);
    flight = {
      from: { target: target.clone(), distance, lead },
      goal,
      elapsed: 0,
      seconds: Math.min(FLIGHT_SECONDS + travel / FLIGHT_METRES_PER_EXTRA_SECOND, FLIGHT_SECONDS_MAX),
      arc: Math.min(travel * FLIGHT_ARC, FLIGHT_ARC_MAX),
    };
  };

  // Flies the view to `point` (ground), a little higher to take in the place: an
  // event, or someone (a function answering where they are now: the view follows them)
  const flyTo = (point) => {
    leaveHome();
    following = typeof point === 'function' ? point : null;
    const where = following ?? (() => point);
    const goal = {
      target: new THREE.Vector3(),
      distance: THREE.MathUtils.clamp(startingDistance * 1.35, minDistance, maxDistance),
      lead: FOCUS_LEAD,
    };
    startFlight(() => {
      const now = where();
      if (now) goal.target.set(now.x, 0, now.z);
      return goal;
    });
  };

  // Flies back to the player (`playerPosition` is followed live while flying), with the
  // zoom the user had
  const flyBack = (playerPosition) => {
    if (!focused) return;
    focused = false;
    following = null;
    const goal = { target: playerPosition, distance: homeDistance, lead: 0 };
    startFlight(() => goal);
  };

  const advanceFlight = (deltaSeconds) => {
    if (flight) {
      flight.elapsed += deltaSeconds;
      const t = Math.min(1, flight.elapsed / flight.seconds);
      const eased = easeInOut(t);
      const goal = flight.goal();
      target.lerpVectors(flight.from.target, goal.target, eased);
      target.y = 0;
      distance = THREE.MathUtils.lerp(flight.from.distance, goal.distance, eased) + flight.arc * Math.sin(Math.PI * eased);
      lead = THREE.MathUtils.lerp(flight.from.lead, goal.lead, eased);
      if (t >= 1) flight = null;
      return;
    }
    // Someone who walks: the view glides after them
    const now = following?.();
    if (!now) return;
    const follow = 1 - Math.exp(-deltaSeconds * FOLLOW_RATE);
    target.x += (now.x - target.x) * follow;
    target.z += (now.z - target.z) * follow;
  };

  const dispose = () => {
    domElement.removeEventListener('pointerdown', onPointerDown);
    domElement.removeEventListener('pointermove', onPointerMove);
    domElement.removeEventListener('pointerup', onPointerEnd);
    domElement.removeEventListener('pointercancel', onPointerEnd);
    domElement.removeEventListener('touchstart', onTouchStart);
    domElement.removeEventListener('touchmove', onTouchMove);
    domElement.removeEventListener('touchend', onTouchEnd);
    domElement.removeEventListener('touchcancel', onTouchEnd);
  };

  updateCameraPose();

  const update = (deltaSeconds = 0) => {
    advanceFlight(Math.min(deltaSeconds, 0.1));
    if (pointers.size === 0 && Math.abs(orbitVelocity) > 0.005 && deltaSeconds > 0) {
      const elapsed = Math.min(deltaSeconds, 0.1);
      const decay = Math.exp(-settings.orbitFriction * elapsed);
      orbitAngle += orbitVelocity * (1 - decay) / settings.orbitFriction;
      orbitVelocity *= decay;
    } else if (Math.abs(orbitVelocity) <= 0.005) {
      orbitVelocity = 0;
    }
    if (deltaSeconds > 0) {
      const elapsed = Math.min(deltaSeconds, 0.1);
      viewAngle += (orbitAngle - viewAngle) * (1 - Math.exp(-elapsed / settings.orbitSmoothing));
      viewDistance += (distance - viewDistance) * (1 - Math.exp(-elapsed / settings.zoomSmoothing));
    }
    if (pointers.size > 0) {
      input.frames++;
      if (!input.samples) input.empty++;
      input.ageTotal += performance.now() - input.lastSampleAt;
    }
    input.samples = 0;
    updateCameraPose();
  };

  // Developer overlay: of the frames with a finger down since the last call, how many got no
  // touch at all, and how old the newest touch was when the frame began
  const takeInputStats = () => {
    if (!input.frames) return null;
    const stats = { emptyShare: input.empty / input.frames, ageMs: input.ageTotal / input.frames };
    input.frames = 0;
    input.empty = 0;
    input.ageTotal = 0;
    return stats;
  };

  // Developer tools: zoom (0 closest – 1 farthest) and orbit angle (radians)
  const setView = ({ zoom, angle } = {}) => {
    if (Number.isFinite(zoom)) distance = THREE.MathUtils.lerp(minDistance, maxDistance, THREE.MathUtils.clamp(zoom, 0, 1));
    if (Number.isFinite(angle)) orbitAngle = angle;
    viewAngle = orbitAngle;
    viewDistance = distance;
    orbitVelocity = 0;
    updateCameraPose();
  };

  return {
    camera,
    // Where the view looks on the ground: the player, or the place it flew to
    target,
    centerOn,
    setView,
    flyTo,
    flyBack,
    isAway: () => focused || flight !== null,
    followMovement,
    shift,
    update,
    takeInputStats,
    dispose,
  };
}
