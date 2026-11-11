// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Where the user is and whether they are moving.
//
// THE GPS IS THE ONLY SOURCE OF THE POSITION: nothing here moves it but a GPS fix, and
// that must stay true. People meet on this map, see each other and write to each other
// because of where they are: a phone shaken on a sofa must not walk anywhere.
//
// The phone's sensors only support the GPS:
//  - they animate: steps (stepDetector.js) give the walk its rhythm and end it at once,
//    the compass and the gyroscope (headingTracker.js) say where the user faces;
//  - they hold back: with no steps, the few metres a GPS wanders around someone standing
//    are damped. They can keep the position from moving, never move it.
// The avatar walks when the steps AND the GPS agree: steps alone (a shaken phone, a
// treadmill, a walk on the spot) move nothing and animate nothing. Fast by GPS with no
// steps (a car, a tram, a phone in a bag) it moves as the GPS says.

const METRES_PER_DEGREE = 111320;
// A rhythm of steps: this many in a row at a human pace (a phone put down makes one or
// two bumps, not a rhythm), ended after this long without one (seconds, or this many
// times the last interval)
const STEPS_TO_START = 3;
const STOP_AFTER = 1.1;
const STOP_AFTER_INTERVALS = 2.2;
// Two intervals in a row this far apart are not a rhythm
const RHYTHM_RATIO = [0.55, 1.8];
// The GPS confirms a walk: a speed above this (m/s), from a fix at least this good (m)…
const CONFIRMING_SPEED = 0.5;
const CONFIRMING_ACCURACY = 30;
// …or a distance covered, beyond this and beyond the fix's accuracy, within this long (s)
const CONFIRMING_DISTANCE = 4;
const CONFIRMING_DISTANCE_ACCURACY = 1.5;
const CONFIRMING_WINDOW = 10;
// A confirmation lasts this long (s): the steps go on showing a walk between two fixes,
// not for long after the GPS stopped seeing one
const CONFIRMATION_LASTS = 5;
// Moving by GPS alone: above this speed (m/s), for this many fixes in a row. Without
// motion sensors the GPS is all there is, so a lower speed and one fix are enough.
const GPS_ONLY_SPEED = 0.9;
const GPS_ONLY_FIXES = 2;
const GPS_ONLY_SPEED_NO_SENSORS = 0.6;
// The GPS course is trusted above this speed (m/s)
const COURSE_SPEED = 0.8;
// The GPS never claims better than this (m)
const GPS_FLOOR = 3;
// Standing: a fix counts this many times less (it wanders around someone who stays)
const STANDING_DISTRUST = 25;
// A fix farther than 3 σ is ignored until this many in a row say the same: one wild fix
// (reflections between buildings) moves nobody; then the GPS is right and the user jumps
const OUTLIER_FIXES = 3;
const OUTLIER_FIXES_MOVING = 2;
const JUMP_METRES = 60;
// Longer than this without a fix (s): what the filter knew says nothing any more
const GAP_SECONDS = 30;
// Metres a step covers, only to give the gait a speed when the GPS has none (m)
const GAIT_STEP_LENGTH = 0.7;

const wrap360 = (degrees) => ((degrees % 360) + 360) % 360;
const radians = (degrees) => (degrees * Math.PI) / 180;

