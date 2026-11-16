// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Edge cases of the motion pipeline (src/features/map/motion): steps, heading, tracker.
// The rule above all: only the GPS moves the user. The sensors animate.
import { createSharingWindow } from '../src/features/map/state/sharingWindow.js';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createStepDetector } from '../src/features/map/motion/stepDetector.js';
import { createPlayerTracker } from '../src/features/map/motion/playerTracker.js';
import { createHeadingTracker } from '../src/features/map/motion/headingTracker.js';

// A seeded random, so every run sees the same noise
const random = (seed = 7) => () => {
  seed = (seed * 16807) % 2147483647;
  return seed / 2147483647 - 0.5;
};

// Vertical acceleration samples at 50 Hz: a bounce of `hz` and `amplitude` (m/s²) from
// `from` to `to` seconds, hand noise always; the phone upright (gravity on y)
function samples({ seconds, hz = 0, amplitude = 0, from = 0, to = Infinity, noise = 0.6, shake = null }) {
  const rand = random();
  const list = [];
  for (let i = 0; i < seconds * 50; i++) {
    const t = i / 50;
    const active = t >= from && t < to;
    let vertical = (active && hz ? amplitude * Math.sin(2 * Math.PI * hz * t) : 0) + rand() * noise;
    if (shake && t >= shake.at && t < shake.at + 0.05) vertical += shake.size;
    list.push({ t, ax: rand() * 0.3, ay: vertical, az: rand() * 0.3, gx: 0, gy: 9.81, gz: 0 });
  }
  return list;
}

const countSteps = (list) => {
  let steps = 0;
  const detector = createStepDetector({ onStep: () => steps++ });
  for (const sample of list) detector.push(sample);
  return steps;
};

describe('step detector', () => {
  it('sees no steps in a phone held still', () => {
    assert.equal(countSteps(samples({ seconds: 20 })), 0);
  });

  it('counts a walk at 1.8 steps/s', () => {
    assert.equal(countSteps(samples({ seconds: 10, hz: 1.8, amplitude: 2.8 })), 18);
  });

  it('counts a slow walk and a run', () => {
    assert.ok(Math.abs(countSteps(samples({ seconds: 10, hz: 1.4, amplitude: 1.8 })) - 14) <= 1);
    assert.ok(Math.abs(countSteps(samples({ seconds: 10, hz: 2.8, amplitude: 9 })) - 28) <= 1);
  });

  it('takes a single bump (a tap, the phone put down) for one step at most', () => {
    assert.ok(countSteps(samples({ seconds: 5, shake: { at: 2, size: 12 } })) <= 1);
  });

  it('ignores broken samples and restarts after a gap', () => {
    let steps = 0;
    const detector = createStepDetector({ onStep: () => steps++ });
    assert.doesNotThrow(() => {
      detector.push({ t: NaN, ax: 0, ay: 0, az: 0, gx: 0, gy: 9.81, gz: 0 });
      detector.push({ t: 1, ax: 0, ay: 0, az: 0, gx: 0, gy: 0, gz: 0 });
      detector.push({ t: 1, ax: Infinity, ay: NaN, az: 0, gx: 0, gy: 9.81, gz: 0 });
    });
    // Time going backwards or jumping ahead (app paused): no step from the gap
    for (const sample of samples({ seconds: 2, hz: 1.8, amplitude: 2.8 })) detector.push({ ...sample, t: sample.t + 100 });
    for (const sample of samples({ seconds: 2, hz: 1.8, amplitude: 2.8 })) detector.push(sample);
    assert.ok(steps <= 8);
  });

  it('works with the phone flat or upside down (gravity on any axis)', () => {
    const flat = samples({ seconds: 10, hz: 1.8, amplitude: 2.8 }).map((s) => ({ ...s, ax: s.az, az: -s.ay, gx: 0, gy: 0, gz: -9.81 }));
    assert.equal(countSteps(flat), 18);
  });
});

