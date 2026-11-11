// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, Linking } from 'react-native';
import * as Location from 'expo-location';
import { DeviceMotion } from 'expo-sensors';
import { createStepDetector } from '../motion/stepDetector';
import { createHeadingTracker } from '../motion/headingTracker';
import { createPlayerTracker } from '../motion/playerTracker';
import { PROVISIONAL_MAX_ACCURACY_M, PROVISIONAL_MAX_AGE_MS, provisionalPosition } from '../model/provisionalPosition';
import { SHOWCASE } from '../../../showcase/useShowcaseDirector';

// The user's position, heading and walking for the map and the people around. The GPS
// alone says where they are; the sensors (../motion/) only animate: steps give the
// avatar's walk its rhythm once the GPS confirms it, the compass and the gyroscope say
// where it faces. Published at most PUBLISH_INTERVAL_MS apart, and at once on each step
// of a walk.

const MAX_GPS_FIX_AGE_MS = 30_000;
// Every fix counts: about one a second
const GPS_UPDATE_INTERVAL_MS = 1_000;
const GPS_DISTANCE_INTERVAL_METERS = 0;
const GPS_ACQUISITION_WARNING_DELAY_MS = 20_000;
const GPS_ERROR_WARNING_DELAY_MS = 10_000;
const GPS_WEAK_SIGNAL_WARNING_DELAY_MS = 8_000;
const GPS_WEAK_SIGNAL_MIN_FIXES = 2;
// Fixes coarser than this (m) are not used: indoors they can throw the avatar about
const MAX_FIX_ACCURACY_METERS = 100;
// 50 Hz: enough for the stride rhythm (≤ 3.5 Hz) and a smooth gyroscope
const DEVICE_MOTION_UPDATE_INTERVAL_MS = 20;
const PUBLISH_INTERVAL_MS = 100;
// A fresh fix is published at least this often, even standing still: its timestamp tells
// the presence (nearbyPeople) how old the position is. Without fixes nothing is
// published, so a GPS that went silent never looks like a fresh position.
const REPUBLISH_MS = 30_000;
// Changes smaller than these are not published
const MIN_MOVE_METERS = 0.05;
const MIN_TURN_DEGREES = 0.8;
// Where there is no linear-acceleration sensor, gravity is the accelerometer's slow
// part (seconds)
const GRAVITY_SMOOTHING_SECONDS = 0.8;
// The motion sensor counts as silent after this long without a sample (s)
const SENSOR_SILENCE_S = 2;

const now = () => performance.now() / 1000;

// GPS fixes, steps and heading into the tracker; `stepped`: a step since the last publish
function createMotionPipeline() {
  const pipeline = {
    tracker: createPlayerTracker(),
    heading: createHeadingTracker(),
    stepped: false,
    gravity: null,
    lastT: null,
  };
  pipeline.steps = createStepDetector({
    onStep: (step) => {
      pipeline.tracker.addStep(step);
      pipeline.stepped = true;
    },
  });
  return pipeline;
}

