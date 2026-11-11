// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { MAP_EDGE_SLOPE } from '../../config.js';

// Height (sine of the elevation) where a bolt of lightning leaves the clouds
const BOLT_TOP = 0.13;

// Sky dome, drawn behind everything:
//  1. gradient from the horizon to the zenith (colours of the hour and weather)
//  2. sun: disc, soft glow, and a warm band along the horizon below it
//  3. moon: disc lit on the side of the sun (its real phase) with faint earthshine
//  4. stars at night: many faint ones and a few bright ones, twinkling
//  5. the volumetric clouds (premultiplied texture, see scene/clouds/)
//  6. haze: the ground fog colour, full where the curved map drops out of sight
//     and quickly fading upwards, so the map melts into the sky without an edge
//  7. far mountains: always the same three, far apart along the horizon (never all
//     around it), low, the nearer one darker, rising out of the haze. The map bends
//     away below the horizon (world curvature) into the same haze, so the world
//     seems to go on to distant country
// The map's visible edge is below the true horizon (the world curves away more the
// higher the camera): the gradient, haze and mountains start from that edge, and the
// sun, moon and stars dim gradually as they sink towards it
// One triangle over the whole screen, drawn first, behind everything (the far map
// writes no depth, so the sky cannot be drawn after it), only where the map's ground
// is not (createSky.js: stencil). The view direction of a
// pixel: its point on the far plane, less the camera (linear across the screen,
// normalised per pixel).
export const vertexShader = /* glsl */ `
  uniform mat4 uInverseViewProjection;
  varying vec3 vDir;

  void main() {
    vec4 far = uInverseViewProjection * vec4(position.xy, 1.0, 1.0);
    vDir = far.xyz / far.w - cameraPosition;
    gl_Position = vec4(position.xy, 1.0, 1.0);
  }
`;

