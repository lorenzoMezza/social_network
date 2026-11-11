// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Cloud noise generators: pure functions, run by the build (scripts/bundleOptions.mjs)
// and baked into the bundle as bytes, so the phone does not spend a few hundred
// milliseconds of startup computing them (cloudNoise.js turns them into textures).
//  - volume, R: Perlin-Worley (billowy base shape), G: Worley fbm (detail that
//    erodes the edges)
//  - weather map, R: where clouds are (low-frequency coverage), G: how tall they grow
export const VOLUME_SIZE = 32;
export const WEATHER_SIZE = 256;

// Deterministic hash → [0, 1)
function hash3(x, y, z, seed) {
  let h = Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 2147483647) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1103515245);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
const mod = (a, n) => ((a % n) + n) % n;

// Tileable gradient noise in [0, 1] with `period` cells per side
function perlin3(x, y, z, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const xf = x - xi, yf = y - yi, zf = z - zi;
  const corner = (dx, dy, dz) => {
    const cx = mod(xi + dx, period), cy = mod(yi + dy, period), cz = mod(zi + dz, period);
    // Random unit-ish gradient from three hashes
    const gx = hash3(cx, cy, cz, seed) * 2 - 1;
    const gy = hash3(cx, cy, cz, seed + 1) * 2 - 1;
    const gz = hash3(cx, cy, cz, seed + 2) * 2 - 1;
    return gx * (xf - dx) + gy * (yf - dy) + gz * (zf - dz);
  };
  const u = fade(xf), v = fade(yf), w = fade(zf);
  const lerp = (a, b, t) => a + (b - a) * t;
  const x00 = lerp(corner(0, 0, 0), corner(1, 0, 0), u);
  const x10 = lerp(corner(0, 1, 0), corner(1, 1, 0), u);
  const x01 = lerp(corner(0, 0, 1), corner(1, 0, 1), u);
  const x11 = lerp(corner(0, 1, 1), corner(1, 1, 1), u);
  const value = lerp(lerp(x00, x10, v), lerp(x01, x11, v), w);
  return Math.min(1, Math.max(0, value * 0.9 + 0.5));
}

// Tileable cellular noise: 1 at a feature point, 0 far from any, `cells` per side
function worley3(x, y, z, cells, seed) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  let nearest = Infinity;
  for (let dz = -1; dz <= 1; dz++) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const cx = xi + dx, cy = yi + dy, cz = zi + dz;
        const wx = mod(cx, cells), wy = mod(cy, cells), wz = mod(cz, cells);
        const px = cx + hash3(wx, wy, wz, seed) - x;
        const py = cy + hash3(wx, wy, wz, seed + 7) - y;
        const pz = cz + hash3(wx, wy, wz, seed + 13) - z;
        nearest = Math.min(nearest, px * px + py * py + pz * pz);
      }
    }
  }
  return 1 - Math.min(Math.sqrt(nearest), 1);
}

// VOLUME_SIZE³ texels, RG
export function cloudVolumeData() {
  const size = VOLUME_SIZE;
  const data = new Uint8Array(size * size * size * 2);
  let i = 0;
  for (let z = 0; z < size; z++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = x / size, v = y / size, w = z / size;
        const perlin = perlin3(u * 4, v * 4, w * 4, 4, 1) * 0.6
          + perlin3(u * 8, v * 8, w * 8, 8, 2) * 0.28
          + perlin3(u * 16, v * 16, w * 16, 16, 3) * 0.12;
        const worleyLow = worley3(u * 4, v * 4, w * 4, 4, 11) * 0.625
          + worley3(u * 8, v * 8, w * 8, 8, 12) * 0.25
          + worley3(u * 16, v * 16, w * 16, 16, 13) * 0.125;
        // Perlin-Worley: Perlin's continuity with Worley's round, billowy cells
        const shape = worleyLow + perlin * (1 - worleyLow);
        const detail = worley3(u * 6, v * 6, w * 6, 6, 21) * 0.625
          + worley3(u * 12, v * 12, w * 12, 12, 22) * 0.25
          + worley3(u * 24, v * 24, w * 24, 24, 23) * 0.125;
        data[i++] = Math.round(Math.min(1, Math.max(0, (shape - 0.35) / 0.6)) * 255);
        data[i++] = Math.round(detail * 255);
      }
    }
  }
  return data;
}

// 2D value noise, tileable
function value2(x, y, period, seed) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const h = (dx, dy) => hash3(mod(xi + dx, period), mod(yi + dy, period), 0, seed);
  const top = h(0, 0) + (h(1, 0) - h(0, 0)) * u;
  const bottom = h(0, 1) + (h(1, 1) - h(0, 1)) * u;
  return top + (bottom - top) * v;
}

const fbm2 = (u, v, basePeriod, seed) =>
  value2(u * basePeriod, v * basePeriod, basePeriod, seed) * 0.55
  + value2(u * basePeriod * 2, v * basePeriod * 2, basePeriod * 2, seed + 1) * 0.28
  + value2(u * basePeriod * 4, v * basePeriod * 4, basePeriod * 4, seed + 2) * 0.17;

// WEATHER_SIZE² texels, RG
export function cloudWeatherData() {
  const size = WEATHER_SIZE;
  const data = new Uint8Array(size * size * 2);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size;
      // Stretch the coverage contrast: separate clouds with clear gaps between them.
      // Cells about a kilometre wide: many clouds spread evenly over the sky, so
      // every direction shows about the same cover (with bigger cells one cloud
      // mass over the player filled half the sky whatever the cover)
      const coverage = Math.min(1, Math.max(0, (fbm2(u, v, 9, 31) - 0.25) / 0.5));
      const height = fbm2(u, v, 3, 41);
      const index = (y * size + x) * 2;
      data[index] = Math.round(coverage * 255);
      data[index + 1] = Math.round(height * 255);
    }
  }
  return data;
}
