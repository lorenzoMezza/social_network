// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { startingPixelRatio } from './adaptiveResolution.js';

// Multisample antialiasing of the canvas (the browser's default). It costs only where
// edges are: a pixel inside one triangle is shaded once whatever the samples, so the
// sky (one big quad) and flat areas cost no more; the clouds are drawn into textures of
// their own, without it. Materials read this (the crowd's see-through parts use
// alpha to coverage with it: crowdBatch.js).
export const ANTIALIAS = true;

export function createRenderer() {
  // Opaque: the sky and the map cover the whole canvas (cleared to opaque black, three's
  // default, as before), so the page never has to blend it with what is under it: work
  // for every frame, nothing to see
  const renderer = new THREE.WebGLRenderer({ antialias: ANTIALIAS, alpha: false, stencil: true, powerPreference: 'high-performance' });
  // Starts at the screen's full density, at most 2.25× (MAX_PIXEL_RATIO);
  // adaptiveResolution.js lowers it if the GPU is slow.
  renderer.setPixelRatio(startingPixelRatio());
  // The first time a shader is used three.js reads its three compile logs and its link
  // status: four questions the page waits on the GPU process to answer, for each of the
  // twenty to thirty shaders, while the map starts. They only ever say something to a
  // developer: asked on the browser's dev page alone (npm run dev), as the avatar viewer does
  renderer.debug.checkShaderErrors = process.env.NODE_ENV === 'development';
  renderer.setSize(innerWidth, innerHeight);
  document.body.append(renderer.domElement);
  return renderer;
}
