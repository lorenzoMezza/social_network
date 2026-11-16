// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The events of the showcase scene: each by another demo person, around a point, some on
// now, one sponsored, and Alex going to two of them with a few friends. Used by
// seed-scene.mjs (the development backend, for the recordings) and by the try-it demo
// (show-case/demo/, the backend in the browser). Run again, what is there stays.
//   await seedScene(call, { latitude, longitude })
//   call(token, method, path, body) → the answer's JSON (throws on an error status)
const MINUTE = 60_000;

export const EVENTS = [
  { host: 'giulia', name: 'Giulia Rossi', title: 'Sunset rooftop DJ set', emoji: '🎧', categories: ['music', 'party'], at: [30, 220],
    from: -20, hours: 4, theme: { color: null, beam: '#FF5FA2', beamStyle: 'helix', background: 'aurora', title: 'bold' },
    description: 'Deep house as the sun goes down over the Colosseum. Bring friends, the terrace is big.' },
  { host: 'marco', name: 'Marco Bianchi', title: 'Street food night market', emoji: '🍕', categories: ['food', 'festival'], at: [140, 330],
    from: -45, hours: 5, sponsored: true, theme: { beam: '#FF7A3D', beamStyle: 'pulse', background: 'glow', title: 'classic' },
    description: 'Twenty stalls from all over Italy: supplì, arrosticini, cannoli. Live music from 8.' },
  { host: 'luca', name: 'Luca Ferri', title: '5-a-side football, one spot left', emoji: '⚽', categories: ['sports', 'competitive'], at: [250, 160],
    from: 35, hours: 1.5, theme: { beam: '#5CD66B', beamStyle: 'beam', background: 'plain', title: 'bold' },
    description: 'Friendly match on the small pitch. We need one more player, any level.' },
  { host: 'sofia', name: 'Sofia Conti', title: 'Open-air cinema: Roman Holiday', emoji: '🎬', categories: ['exposition', 'free entry'], at: [300, 480],
    from: 150, hours: 2.5, theme: { beam: '#A46BFF', beamStyle: 'veil', background: 'tint', title: 'serif' },
    description: 'The 1953 classic on a big screen under the stars. Blankets welcome.' },
  { host: 'chiara', name: 'Chiara Greco', title: 'Board games & spritz', emoji: '🎲', categories: ['games', 'drinks'], at: [200, 420],
    from: 90, hours: 3, theme: { beam: '#4DA3FF', beamStyle: 'stardust', background: 'pattern', title: 'mono' },
    description: 'Catan, Codenames and a lot of spritz. Newcomers are very welcome.' },
  { host: 'paolo', name: 'Paolo Russo', title: 'Live jazz at the corner bar', emoji: '🎸', categories: ['music', 'drinks'], at: [80, 520],
    from: -10, hours: 3, theme: { beam: '#FF5C5C', beamStyle: 'beam', background: 'glow', title: 'serif' },
    description: 'A trio playing standards all night. Free entry, good wine.' },
  { host: 'elena', name: 'Elena Marino', title: 'Morning yoga in the park', emoji: '🧘', categories: ['relaxing', 'free entry'], at: [340, 300],
    from: 18 * 60, hours: 1, theme: { beam: '#22D3C5', beamStyle: 'stardust', background: 'tint', title: 'classic' },
    description: 'Gentle flow on the grass for every level. Bring a mat and water.' },
  // Close to the player: big beams in the first shots
  { host: 'irene', name: 'Irene Gallo', title: 'Aperitivo by the fountain', emoji: '🍹', categories: ['drinks', 'social'], at: [110, 85],
    from: -4, hours: 3, theme: { beam: '#22D3C5', beamStyle: 'pulse', background: 'glow', title: 'classic' },
    description: 'Spritz, olives and good company around the fountain. Come say hi.' },
  { host: 'davide', name: 'Davide Costa', title: 'Golden hour photo walk', emoji: '📸', categories: ['social', 'free entry'], at: [210, 95],
    from: 15, hours: 2, theme: { beam: '#A46BFF', beamStyle: 'helix', background: 'aurora', title: 'bold' },
    description: 'A slow walk around the Colosseum with cameras or phones. All levels.' },
  { host: 'fabio', name: 'Fabio Moretti', title: 'Karaoke night', emoji: '🎤', categories: ['music', 'party'], at: [320, 75],
    from: -4, hours: 4, theme: { beam: '#FF5C5C', beamStyle: 'stardust', background: 'aurora', title: 'bold' },
    description: 'Pick a song, grab the mic. Prizes for the bravest.' },
];

