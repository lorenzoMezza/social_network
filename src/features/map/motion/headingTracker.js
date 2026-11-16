// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Where the phone points (°, from north, clockwise), smooth and quick: the gyroscope
// turns it at once, the compass keeps it true (a complementary filter). The turn
// around the vertical is the rotation rate projected on gravity, so it is right
// however the phone is held (upright, flat, tilted). Platforms report the axes with
// different signs: the sign is learned by comparing the gyroscope's turns with the
// compass's. A compass with no calibration (accuracy 0) is not used.

// How much each compass reading pulls the heading back, by its accuracy (3 best)
const COMPASS_PULL = [0, 0.04, 0.1, 0.2];
// Longest gap integrated (s): beyond it the gyroscope restarts from the compass
const MAX_GAP = 0.25;
// Sign learning: turns of at least this much (°) over a window, agreeing this many
// times in a row
const SIGN_TURN = 20;
const SIGN_VOTES = 2;

const wrap180 = (degrees) => ((degrees % 360) + 540) % 360 - 180;
const wrap360 = (degrees) => ((degrees % 360) + 360) % 360;

export function createHeadingTracker() {
  let heading = null;
  let lastT = null;
  // W3C axes (DeviceMotion): a right turn is a negative rotation around "up"
  let sign = -1;
  // Window comparing the gyroscope's turn with the compass's
  let gyroTurn = 0;
  let compassStart = null;
  let votes = 0;

  // A compass reading: { degrees, accuracy (0–3) }
  const compass = ({ degrees, accuracy }) => {
    if (!Number.isFinite(degrees) || degrees < 0 || !(accuracy > 0)) return;
    if (heading === null) {
      heading = degrees;
      compassStart = degrees;
      gyroTurn = 0;
      return;
    }
    heading = wrap360(heading + wrap180(degrees - heading) * COMPASS_PULL[Math.min(accuracy, 3)]);
    if (compassStart === null) compassStart = degrees;
    const compassTurn = wrap180(degrees - compassStart);
    if (Math.abs(compassTurn) >= SIGN_TURN && Math.abs(gyroTurn) >= SIGN_TURN * 0.5) {
      if (Math.sign(compassTurn) !== Math.sign(gyroTurn)) {
        votes += 1;
        if (votes >= SIGN_VOTES) {
          sign = -sign;
          votes = 0;
        }
      } else {
        votes = 0;
      }
      compassStart = degrees;
      gyroTurn = 0;
    }
  };

  // A motion sample: { t (s), rotationRate: { alpha, beta, gamma } (°/s, around z, x,
  // y), gravity: { x, y, z } }
  const motion = ({ t, rotationRate, gravity }) => {
    if (!rotationRate || !gravity) return;
    const g = Math.hypot(gravity.x, gravity.y, gravity.z);
    if (!(g > 1)) return;
    const previous = lastT;
    lastT = t;
    if (previous === null || heading === null) return;
    const dt = t - previous;
    if (!(dt > 0) || dt > MAX_GAP) return;
    const aroundUp = (rotationRate.beta * gravity.x + rotationRate.gamma * gravity.y + rotationRate.alpha * gravity.z) / g;
    if (!Number.isFinite(aroundUp)) return;
    // Whichever way "up" is reported, the learned sign makes a right turn positive
    const turn = sign * aroundUp * dt;
    heading = wrap360(heading + turn);
    gyroTurn += turn;
  };

  // Without a calibrated compass, a start from somewhere else (the GPS course)
  const seed = (degrees) => {
    if (heading === null && Number.isFinite(degrees) && degrees >= 0) heading = wrap360(degrees);
  };

  return {
    compass,
    motion,
    seed,
    heading: () => heading,
  };
}