// onPosition: every fresh GPS fix, what the app acts on and the server hears. onProvisional:
// once at most, before the first fix, where the phone last was: for drawing the map, nothing else
export function usePlayerLocation(onPosition, onProvisional) {
  const [gpsIssue, setGpsIssue] = useState(null);
  const subscriptions = useRef([]);
  const startup = useRef(null);
  const session = useRef(0);
  // The latest fix's time (fixes arriving out of order are dropped)
  const lastFixTimestamp = useRef(null);
  // The tracker and the sensors' pipeline, made once
  const motionRef = useRef(null);
  const getMotion = useCallback(() => {
    if (motionRef.current === null) motionRef.current = createMotionPipeline();
    return motionRef.current;
  }, []);
  // What was last published, to publish only changes
  const published = useRef(null);
  const publishTimer = useRef(null);
  const onPositionRef = useRef(onPosition);
  const onProvisionalRef = useRef(onProvisional);
  const provisionalAsked = useRef(false);
  const gpsIssueRef = useRef(null);
  const trackingRequested = useRef(false);
  const locationPermissionCanAskAgain = useRef(true);
  const sessionHasFix = useRef(false);
  const poorAccuracySince = useRef(null);
  const poorAccuracyCount = useRef(0);
  const lastPoorAccuracyTimestamp = useRef(null);
  const timers = useRef({ acquisition: null, error: null, weakSignal: null });

  const updateGpsIssue = useCallback((nextIssue) => {
    if (gpsIssueRef.current === nextIssue) return;
    gpsIssueRef.current = nextIssue;
    setGpsIssue(nextIssue);
  }, []);

  const clearTimer = useCallback((name) => {
    if (timers.current[name] !== null) {
      clearTimeout(timers.current[name]);
      timers.current[name] = null;
    }
  }, []);

  const clearGpsTimers = useCallback(() => {
    clearTimer('acquisition');
    clearTimer('error');
    clearTimer('weakSignal');
    poorAccuracySince.current = null;
    poorAccuracyCount.current = 0;
    lastPoorAccuracyTimestamp.current = null;
  }, [clearTimer]);

  const recoverGps = useCallback(() => {
    clearGpsTimers();
    updateGpsIssue(null);
  }, [clearGpsTimers, updateGpsIssue]);

  useEffect(() => {
    onPositionRef.current = onPosition;
    onProvisionalRef.current = onProvisional;
  }, [onPosition, onProvisional]);

  // The state to the map and the presence, when it changed enough
  const publish = useCallback(() => {
    const motion = getMotion();
    const { tracker, heading } = motion;
    tracker.setHeading(heading.heading());
    // Steps count only while the motion sensor talks (a phone that stops sending
    // samples, a simulator: the GPS alone again)
    tracker.setStepsAvailable(motion.lastT !== null && now() - motion.lastT < SENSOR_SILENCE_S);
    tracker.tick(now());
    const next = tracker.state();
    if (!next) return;
    const last = published.current;
    const changed = !last
      || (motion.stepped && next.moving)
      || next.moving !== last.moving
      || next.steps !== last.steps
      || Math.abs(next.speed - last.speed) > 0.05
      || Math.hypot((next.latitude - last.latitude) * 111320, (next.longitude - last.longitude) * 111320 * Math.cos((next.latitude * Math.PI) / 180)) > MIN_MOVE_METERS
      || (next.heading !== null && (last.heading === null || Math.abs(((next.heading - last.heading + 540) % 360) - 180) >= MIN_TURN_DEGREES))
      || next.fixedAt - last.timestamp >= REPUBLISH_MS;
    motion.stepped = false;
    if (!changed) return;
    // Its age is the age of the GPS fix behind it, not of this message
    const position = { ...next, timestamp: next.fixedAt };
    published.current = position;
    onPositionRef.current?.(position);
  }, [getMotion]);

  const resetTracking = useCallback((preserveRequest = false) => {
    session.current += 1;
    if (!preserveRequest) trackingRequested.current = false;
    subscriptions.current.forEach((subscription) => subscription?.remove());
    subscriptions.current = [];
    startup.current = null;
    clearGpsTimers();
    sessionHasFix.current = false;
    if (publishTimer.current !== null) {
      clearInterval(publishTimer.current);
      publishTimer.current = null;
    }
    // The next sensor session starts from fresh samples (no gap integrated); where
    // the user is stays known
    const motion = getMotion();
    motion.steps.reset();
    motion.stepped = false;
    motion.lastT = null;
    motion.gravity = null;
    published.current = null;
  }, [getMotion, clearGpsTimers]);

  const stopTracking = useCallback(() => resetTracking(), [resetTracking]);

  const acceptFix = useCallback((fix) => {
    const { latitude, longitude, accuracy, heading, speed } = fix.coords;
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
    // Spawn only from a location acquired within the user's 30-second limit.
    const fixAge = Date.now() - fix.timestamp;
    if (!Number.isFinite(fix.timestamp) || fixAge < -2_000 || fixAge > MAX_GPS_FIX_AGE_MS) return;
    if (lastFixTimestamp.current !== null && fix.timestamp < lastFixTimestamp.current) return;

    // A position from a fake-GPS app (Android tells) is not where the user is. Allowed
    // in development, where an emulator's position counts as one.
    if (fix.mocked && !__DEV__ && !SHOWCASE) {
      updateGpsIssue('mocked');
      return;
    }

    // Discard very coarse readings: they can move the avatar across the map indoors.
    if (Number.isFinite(accuracy) && accuracy > MAX_FIX_ACCURACY_METERS) {
      if (
        lastPoorAccuracyTimestamp.current !== null
        && fix.timestamp - lastPoorAccuracyTimestamp.current < GPS_UPDATE_INTERVAL_MS * 5
      ) return;
      lastPoorAccuracyTimestamp.current = fix.timestamp;
      const now = Date.now();
      poorAccuracyCount.current += 1;
      if (poorAccuracySince.current === null) {
        poorAccuracySince.current = now;
      }
      const poorAccuracyDuration = now - poorAccuracySince.current;
      if (
        poorAccuracyCount.current >= GPS_WEAK_SIGNAL_MIN_FIXES
        && poorAccuracyDuration >= GPS_WEAK_SIGNAL_WARNING_DELAY_MS
      ) {
        updateGpsIssue('weak');
      }
      if (timers.current.weakSignal === null) {
        timers.current.weakSignal = setTimeout(() => {
          timers.current.weakSignal = null;
          if (
            poorAccuracyCount.current >= GPS_WEAK_SIGNAL_MIN_FIXES
            && Date.now() - poorAccuracySince.current >= GPS_WEAK_SIGNAL_WARNING_DELAY_MS
          ) {
            updateGpsIssue('weak');
          }
        }, GPS_WEAK_SIGNAL_WARNING_DELAY_MS);
      }
      return;
    }

    sessionHasFix.current = true;
    clearTimer('acquisition');
    clearTimer('error');
    clearTimer('weakSignal');
    poorAccuracySince.current = null;
    poorAccuracyCount.current = 0;
    lastPoorAccuracyTimestamp.current = null;
    recoverGps();

    lastFixTimestamp.current = fix.timestamp;
    const { tracker, heading: facing } = getMotion();
    tracker.addGps({ latitude, longitude, accuracy, speed, heading, timestamp: fix.timestamp });
    // No calibrated compass yet: the course of a moving GPS starts the heading
    if (Number.isFinite(speed) && speed > 0.8) facing.seed(heading);
    publish();
  }, [getMotion, clearTimer, publish, recoverGps, updateGpsIssue]);

  const acceptHeading = useCallback((reading) => {
    // trueHeading is north referenced when available; magHeading is the robust fallback.
    const degrees = Number.isFinite(reading.trueHeading) && reading.trueHeading >= 0
      ? reading.trueHeading
      : reading.magHeading;
    // Expo reports accuracy 0 when the compass has no useful calibration: not used
    getMotion().heading.compass({ degrees, accuracy: Number.isFinite(reading.accuracy) ? reading.accuracy : 2 });
  }, [getMotion]);

  // 50 times a second: the user's acceleration and the phone's rotation
  const acceptMotion = useCallback((measurement) => {
    const total = measurement.accelerationIncludingGravity;
    if (!total) return;
    const state = getMotion();
    const t = now();
    let user = measurement.acceleration;
    let gravity;
    if (user && Number.isFinite(user.x)) {
      gravity = { x: total.x - user.x, y: total.y - user.y, z: total.z - user.z };
    } else {
      // No linear-acceleration sensor: gravity is the slow part of the accelerometer
      const blend = state.gravity && state.lastT !== null
        ? 1 - Math.exp(-(t - state.lastT) / GRAVITY_SMOOTHING_SECONDS)
        : 1;
      const previous = state.gravity ?? total;
      gravity = {
        x: previous.x + (total.x - previous.x) * blend,
        y: previous.y + (total.y - previous.y) * blend,
        z: previous.z + (total.z - previous.z) * blend,
      };
      user = { x: total.x - gravity.x, y: total.y - gravity.y, z: total.z - gravity.z };
    }
    state.gravity = gravity;
    state.lastT = t;
    state.steps.push({ t, ax: user.x, ay: user.y, az: user.z, gx: gravity.x, gy: gravity.y, gz: gravity.z });
    state.heading.motion({ t, rotationRate: measurement.rotationRate, gravity });
    // A step of a walk reaches the avatar at once (its foot lands with the user's)
    if (state.stepped) publish();
  }, [getMotion, publish]);

  const startTracking = useCallback(() => {
    trackingRequested.current = true;
    if (subscriptions.current.length || startup.current) return startup.current;

    const activeSession = session.current;
    sessionHasFix.current = false;
    startup.current = (async () => {
      try {
        let permission = await Location.getForegroundPermissionsAsync();
        if (!permission.granted && permission.canAskAgain) {
          permission = await Location.requestForegroundPermissionsAsync();
        }
        if (session.current !== activeSession) return;
        locationPermissionCanAskAgain.current = permission.canAskAgain;
        if (!permission.granted) {
          updateGpsIssue('permission');
          return;
        }

        const locationServicesEnabled = await Location.hasServicesEnabledAsync();
        if (session.current !== activeSession) return;
        if (!locationServicesEnabled) {
          updateGpsIssue('services');
          return;
        }
        if (gpsIssueRef.current === 'permission' || gpsIssueRef.current === 'services') {
          recoverGps();
        }

        // Not waited for: the GPS starts at once, and its first fix wins if it comes first
        if (!provisionalAsked.current && lastFixTimestamp.current === null) {
          provisionalAsked.current = true;
          Location.getLastKnownPositionAsync({ maxAge: PROVISIONAL_MAX_AGE_MS, requiredAccuracy: PROVISIONAL_MAX_ACCURACY_M })
            .then((fix) => {
              if (session.current !== activeSession || lastFixTimestamp.current !== null) return;
              const position = provisionalPosition(fix, Date.now(), { allowMocked: __DEV__ || SHOWCASE });
              if (position) onProvisionalRef.current?.(position);
            })
            .catch(() => {});
        }

        const reportSustainedLocationError = () => {
          if (timers.current.error !== null) return;
          timers.current.error = setTimeout(() => {
            timers.current.error = null;
            if (session.current === activeSession && gpsIssueRef.current !== 'weak') {
              updateGpsIssue('unavailable');
            }
          }, GPS_ERROR_WARNING_DELAY_MS);
        };

        const handleLocationError = (reason) => {
          if (session.current !== activeSession) return;
          reportSustainedLocationError();
          console.warn('Location watch failed:', reason?.message ?? reason);
        };

        const onFix = (fix) => {
          if (session.current === activeSession) acceptFix(fix);
        };
        const onHeading = (reading) => {
          if (session.current === activeSession) acceptHeading(reading);
        };
        const onMotion = (measurement) => {
          if (session.current === activeSession) acceptMotion(measurement);
        };

        const gpsSubscription = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            timeInterval: GPS_UPDATE_INTERVAL_MS,
            // iOS maps this to CLLocationManager.distanceFilter: every fix, the
            // tracker weighs each one by its accuracy
            distanceInterval: GPS_DISTANCE_INTERVAL_METERS,
            mayShowUserSettingsDialog: true,
          },
          onFix,
          handleLocationError,
        );
        if (session.current !== activeSession) {
          gpsSubscription.remove();
          return;
        }
        subscriptions.current.push(gpsSubscription);
        clearTimer('acquisition');
        timers.current.acquisition = setTimeout(() => {
          timers.current.acquisition = null;
          if (
            session.current === activeSession
            && !sessionHasFix.current
            && gpsIssueRef.current !== 'weak'
          ) {
            updateGpsIssue('unavailable');
          }
        }, GPS_ACQUISITION_WARNING_DELAY_MS);

        try {
          const headingSubscription = await Location.watchHeadingAsync(onHeading);
          if (session.current !== activeSession) {
            headingSubscription.remove();
            return;
          }
          subscriptions.current.push(headingSubscription);
        } catch {
          // GPS location remains usable if the device has no compass sensor.
        }

        // DeviceMotion, for the animation only: the steps (accelerometer) and the turns (gyroscope).
        // watchHeadingAsync supplies its north-calibrated bearing to avoid gyro drift.
        let motionAvailable = false;
        try {
          if (await DeviceMotion.isAvailableAsync()) {
            DeviceMotion.setUpdateInterval(DEVICE_MOTION_UPDATE_INTERVAL_MS);
            const motionSubscription = DeviceMotion.addListener(onMotion);
            if (session.current !== activeSession) {
              motionSubscription.remove();
              return;
            }
            subscriptions.current.push(motionSubscription);
            motionAvailable = true;
          }
        } catch {
          // Compass heading still works on devices without a motion sensor.
        }
        // Stopped while the sensors were being set up: nothing more to start
        if (session.current !== activeSession) return;
        // Without motion sensors the GPS alone says when the user walks (publish
        // checks it again every time)
        getMotion().tracker.setStepsAvailable(motionAvailable);
        if (publishTimer.current === null) publishTimer.current = setInterval(publish, PUBLISH_INTERVAL_MS);

      } catch (locationError) {
        console.warn('Unable to start location tracking:', locationError?.message ?? locationError);
        if (session.current === activeSession) {
          if (timers.current.error === null) {
            timers.current.error = setTimeout(() => {
              timers.current.error = null;
              if (session.current === activeSession) updateGpsIssue('unavailable');
            }, GPS_ERROR_WARNING_DELAY_MS);
          }
        }
      } finally {
        if (session.current === activeSession) startup.current = null;
      }
    })();
    return startup.current;
  }, [getMotion, acceptFix, acceptHeading, acceptMotion, clearTimer, publish, recoverGps, updateGpsIssue]);

  const retryLocationPermission = useCallback(() => {
    if (locationPermissionCanAskAgain.current) {
      return startTracking();
    }
    return Linking.openSettings();
  }, [startTracking]);

  useEffect(() => {
    const appStateSubscription = AppState.addEventListener('change', (nextState) => {
      if (!trackingRequested.current) return;
      // In the background nobody sees the map and the presence is not sent: the GPS,
      // the compass and the 50 Hz motion sensors stop (the battery), and start again
      // below when the app is back in front
      if (nextState === 'background') {
        resetTracking(true);
        return;
      }
      if (nextState !== 'active') return;
      const activeSession = session.current;

      Promise.all([
        Location.getForegroundPermissionsAsync(),
        Location.hasServicesEnabledAsync(),
      ]).then(([permission, servicesEnabled]) => {
        if (!trackingRequested.current || session.current !== activeSession) return;
        locationPermissionCanAskAgain.current = permission.canAskAgain;
        // Native location watchers can remain registered after Settings turns the
        // permission or GPS service off. Drop that session on resume so a later
        // re-enable always creates a fresh watcher and sensor pipeline.
        resetTracking(true);
        if (!permission.granted) {
          updateGpsIssue('permission');
          return;
        }
        if (!servicesEnabled) {
          updateGpsIssue('services');
          return;
        }
        if (gpsIssueRef.current === 'permission' || gpsIssueRef.current === 'services') {
          updateGpsIssue(null);
        }
        startTracking();
      }).catch(() => {
        // Keep the current indicator if iOS cannot report status during resume.
      });
    });

    return () => appStateSubscription.remove();
  }, [resetTracking, startTracking, updateGpsIssue]);

  useEffect(() => stopTracking, [stopTracking]);

  return { startTracking, stopTracking, retryLocationPermission, gpsIssue };
}