// Alex, the person the visitor is in the demo
const ALEX = { token: 'showcase.alex', name: 'Alex', username: 'alex', bio: 'Out and about in Rome. Live music, street food, sunsets.' };

export async function seedScene(call, { latitude: LAT, longitude: LON, log = () => {} }) {
  // A point `metres` away from the centre towards `bearing` (degrees from north)
  const place = (bearing, metres) => {
    const rad = (bearing * Math.PI) / 180;
    return {
      latitude: LAT + (Math.cos(rad) * metres) / 111_320,
      longitude: LON + (Math.sin(rad) * metres) / (111_320 * Math.cos((LAT * Math.PI) / 180)),
    };
  };
  const me = await call(ALEX.token, 'GET', '/me');
  if (me?.name !== ALEX.name) {
    await call(ALEX.token, 'PATCH', '/me', { name: ALEX.name, bio: ALEX.bio }).catch(() => {});
    await call(ALEX.token, 'PATCH', '/me', { username: ALEX.username }).catch(() => {});
  }
  const now = Date.now();
  const made = [];
  for (const event of EVENTS) {
    const token = `showcase.${event.host}`;
    await call(token, 'GET', '/me');
    await call(token, 'PATCH', '/me', { name: event.name }).catch(() => {});
    await call(token, 'PATCH', '/me', { username: `${event.host}.rome` }).catch(() => {});
    // Run again: what is there stays
    const mine = await call(token, 'GET', '/me/events');
    const existing = Object.values(mine).flat().find((entry) => entry?.title === event.title && !['cancelled', 'concluded'].includes(entry.status));
    if (existing) {
      made.push({ ...event, id: existing.id });
      log(`${existing.id}  ${event.title} (already there)`);
      continue;
    }
    const at = place(...event.at);
    // Already on: started just now (the server takes a start up to 5 minutes ago)
    const start = new Date(now + Math.max(event.from, -4) * MINUTE);
    const end = new Date(start.getTime() + event.hours * 60 * MINUTE);
    const body = {
      title: event.title,
      description: event.description,
      categories: event.categories,
      location: { ...at, address: 'Rome' },
      dates: { startDate: start.toISOString(), endDate: end.toISOString() },
      theme: { emoji: event.emoji, ...event.theme },
      reach: 800,
    };
    const created = await call(token, 'POST', '/events', body);
    made.push({ ...event, id: created.id });
    log(`${created.id}  ${event.title}`);
    if (event.sponsored) {
      // Development credits (DEV_TOOLS), then the gold beam over a wider reach
      await call(token, 'POST', '/me/wallet/purchases', { platform: 'dev', productId: 'promo.credits.4999', purchaseToken: `showcase-${now}` });
      const quote = await call(token, 'GET', `/events/${created.id}/promotion/quote?radius=1500`);
      await call(token, 'PUT', `/events/${created.id}/promotion`, { radius: 1500, daily: quote.daily });
    }
  }

  // Alex goes to the DJ set and the market; a few friends join too
  const alex = 'showcase.alex';
  for (const title of ['Sunset rooftop DJ set', 'Street food night market']) {
    const event = made.find((entry) => entry.title === title);
    await call(alex, 'PUT', `/events/${event.id}/followers/me`).catch(() => {});
  }
  for (const [host, title] of [['sofia', 'Sunset rooftop DJ set'], ['luca', 'Street food night market'], ['chiara', 'Sunset rooftop DJ set']]) {
    const event = made.find((entry) => entry.title === title);
    await call(`showcase.${host}`, 'PUT', `/events/${event.id}/followers/me`).catch(() => {});
  }
  log(`${made.length} events around ${LAT},${LON}`);
  return made;
}
