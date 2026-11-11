// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useConnectApi } from './useConnectApi';
import { useRealtime, useRealtimeEvent } from '../../realtime/RealtimeProvider';
import { getConnectPosition } from './connectPosition';
import { CONNECT_ERRORS, POLL_MS, TOKEN_ROTATE_MS, connectError } from './protocol';

// A rotation lost to the network: tried again this soon, at most this many times in a row
const ROTATE_RETRY_MS = 1000;
const ROTATE_TRIES = 3;

// Whether the app is in the foreground: codes live only while it is, so a code can never
// stay valid on a phone left in a pocket
function useAppActive() {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setActive(state === 'active'));
    return () => subscription.remove();
  }, []);
  return active;
}

// The phone showing its code. While `enabled` (the code is on screen and the app in
// front) it holds a session on the server: a new token every TOKEN_ROTATE_MS. The scan
// arrives over the socket (`connection.created`); only while the socket is down the
// server is asked every POLL_MS. Phases:
//   starting → ready (token, issuedAt) → connected (user) | error (error.code)
export function useHostSession(enabled) {
  const api = useConnectApi();
  // The latest operations, without restarting the session when they are re-created
  // (the sign-in's context changes, e.g. a refreshed access token): a restart would
  // invalidate the code someone is reading
  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);
  const appActive = useAppActive();
  const active = enabled && appActive;
  const [state, setState] = useState({ phase: 'starting' });
  const [attempt, setAttempt] = useState(0);
  const sessionId = useRef(null);
  const { status: socket } = useRealtime();
  const socketOpen = useRef(socket === 'open');
  useEffect(() => {
    socketOpen.current = socket === 'open';
  }, [socket]);
  // Connected: the session is over, its timers stop (a rotation after it would be
  // refused by the server, and its error must not replace "Connected!")
  const connected = useRef(false);
  const finish = useCallback((user) => {
    connected.current = true;
    setState({ phase: 'connected', user });
  }, []);
  // The scan, heard at once
  useRealtimeEvent('connection.created', useCallback(({ connection }) => {
    if (sessionId.current && connection?.user) finish(connection.user);
  }, [finish]));

  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    let done = false;
    let pollTimer = null;
    let rotateTimer = null;
    let id = null;
    connected.current = false;
    const fail = (error) => {
      if (!alive || connected.current) return;
      done = true;
      clearTimeout(pollTimer);
      clearTimeout(rotateTimer);
      setState({ phase: 'error', error });
    };

    const show = ({ token, expiresAt }) => {
      if (alive && !done && token) setState({ phase: 'ready', token, expiresAt, issuedAt: Date.now() });
    };

    // A rotation lost to the network is tried again (the last code stays valid a few
    // seconds more); only several in a row end the session
    let misses = 0;
    const rotate = async () => {
      if (connected.current) return;
      try {
        const issued = await apiRef.current.rotateToken(id, await getConnectPosition());
        misses = 0;
        show(issued);
      } catch (error) {
        if (error?.code === CONNECT_ERRORS.offline && ++misses < ROTATE_TRIES) {
          if (alive && !done) rotateTimer = setTimeout(rotate, ROTATE_RETRY_MS);
          return;
        }
        fail(error);
        return;
      }
      if (alive && !done) rotateTimer = setTimeout(rotate, TOKEN_ROTATE_MS);
    };

    const poll = async () => {
      if (connected.current) return;
      try {
        if (socketOpen.current) {
          if (alive && !done) pollTimer = setTimeout(poll, POLL_MS);
          return;
        }
        const answer = await apiRef.current.getSession(id).catch((error) => {
          // The socket is down and so may be the network: asked again at the next turn
          if (error?.code === CONNECT_ERRORS.offline) return { status: 'waiting' };
          throw error;
        });
        if (!alive || done) return;
        if (answer.status === 'connected') {
          done = true;
          clearTimeout(rotateTimer);
          finish(answer.user);
          return;
        }
        if (answer.status === 'closed') throw connectError(CONNECT_ERRORS.expired);
      } catch (error) {
        fail(error);
        return;
      }
      if (alive && !done) pollTimer = setTimeout(poll, POLL_MS);
    };

    (async () => {
      try {
        const started = await apiRef.current.startSession(await getConnectPosition());
        id = started.sessionId;
        if (!alive) {
          apiRef.current.closeSession(id).catch(() => {});
          return;
        }
        sessionId.current = id;
        show(started);
        rotateTimer = setTimeout(rotate, TOKEN_ROTATE_MS);
        pollTimer = setTimeout(poll, POLL_MS);
      } catch (error) {
        fail(error);
      }
    })();

    return () => {
      alive = false;
      clearTimeout(pollTimer);
      clearTimeout(rotateTimer);
      if (id && !done) apiRef.current.closeSession(id).catch(() => {});
      sessionId.current = null;
      setState({ phase: 'starting' });
    };
  }, [active, attempt, finish]);

  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  return { ...state, retry };
}

// The phone reading a code. Phases:
//   idle → connecting → connected (user) | error (error.code)
export function useGuestClaim() {
  const api = useConnectApi();
  const [state, setState] = useState({ phase: 'idle' });
  const run = useRef(0);
  useEffect(() => () => {
    run.current++;
  }, []);

  // token: read from a QR code (decodeQr). check(user) may refuse the result on this side
  // too (e.g. someone the user blocked): an error code or null.
  const submit = useCallback(async (token, check) => {
    const current = ++run.current;
    const set = (next) => {
      if (run.current === current) setState(next);
    };
    set({ phase: 'connecting' });
    try {
      const position = await getConnectPosition();
      // Reset or unmount can happen while the location permission/GPS lookup waits.
      // Do not complete a connection after the user has already cancelled it.
      if (run.current !== current) return;
      const result = await api.claim(token, position);
      if (run.current !== current) return;
      const refused = check?.(result.user);
      if (refused) throw connectError(refused);
      set({ phase: 'connected', user: result.user });
    } catch (error) {
      set({ phase: 'error', error });
    }
  }, [api]);

  const reset = useCallback(() => {
    run.current++;
    setState({ phase: 'idle' });
  }, []);

  return { ...state, submit, reset };
}
