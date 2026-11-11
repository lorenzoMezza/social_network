// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Steps from the phone's accelerometer, for the rhythm of the avatar's walk: never for
// its position (playerTracker.js: a shaken phone makes steps too). The user's
// acceleration (gravity removed, DeviceMotion `acceleration`) projected on gravity
// (DeviceMotion `accelerationIncludingGravity` minus it) is the body's vertical
// bounce, whatever way the phone is held. Walking makes it swing once per step; a
// low-pass filter keeps the stride rhythm (≈1.5–3.5 Hz) and drops the jitter of a hand
// or a finger on the screen. A step is a peak after a valley (hysteresis), with a
// swing above an adaptive threshold, at a human interval from the previous one.

// Low-pass cut-off of the vertical acceleration (Hz)
const CUTOFF_HZ = 3.2;
// The smallest swing (m/s², valley to peak) that can be a step: slow walking ≈ 1.5–3,
// walking ≈ 3–7, running > 8
const MIN_SWING = 1.1;
// The swing must also reach this share of the recent average: a step stands out from
// what the hand does in between
const ADAPTIVE_SHARE = 0.45;
// Seconds between two steps: faster is a shake, slower starts a new walk
const MIN_INTERVAL = 0.24;
const MAX_INTERVAL = 1.6;

/**
 * createStepDetector({ onStep }) → { push(sample), reset() }
 * sample: { t (seconds), ax, ay, az (m/s², gravity removed), gx, gy, gz (gravity, m/s²) }
 * onStep({ t, interval (s, null for the first of a walk), swing })
 */
export function createStepDetector({ onStep }) {
  let filtered = 0;
  let lastT = null;
  // Looking for a valley (-1) or a peak (+1), and the extreme found so far
  let seeking = -1;
  let valley = 0;
  let peak = 0;
  let peakT = 0;
  let lastStepT = null;
  // Running average of recent swings (adaptive threshold)
  let typicalSwing = 3;

  const reset = () => {
    filtered = 0;
    lastT = null;
    seeking = -1;
    valley = 0;
    peak = 0;
    lastStepT = null;
  };

  const push = ({ t, ax, ay, az, gx, gy, gz }) => {
    const g = Math.hypot(gx, gy, gz);
    if (!(g > 1) || !Number.isFinite(t)) return;
    const vertical = (ax * gx + ay * gy + az * gz) / g;
    if (lastT === null || t - lastT > 0.5 || t <= lastT) {
      // A gap in the samples (app paused, sensor restarted): start over
      filtered = vertical;
      lastT = t;
      seeking = -1;
      valley = vertical;
      return;
    }
    const dt = t - lastT;
    lastT = t;
    const rc = 1 / (2 * Math.PI * CUTOFF_HZ);
    filtered += (dt / (rc + dt)) * (vertical - filtered);

    if (seeking < 0) {
      // Going down: follow the valley until the signal clearly rises again
      if (filtered < valley) valley = filtered;
      if (filtered > valley + MIN_SWING * 0.5) {
        seeking = 1;
        peak = filtered;
        peakT = t;
      }
      return;
    }
    // Going up: follow the peak until the signal clearly falls again
    if (filtered > peak) {
      peak = filtered;
      peakT = t;
    }
    if (filtered < peak - MIN_SWING * 0.5) {
      const swing = peak - valley;
      const interval = lastStepT === null ? null : peakT - lastStepT;
      const tooSoon = interval !== null && interval < MIN_INTERVAL;
      const strongEnough = swing >= Math.max(MIN_SWING, typicalSwing * ADAPTIVE_SHARE);
      if (strongEnough && !tooSoon) {
        typicalSwing += (Math.min(swing, 20) - typicalSwing) * 0.2;
        onStep({ t: peakT, interval: interval !== null && interval <= MAX_INTERVAL ? interval : null, swing });
        lastStepT = peakT;
      }
      seeking = -1;
      valley = filtered;
    }
  };

  return { push, reset };
}