// A tracker fed like usePlayerLocation: steps from the detector, a GPS fix each second
function walkScenario({ seconds, walkFrom = 2, walkTo = Infinity, gpsJitter = 12, heading = 90, gpsSpeed = 1.3, accuracy = 8, stepsAvailable = true, signal = {} }) {
  const fusion = createPlayerTracker();
  fusion.setStepsAvailable(stepsAvailable);
  fusion.setHeading(heading);
  const detector = createStepDetector({ onStep: (step) => fusion.addStep(step) });
  const rand = random(3);
  const lat0 = 41.9;
  const lon0 = 12.5;
  const toGeo = (east, north) => ({ latitude: lat0 + north / 111320, longitude: lon0 + east / (111320 * Math.cos((lat0 * Math.PI) / 180)) });
  const states = [];
  const list = samples({ seconds, hz: 1.8, amplitude: 2.8, from: walkFrom, to: walkTo, ...signal });
  for (let i = 0; i < list.length; i++) {
    const { t } = list[i];
    if (stepsAvailable) detector.push(list[i]);
    fusion.tick(t);
    if (i % 50 === 0) {
      const walking = t >= walkFrom && t < walkTo;
      const trueEast = Math.max(0, Math.min(t, walkTo) - walkFrom) * 1.26;
      fusion.addGps({ ...toGeo(trueEast + rand() * gpsJitter, rand() * gpsJitter), accuracy, speed: walking ? gpsSpeed : 0.2, heading: walking ? heading : -1, timestamp: t * 1000 });
      const state = fusion.state();
      states.push({
        t,
        trueEast,
        moving: state.moving,
        speed: state.speed,
        east: (state.longitude - lon0) * 111320 * Math.cos((lat0 * Math.PI) / 180),
        north: (state.latitude - lat0) * 111320,
      });
    }
  }
  return states;
}

// A phone shaken in rhythm, like walking to the accelerometer: real samples through the
// real detector, for `seconds`, with a GPS fix each second from `gps(t)` (null: no fix)
function shake({ seconds, gps, hz = 2.5, amplitude = 8 }) {
  const fusion = createPlayerTracker();
  fusion.setHeading(45);
  let steps = 0;
  const detector = createStepDetector({
    onStep: (step) => {
      steps += 1;
      fusion.addStep(step);
    },
  });
  fusion.addGps({ latitude: 41.9, longitude: 12.5, accuracy: 6, speed: 0, timestamp: 0 });
  const seen = [];
  for (const sample of samples({ seconds, hz, amplitude })) {
    detector.push(sample);
    fusion.tick(sample.t);
    if (Math.round(sample.t * 50) % 50 === 0) {
      const fix = gps(sample.t);
      if (fix) fusion.addGps({ accuracy: 6, speed: 0, heading: -1, timestamp: sample.t * 1000, ...fix });
      seen.push(fusion.state());
    }
  }
  return { steps, seen };
}

const metresFrom = (state, latitude = 41.9, longitude = 12.5) => Math.hypot(
  (state.latitude - latitude) * 111320,
  (state.longitude - longitude) * 111320 * Math.cos((latitude * Math.PI) / 180),
);

