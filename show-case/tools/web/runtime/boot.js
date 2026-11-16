// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Starts the try-it demo before the app (show-case/demo/index.html, made by build.mjs):
//   1. a fixed GPS position in Rome, fresh every few seconds, as a phone's would be;
//   2. the service worker (sw.js) that answers for the app's servers;
//   3. the backend (backend-worker.js: Python in WebAssembly) and a WebSocket that reaches it;
//   4. then the app itself, the Expo web build, which knows none of this.
(function () {
  'use strict';
  const HOME = { latitude: 41.8953, longitude: 12.4918 };
  const API_HOST = 'api.demo.invalid';
  const reset = /[?&]reset\b/.test(location.search);
  // The demo's folder on the site (build.mjs --base), whatever screen the address names
  const BASE = new URL(window.DEMO_BASE || './', location.href).href;

  // --- What this page is: a beta, squeezed into a browser, rougher than the phone app ---
  // On a computer it stays beside the app; on a phone, where there is no room beside it,
  // the screen shown while the server starts says it, and waits for a tap.
  // Wider than a phone (a computer, a tablet, a narrow browser window) this page is a frame:
  // the app runs in a phone-sized iframe (this same page with ?embedded), because it sizes
  // everything on its window, and the words sit beside it (or under it, below 900 px). On a
  // phone the app takes the whole screen.
  const wide = window.matchMedia('(min-width: 600px)');
  const embedded = /[?&]embedded\b/.test(location.search);
  const hosting = !embedded && wide.matches;
  const showcase = new URL('../', BASE).href;
  const aside = document.createElement('aside');
  aside.id = 'demo-aside';
  aside.innerHTML = '<span class="demo-badge">Beta</span>' +
    '<h1 class="demo-warning">A web stand-in, not the real app</h1>' +
    '<p class="demo-warning-text">This is the app squeezed into a browser, so you can try it without installing anything. ' +
    'The real one is made for iPhone and Android. Here its phone parts (GPS, camera, the 3D views, the sensors) are replaced ' +
    'by web substitutes, so it is slower, rougher and buggier than on a phone.</p>' +
    '<p>The app itself is in beta too: not in the stores yet, and still changing.</p>' +
    '<p>To see how it really looks and feels, watch the recordings on the <a href="' + showcase + '">showcase page</a>.</p>' +
    '<h2>Things to try</h2><ul>' +
    '<li>You are Alex, near the Colosseum. The people walking around are demo people: they wave back, answer and chat.</li>' +
    '<li>Tap someone on the map to wave or say hi; tap yourself to say something to everyone around.</li>' +
    '<li>Tap a beam of light to open its event; press and hold the map to put up your own.</li>' +
    '<li>In <b>Profile</b>, change your avatar and the style of your page.</li>' +
    '<li>In <b>Social</b>, open your code: someone nearby connects.</li></ul>' +
    '<p class="demo-aside-small">Here you start visible, so the people around show at once; the real app opens invisible every time.</p>' +
    '<p class="demo-aside-small">It all runs in this tab: the Python backend is compiled to WebAssembly. Nothing leaves your device, and it starts over after a few hours.</p>' +
    '<a class="demo-back" href="' + showcase + '">Back to the showcase</a>';

  // --- The screen shown while the server starts ---
  const cover = document.createElement('div');
  cover.id = 'demo-cover';
  cover.innerHTML = '<div class="demo-cover-body"><div class="demo-beam" aria-hidden="true"></div>' +
    '<span class="demo-badge">Beta</span>' +
    '<p class="demo-cover-title">Starting the server in your browser</p>' +
    '<p class="demo-cover-step" role="status">Loading</p>' +
    '<p class="demo-cover-caveat"><strong>A web stand-in, not the real app.</strong> The real one is made for iPhone and Android: ' +
    'squeezed into a browser it is slower, rougher and buggier. The app itself is still in beta.</p>' +
    '<button class="demo-open" type="button" hidden>Open the app</button>' +
    '<a class="demo-back" href="' + showcase + '" target="_top">Back to the showcase</a></div>';
  const step = (text) => {
    const line = cover.querySelector('.demo-cover-step');
    if (line) line.textContent = text;
  };
  if (hosting) {
    document.documentElement.classList.add('demo-hosting');
    document.addEventListener('DOMContentLoaded', () => {
      const frame = document.createElement('iframe');
      frame.id = 'demo-frame';
      frame.title = 'UnnamedApp beta';
      frame.src = `${BASE}?embedded${reset ? '&reset' : ''}`;
      document.body.append(frame, aside);
      if (reset) history.replaceState(null, '', location.pathname);
    });
    return;
  }
  if (embedded) document.documentElement.classList.add('demo-embedded');
  document.addEventListener('DOMContentLoaded', () => document.body.appendChild(cover));

  // --- 1. Where the demo stands ---
  const fix = () => ({
    coords: { latitude: HOME.latitude, longitude: HOME.longitude, accuracy: 6, altitude: null, altitudeAccuracy: null, heading: null, speed: 0 },
    timestamp: Date.now(),
  });
  const watches = new Map();
  let nextWatch = 1;
  const geolocation = {
    getCurrentPosition(success) {
      setTimeout(() => success(fix()), 30);
    },
    watchPosition(success) {
      const id = nextWatch++;
      setTimeout(() => success(fix()), 30);
      watches.set(id, setInterval(() => success(fix()), 5000));
      return id;
    },
    clearWatch(id) {
      clearInterval(watches.get(id));
      watches.delete(id);
    },
  };
  try {
    Object.defineProperty(navigator, 'geolocation', { configurable: true, get: () => geolocation });
    if (navigator.permissions?.query) {
      const query = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = (what) => (what?.name === 'geolocation'
        ? Promise.resolve({ state: 'granted', status: 'granted', onchange: null, addEventListener() {}, removeEventListener() {} })
        : query(what));
    }
  } catch (error) {
    console.warn('demo: no fixed position', error);
  }

  // --- 3b. The app's WebSocket to the backend in the worker ---
  let worker = null;
  const sockets = new Map();
  let nextSocket = 1;
  const NativeWebSocket = window.WebSocket;
  class DemoSocket extends EventTarget {
    constructor(url) {
      super();
      const address = new URL(url);
      this.url = String(url);
      this.readyState = 0;
      this.protocol = '';
      this.extensions = '';
      this.bufferedAmount = 0;
      this.binaryType = 'blob';
      this.onopen = this.onmessage = this.onclose = this.onerror = null;
      this.id = nextSocket++;
      sockets.set(this.id, this);
      worker.postMessage({ type: 'ws-open', id: this.id, path: address.pathname, query: address.search.slice(1) });
    }
    send(data) {
      if (this.readyState !== 1) throw new DOMException('not open', 'InvalidStateError');
      worker.postMessage({ type: 'ws-send', id: this.id, data: String(data) });
    }
    close(code = 1000) {
      if (this.readyState >= 2) return;
      this.readyState = 2;
      worker.postMessage({ type: 'ws-close', id: this.id, code });
    }
    fire(type, init) {
      const event = type === 'message' ? new MessageEvent('message', init) : type === 'close' ? new CloseEvent('close', init) : new Event(type);
      this.dispatchEvent(event);
      this[`on${type}`]?.(event);
    }
  }
  for (const [name, value] of Object.entries({ CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 })) {
    DemoSocket[name] = value;
    DemoSocket.prototype[name] = value;
  }
  function WebSocketForDemo(url, protocols) {
    if (String(url).includes(API_HOST)) return new DemoSocket(url);
    return new NativeWebSocket(url, protocols);
  }
  Object.assign(WebSocketForDemo, { CONNECTING: 0, OPEN: 1, CLOSING: 2, CLOSED: 3 });
  WebSocketForDemo.prototype = NativeWebSocket.prototype;
  window.WebSocket = WebSocketForDemo;

  const onWorker = (event) => {
    const message = event.data;
    if (message.type === 'progress') step(message.text);
    if (message.type !== 'ws') return;
    const socket = sockets.get(message.id);
    if (!socket) return;
    if (message.kind === 'open') {
      socket.readyState = 1;
      socket.fire('open');
    } else if (message.kind === 'message') {
      socket.fire('message', { data: message.data });
    } else if (message.kind === 'close') {
      socket.readyState = 3;
      sockets.delete(message.id);
      socket.fire('close', { code: Number(message.data) || 1000, reason: '', wasClean: true });
    }
  };

  // --- 4. The app, once its servers answer ---
  const hideCover = () => {
    cover.classList.add('is-done');
    setTimeout(() => cover.remove(), 900);
  };
  const startApp = () => {
    // The demo starts visible (the app's own setting, Settings › Start invisible), so the
    // people around show at once; a visitor's later choice is kept
    try {
      if (reset) localStorage.removeItem('settings:v1');
      if (!localStorage.getItem('settings:v1')) {
        localStorage.setItem('settings:v1', JSON.stringify({ mapStartInvisible: false, mapLastMode: 'visible', mapModeExplained: true }));
      }
    } catch {
      // No storage (a private window): the app starts invisible, as on a phone
    }
    for (const src of window.DEMO_SCRIPTS ?? []) {
      const script = document.createElement('script');
      script.src = src;
      script.async = false;
      document.body.appendChild(script);
    }
    if (embedded || wide.matches) {
      hideCover();
      return;
    }
    // A phone: the app starts under the cover, which goes once its words were seen
    step('Ready');
    const open = cover.querySelector('.demo-open');
    open.hidden = false;
    open.addEventListener('click', hideCover, { once: true });
    open.focus();
  };

  const fail = (text) => {
    cover.classList.add('is-failed');
    cover.querySelector('.demo-cover-title').textContent = 'The demo could not start';
    step(text);
  };

  (async () => {
    // --- 2. The service worker ---
    if (!('serviceWorker' in navigator)) return fail('This browser has no service workers (a private window, or an old browser).');
    step('Preparing the network');
    await navigator.serviceWorker.register(new URL('sw.js', BASE).href, { scope: BASE });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
    }
    // --- 3. The backend ---
    worker = new Worker(new URL('backend-worker.js', BASE).href, { type: 'module' });
    worker.addEventListener('message', onWorker);
    const started = new Promise((resolve, reject) => worker.addEventListener('message', (event) => {
      if (event.data.type === 'ready') resolve();
      if (event.data.type === 'failed') reject(new Error(event.data.text));
    }));
    worker.postMessage({ type: 'start', reset });
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data?.type === 'http') worker.postMessage(event.data, [...event.ports, ...(event.data.body ? [event.data.body] : [])]);
    });
    await started;
    navigator.serviceWorker.controller.postMessage({ type: 'backend-ready' });
    // A worker that started again (the browser stops idle ones) has forgotten this page
    setInterval(() => navigator.serviceWorker.controller?.postMessage({ type: 'backend-ready' }), 10000);
    if (reset) history.replaceState(null, '', location.pathname);
    // The scene of the showcase: events by demo people around the spot, one sponsored
    step('Setting the scene');
    try {
      const { seedScene } = await import(new URL('scene.mjs', BASE).href);
      const call = async (token, method, path, body) => {
        const answer = await fetch(`https://${API_HOST}/v1${path}`, {
          method,
          headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
          body: body ? JSON.stringify(body) : undefined,
        });
        const text = await answer.text();
        if (!answer.ok) throw new Error(`${method} ${path}: ${answer.status} ${text.slice(0, 160)}`);
        return text ? JSON.parse(text) : null;
      };
      await seedScene(call, HOME);
    } catch (error) {
      console.warn('demo: the scene was not set', error);
    }
    step('Opening the app');
    startApp();
  })().catch((error) => {
    console.error(error);
    fail(String(error?.message ?? error));
  });
})();
