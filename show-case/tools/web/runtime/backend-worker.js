// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The development backend (backend/app, Python) inside the browser (a module worker): Pyodide runs CPython
// compiled to WebAssembly, with FastAPI, pydantic, orjson and Pillow, in this worker so the
// page never waits on it. boot.js hands it the app's requests (from sw.js) and sockets.
// Its state is kept in this browser (IndexedDB) for a few hours; ?reset in the page's
// address starts it over.
// (pyodide/ is put next to this file by build.mjs)
// eslint-disable-next-line import/no-unresolved
import { loadPyodide } from './pyodide/pyodide.mjs';

const say = (text) => postMessage({ type: 'progress', text });
const KEPT_MS = 6 * 60 * 60 * 1000;
const sockets = new Map();
let demo = null;

const ready = (async () => {
  const { reset } = await new Promise((resolve) => {
    self.addEventListener('message', function first(event) {
      if (event.data?.type !== 'start') return;
      self.removeEventListener('message', first);
      resolve(event.data);
    });
  });
  say('Starting Python');
  const py = await loadPyodide({ indexURL: new URL('pyodide/', self.location).href });
  say('Loading FastAPI, pydantic, Pillow');
  const manifest = await (await fetch('backend/manifest.json')).json();
  await py.loadPackage([...manifest.packages, ...manifest.wheels.map((wheel) => new URL(`pyodide/${wheel}`, self.location).href)], { messageCallback: () => {} });
  say('Unpacking the backend');
  py.unpackArchive(await (await fetch('backend/backend.zip')).arrayBuffer(), 'zip', { extractDir: '/' });

  // The state of the server, kept between visits
  py.FS.mkdirTree('/data');
  py.FS.mount(py.FS.filesystems.IDBFS, {}, '/data');
  await new Promise((resolve) => py.FS.syncfs(true, () => resolve()));
  // Kept for a few hours: a visit days later finds the demo's events long over, so it
  // starts again, as it does with ?reset
  let since = 0;
  try {
    since = Number(py.FS.readFile('/data/started', { encoding: 'utf8' })) || 0;
  } catch {
    // First visit
  }
  if (reset || Date.now() - since > KEPT_MS) {
    try {
      py.FS.unlink('/data/state.pickle');
    } catch {
      // Nothing kept
    }
    py.FS.writeFile('/data/started', String(Date.now()));
  }
  let saving = false;
  setInterval(() => {
    if (saving) return;
    saving = true;
    py.FS.syncfs(false, () => {
      saving = false;
    });
  }, 4000);

  say('Starting the server');
  py.globals.set('demo_env', py.toPy(manifest.env));
  py.globals.set('demo_looks', py.toPy(manifest.looks));
  await py.runPythonAsync(`
import os, sys
os.environ.update(demo_env)
sys.path.insert(0, '/backend')
import webdemo
webdemo.bake_known(demo_looks)
await webdemo.start()
`);
  demo = py.pyimport('webdemo');
  return py;
})();

ready.then(() => postMessage({ type: 'ready' }), (error) => {
  console.error(error);
  postMessage({ type: 'failed', text: String(error?.message ?? error).split('\n').slice(-3).join(' ') });
});

self.addEventListener('message', async (event) => {
  const message = event.data;
  if (message?.type === 'http') {
    const port = event.ports[0];
    try {
      const py = await ready;
      const answer = await demo.http(message.method, message.path, message.query, py.toPy(message.headers), message.body ? new Uint8Array(message.body) : null);
      const [status, headers, body] = answer.toJs({ create_pyproxies: false });
      answer.destroy();
      const bytes = body instanceof Uint8Array ? body : new Uint8Array(body ?? []);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      port.postMessage({ status, headers, body: buffer }, [buffer]);
    } catch (error) {
      console.error(error);
      const body = new TextEncoder().encode('{"code":"internal","message":"something went wrong"}').buffer;
      port.postMessage({ status: 500, headers: [['content-type', 'application/json']], body }, [body]);
    }
  } else if (message?.type === 'ws-open') {
    await ready;
    const socket = demo.Socket(message.path, message.query, (kind, data) => {
      postMessage({ type: 'ws', id: message.id, kind, data: data ?? null });
      if (kind === 'close') sockets.delete(message.id);
    });
    sockets.set(message.id, socket);
  } else if (message?.type === 'ws-send') {
    sockets.get(message.id)?.push(message.data);
  } else if (message?.type === 'ws-close') {
    sockets.get(message.id)?.close(message.code ?? 1000);
  }
});