describe('only the GPS moves the user', () => {
  it('a shaken phone with no GPS moves nowhere, however long', () => {
    const { steps, seen } = shake({ seconds: 600, gps: () => null });
    assert.ok(steps > 500, `the detector did see steps (${steps})`);
    for (const state of seen) {
      assert.equal(metresFrom(state), 0);
      assert.equal(state.moving, false);
      assert.equal(state.speed, 0);
      assert.deepEqual(state.velocity, { east: 0, north: 0 });
      assert.equal(state.cadence, 0);
    }
  });

  it('a shaken phone stays where the GPS says, and does not walk', () => {
    const rand = random(11);
    const { steps, seen } = shake({
      seconds: 120,
      gps: () => ({ latitude: 41.9 + (rand() * 4) / 111320, longitude: 12.5 + (rand() * 4) / 111320, speed: 0.1 }),
    });
    assert.ok(steps > 100);
    for (const state of seen) {
      assert.ok(metresFrom(state) < 4, `off by ${metresFrom(state)} m`);
      assert.equal(state.moving, false);
    }
  });

  it('steps with no position to confirm them stop showing a walk', () => {
    // A real walk, then the GPS goes silent (a tunnel) and the steps go on
    const fusion = createPlayerTracker();
    let last = null;
    const detector = createStepDetector({ onStep: (step) => fusion.addStep(step) });
    for (const sample of samples({ seconds: 40, hz: 1.8, amplitude: 2.8 })) {
      detector.push(sample);
      fusion.tick(sample.t);
      if (sample.t < 10 && Math.round(sample.t * 50) % 50 === 0) {
        fusion.addGps({ latitude: 41.9 + (sample.t * 1.3) / 111320, longitude: 12.5, accuracy: 5, speed: 1.3, heading: 0, timestamp: sample.t * 1000 });
      }
      if (sample.t === 9) assert.equal(fusion.state().moving, true, 'walking while the GPS sees it');
      last = fusion.state();
    }
    assert.equal(last.moving, false);
    assert.ok((last.latitude - 41.9) * 111320 < 15, 'and the position stopped with the GPS');
  });

  it('never goes beyond where the GPS has been', () => {
    // A very fast rhythm of steps while the GPS says a slow walk: only the GPS counts
    const states = walkScenario({ seconds: 60, walkFrom: 1, gpsJitter: 2, accuracy: 5, signal: { hz: 3.4, amplitude: 9 } });
    for (const state of states) assert.ok(Math.abs(state.east - state.trueEast) < 5, `${state.east} vs ${state.trueEast}`);
  });

  it('after a long gap goes straight to the first fix', () => {
    const fusion = createPlayerTracker();
    fusion.addGps({ latitude: 41.9, longitude: 12.5, accuracy: 5, speed: 0, timestamp: 0 });
    fusion.addGps({ latitude: 45, longitude: 9, accuracy: 5, speed: 0, timestamp: 3_600_000 });
    assert.ok(metresFrom(fusion.state(), 45, 9) < 1);
  });
});

