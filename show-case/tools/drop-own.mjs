// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Removes an event Alex made during a take, so the next take starts from the same map:
//   node show-case/tools/drop-own.mjs <words of its title>
const API = process.env.API_URL || 'http://127.0.0.1:7777/v1';
const headers = { Authorization: 'Bearer showcase.alex' };
const words = process.argv.slice(2).join(' ').toLowerCase();
if (!words) throw new Error('which event? some words of its title');
const { created = [] } = await (await fetch(`${API}/me/events`, { headers })).json();
for (const event of created) {
  if (!event.title.toLowerCase().includes(words)) continue;
  const gone = await fetch(`${API}/events/${event.id}`, { method: 'DELETE', headers });
  console.log(gone.status, event.title);
}
