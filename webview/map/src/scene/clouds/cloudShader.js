// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { MAP_EDGE_SLOPE } from '../../config.js';

// Volumetric clouds, in two passes at reduced resolution, only over the rows of
// the screen above the horizon (createClouds.js):
//  1. march: every frame only one pixel of each 2×2 block (a different one each
//     frame, in turn): its view ray crosses a cloud layer (a slab between
//     CLOUD_BASE and CLOUD_TOP metres) in jittered steps, big in clear air and fine inside clouds
//  2. resolve: the new pixels are blended with the previous frames reprojected
//     (which removes the jitter noise), the other three are only reprojected.
//     Clouds change slowly: a pixel marched every fourth frame looks the same, for
//     a quarter of the cost (the technique of Horizon Zero Dawn's clouds)
// The result (premultiplied colour, alpha = opacity) is composited by the sky.
//
// Density: the weather map decides where clouds are and how tall they grow, the
// 3D Perlin-Worley noise forms their billowy mass, the Worley detail erodes only
// their edges. Light: Beer-Lambert transmittance towards the sun (two samples),
// a dual-lobe Henyey-Greenstein phase (silver lining against the sun), the
// "powder" darkening of thin edges, and an ambient term from shaded base to lit top.

const CLOUD_BASE = 1100;
const CLOUD_TOP = 3200;

// Metres covered by one repeat of the weather map and of the 3D shape noise
const WEATHER_SCALE = 10000;
const SHAPE_SCALE = 1400;
// GLSL expression of the cloud cover `cover` (0–1): how much the shape noise opens
// holes in the clouds, a lot in broken cumulus, little at full cover, where they
// close into a layer. Where clouds form at all is uCoverageLevel, measured on the
// weather map so that they cover exactly the share of the sky asked
// (cloudNoise.js coverageLevel)
const SHAPE_EROSION_GLSL = 'mix(0.95, 0.12, cover * cover)';
// The cloud mass grows over this range of the weather map, centred on the level
const MASS_SOFTNESS = 0.3;
// GLSL expression: horizontal warp (metres) of the weather map lookup at the shape
// noise coordinate q, so cloud outlines never follow its texel grid
const cloudWarpGlsl = (noise) => `(textureLod(${noise}, q * 0.31, 0.0).rg - 0.5) * 900.0`;

export const vertexShader = /* glsl */ `
  void main() {
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`;

// View ray of a pixel of the cloud history (its centre, in 0–1 screen coordinates).
// The sky is lowered towards the horizon: what is seen at the true horizon is drawn
// down at the map's edge (MAP_EDGE_SLOPE below it), and the higher up the less it
// moves (the slope of a ray grows by the same amount, scaled to stay put at 45°).
// So the clouds come down to the edge of the world, as far clouds do over a real
// horizon, instead of ending above an empty band of sky. Fixed: it never changes
// with the camera
const viewRayGlsl = /* glsl */ `
  #define CLOUD_DROP ${MAP_EDGE_SLOPE.toFixed(5)}
  // Screen direction → the direction of the sky drawn there
  vec3 raiseRay(vec3 d) {
    float level = length(d.xz);
    return normalize(vec3(d.x, (d.y + CLOUD_DROP * level) / (1.0 + CLOUD_DROP), d.z));
  }
  // The direction of the sky → where it is drawn on screen
  vec3 lowerRay(vec3 w) {
    float level = length(w.xz);
    return normalize(vec3(w.x, w.y * (1.0 + CLOUD_DROP) - CLOUD_DROP * level, w.z));
  }

  vec3 viewRay(vec2 uv) {
    vec4 farPoint = uInverseViewProjection * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
    return raiseRay(normalize(farPoint.xyz / farPoint.w - uCameraPosition));
  }

  // Distance along the ray to the flat layer at altitude "level"
  float crossing(vec3 dir, float level) {
    return (level - uCameraPosition.y) / dir.y;
  }
`;

