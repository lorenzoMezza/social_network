// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The code Alex is showing gets scanned by a demo person (backend with SHOWCASE=1):
//   node show-case/tools/scan.mjs user-nico_l
//   node show-case/tools/scan.mjs reset user-nico_l   (disconnect them again, for another take)
const API = process.env.API_URL || 'http://127.0.0.1:7777/v1';
if (process.argv[2] === 'reset') {
  const gone = await fetch(`${API}/me/connections/${process.argv[3]}`, { method: 'DELETE', headers: { Authorization: 'Bearer showcase.alex' } });
  console.log('reset', gone.status);
  process.exit(0);
}
const answer = await fetch(`${API}/dev/showcase/scanned`, {
  method: 'POST',
  headers: { Authorization: 'Bearer showcase.alex', 'Content-Type': 'application/json' },
  body: JSON.stringify({ guest: process.argv[2] }),
});
console.log(answer.status, (await answer.text()).slice(0, 120));
