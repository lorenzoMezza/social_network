// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Photos in the album of the showcase's DJ set (show-case/tools/ready.sh), through the app's own
// upload flow: POST /uploads, PUT the file, POST /events/{id}/photos. Free Unsplash photos via
// Picsum. Run after seed-scene.mjs:  node show-case/tools/seed-album.mjs <eventId>
const API = process.env.API_URL || 'http://127.0.0.1:7777/v1';
const event = process.argv[2];
const PHOTOS = [['showcase.giulia', 1067, 1600, 1200], ['showcase.alex', 129, 1200, 1600], ['showcase.sofia', 249, 1600, 1200], ['showcase.chiara', 1047, 1200, 1600]];

for (const [token, id, width, height] of PHOTOS) {
  const file = Buffer.from(await (await fetch(`https://picsum.photos/id/${id}/${width}/${height}.jpg`)).arrayBuffer());
  const auth = { Authorization: `Bearer ${token}` };
  const ticket = await (await fetch(`${API}/uploads`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ purpose: 'event-photo', mimeType: 'image/jpeg', fileSize: file.length, eventId: event, width, height }),
  })).json();
  if (!ticket.uploadUrl) throw new Error(`ticket: ${JSON.stringify(ticket)}`);
  const put = await fetch(ticket.uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg', ...ticket.headers, ...auth }, body: file });
  if (!put.ok) throw new Error(`upload: ${put.status} ${await put.text()}`);
  const posted = await fetch(`${API}/events/${event}/photos`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ uploadId: ticket.uploadId }),
  });
  console.log(token, id, posted.status, posted.ok ? '' : (await posted.text()).slice(0, 160));
}