export const fragmentShader = /* glsl */ `
  precision highp sampler3D;

  uniform mat4 uInverseViewProjection;
  uniform vec3 uCameraPosition;
  uniform sampler3D uNoise;
  uniform sampler2D uWeatherMap;
  // Size of the cloud history (pixels) and the pixel of each 2×2 block marched now
  uniform vec2 uHistorySize;
  uniform vec2 uBlockPixel;
  uniform float uFrame;
  uniform float uTime;
  uniform vec3 uLightDirection;
  uniform float uLightStrength;
  uniform vec3 uLitColor;
  uniform vec3 uShadeColor;
  uniform vec3 uHorizonColor;
  uniform float uCoverage;
  uniform float uCoverageLevel;
  uniform float uDensity;
  uniform vec2 uOffset;

  // Adaptive march: COARSE_STEPS across the layer through empty sky; inside a
  // cloud steps FINE_SHARE as long, at most MAX_SAMPLES samples in all
  #define COARSE_STEPS 12.0
  #define FINE_SHARE 0.25
  #define MAX_SAMPLES 30
  #define BASE ${CLOUD_BASE.toFixed(1)}
  #define TOP ${CLOUD_TOP.toFixed(1)}
  #define THICKNESS (TOP - BASE)
  #define MAX_DISTANCE 34000.0
  // Where the marched clouds start to fade into the far veil
  #define FAR_FADE 24000.0
  #define EXTINCTION 0.006
  #define PI 3.14159265

  float remap(float x, float a, float b) {
    return clamp((x - a) / max(b - a, 1e-4), 0.0, 1.0);
  }

  // Henyey-Greenstein, scaled so that an isotropic medium gives 1
  float phase(float mu, float g) {
    float g2 = g * g;
    return (1.0 - g2) / pow(1.0 + g2 - 2.0 * g * mu, 1.5);
  }

  ${viewRayGlsl}

  // Density at p. The weather map is read through a small warp of the 3D noise, so
  // the cloud outlines never follow its texel grid (straight, box-like walls); the
  // warp varies over kilometres, so the samples towards the light reuse the one
  // of their step (warp: in from the step, out for it).
  // How much of the detail noise this ray can resolve (set per ray): it fades out
  // with the distance, where a pixel spans more than its small features and reading
  // them would only sparkle (the 3D noise has no mipmaps)
  float detailAmount = 1.0;

  float density(vec3 p, bool withDetail, inout vec2 warp) {
    float h = (p.y - BASE) / THICKNESS;
    // Explicit levels: inside the loop (dynamic branches, early exit) implicit
    // derivatives are undefined and would pick random mip levels.
    vec3 q = vec3(p.x + uOffset.x, p.y - uTime * 1.5, p.z + uOffset.y) / ${SHAPE_SCALE.toFixed(1)};
    if (withDetail) warp = ${cloudWarpGlsl('uNoise')};
    vec2 weather = textureLod(uWeatherMap, (p.xz + uOffset + warp) / ${WEATHER_SCALE.toFixed(1)}, 0.0).rg;
    // More cover lowers the level: more of the sky gets clouds
    float cover = uCoverage;
    float mass = smoothstep(uCoverageLevel - ${(MASS_SOFTNESS / 2).toFixed(2)}, uCoverageLevel + ${(MASS_SOFTNESS / 2).toFixed(2)}, weather.r);
    // Rounded all around: the base rises towards the edges of a cloud and is
    // broken up by the noise, the top is domed; taller towers where the weather
    // map says so, and the middle of a cloud grows higher than its edges
    float top = mix(0.35, 1.0, weather.g * weather.g) * (0.55 + 0.45 * mass);
    float bottom = (1.0 - mass) * 0.22 + (warp.x / 900.0 + 0.5) * 0.08;
    float profile = smoothstep(bottom, bottom + 0.16, h) * (1.0 - smoothstep(top * 0.45, top, h));
    float base = mass * profile;
    if (base <= 0.0) return 0.0;

    float shape = textureLod(uNoise, q, 0.0).r;
    // Broken cumulus on fair days; at full cover the shape noise opens fewer
    // holes and the clouds close into a continuous layer
    float d = remap(base, (1.0 - shape) * ${SHAPE_EROSION_GLSL}, 1.0);
    if (withDetail && d > 0.0 && detailAmount > 0.0) {
      float detail = textureLod(uNoise, q * 4.7 + vec3(uTime * 0.003), 0.0).g;
      // Wispy at the base, cauliflower-like at the top
      float erosion = mix(1.0 - detail, detail, clamp(h * 3.0, 0.0, 1.0)) * 0.42 * detailAmount;
      d = remap(d, erosion, 1.0);
    }
    return d * uDensity;
  }

  void main() {
    // The pixel of the history this block marches now
    vec2 pixel = floor(gl_FragCoord.xy) * 2.0 + uBlockPixel;
    vec3 dir = viewRay((pixel + 0.5) / uHistorySize);
    vec4 result = vec4(0.0);

    if (dir.y > 0.004 && uCoverage > 0.001) {
      float t0 = crossing(dir, BASE);
      // Beyond the marched distance the layer goes on to the horizon: a veil as
      // opaque as the cover, already in the haze (else an overcast sky would end in
      // a straight edge over a band of clear blue). The march fades into it.
      float farShare = smoothstep(FAR_FADE, MAX_DISTANCE, t0);
      float farAlpha = clamp(uCoverage * 1.15, 0.0, 1.0) * 0.92;
      vec4 far = vec4(mix(uShadeColor * 1.05, uHorizonColor, 0.75) * farAlpha, farAlpha);
      result = far;
      if (t0 < MAX_DISTANCE) {
        // At grazing angles the slab is long: cap the marched length
        float t1 = min(crossing(dir, TOP), t0 + 9000.0);
        detailAmount = 1.0 - smoothstep(3500.0, 11000.0, t0);
        float coarse = (t1 - t0) / COARSE_STEPS;
        float fine = coarse * FINE_SHARE;
        // A random start per pixel, advanced by the golden ratio every frame: a
        // low-discrepancy sequence that the history averages in a few frames. Random,
        // not interleaved gradient noise: its diagonal pattern showed as combs in the
        // clouds whenever the camera turned
        float pixelNoise = fract(sin(dot(pixel, vec2(12.9898, 78.233))) * 43758.5453);
        float jitter = fract(pixelNoise + uFrame * 0.6180339887);
        float t = t0 + coarse * jitter;
        // Big steps through empty sky; on reaching a cloud, one step back and fine
        // steps through it (back to big ones after a stretch of clear air). The
        // clouds are sampled four times as densely, so each frame is far less
        // noisy and they stay steady when the camera moves
        bool inCloud = false;
        int clearSteps = 0;

        float mu = dot(dir, uLightDirection);
        float scatter = mix(phase(mu, 0.6), phase(mu, -0.25), 0.35);
        float transmittance = 1.0;
        vec3 radiance = vec3(0.0);

        for (int i = 0; i < MAX_SAMPLES; i++) {
          if (t > t1) break;
          vec3 p = uCameraPosition + dir * t;
          vec2 warp;
          float rho = density(p, true, warp);
          if (rho > 0.002 && !inCloud) {
            inCloud = true;
            t = max(t - coarse + fine, t0);
            continue;
          }
          if (rho > 0.002) {
            clearSteps = 0;
            float h = clamp((p.y - BASE) / THICKNESS, 0.0, 1.0);
            // Optical depth towards the light, two cheap samples
            float towardsLight = density(p + uLightDirection * 160.0, false, warp) * 160.0
              + density(p + uLightDirection * 480.0, false, warp) * 320.0;
            float beer = exp(-towardsLight * EXTINCTION);
            float powder = 1.0 - exp(-rho * 4.0);
            vec3 direct = uLitColor * uLightStrength * beer * mix(1.0, scatter, 0.55) * mix(0.45, 1.0, powder);
            // Shaded, cool base; the top catches some light from the sky
            vec3 ambient = uShadeColor * mix(0.75, 1.15, h);
            vec3 source = direct * 1.1 + ambient;

            float stepTransmittance = exp(-rho * EXTINCTION * fine);
            radiance += transmittance * source * (1.0 - stepTransmittance);
            transmittance *= stepTransmittance;
            if (transmittance < 0.03) break;
          } else if (inCloud && ++clearSteps > 4) {
            inCloud = false;
          }
          t += inCloud ? fine : coarse;
        }

        float alpha = 1.0 - transmittance;
        // Aerial perspective: far clouds melt into the haze of the horizon
        float haze = 1.0 - exp(-t0 / 15000.0);
        radiance = mix(radiance, uHorizonColor * alpha, haze * 0.7);
        result = mix(vec4(radiance, alpha), far, farShare);
      }
    }
    gl_FragColor = result;
  }
`;

