// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { createContext, use, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useLogto } from '@logto/rn';
import { API_RESOURCE } from '../auth/logtoConfig';
import { SOCKET_URL } from '../api/apiConfig';
import { subscribeNetwork } from '../api/networkStatus';

// The app's one WebSocket (docs/API.md): open while someone is signed in and the app
// is in front, closed in the background (the phone sleeps, the server forgets the map
// presence after 45 s). Its first frame is the access token; when the server closes
// with 4001 (token expired) it reconnects at once with a fresh one, otherwise after a
// growing pause (1 s … 30 s). Frames from the server reach the listeners of their
// `type`; `request` sends a frame and waits for its `ack` (or `error`).
// A socket can die without closing (Wi-Fi to mobile data, a tunnel): the app says `ping`
// every little while and a socket heard from no longer is dropped and opened again. The
// pauses vary a little from phone to phone, so that after a server restart they do not
// all come back in the same second; when the network comes back there is no pause.
//   status: 'offline' | 'connecting' | 'open'
// Listeners of 'ready' run at each (re)connection: whoever sends state (the map's
// presence) sends it again then.

const RealtimeContext = createContext(null);
const MAX_PAUSE_MS = 30_000;
const REQUEST_TIMEOUT_MS = 8_000;
const HEARTBEAT_MS = 25_000;
// Nothing heard for this long (a `pong` is due at each heartbeat): the socket is dead
const SILENCE_LIMIT_MS = 40_000;
// A pause is between this share of its length and all of it
const JITTER_SHARE = 0.5;
const jittered = (ms) => ms * (JITTER_SHARE + Math.random() * (1 - JITTER_SHARE));

export function RealtimeProvider({ children }) {
  const { isAuthenticated, getAccessToken } = useLogto();
  const [status, setStatus] = useState('offline');
  const [active, setActive] = useState(AppState.currentState === 'active');
  const socket = useRef(null);
  const listeners = useRef(new Map());
  const pending = useRef(new Map());
  const counter = useRef(0);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setActive(state === 'active'));
    return () => subscription.remove();
  }, []);

  const emit = useCallback((frame) => {
    for (const listener of listeners.current.get(frame.type) ?? []) {
      try {
        listener(frame);
      } catch (error) {
        console.warn('Realtime listener failed:', error);
      }
    }
  }, []);

  const failPending = useCallback(() => {
    for (const { reject, timer } of pending.current.values()) {
      clearTimeout(timer);
      reject(Object.assign(new Error('Disconnected'), { status: 0 }));
    }
    pending.current.clear();
  }, []);

  useEffect(() => {
    if (!isAuthenticated || !active || !SOCKET_URL) return undefined;
    let closed = false;
    let retry = null;
    let pause = 1000;
    // Refusals of the token in a row: only the first is retried at once (a refreshed
    // token); a token refused again waits like any failure, never a tight loop
    let refusals = 0;
    let heartbeat = null;
    let opening = false;

    const again = (wait) => {
      clearTimeout(retry);
      retry = setTimeout(open, wait ? jittered(wait) : 0);
    };

    const open = async () => {
      if (closed || opening || socket.current) return;
      opening = true;
      retry = null;
      setStatus('connecting');
      let token;
      try {
        token = await getAccessToken(API_RESOURCE);
      } catch {
        opening = false;
        again(pause);
        pause = Math.min(pause * 2, MAX_PAUSE_MS);
        return;
      }
      opening = false;
      if (closed) return;
      const ws = new WebSocket(SOCKET_URL);
      socket.current = ws;
      let heardAt = Date.now();
      const lost = (code) => {
        // A socket from the previous app/auth session can close after the new one
        // has opened. Its callbacks must not tear down the new connection's state.
        if (socket.current !== ws) return;
        socket.current = null;
        clearInterval(heartbeat);
        failPending();
        setStatus('offline');
        if (closed) return;
        // An expired token: straight back with a fresh one (once)
        refusals = code === 4001 ? refusals + 1 : 0;
        const wait = refusals === 1 ? 0 : pause;
        pause = Math.min(pause * 2, MAX_PAUSE_MS);
        again(wait);
      };
      clearInterval(heartbeat);
      heartbeat = setInterval(() => {
        if (Date.now() - heardAt > SILENCE_LIMIT_MS) {
          lost(0);
          ws.close();
        } else if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, HEARTBEAT_MS);
      ws.onopen = () => {
        if (closed || socket.current !== ws) {
          ws.close();
          return;
        }
        ws.send(JSON.stringify({ type: 'auth', token }));
      };
      ws.onmessage = (event) => {
        if (closed || socket.current !== ws) return;
        heardAt = Date.now();
        let frame;
        try {
          frame = JSON.parse(event.data);
        } catch {
          return;
        }
        if (frame.type === 'ready') {
          pause = 1000;
          refusals = 0;
          setStatus('open');
        }
        if ((frame.type === 'ack' || frame.type === 'error') && frame.ref && pending.current.has(frame.ref)) {
          const { resolve, reject, timer } = pending.current.get(frame.ref);
          clearTimeout(timer);
          pending.current.delete(frame.ref);
          if (frame.type === 'ack') resolve(frame);
          else reject(Object.assign(new Error(frame.message ?? frame.code), { code: frame.code, status: frame.code === 'rate_limited' ? 429 : 400 }));
          return;
        }
        emit(frame);
      };
      ws.onclose = (event) => lost(event.code);
      ws.onerror = () => {
        // onclose follows and schedules the retry
      };
    };

    open();
    // The network is back: no reason to sit out the pause
    const unsubscribe = subscribeNetwork((next, previous) => {
      if (next === 'online' && previous === 'offline' && retry !== null && !socket.current) {
        pause = 1000;
        clearTimeout(retry);
        open();
      }
    });
    return () => {
      closed = true;
      unsubscribe();
      clearInterval(heartbeat);
      clearTimeout(retry);
      socket.current?.close(1000);
      socket.current = null;
      failPending();
      setStatus('offline');
    };
  }, [isAuthenticated, active, getAccessToken, emit, failPending]);

  // Fire and forget: false when the socket is not open (the frame is dropped)
  const send = useCallback((frame) => {
    const ws = socket.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(frame));
    return true;
  }, []);

  // A frame that the server answers: resolves with its ack, rejects with its error
  const request = useCallback((frame) => new Promise((resolve, reject) => {
    const ref = `r${++counter.current}`;
    const timer = setTimeout(() => {
      pending.current.delete(ref);
      reject(Object.assign(new Error('No answer'), { status: 0 }));
    }, REQUEST_TIMEOUT_MS);
    pending.current.set(ref, { resolve, reject, timer });
    if (!send({ ...frame, ref })) {
      clearTimeout(timer);
      pending.current.delete(ref);
      reject(Object.assign(new Error('Not connected'), { status: 0 }));
    }
  }), [send]);

  const subscribe = useCallback((type, listener) => {
    if (!listeners.current.has(type)) listeners.current.set(type, new Set());
    listeners.current.get(type).add(listener);
    return () => listeners.current.get(type)?.delete(listener);
  }, []);

  const value = useMemo(() => ({ status, send, request, subscribe }), [status, send, request, subscribe]);
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}

export function useRealtime() {
  const context = use(RealtimeContext);
  if (!context) throw new Error('useRealtime must be used inside <RealtimeProvider>');
  return context;
}

// Calls `handler(frame)` for every frame of `type` from the server
export function useRealtimeEvent(type, handler) {
  const { subscribe } = useRealtime();
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  }, [handler]);
  useEffect(() => subscribe(type, (frame) => latest.current(frame)), [subscribe, type]);
}
