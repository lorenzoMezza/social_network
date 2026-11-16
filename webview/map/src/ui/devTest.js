// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as THREE from 'three';
import { WEATHER_PRESETS } from '../scene/environment/weather.js';

// Test things for the developer panel (ui/testPanel.js), on this page only: events and
// people the app and the server never hear of, shown together with the app's own
// (setAppEvents / setAppPeople keep both lists). Test people walk around the player.
// Tapping one of them selects it here (the app has no card for it).

const EVENT_EMOJIS = ['🎉', '🎵', '⚽', '🍕', '🎨', '☕'];
const NAMES = ['Giulia', 'Marco', 'Sofia', 'Luca', 'Chiara', 'Matteo', 'Elena', 'Davide', 'Sara', 'Paolo', 'Irene', 'Fabio'];
const TONES = ['#4C8BF5', '#E5735B', '#3DAA6D', '#F2A33A', '#9B6CF0', '#E2557B'];
// Test people walk this fast (m/s), turn a little each step, and stay this near the
// player (metres)
const WALK_SPEED = 1.4;
const WALK_RADIUS = 90;
const WALK_STEP_MS = 1000;

const pick = (list) => list[Math.floor(Math.random() * list.length)];

/**
 * `select`: { event(id | null), person(id | null) } (main.js: the view flies to it);
 * `camera`, `player` (the avatar's root), `geo` (the map), `environment`, `wildlife`.
 */
export function createDevTest({ beacons, people, geo, camera, player, environment, wildlife, select }) {
  let appEvents = [];
  let appPeople = [];
  const events = [];
  const walkers = []; // { data, x, z, heading }
  let selected = null; // 'event' | 'person' while a test thing is selected
  let walking = null;
  let count = 0;

  const showEvents = () => beacons.set([...appEvents, ...events]);
  const showPeople = () => people.set([...appPeople, ...walkers.map((walker) => walker.data)]);

  const forward = () => camera.getWorldDirection(new THREE.Vector3()).setY(0).normalize();
  const latLonAt = (x, z) => {
    const { lat, lon } = geo.worldToLatLon(x, z);
    return { latitude: lat, longitude: lon };
  };

  const addEvent = (x, z, live) => {
    const emoji = pick(EVENT_EMOJIS);
    events.push({
      id: `dev-event-${++count}`,
      ...latLonAt(x, z),
      emoji,
      crowd: Math.floor(1 + Math.random() * 40),
      live,
    });
  };
  const eventInFront = (live) => {
    const ahead = forward();
    const side = new THREE.Vector3(-ahead.z, 0, ahead.x);
    const at = player.position.clone().addScaledVector(ahead, 45 + Math.random() * 25).addScaledVector(side, (Math.random() - 0.5) * 40);
    addEvent(at.x, at.z, live);
    showEvents();
  };

  // A step of every walker: on, turning a little, back towards the player if far
  const walk = () => {
    const seconds = WALK_STEP_MS / 1000;
    for (const walker of walkers) {
      const toPlayer = Math.atan2(player.position.x - walker.x, -(player.position.z - walker.z));
      const far = Math.hypot(walker.x - player.position.x, walker.z - player.position.z) > WALK_RADIUS;
      walker.heading = far ? toPlayer : walker.heading + (Math.random() - 0.5) * 0.6;
      walker.x += Math.sin(walker.heading) * WALK_SPEED * seconds;
      walker.z -= Math.cos(walker.heading) * WALK_SPEED * seconds;
      const { latitude, longitude } = latLonAt(walker.x, walker.z);
      Object.assign(walker.data, { lat: latitude, lon: longitude, heading: THREE.MathUtils.radToDeg(walker.heading), speed: WALK_SPEED });
    }
    showPeople();
  };
  const addPerson = (connected) => {
    const angle = Math.random() * Math.PI * 2;
    const distance = 15 + Math.random() * 45;
    const x = player.position.x + Math.cos(angle) * distance;
    const z = player.position.z + Math.sin(angle) * distance;
    const { latitude, longitude } = latLonAt(x, z);
    walkers.push({
      x,
      z,
      heading: Math.random() * Math.PI * 2,
      data: {
        id: `dev-person-${++count}`,
        name: pick(NAMES),
        lat: latitude,
        lon: longitude,
        precision: 'precise',
        tone: pick(TONES),
        connected,
      },
    });
    walking ??= setInterval(walk, WALK_STEP_MS);
  };

  const actions = {
    event: () => eventInFront(false),
    liveEvent: () => eventInFront(true),
    events: () => {
      for (let i = 0; i < 10; i++) {
        const angle = Math.random() * Math.PI * 2;
        const distance = 60 + Math.random() * 240;
        addEvent(player.position.x + Math.cos(angle) * distance, player.position.z + Math.sin(angle) * distance, Math.random() < 0.3);
      }
      showEvents();
    },
    clearEvents: () => {
      if (selected === 'event') select.event(null);
      selected = selected === 'event' ? null : selected;
      events.length = 0;
      showEvents();
    },
    person: () => {
      addPerson(false);
      showPeople();
    },
    friend: () => {
      addPerson(true);
      showPeople();
    },
    crowd: () => {
      for (let i = 0; i < 20; i++) addPerson(Math.random() < 0.15);
      showPeople();
    },
    hello: () => {
      walkers
        .map((walker) => [walker, Math.hypot(walker.x - player.position.x, walker.z - player.position.z)])
        .sort((a, b) => a[1] - b[1])
        .slice(0, 5)
        .forEach(([walker], i) => {
          if (i % 2) people.say({ from: walker.data.id, text: 'Ciao!' });
          else people.gesture({ from: walker.data.id, to: 'me', url: null, emoji: '👋' });
        });
    },
    clearPeople: () => {
      if (selected === 'person') select.person(null);
      selected = selected === 'person' ? null : selected;
      walkers.length = 0;
      clearInterval(walking);
      walking = null;
      showPeople();
    },
    storm: () => {
      environment.setWeatherOverride(WEATHER_PRESETS.storm);
      actions.strike();
    },
    strike: () => {
      const ahead = forward();
      environment.strike(Math.atan2(ahead.z, ahead.x) + (Math.random() - 0.5) * 0.6);
    },
    flock: () => wildlife.flockNow(),
    status: () => `${events.length} test events · ${walkers.length} test people`,
  };

  // A tap: a test person or event is selected here (true: handled); any other tap
  // first lets go of the test thing selected
  const tap = (personId, eventId) => {
    if (personId?.startsWith('dev-')) {
      select.person(personId);
      selected = 'person';
      return true;
    }
    if (!personId && eventId?.startsWith('dev-')) {
      select.event(eventId);
      selected = 'event';
      return true;
    }
    if (selected) {
      select[selected](null);
      selected = null;
    }
    return false;
  };

  return {
    actions,
    tap,
    setAppEvents(list) {
      appEvents = Array.isArray(list) ? list : [];
      showEvents();
    },
    setAppPeople(list) {
      appPeople = Array.isArray(list) ? list : [];
      showPeople();
    },
  };
}