export function createPlayerTracker() {
  let origin = null;
  // Position (m east, m north of the first fix) and its variance (m²): GPS only
  let east = 0;
  let north = 0;
  let variance = 0;
  let lastFixAt = null;
  let outliers = 0;
  let gpsSpeed = 0;
  let gpsCourse = null;
  // Where a walk is measured from: { east, north, at (ms) }
  let anchor = null;
  // Motion clock (seconds, from tick), and on it the last fix and when the GPS last
  // confirmed a walk
  let clock = 0;
  let fixClock = 0;
  let confirmedAt = -Infinity;
  let fastFixes = 0;
  // Sensors
  let deviceHeading = null;
  let stepsAvailable = true;
  let stepCount = 0;
  let lastStep = null;
  let rhythm = 0;
  let stepping = false;
  let cadence = 0;

  const toLocal = (latitude, longitude) => ({
    east: (longitude - origin.longitude) * METRES_PER_DEGREE * origin.cos,
    north: (latitude - origin.latitude) * METRES_PER_DEGREE,
  });

  // A silent GPS says nothing about now: its last speed does not last
  const movingByGps = () => clock - fixClock <= CONFIRMATION_LASTS
    && (stepsAvailable ? fastFixes >= GPS_ONLY_FIXES : gpsSpeed > GPS_ONLY_SPEED_NO_SENSORS);
  const walkConfirmed = () => stepping && clock - confirmedAt <= CONFIRMATION_LASTS;
  const isMoving = () => movingByGps() || walkConfirmed();

  const stopStepping = () => {
    stepping = false;
    rhythm = 0;
    cadence = 0;
  };

  // A step of the detector: { t, interval }. Only rhythm for the avatar's walk: a step
  // never touches the position.
  const addStep = ({ t, interval }) => {
    stepCount += 1;
    const inRhythm = interval !== null && (lastStep?.interval == null
      || (interval / lastStep.interval >= RHYTHM_RATIO[0] && interval / lastStep.interval <= RHYTHM_RATIO[1]));
    lastStep = { t, interval };
    if (interval !== null) cadence = cadence ? cadence + (1 / interval - cadence) * 0.35 : 1 / interval;
    rhythm = inRhythm ? rhythm + 1 : 1;
    if (rhythm >= STEPS_TO_START) stepping = true;
  };

  // The time now (seconds, the motion clock): the rhythm ends when the steps stop
  const tick = (t) => {
    clock = t;
    if (!lastStep) return;
    const limit = Math.max(STOP_AFTER, (lastStep.interval ?? 0.6) * STOP_AFTER_INTERVALS);
    if (t - lastStep.t > limit) stopStepping();
  };

  // The phone's heading (°, from north, clockwise): headingTracker.js
  const setHeading = (degrees) => {
    if (Number.isFinite(degrees)) deviceHeading = wrap360(degrees);
  };

  const setStepsAvailable = (available) => {
    stepsAvailable = !!available;
  };

  const snapTo = (fix, noise) => {
    east = fix.east;
    north = fix.north;
    variance = noise;
    outliers = 0;
  };

  // Does the GPS see the user move? Its speed, or a distance beyond what it wanders
  const noteMovement = (fix, accuracy, at) => {
    const known = Number.isFinite(accuracy);
    if (known && accuracy <= CONFIRMING_ACCURACY && gpsSpeed >= CONFIRMING_SPEED) confirmedAt = clock;
    if (!anchor) {
      anchor = { ...fix, at };
      return;
    }
    const needed = Math.max(CONFIRMING_DISTANCE, (known ? accuracy : 30) * CONFIRMING_DISTANCE_ACCURACY);
    if (Math.hypot(fix.east - anchor.east, fix.north - anchor.north) >= needed) {
      confirmedAt = clock;
      anchor = { ...fix, at };
    } else if (at - anchor.at > CONFIRMING_WINDOW * 1000) {
      anchor = { ...fix, at };
    }
  };

  // A GPS fix: { latitude, longitude, accuracy, speed, heading (course), timestamp (ms) }
  const addGps = ({ latitude, longitude, accuracy, speed, heading, timestamp }) => {
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    const at = Number.isFinite(timestamp) ? timestamp : Date.now();
    const elapsed = lastFixAt === null ? 0 : Math.max((at - lastFixAt) / 1000, 0);
    lastFixAt = at;
    fixClock = clock;
    if (!origin) origin = { latitude, longitude, cos: Math.cos(radians(latitude)) };
    const fix = toLocal(latitude, longitude);
    const noise = Math.max(Number.isFinite(accuracy) ? accuracy : 30, GPS_FLOOR) ** 2;
    gpsSpeed = Number.isFinite(speed) && speed > 0 ? speed : 0;
    gpsCourse = Number.isFinite(heading) && heading >= 0 && gpsSpeed > COURSE_SPEED ? heading : null;
    fastFixes = gpsSpeed > GPS_ONLY_SPEED ? fastFixes + 1 : 0;
    noteMovement(fix, accuracy, at);

    if (variance === 0 || elapsed > GAP_SECONDS) {
      snapTo(fix, noise);
      return;
    }

    // Moving by its own speed and course, the GPS predicts where this fix should fall
    const moving = isMoving() || gpsSpeed > GPS_ONLY_SPEED;
    if (moving && gpsCourse !== null) {
      east += Math.sin(radians(gpsCourse)) * gpsSpeed * elapsed;
      north += Math.cos(radians(gpsCourse)) * gpsSpeed * elapsed;
    }
    variance += moving ? (gpsSpeed * elapsed) ** 2 + elapsed : 0.01 * elapsed;

    const apart = Math.hypot(fix.east - east, fix.north - north);
    if (apart > 3 * Math.sqrt(variance + noise)) {
      outliers += 1;
      if (outliers >= (moving || apart > JUMP_METRES ? OUTLIER_FIXES_MOVING : OUTLIER_FIXES)) snapTo(fix, noise);
      return;
    }
    outliers = 0;
    const gain = variance / (variance + (moving ? noise : noise * STANDING_DISTRUST));
    east += (fix.east - east) * gain;
    north += (fix.north - north) * gain;
    variance *= 1 - gain;
  };

  /**
   * The state to show: null before the first fix, else { latitude, longitude, accuracy
   * (m), fixedAt (ms, the GPS fix behind it), heading (°: the GPS course while moving,
   * else where the phone faces), speed (m/s), moving, velocity: { east, north } (m/s,
   * from the GPS only, zero without a course), cadence (steps/s), steps (count) }
   */
  const state = () => {
    if (!origin || variance === 0) return null;
    const moving = isMoving();
    const heading = moving && gpsCourse !== null ? gpsCourse : deviceHeading;
    const speed = !moving ? 0 : gpsSpeed > 0 ? gpsSpeed : cadence * GAIT_STEP_LENGTH;
    const course = moving && gpsCourse !== null ? radians(gpsCourse) : null;
    return {
      latitude: origin.latitude + north / METRES_PER_DEGREE,
      longitude: origin.longitude + east / (METRES_PER_DEGREE * origin.cos),
      accuracy: Math.sqrt(variance),
      fixedAt: lastFixAt,
      heading,
      speed,
      moving,
      velocity: course === null ? { east: 0, north: 0 } : { east: Math.sin(course) * gpsSpeed, north: Math.cos(course) * gpsSpeed },
      cadence: moving ? cadence : 0,
      steps: stepCount,
    };
  };

  return { addStep, addGps, setHeading, setStepsAvailable, tick, state };
}