export const fragmentShader = /* glsl */ `
  uniform vec3 uZenith;
  uniform vec3 uHorizon;
  uniform vec3 uHaze;
  // The haze on the side of the sun (or moon)
  uniform vec3 uHazeSun;
  uniform vec3 uGlowDirection;
  uniform float uHazeHeight;
  uniform float uHorizonSlope;
  uniform vec3 uHills;
  uniform vec3 uHillsLight;
  uniform vec3 uSunDirection;
  uniform vec3 uSunColor;
  uniform float uSunVisibility;
  uniform vec3 uMoonDirection;
  uniform float uMoonVisibility;
  uniform float uMoonIllumination;
  uniform float uStars;
  uniform float uTime;
  uniform float uFlash;
  // A bolt far away: azimuth, seed, brightness (0: none)
  uniform vec3 uBolt;
  uniform sampler2D uClouds;
  uniform bool uCloudsVisible;
  uniform vec2 uResolution;

  varying vec3 vDir;

  float hash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
  }

  // One isolated mountain on the horizon: a wide base and long slopes rising to a
  // pointed peak (concave profile), with a slightly rugged outline; 0 elsewhere
  float hill(float az, float center, float halfWidth, float height, float seed) {
    float offset = mod(az - center + 3.14159265, 6.2831853) - 3.14159265;
    float t = clamp(abs(offset) / halfWidth, 0.0, 1.0);
    float slope = pow(1.0 - t, 1.7);
    float rugged = 1.0 + 0.06 * sin(az * 61.0 + seed) + 0.04 * sin(az * 137.0 + seed * 2.7);
    return slope * height * rugged;
  }

  // Height (sine of the elevation) of the skyline: always the same three
  // mountains, far apart along the horizon, the rest is open haze
  float farSkyline(float az) {
    return max(hill(az, -1.9, 0.5, 0.028, 3.0), hill(az, 0.2, 0.3, 0.022, 8.0));
  }
  float nearSkyline(float az) {
    return hill(az, 1.25, 0.46, 0.025, 5.0);
  }

  // Share of horizon haze at a height above the map's edge (sine of the elevation):
  // full at the edge, smooth there, then thinning out gradually (a long soft tail
  // instead of a wall)
  float horizonHaze(float h) {
    float x = max(h, 0.0) / uHazeHeight;
    return exp(-x * x / (1.0 + x));
  }

  // Stars of one cell grid: one possible star per cell
  float starLayer(vec3 dir, float scale, float density, float size) {
    vec2 grid = vec2(atan(dir.z, dir.x) * scale, dir.y * scale * 1.6);
    vec2 cell = floor(grid);
    vec2 offset = vec2(hash(cell + 3.1), hash(cell + 9.7)) * 0.6 + 0.2;
    float point = smoothstep(size, 0.0, length(fract(grid) - offset));
    float brightness = hash(cell + 1.7);
    float twinkle = 0.65 + 0.35 * sin(uTime * (1.2 + brightness * 2.5) + hash(cell + 7.0) * 40.0);
    return step(1.0 - density, hash(cell)) * point * (0.4 + brightness * 0.8) * twinkle;
  }

  void main() {
    vec3 dir = normalize(vDir);
    // Height above the visible edge of the map
    float above = dir.y + uHorizonSlope;
    float h = clamp(above, 0.0, 1.0);
    // Thicker air towards the horizon: sun, moon and stars dim gradually
    float extinction = smoothstep(0.0, 0.16, above);

    // 1. Gradient: the horizon colour climbs a little before giving way to the zenith
    vec3 color = mix(uHorizon, uZenith, smoothstep(0.0, 1.0, pow(h, 0.55)));

    // 2. Sun
    float mu = dot(dir, uSunDirection);
    float towardsSun = max(mu, 0.0);
    color += uSunColor * uSunVisibility * (pow(towardsSun, 6.0) * 0.18 + pow(towardsSun, 48.0) * 0.45);
    // Warm light spreading along the horizon on the side of the sun (stronger when low)
    float lowSun = 1.0 - smoothstep(0.0, 0.35, uSunDirection.y);
    color += uSunColor * pow(towardsSun, 2.5) * pow(1.0 - h, 6.0) * lowSun * 0.45
      * smoothstep(-0.15, 0.02, uSunDirection.y);
    float disc = smoothstep(0.99975, 0.99988, mu);
    // Low down the disc turns from white-hot to the colour of the light
    vec3 discColor = mix(uSunColor * 1.6, uSunColor * 4.0 + 1.0, extinction);
    color = mix(color, discColor, disc * uSunVisibility * (0.35 + 0.65 * extinction));

    // 3. Moon, about twice its real size so it reads on a phone
    float moonCos = dot(dir, uMoonDirection);
    if (uMoonVisibility > 0.0 && moonCos > 0.9985) {
      vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), uMoonDirection));
      vec3 up = cross(uMoonDirection, right);
      vec3 offset = dir - uMoonDirection * moonCos;
      vec2 local = vec2(dot(offset, right), dot(offset, up)) / 0.0165;
      float r2 = dot(local, local);
      float inside = 1.0 - smoothstep(0.92, 1.0, r2);
      // Sphere normal facing the viewer, lit where it faces the sun
      vec3 normal = right * local.x + up * local.y - uMoonDirection * sqrt(max(1.0 - r2, 0.0));
      float lit = smoothstep(-0.08, 0.12, dot(normal, uSunDirection));
      float maria = 0.86 + 0.14 * hash(floor(local * 3.0 + 7.0));
      vec3 moon = vec3(0.98, 0.96, 0.9) * maria * (lit + 0.06);
      color = mix(color, moon, inside * uMoonVisibility * (0.3 + 0.7 * extinction));
    }
    // Moon glow
    color += vec3(0.55, 0.62, 0.8) * pow(max(moonCos, 0.0), 180.0) * 0.18 * uMoonVisibility
      * (0.3 + uMoonIllumination);

    // 4. Stars: small, many faint and a few bright, a little warm or cool
    if (uStars > 0.0 && above > 0.0) {
      // Cells of a few pixels on a phone: the dots stay about 1–2 px wide
      float faint = starLayer(dir, 90.0, 0.07, 0.17) * 0.8;
      float bright = starLayer(dir, 38.0, 0.06, 0.1) * 1.8;
      vec3 starColor = mix(vec3(1.0, 0.92, 0.8), vec3(0.8, 0.88, 1.0), hash(floor(dir.xz * 40.0)));
      // Fewer and fainter towards the horizon, gone into the haze
      color += starColor * (faint + bright) * uStars * extinction * extinction;
    }

    // 5. Clouds (they cover sun, moon and stars): drawn down to the map's edge of
    // the default zoom (scene/clouds/), the rows of the cloud texture below it are not drawn
    float cloudAlpha = 0.0;
    if (uCloudsVisible && dir.y + ${MAP_EDGE_SLOPE.toFixed(5)} * length(dir.xz) > 0.0) {
      vec4 clouds = texture2D(uClouds, gl_FragCoord.xy / uResolution);
      color = color * (1.0 - clouds.a) + clouds.rgb;
      cloudAlpha = clouds.a;
    }

    // Lightning lights the whole sky
    color += vec3(0.75, 0.8, 1.0) * uFlash * (0.35 + cloudAlpha * 0.65);

    // Some strikes show their bolt, far away: a thin jagged line from the base of the
    // clouds down into the haze (a few large bends and many small kinks)
    if (uBolt.z > 0.0 && dir.y > 0.0 && dir.y < ${BOLT_TOP.toFixed(3)}) {
      float boltT = dir.y / ${BOLT_TOP.toFixed(3)};
      float kinks = boltT * 11.0;
      float bends = boltT * 3.0;
      float boltOffset = mix(hash(vec2(floor(kinks), uBolt.y)), hash(vec2(floor(kinks) + 1.0, uBolt.y)), fract(kinks)) * 0.012
        + mix(hash(vec2(floor(bends), uBolt.y + 7.0)), hash(vec2(floor(bends) + 1.0, uBolt.y + 7.0)), fract(bends)) * 0.035;
      float boltAz = mod(atan(dir.z, dir.x) - uBolt.x - boltOffset + 3.14159265, 6.2831853) - 3.14159265;
      float boltDistance = abs(boltAz) * length(dir.xz);
      float bolt = (1.0 - smoothstep(0.0007, 0.0018, boltDistance)) + exp(-boltDistance * 160.0) * 0.3;
      // It comes out of the clouds: fades in from its top, dimmer behind them
      bolt *= (1.0 - smoothstep(0.8, 1.0, boltT)) * (1.0 - cloudAlpha * 0.5);
      color += vec3(0.86, 0.9, 1.0) * bolt * uBolt.z;
    }

    // 6. Haze at the horizon, the same colour as the fog on the map: warmer (or of
    // the look's colour) on the side of the sun
    vec2 glowSide = normalize(uGlowDirection.xz + vec2(1e-4, 0.0));
    float sunSide = dot(normalize(dir.xz + vec2(1e-4, 0.0)), glowSide) * 0.5 + 0.5;
    vec3 haze = mix(uHaze, uHazeSun, sunSide * sunSide);
    color = mix(color, haze, horizonHaze(above));

    // 7. Three far mountains rising out of the haze: the farther paler, the nearer
    // a little darker; light catches their tops. Only in the low band where they
    // can be (most of the sky skips them)
    if (above < 0.033) {
      float az = atan(dir.z, dir.x);
      // They stand on the map's edge; their foot is lost in the haze
      float farHeight = farSkyline(az);
      float nearHeight = nearSkyline(az);
      float farRidge = farHeight - uHorizonSlope;
      float nearRidge = nearHeight - uHorizonSlope;
      float edge = 0.0009;
      // Only where there is a mountain; solid at the top, melting into the haze
      // towards the foot
      float farHill = smoothstep(farRidge + edge, farRidge - edge, dir.y) * smoothstep(0.0, 0.008, farHeight);
      float nearHill = smoothstep(nearRidge + edge, nearRidge - edge, dir.y) * smoothstep(0.0, 0.007, nearHeight);
      float farBody = smoothstep(0.0, 0.014, above);
      float nearBody = smoothstep(0.0, 0.012, above);
      vec3 farColor = mix(haze, uHills, 0.6 * farBody)
        + uHillsLight * smoothstep(farRidge - 0.006, farRidge, dir.y) * 0.5;
      vec3 nearColor = mix(haze, uHills, 0.85 * nearBody)
        + uHillsLight * smoothstep(nearRidge - 0.005, nearRidge, dir.y);
      color = mix(color, farColor, farHill);
      color = mix(color, nearColor, nearHill);
    }

    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`;