// Resolve: the full cloud history from this frame's marched pixels and the
// previous history, reprojected to where the same piece of cloud was on screen.
// The point reprojected is on the ray in the middle of the cloud layer, so
// moving the camera (walking, zooming up and down) keeps the clouds fixed in the
// world, with their real parallax. The reprojected colour is then clamped to the
// range of the freshly marched pixels around it: whatever moved or came into view
// takes the new look at once instead of smearing or shaking (the neighbourhood
// clamp of temporal antialiasing). Still, the history averages the jitter noise.
export const resolveFragmentShader = /* glsl */ `
  uniform mat4 uInverseViewProjection;
  uniform mat4 uPreviousViewProjection;
  // How far the wind moved the clouds since the previous frame (metres, x and z):
  // a piece of cloud seen now along a ray was there, that much upwind, before
  uniform vec2 uCloudShift;
  uniform vec3 uCameraPosition;
  uniform sampler2D uMarch;
  uniform sampler2D uHistory;
  uniform vec2 uHistorySize;
  uniform vec2 uBlockPixel;
  uniform float uHistoryWeight;
  // 0 still, 1 while the camera turns fast: the history then weighs less, so what
  // the turn leaves behind clears at once instead of over a couple of seconds
  uniform float uTurning;
  // Lowest row (0–1) of the previous history that was drawn; below it is stale
  uniform float uPreviousMinV;
  // Lowest row of the marched pixels drawn this frame
  uniform float uMarchFirstRow;

  #define MAX_DISTANCE 34000.0

  ${viewRayGlsl}

  // Where the point at this distance along the ray was on the previous frame's
  // screen (0–1), the clouds moved back by the wind
  vec2 previousScreen(vec3 dir, float distance) {
    vec3 point = uCameraPosition + dir * distance + vec3(uCloudShift.x, 0.0, uCloudShift.y);
    // Drawn lowered on screen (viewRay), like the clouds seen now
    vec3 drawn = lowerRay(normalize(point - uCameraPosition));
    vec4 clip = uPreviousViewProjection * vec4(uCameraPosition + drawn * 1000.0, 1.0);
    return clip.xy / clip.w * 0.5 + 0.5;
  }

  // The history at a point between its pixels, Catmull-Rom filtered in 5 bilinear
  // reads: a bilinear read blurs a little, and as the camera turns the history is
  // read between pixels every frame, so the clouds would grow soft and smeared
  vec4 historyAt(vec2 uv) {
    vec2 position = uv * uHistorySize;
    vec2 center = floor(position - 0.5) + 0.5;
    vec2 f = position - center;
    vec2 f2 = f * f;
    vec2 f3 = f2 * f;
    vec2 w0 = -0.5 * f3 + f2 - 0.5 * f;
    vec2 w1 = 1.5 * f3 - 2.5 * f2 + 1.0;
    vec2 w2 = -1.5 * f3 + 2.0 * f2 + 0.5 * f;
    vec2 w3 = 0.5 * f3 - 0.5 * f2;
    vec2 w12 = w1 + w2;
    vec2 at12 = (center + w2 / w12) / uHistorySize;
    vec2 at0 = (center - 1.0) / uHistorySize;
    vec2 at3 = (center + 2.0) / uHistorySize;
    vec4 sum = textureLod(uHistory, vec2(at12.x, at0.y), 0.0) * (w12.x * w0.y)
      + textureLod(uHistory, vec2(at0.x, at12.y), 0.0) * (w0.x * w12.y)
      + textureLod(uHistory, at12, 0.0) * (w12.x * w12.y)
      + textureLod(uHistory, vec2(at3.x, at12.y), 0.0) * (w3.x * w12.y)
      + textureLod(uHistory, vec2(at12.x, at3.y), 0.0) * (w12.x * w3.y);
    float total = w12.x * w0.y + w0.x * w12.y + w12.x * w12.y + w3.x * w12.y + w12.x * w3.y;
    // The filter can overshoot a little at sharp edges
    vec4 history = max(sum / total, 0.0);
    history.a = min(history.a, 1.0);
    return history;
  }

  void main() {
    vec2 pixel = floor(gl_FragCoord.xy);
    vec2 uv = (pixel + 0.5) / uHistorySize;
    ivec2 block = ivec2(pixel) / 2;
    vec4 marched = texelFetch(uMarch, block, 0);
    bool fresh = all(equal(mod(pixel, 2.0), uBlockPixel));

    // Range of the marched pixels around this one (3×3 blocks)
    ivec2 lastBlock = textureSize(uMarch, 0) - 1;
    vec4 low = marched;
    vec4 high = marched;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        ivec2 at = clamp(block + ivec2(x, y), ivec2(0, int(uMarchFirstRow)), lastBlock);
        vec4 around = texelFetch(uMarch, at, 0);
        low = min(low, around);
        high = max(high, around);
      }
    }

    vec3 dir = viewRay(uv);
    // Where the ray crosses the middle of the cloud layer; the piece of cloud seen
    // can be anywhere between its base and its top (at most as far as the march)
    float base = MAX_DISTANCE;
    float top = MAX_DISTANCE;
    if (dir.y > 0.004) {
      base = min(crossing(dir, ${CLOUD_BASE.toFixed(1)}), MAX_DISTANCE);
      top = min(min(crossing(dir, ${CLOUD_TOP.toFixed(1)}), base + 9000.0), MAX_DISTANCE);
    }
    vec2 previousUv = previousScreen(dir, (base + top) * 0.5);
    vec4 previousClip = uPreviousViewProjection * vec4(uCameraPosition + lowerRay(dir) * 1000.0, 1.0);
    bool valid = uHistoryWeight > 0.0 && previousClip.w > 0.0
      && all(greaterThanEqual(previousUv, vec2(0.0, uPreviousMinV))) && all(lessThanEqual(previousUv, vec2(1.0)));
    // Pixels between where the base and the top of the layer were: how wrong the
    // history can be here. A turn of the camera only changes directions, so the
    // history is exact however fast it turns; walking and zooming move the camera
    // little against clouds kilometres away
    float uncertain = length((previousScreen(dir, base) - previousScreen(dir, top)) * uHistorySize);

    vec4 result;
    if (!valid) {
      // Nothing to reproject (start, or just come into view): this frame's pixels,
      // smooth and the same way for all four pixels of a block (the marched one taken
      // as is would stand out of the other three in a grid of dots until the history
      // averages it away, a second or two)
      result = textureLod(uMarch, uv, 0.0);
    } else {
      // The history is held to the range of the fresh pixels around only where it
      // may be wrong (else the clouds would turn as blocky and noisy as this frame's
      // quarter of the pixels whenever the camera turns). With a still view that range
      // changes every frame with the pixel marched in each 2×2 block, and clamping to
      // it made the history flicker in a grid
      vec4 history = historyAt(previousUv);
      float stale = smoothstep(0.5, 2.0, uncertain);
      vec4 margin = (high - low) * 0.25 + 0.015;
      history = mix(history, clamp(history, low - margin, high + margin), stale);
      // Where the history is right it averages longer: the jitter noise fades
      float weight = mix(max(uHistoryWeight, 0.97), uHistoryWeight, max(stale, uTurning));
      result = fresh ? mix(marched, history, weight) : history;
    }
    gl_FragColor = result;
  }
`;
