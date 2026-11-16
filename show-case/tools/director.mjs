// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The director of a showcase recording (show-case/tools/ready.sh): the app in showcase mode
// (EXPO_PUBLIC_SHOWCASE=1) asks it every 200 ms for a script to run in the map page.
//   node show-case/tools/director.mjs            serve on port 8095
//   node show-case/tools/director.mjs run 'js'   queue a script (the server must be running)
//   node show-case/tools/director.mjs file f.js  queue the content of a file
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';

const PORT = 8095;
// Where the phone reaches this computer (the same address as the development servers)
const DIRECTOR = process.env.DIRECTOR_URL || 'http://127.0.0.1:8095';
const [command, value] = process.argv.slice(2);

if (command === 'run' || command === 'file') {
  const script = command === 'file' ? readFileSync(value, 'utf8') : value;
  const answer = await fetch(`http://127.0.0.1:${PORT}/run`, { method: 'POST', body: script });
  console.log(answer.ok ? 'queued' : `refused: ${answer.status}`);
} else {
  const queue = [];
  createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/next') {
      const script = queue.shift() ?? '';
      res.writeHead(200, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
      res.end(script);
      return;
    }
    // What a script reports (window.report(value) in the page): printed here
    if (req.method === 'POST' && req.url === '/log') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        console.log(`[map] ${body}`);
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*' }).end();
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/run') {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        // Each script runs on its own: one that throws does not stop the next
        queue.push(`window.report = (value) => fetch('${DIRECTOR}/log', { method: 'POST', body: typeof value === 'string' ? value : JSON.stringify(value) }).catch(() => {});
try { ${body}\n} catch (error) { window.report('error: ' + error.message); }`);
        res.writeHead(204).end();
      });
      return;
    }
    res.writeHead(404).end();
  }).listen(PORT, '0.0.0.0', () => console.log(`director on ${PORT}`));
}
