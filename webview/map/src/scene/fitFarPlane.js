// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { fogOrigin } from './horizontalFog.js';

// Moves the camera far plane to the end of the fog. Beyond fogFar (horizontal
// distance from the player) everything has exactly the fog colour, which is also
// the colour of the sky at the horizon, so nothing visible changes; but nothing
// past it is drawn, and depth precision improves.
//
// The farthest visible point is at most (camera → player) + fogFar away
// horizontally, and as high as the camera at most.
const MARGIN = 1; // world units

export function fitFarPlane(camera, fog) {
  if (!fog) return;
  const toPlayer = Math.hypot(camera.position.x - fogOrigin.x, camera.position.z - fogOrigin.z);
  const far = Math.hypot(toPlayer + fog.far, Math.max(camera.position.y, 0)) + MARGIN;
  if (Math.abs(camera.far - far) < MARGIN) return;
  camera.far = far;
  camera.updateProjectionMatrix();
}
