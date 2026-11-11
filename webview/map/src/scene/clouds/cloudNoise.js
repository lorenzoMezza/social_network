// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { VOLUME_SIZE, WEATHER_SIZE } from './cloudNoiseData.js';
// Baked at build time from cloudNoiseData.js (scripts/bundleOptions.mjs)
import { volume, weather } from 'baked:cloud-noise';

// Cloud noise, tileable, so the cloud shader only reads textures (much cheaper on
// a phone than noise math per sample).
//  - 3D texture, R: Perlin-Worley (billowy base shape), G: Worley fbm (detail that
//    erodes the edges)
//  - 2D weather map, R: where clouds are (low-frequency coverage), G: how tall they grow

const decode = (base64) => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

export function createCloudVolumeTexture() {
  const size = VOLUME_SIZE;
  const texture = new THREE.Data3DTexture(decode(volume), size, size, size);
  texture.format = THREE.RGFormat;
  texture.wrapS = texture.wrapT = texture.wrapR = THREE.RepeatWrapping;
  texture.minFilter = texture.magFilter = THREE.LinearFilter;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  return texture;
}

export function createCloudWeatherTexture() {
  const size = WEATHER_SIZE;
  const data = decode(weather);
  const texture = new THREE.DataTexture(data, size, size, THREE.RGFormat);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = true;
  texture.unpackAlignment = 1;
  texture.needsUpdate = true;
  texture.userData.coverageLevels = coverageLevels(data);
  return texture;
}

// Sorted coverage values of the weather map (R channel, 0–1), for coverageLevel()
function coverageLevels(data) {
  const levels = new Float32Array(data.length / 2);
  for (let i = 0; i < levels.length; i++) levels[i] = data[i * 2] / 255;
  return levels.sort();
}

// The coverage value above which `share` (0–1) of the weather map lies: with the
// clouds formed above it, they cover that share of the sky
export function coverageLevel(weatherMap, share) {
  const levels = weatherMap.userData.coverageLevels;
  const index = Math.round((1 - Math.min(Math.max(share, 0), 1)) * (levels.length - 1));
  return levels[index];
}
