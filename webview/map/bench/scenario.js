// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// In the map page (bench.mjs): a busy world, the same every run, fed through the calls
// the app makes (MapWebView): events around, people walking in their map avatars, the
// player walking a circle with the phone's fused state ten times a second
window.startBenchScenario = ({ center, events, people, avatarBase, avatarKeys, standIn, spread = 450, walkRadius = 120 }) => {
  let seed = 12345;
  const random = () => {
    seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const M_LAT = 1 / 111320;
  const M_LON = 1 / (111320 * Math.cos((center.latitude * Math.PI) / 180));
  const around = (radius) => {
    const r = radius * Math.sqrt(random());
    const a = random() * Math.PI * 2;
    return { latitude: center.latitude + Math.sin(a) * r * M_LAT, longitude: center.longitude + Math.cos(a) * r * M_LON };
  };

  // Events within 1 km (the app's map radius): the farther ones are in the fog
  const colors = ['#E5735B', '#5B8DE5', '#5BC28A', '#C25BB5', '#E5B95B', '#5BC2C2'];
  const emojis = ['🎉', '🎸', '⚽', '🍕', '🎨', '📚', '🧘', '🍷'];
  const eventList = Array.from({ length: events }, (_, i) => ({
    id: `bench-event-${i}`,
    ...around(1000),
    color: colors[i % colors.length],
    emoji: emojis[i % emojis.length],
    crowd: Math.floor(random() * 40),
    live: random() < 0.4,
    flash: random() < 0.1,
    mine: i === 0,
    following: random() < 0.2,
  }));
  window.setMapEvents(eventList);

  const files = (key) => ({ model: `${avatarBase}${key}.glb`, astc: `${avatarBase}${key}.ktx2`, png: `${avatarBase}${key}.png` });
  if (standIn) window.setPeopleStandIn(files(standIn));
  const names = ['Sara Moretti', 'Tommaso', 'Chiara V.', 'Davide', 'Irene', 'Federico', 'Marta', 'Luca B.', 'Giulia R.', 'Blue Note TV'];
  const walkers = Array.from({ length: people }, (_, i) => ({
    id: `bench-person-${i}`,
    name: names[i % names.length],
    ...around(spread),
    heading: random() * 360,
    speed: random() < 0.25 ? 0 : 1.2 + random() * 0.6,
    area: i % 9 === 0,
    tone: colors[i % colors.length],
  }));
  // Every second, as the server's presence frames: everyone, in the short form
  const sendPeople = () => window.setMapPeople(walkers.map((w) => ({
    id: w.id, name: w.name, lat: w.latitude, lon: w.longitude, precision: w.area ? 'area' : 'precise', heading: w.heading, speed: w.speed, tone: w.tone,
  })));
  sendPeople();
  if (avatarKeys.length) walkers.forEach((w, i) => window.setPersonAvatar(w.id, files(avatarKeys[i % avatarKeys.length])));
  const timers = [setInterval(() => {
    for (const w of walkers) {
      if (w.area || !w.speed) continue;
      w.heading = (w.heading + (random() - 0.5) * 30 + 360) % 360;
      const a = (w.heading * Math.PI) / 180;
      w.latitude += Math.cos(a) * w.speed * M_LAT;
      w.longitude += Math.sin(a) * w.speed * M_LON;
    }
    sendPeople();
  }, 1000)];

  // The player: walkRadius (120 m) around the centre at 1.4 m/s, a step every 0.6 m
  const RADIUS = walkRadius;
  const SPEED = 1.4;
  let angle = 0;
  let steps = 0;
  let travelled = 0;
  timers.push(setInterval(() => {
    angle += (SPEED * 0.1) / RADIUS;
    travelled += SPEED * 0.1;
    if (travelled > 0.6) {
      steps++;
      travelled = 0;
    }
    const heading = (360 - (angle * 180) / Math.PI) % 360;
    window.updatePlayerLocation({
      latitude: center.latitude + Math.sin(angle) * RADIUS * M_LAT,
      longitude: center.longitude + Math.cos(angle) * RADIUS * M_LON,
      heading,
      speed: SPEED,
      accuracy: 5,
      timestamp: Date.now(),
      moving: true,
      velocity: { east: -Math.sin(angle) * SPEED, north: Math.cos(angle) * SPEED },
      cadence: 1.8,
      steps,
    });
  }, 100));
  return { events: eventList, stop: () => timers.forEach(clearInterval) };
};
