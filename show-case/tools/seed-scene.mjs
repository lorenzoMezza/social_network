// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The events of the showcase scene (scene.mjs) on the development backend started with
// SHOWCASE=1 (show-case/tools/ready.sh). Run once per backend start:
//   node show-case/tools/seed-scene.mjs
import { seedScene } from './scene.mjs';

const API = process.env.API_URL || 'http://127.0.0.1:7777/v1';
const [latitude, longitude] = (process.env.CENTER || '41.8953,12.4918').split(',').map(Number);

const call = async (token, method, path, body) => {
  const answer = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await answer.text();
  const json = text ? JSON.parse(text) : null;
  if (!answer.ok) throw new Error(`${method} ${path}: ${answer.status} ${text.slice(0, 200)}`);
  return json;
};

await seedScene(call, { latitude, longitude, log: console.log });
