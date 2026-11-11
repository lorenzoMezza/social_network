// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { look } from '../../looks/index.js';

// The colours of the scene through the day, by sun altitude in degrees, from the
// look (looks/): between two stops every value is interpolated, so dawn and dusk are
// smooth. See looks/index.js for what each value does.
const STOPS = look.atmosphere;

const COLOR_KEYS = ['zenith', 'horizon', 'haze', 'hazeSun', 'light', 'ambientSky', 'ambientGround', 'cloudLit', 'cloudShade'];
const NUMBER_KEYS = ['lightIntensity', 'ambientIntensity', 'saturation', 'stars'];

// Colours converted once to linear THREE.Colors
const stops = STOPS.map((stop) => {
  const converted = { altitude: stop.altitude, tint: new THREE.Color(...stop.tint) };
  for (const key of COLOR_KEYS) converted[key] = new THREE.Color(stop[key]);
  for (const key of NUMBER_KEYS) converted[key] = stop[key];
  return converted;
});

export function createLighting() {
  const lighting = { tint: new THREE.Color() };
  for (const key of COLOR_KEYS) lighting[key] = new THREE.Color();
  return lighting;
}

// Fills `out` (from createLighting) with the colours at this sun altitude
export function sampleLighting(sunAltitudeDegrees, out) {
  const last = stops.length - 1;
  let upper = stops.findIndex((stop) => stop.altitude >= sunAltitudeDegrees);
  if (upper === -1) upper = last;
  const lower = Math.max(upper - 1, 0);
  const a = stops[lower];
  const b = stops[upper];
  const span = b.altitude - a.altitude;
  const t = span > 0 ? THREE.MathUtils.smoothstep(sunAltitudeDegrees, a.altitude, b.altitude) : 0;

  for (const key of COLOR_KEYS) out[key].copy(a[key]).lerp(b[key], t);
  for (const key of NUMBER_KEYS) out[key] = THREE.MathUtils.lerp(a[key], b[key], t);
  out.tint.copy(a.tint).lerp(b.tint, t);
  return out;
}