describe('player tracker', () => {
  it('has no state before the first fix, and never throws on bad fixes', () => {
    const fusion = createPlayerTracker();
    assert.equal(fusion.state(), null);
    fusion.addGps({ latitude: NaN, longitude: 12 });
    fusion.addGps({ latitude: undefined, longitude: undefined });
    assert.equal(fusion.state(), null);
    fusion.addStep({ t: 1, interval: null });
    assert.equal(fusion.state(), null);
  });

  it('says how old the position is: the time of its GPS fix', () => {
    const fusion = createPlayerTracker();
    fusion.addGps({ latitude: 41.9, longitude: 12.5, accuracy: 5, speed: 0, timestamp: 1000 });
    assert.equal(fusion.state().fixedAt, 1000);
    fusion.tick(500);
    assert.equal(fusion.state().fixedAt, 1000);
  });

  it('stands still while the GPS wanders by ±6 m', () => {
    const states = walkScenario({ seconds: 20, walkFrom: 99 });
    // Where the first fix put the user: it holds there, whatever the next fixes say
    const [first] = states;
    for (const state of states) {
      assert.equal(state.moving, false);
      // It may settle slowly towards the average of the fixes, never jump
      assert.ok(Math.hypot(state.east - first.east, state.north - first.north) < 4, `drifted to ${state.east}, ${state.north}`);
    }
  });

  it('walks on real steps, along the heading, close to the truth', () => {
    const states = walkScenario({ seconds: 15, walkFrom: 2, walkTo: 12 });
    const during = states.filter((s) => s.t >= 5 && s.t <= 11);
    assert.ok(during.every((s) => s.moving));
    assert.ok(during.every((s) => s.speed > 0.8 && s.speed < 1.8));
    const end = states.at(-1);
    assert.equal(end.moving, false, 'stops after the last step');
    assert.ok(Math.abs(end.east - end.trueEast) < 3.5, `east ${end.east} vs ${end.trueEast}`);
    assert.ok(Math.abs(end.north) < 3);
  });

  it('on a long walk the GPS keeps it within a few metres of the truth', () => {
    const states = walkScenario({ seconds: 90, walkFrom: 1, gpsJitter: 10, accuracy: 6 });
    const late = states.filter((s) => s.t > 30);
    const worst = Math.max(...late.map((s) => Math.hypot(s.east - s.trueEast, s.north)));
    assert.ok(worst < 4, `off by ${worst} m`);
  });

  it('does not start walking on a phone shaken once', () => {
    const states = walkScenario({ seconds: 10, walkFrom: 99, signal: { shake: { at: 3, size: 15 } } });
    assert.ok(states.every((s) => !s.moving));
  });

  it('follows the GPS in a vehicle (fast, no steps)', () => {
    const fusion = createPlayerTracker();
    fusion.setHeading(0);
    for (let t = 0; t < 10; t++) {
      fusion.tick(t);
      fusion.addGps({ latitude: 41.9 + (t * 10) / 111320, longitude: 12.5, accuracy: 6, speed: 10, heading: 0, timestamp: t * 1000 });
    }
    const state = fusion.state();
    assert.equal(state.moving, true);
    assert.ok(state.speed > 9);
    // Close behind the last fix (90 m), not left far behind
    assert.ok((state.latitude - 41.9) * 111320 > 80, `${(state.latitude - 41.9) * 111320} m`);
  });

  it('moves a standing user only when the GPS keeps disagreeing (not on one jump)', () => {
    const fusion = createPlayerTracker();
    fusion.addGps({ latitude: 41.9, longitude: 12.5, accuracy: 5, speed: 0 });
    // One wild fix 40 m away: ignored
    fusion.addGps({ latitude: 41.9 + 40 / 111320, longitude: 12.5, accuracy: 5, speed: 0 });
    assert.ok((fusion.state().latitude - 41.9) * 111320 < 3);
    // Three in a row: the user did move (a tram)
    for (let i = 0; i < 3; i++) fusion.addGps({ latitude: 41.9 + 40 / 111320, longitude: 12.5, accuracy: 5, speed: 0 });
    assert.ok((fusion.state().latitude - 41.9) * 111320 > 20);
  });

  it('without motion sensors walks by GPS speed', () => {
    const states = walkScenario({ seconds: 10, walkFrom: 2, stepsAvailable: false, gpsJitter: 2 });
    assert.ok(states.filter((s) => s.t >= 4).every((s) => s.moving));
    assert.ok(states.filter((s) => s.t < 2).every((s) => !s.moving));
  });

  it('walks by GPS alone when the steps are not seen (a phone in a bag)', () => {
    const fusion = createPlayerTracker();
    for (let t = 0; t < 6; t++) fusion.addGps({ latitude: 41.9 + (t * 1.3) / 111320, longitude: 12.5, accuracy: 5, speed: 1.3, heading: 0, timestamp: t * 1000 });
    assert.equal(fusion.state().moving, true);
    assert.equal(fusion.state().heading, 0);
  });
});

