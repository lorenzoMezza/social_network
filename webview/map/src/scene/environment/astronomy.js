// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Sun and moon positions for a date and place, with the usual low-precision
// astronomical formulas (the ones of SunCalc / Astronomy Answers): well under a
// degree of error, plenty for lighting a map.
const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const J1970 = 2440588;
const J2000 = 2451545;
const OBLIQUITY = RAD * 23.4397;
const SUN_DISTANCE_KM = 149598000;

// `date`: a Date or ms since 1970
const toDays = (date) => date.valueOf() / DAY_MS - 0.5 + J1970 - J2000;

const rightAscension = (l, b) =>
  Math.atan2(Math.sin(l) * Math.cos(OBLIQUITY) - Math.tan(b) * Math.sin(OBLIQUITY), Math.cos(l));
const declination = (l, b) =>
  Math.asin(Math.sin(b) * Math.cos(OBLIQUITY) + Math.cos(b) * Math.sin(OBLIQUITY) * Math.sin(l));
const siderealTime = (d, lw) => RAD * (280.16 + 360.9856235 * d) - lw;

// Azimuth from south, positive towards west; altitude above the horizon
const azimuth = (H, phi, dec) => Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi));
const altitude = (H, phi, dec) => Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));

function sunCoords(d) {
  const M = RAD * (357.5291 + 0.98560028 * d);
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  const L = M + C + RAD * 102.9372 + Math.PI;
  return { dec: declination(L, 0), ra: rightAscension(L, 0) };
}

function moonCoords(d) {
  const L = RAD * (218.316 + 13.176396 * d);
  const M = RAD * (134.963 + 13.064993 * d);
  const F = RAD * (93.272 + 13.22935 * d);
  const l = L + RAD * 6.289 * Math.sin(M);
  const b = RAD * 5.128 * Math.sin(F);
  return { ra: rightAscension(l, b), dec: declination(l, b), dist: 385001 - 20905 * Math.cos(M) };
}

// World direction (x east, y up, z south) towards a body
function toDirection(target, az, alt) {
  const horizontal = Math.cos(alt);
  return target.set(-Math.sin(az) * horizontal, Math.sin(alt), Math.cos(az) * horizontal);
}

/**
 * Fills sunDirection and moonDirection (THREE.Vector3, unit, world space) and
 * returns the sun altitude in degrees and the lit fraction of the moon (0 new, 1 full).
 */
export function computeSky(date, lat, lon, sunDirection, moonDirection) {
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const d = toDays(date);

  const sun = sunCoords(d);
  const sunH = siderealTime(d, lw) - sun.ra;
  const sunAltitude = altitude(sunH, phi, sun.dec);
  toDirection(sunDirection, azimuth(sunH, phi, sun.dec), sunAltitude);

  const moon = moonCoords(d);
  const moonH = siderealTime(d, lw) - moon.ra;
  toDirection(moonDirection, azimuth(moonH, phi, moon.dec), altitude(moonH, phi, moon.dec));

  const elongation = Math.acos(
    Math.sin(sun.dec) * Math.sin(moon.dec) + Math.cos(sun.dec) * Math.cos(moon.dec) * Math.cos(sun.ra - moon.ra),
  );
  const incidence = Math.atan2(SUN_DISTANCE_KM * Math.sin(elongation), moon.dist - SUN_DISTANCE_KM * Math.cos(elongation));

  return {
    sunAltitudeDegrees: sunAltitude / RAD,
    moonIllumination: (1 + Math.cos(incidence)) / 2,
  };
}
