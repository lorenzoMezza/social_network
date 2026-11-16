// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The last step of `make dev` (the Makefile has already set everything up and freed
// the ports): starts the local servers again, waits until each answers, then runs Expo
// in the foreground (QR code, r to reload). Ctrl+C stops Expo and the servers.
// Meanwhile every booted iOS simulator gets a GPS position (see locateSimulators).
//   node scripts/dev.mjs [--production] [--sim-location lat,lon] [--no-backend] [--java <JDK 25 home>]
import { execFile, spawn } from 'node:child_process';
import { mkdirSync, openSync, readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logs = path.join(root, '.dev/logs');
const production = process.argv.includes('--production');
const argument = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const simLocation = argument('--sim-location', '41.8953,12.4918'); // Rome

// --no-backend: another server answers on 7777. --java: the Java backend of production
// (backend-java/, its jar made by make dev JAVA=1, PostGIS already up in Docker)
const noBackend = process.argv.includes('--no-backend');
const javaHome = argument('--java', null);
const DEV_ENV = { DEV_TOOLS: '1', TRUST_UNVERIFIED_TOKENS: '1' };
const BACKEND = javaHome
  ? { name: 'backend', port: 7777, command: path.join(javaHome, 'bin/java'), args: ['-jar', 'app/build/libs/app.jar'], cwd: 'backend-java', env: DEV_ENV, wait: 120_000 }
  : { name: 'backend', port: 7777, command: path.join(root, 'backend/.venv/bin/python'), args: ['-m', 'app.main'], cwd: 'backend', env: DEV_ENV };
const SERVERS = [
  { name: 'tiles', port: 8093, command: process.execPath, args: ['tile-provider/scripts/serve.mjs'] },
  { name: 'avatars', port: 8092, command: process.execPath, args: ['avatar-server/server.mjs'] },
  ...(noBackend ? [] : [BACKEND]),
];

const children = new Set();
let stopping = false;

function stop(code) {
  if (!stopping) {
    stopping = true;
    for (const child of children) child.kill('SIGTERM');
  }
  process.exitCode = code;
}
process.once('SIGINT', () => stop(130));
process.once('SIGTERM', () => stop(143));

// Any HTTP answer (even a 404) means the server is up
async function answers(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}

async function startServer({ name, port, command, args, cwd = '.', env = {}, wait = 30_000 }) {
  const log = path.join(logs, `${name}.log`);
  const output = openSync(log, 'w');
  const child = spawn(command, args, { cwd: path.join(root, cwd), stdio: ['ignore', output, output], env: { ...process.env, ...env } });
  children.add(child);
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (!stopping) console.error(`[dev] ${name} stopped (${signal ?? `code ${code}`}): see ${path.relative(root, log)}`);
  });
  const deadline = Date.now() + wait;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) break;
    if (await answers(port)) return;
    await new Promise((resolve) => { setTimeout(resolve, 200); });
  }
  const tail = readFileSync(log, 'utf8').trim().split('\n').slice(-15).join('\n');
  throw new Error(`${name} did not start on port ${port}:\n${tail}`);
}

// A simulator has no position until one is set, and loses it when it restarts: without
// one the map never gets its first GPS fix and draws no tiles. Each simulator seen
// booted gets the app's location permission and the position once, so a route or a
// point chosen afterwards (Features › Location) is left alone. Checked every 5 s, so a
// simulator booted later gets it too; one shut down gets it again at its next boot.
const { ios: { bundleIdentifier } } = JSON.parse(readFileSync(path.join(root, 'app.json'), 'utf8')).expo;
const located = new Set();
const simctl = (...args) => new Promise((resolve) => {
  execFile('xcrun', ['simctl', ...args], (error, stdout) => resolve(error ? null : stdout));
});
async function locateSimulators() {
  const list = await simctl('list', 'devices', 'booted', '--json');
  if (!list) return;
  const booted = Object.values(JSON.parse(list).devices).flat().filter((device) => device.state === 'Booted');
  for (const udid of located) if (!booted.some((device) => device.udid === udid)) located.delete(udid);
  for (const { udid, name } of booted) {
    if (located.has(udid)) continue;
    located.add(udid);
    await simctl('privacy', udid, 'grant', 'location', bundleIdentifier); // fails harmlessly if not installed
    if (await simctl('location', udid, 'set', simLocation) !== null) console.log(`[dev] ${name}: GPS at ${simLocation}`);
  }
}

try {
  mkdirSync(logs, { recursive: true });
  if (process.platform === 'darwin') {
    await locateSimulators();
    setInterval(locateSimulators, 5000).unref();
  }
  await Promise.all(SERVERS.map(startServer));
  const lan = Object.values(networkInterfaces()).flat().find((a) => a && a.family === 'IPv4' && !a.internal)?.address ?? 'localhost';
  console.log('\n[dev] Servers running (logs in .dev/logs/):');
  for (const { name, port } of SERVERS) console.log(`  ${name.padEnd(8)} http://${lan}:${port}`);
  if (!noBackend && !javaHome) console.log(`  ${'api docs'.padEnd(8)} http://${lan}:7777/v1/docs\n`);

  if (!stopping) {
    const args = ['start', '--lan', '--dev-client', '--scheme', 'projectexpofrontend', ...(production ? ['--no-dev', '--minify'] : [])];
    const env = production ? {
      ...process.env,
      EXPO_PUBLIC_API_URL: `http://${lan}:7777/v1`,
      EXPO_PUBLIC_AVATAR_URL: `http://${lan}:8092`,
      EXPO_PUBLIC_TILE_URL: `http://${lan}:8093/tiles.json`,
    } : process.env;
    const expo = spawn(path.join(root, 'node_modules/.bin/expo'), args, { cwd: root, stdio: 'inherit', env });
    children.add(expo);
    expo.once('exit', (code) => stop(code ?? 0));
  }
} catch (error) {
  if (!stopping) console.error(`\n[dev] ${error.message}`);
  stop(process.exitCode ?? 1);
}