describe('heading tracker', () => {
  it('starts from a calibrated compass only', () => {
    const tracker = createHeadingTracker();
    tracker.compass({ degrees: 120, accuracy: 0 });
    assert.equal(tracker.heading(), null);
    tracker.compass({ degrees: -1, accuracy: 3 });
    assert.equal(tracker.heading(), null);
    tracker.compass({ degrees: 120, accuracy: 3 });
    assert.equal(tracker.heading(), 120);
  });

  it('seeds from the GPS course only when nothing else is known', () => {
    const tracker = createHeadingTracker();
    tracker.seed(80);
    assert.equal(tracker.heading(), 80);
    tracker.seed(200);
    assert.equal(tracker.heading(), 80);
  });

  it('wraps around north and pulls towards the compass the short way', () => {
    const tracker = createHeadingTracker();
    tracker.compass({ degrees: 355, accuracy: 3 });
    for (let i = 0; i < 40; i++) tracker.compass({ degrees: 5, accuracy: 3 });
    const heading = tracker.heading();
    assert.ok(heading >= 0 && heading < 360);
    assert.ok(heading < 10 || heading > 359, `heading ${heading}`);
  });

  it('integrates the gyroscope, learns its sign from the compass, skips gaps', () => {
    const tracker = createHeadingTracker();
    tracker.compass({ degrees: 0, accuracy: 3 });
    const gravity = { x: 0, y: 9.81, z: 0 };
    // A right turn of 90° in 1 s, reported with the "wrong" sign for the default
    let t = 0;
    for (let turn = 0; turn < 3; turn++) {
      for (let i = 0; i < 50; i++) {
        t += 0.02;
        tracker.motion({ t, rotationRate: { alpha: 0, beta: 0, gamma: 90 }, gravity });
      }
      tracker.compass({ degrees: ((turn + 1) * 90) % 360, accuracy: 3 });
    }
    // After learning, a further turn moves the same way as the compass
    const before = tracker.heading();
    for (let i = 0; i < 25; i++) {
      t += 0.02;
      tracker.motion({ t, rotationRate: { alpha: 0, beta: 0, gamma: 90 }, gravity });
    }
    const moved = ((tracker.heading() - before + 540) % 360) - 180;
    assert.ok(moved > 30, `moved ${moved}`);
    // A gap of seconds is not integrated
    const held = tracker.heading();
    tracker.motion({ t: t + 5, rotationRate: { alpha: 0, beta: 0, gamma: 90 }, gravity });
    assert.equal(tracker.heading(), held);
  });

  it('ignores motion without gravity or rotation', () => {
    const tracker = createHeadingTracker();
    tracker.compass({ degrees: 10, accuracy: 2 });
    assert.doesNotThrow(() => {
      tracker.motion({ t: 1, rotationRate: null, gravity: { x: 0, y: 9.8, z: 0 } });
      tracker.motion({ t: 1.02, rotationRate: { alpha: 1, beta: 1, gamma: 1 }, gravity: { x: 0, y: 0, z: 0 } });
    });
    assert.equal(tracker.heading(), 10);
  });
});

// --- when the position is shared ---

it('leaving the map shares for a minute, then stops', () => {
  const clock = fakeClock();
  const changes = [];
  const sharing = createSharingWindow({ onChange: (value) => changes.push(value), graceMs: 60_000, schedule: clock.schedule, cancel: clock.cancel });
  sharing.enter();
  assert.deepEqual(changes, [true]);
  sharing.leave();
  clock.advance(59_000);
  assert.equal(sharing.sharing(), true);
  clock.advance(1_000);
  assert.equal(sharing.sharing(), false);
  assert.deepEqual(changes, [true, false]);
});

it('coming back within the minute goes on without a stop', () => {
  const clock = fakeClock();
  const changes = [];
  const sharing = createSharingWindow({ onChange: (value) => changes.push(value), graceMs: 60_000, schedule: clock.schedule, cancel: clock.cancel });
  sharing.enter();
  sharing.leave();
  clock.advance(30_000);
  sharing.enter();
  clock.advance(120_000);
  assert.deepEqual(changes, [true]);
});

it('the app leaving the front ends the minute at once, and only the map starts it again', () => {
  const clock = fakeClock();
  const sharing = createSharingWindow({ onChange: () => {}, graceMs: 60_000, schedule: clock.schedule, cancel: clock.cancel });
  sharing.enter();
  sharing.leave();
  clock.advance(5_000);
  sharing.appLeft();
  assert.equal(sharing.sharing(), false);
  clock.advance(120_000);
  assert.equal(sharing.sharing(), false);
  sharing.enter();
  assert.equal(sharing.sharing(), true);
});

it('on the map, the app leaving the front keeps the window for its return', () => {
  const clock = fakeClock();
  const sharing = createSharingWindow({ onChange: () => {}, graceMs: 60_000, schedule: clock.schedule, cancel: clock.cancel });
  sharing.enter();
  sharing.appLeft();
  assert.equal(sharing.sharing(), true);
});

it('invisible, leaving the map keeps nothing going', () => {
  const clock = fakeClock();
  const sharing = createSharingWindow({ onChange: () => {}, graceMs: 60_000, schedule: clock.schedule, cancel: clock.cancel });
  sharing.enter();
  sharing.leave({ now: true });
  assert.equal(sharing.sharing(), false);
});

function fakeClock() {
  let now = 0;
  let next = 1;
  const timers = new Map();
  return {
    schedule(run, ms) {
      timers.set(next, { run, at: now + ms });
      return next++;
    },
    cancel: (id) => timers.delete(id),
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.run();
        }
      }
    },
  };
}
