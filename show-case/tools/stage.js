// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Staging helpers for the map page, sent once by the director (show-case/tools/ready.sh):
//   node show-case/tools/director.mjs file show-case/tools/stage.js
// then commands like:  node show-case/tools/director.mjs run "sc.time(19.5); sc.orbit({ to: 1.2, seconds: 9 })"
// It turns on the page's developer tools for their console (mapDebug) and hides their
// buttons and overlay, so nothing of them shows in a recording.
(() => {
  if (!window.mapDebug?.devTest) window.setMapDebugStatsEnabled(true);
  const d = window.mapDebug;
  const hide = () => {
    const labels = new Set(['Virtual player', 'Scene', 'Teleport', 'Test']);
    for (const button of document.querySelectorAll('button')) {
      if (labels.has(button.textContent.trim())) button.style.display = 'none';
    }
    for (const node of document.querySelectorAll('.scene-panel, #debug-stats')) node.style.display = 'none';
  };
  hide();
  // What the panels would do, without their buttons
  const weatherSelect = () => [...document.querySelectorAll('.scene-panel select')].find((select) => [...select.options].some((o) => o.value === 'storm'));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
  let angle = window.sc?.state?.angle ?? Math.PI / 2;
  let zoom = window.sc?.state?.zoom ?? 0.35;
  let move = null;
  // The lists the app gives the map, kept to find someone or something by name
  const seen = window.sc?.seen ?? { people: [], events: [] };
  if (!d.people.__showcase) {
    const setPeople = d.people.set;
    d.people.set = (list) => { seen.people = list; return setPeople(list); };
    d.people.__showcase = true;
    const setEvents = d.beacons.set;
    d.beacons.set = (list) => { seen.events = list; return setEvents(list); };
  }
  const post = (message) => window.ReactNativeWebView?.postMessage(JSON.stringify(message));
  const find = (list, text) => list.find((item) => item.id === text || JSON.stringify(item).toLowerCase().includes(text.toLowerCase()));

  window.sc = {
    state: { get angle() { return angle; }, get zoom() { return zoom; } },
    hide,
    // Hour of the day (0–24), or null for the real one
    time: (hours) => d.environment.setTimeOverride(hours),
    weather: (name) => {
      const select = weatherSelect();
      if (!select) return;
      select.value = name;
      select.dispatchEvent(new Event('change'));
      select.dispatchEvent(new Event('input'));
    },
    // How much of the sky the clouds cover (0–1), on a fair day: the recordings keep it low
    sky: (cover = 0.12) => d.environment.setWeatherOverride({ cloudCover: cover, overcast: 0, rain: 0, snow: 0, fog: 0, storm: 0, windSpeed: 3, windDirection: 270 }),
    // The hour running from one time to another over seconds (sky, light, street lamps)
    timelapse: ({ from, to, seconds = 8 } = {}) => {
      const started = performance.now();
      const step = () => {
        const t = Math.min(1, (performance.now() - started) / (seconds * 1000));
        d.environment.setTimeOverride(from + (to - from) * ease(t));
        if (t < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    },
    // The view at once: zoom 0 (closest) – 1 (farthest), angle in radians around the target
    view: ({ zoom: z = zoom, angle: a = angle } = {}) => {
      zoom = z;
      angle = a;
      d.cameraRig.setView({ zoom, angle });
    },
    // A smooth camera move: to an angle (radians, absolute) and/or a zoom, over seconds
    orbit: ({ to = angle, zoomTo = zoom, seconds = 8, linear = false } = {}) => {
      if (move) cancelAnimationFrame(move);
      const from = { angle, zoom };
      const started = performance.now();
      const step = () => {
        const t = Math.min(1, (performance.now() - started) / (seconds * 1000));
        const k = linear ? t : ease(t);
        angle = from.angle + (to - from.angle) * k;
        zoom = from.zoom + (zoomTo - from.zoom) * k;
        d.cameraRig.setView({ zoom, angle });
        move = t < 1 ? requestAnimationFrame(step) : null;
      };
      move = requestAnimationFrame(step);
    },
    stop: () => {
      if (move) cancelAnimationFrame(move);
      move = null;
    },
    // The developer panel's test things: event, liveEvent, events, person, friend, crowd,
    // hello, storm, strike, flock, clearEvents, clearPeople
    test: (name, times = 1) => {
      for (let i = 0; i < times; i++) d.devTest.actions[name]();
      hide();
    },
    status: () => window.report?.(d.devTest.actions.status()),
    // The view angle that looks from behind the player towards a point (searched: the rig's
    // angle has its own origin), the player turned to it too
    aimAt: (id, { zoom: z = zoom, behind = true } = {}) => {
      const target = d.beacons.positionOf(id);
      if (!target) return window.report?.(`no event ${id}`);
      const from = d.player.position;
      const want = Math.atan2(target.x - from.x, target.z - from.z);
      const dir = d.cameraRig.camera.position.clone();
      let best = angle;
      let bestError = Infinity;
      for (let a = 0; a < Math.PI * 2; a += Math.PI / 90) {
        d.cameraRig.setView({ zoom: z, angle: a });
        d.cameraRig.camera.getWorldDirection(dir);
        const error = Math.abs(Math.atan2(Math.sin(Math.atan2(dir.x, dir.z) - want), Math.cos(Math.atan2(dir.x, dir.z) - want)));
        if (error < bestError) { bestError = error; best = a; }
      }
      angle = best;
      zoom = z;
      d.cameraRig.setView({ zoom, angle });
      if (behind) d.player.rotation.y = want;
      window.report?.({ aimed: id, angle: Number(best.toFixed(3)) });
    },
    // Where a finger must go to tap an event's badge (points), for the recorder
    where: (id) => {
      const canvas = d.renderer.domElement;
      const bounds = canvas.getBoundingClientRect();
      for (const circle of d.beacons.badgeCircles({ width: bounds.width, height: bounds.height })) {
        if (d.beacons.pick(bounds.left + circle.x, bounds.top + circle.y, bounds) === id) {
          return window.report?.({ where: id, x: Math.round(bounds.left + circle.x), y: Math.round(bounds.top + circle.y), r: Math.round(circle.r) });
        }
      }
      window.report?.({ where: id, x: null });
    },
    seen,
    list: () => window.report?.({
      people: seen.people.map((item) => [item.id, item.name ?? item.displayName ?? item.username]),
      events: seen.events.map((item) => [item.id, item.title ?? item.emoji]),
    }),
    // What a finger on it does: the app opens its card and the view flies to it
    tapEvent: (text) => {
      const event = find(seen.events, text);
      post({ type: 'event-tap', id: event?.id ?? text });
    },
    tapPerson: (text) => {
      const person = find(seen.people, text);
      post({ type: 'person-tap', id: person?.id ?? text });
    },
  };
  window.report?.('stage ready');
})();
