// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { createContext, use, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLogto } from '@logto/rn';
import { useApi } from '../api/useApi';
import { useNetworkRecovery } from '../api/useNetworkRecovery';
import { discardPickedFile, uploadFile } from '../api/uploads';
import { forgetAccountData } from '../../lib/accountStorage';
import { forgetMapChoices } from '../map/state/mapVisibility';
import { setOwnPerson } from '../offline/peoplePriority';

// The signed-in user as the backend knows them (GET /me, docs/API.md): name, @handle,
// picture, bio, profile style, notification settings, numbers. Every screen reads it
// from here (profile, events, chats, map). Kept on the device too, so it shows at once
// at the next start while the server answers. Changes go to the server (PATCH /me) and
// show at once; a refusal puts the previous value back and is thrown (`code`:
// username_taken…).

const MeContext = createContext(null);
const keyOf = (id) => `me:v1:${id}`;
const RETRY_MS = 20_000;
const mergeFields = (current, fields) => current && ({
  ...current,
  ...fields,
  ...(fields.style ? { style: { ...current.style, ...fields.style } } : {}),
  ...(fields.settings ? { settings: { ...current.settings, ...fields.settings } } : {}),
  ...(fields.story ? { story: { ...current.story, ...fields.story } } : {}),
});
const applyPending = (base, pending) => {
  let result = base;
  for (const fields of pending.values()) result = mergeFields(result, fields);
  return result;
};

export function MeProvider({ children }) {
  const { isAuthenticated, getIdTokenClaims, getIdToken } = useLogto();
  const request = useApi();
  const [me, setMe] = useState(null);
  const [status, setStatus] = useState('idle');
  const [error, setError] = useState(null);
  const [claims, setClaims] = useState(null);
  const latest = useRef(null);
  const confirmed = useRef(null);
  const pendingUpdates = useRef(new Map());
  const mutationQueue = useRef(Promise.resolve());
  // Keep the server's confirmed answer separate from changes still in the request queue.
  const sequence = useRef(0);
  const readSequence = useRef(0);
  const pendingMutations = useRef(0);
  // An answer from an earlier sign-in must never repopulate this account's state/cache.
  const generation = useRef(0);
  const cacheOwner = useRef(new Map());
  const cacheWrites = useRef(Promise.resolve());
  const captureSession = useCallback(() => generation.current, []);

  const publish = useCallback((next, started = generation.current, persist = true) => {
    if (started !== generation.current) return;
    latest.current = next;
    setMe(next);
    if (persist && next?.id) {
      const key = keyOf(next.id);
      cacheOwner.current.set(key, started);
      cacheWrites.current = cacheWrites.current.catch(() => {}).then(async () => {
        // Skip queued writes from a session that ended before they reached storage.
        if (started !== generation.current || cacheOwner.current.get(key) !== started) return;
        await AsyncStorage.setItem(key, JSON.stringify(next));
        // A write already in progress at sign-out must not survive account cleanup.
        // A newer session's write takes ownership of the same key.
        if (started !== generation.current && cacheOwner.current.get(key) === started) {
          cacheOwner.current.delete(key);
          await AsyncStorage.removeItem(key);
        }
      }).catch(() => {});
    }
  }, []);

  const load = useCallback(async (idClaims, started = generation.current) => {
    if (started !== generation.current) return;
    const read = ++readSequence.current;
    const mutation = sequence.current;
    const mutationsAtStart = pendingMutations.current;
    const isCurrent = () => started === generation.current
      && read === readSequence.current
      && mutation === sequence.current
      && mutationsAtStart === 0
      && pendingMutations.current === 0;
    setStatus((current) => (current === 'ready' ? current : 'loading'));
    setError(null);
    try {
      // Only used when the account is made: its first name and @handle. The server believes
      // what Logto signed (the ID token); the hint is for a development server without it
      const hint = encodeURIComponent(JSON.stringify({ name: idClaims?.name, username: idClaims?.username, email: idClaims?.email }));
      const idToken = await getIdToken().catch(() => null);
      const answer = await request('/me', { headers: { 'X-Profile-Hint': hint, ...(idToken ? { 'X-Id-Token': idToken } : {}) } });
      if (!isCurrent()) return;
      confirmed.current = answer;
      publish(answer, started);
      setStatus('ready');
    } catch (failure) {
      if (!isCurrent()) return;
      setError(failure);
      setStatus(latest.current ? 'ready' : 'error');
    }
  }, [request, publish, getIdToken]);

  // Signing out forgets everything (the next user starts clean)
  const [signedIn, setSignedIn] = useState(isAuthenticated);
  if (signedIn !== isAuthenticated) {
    setSignedIn(isAuthenticated);
    if (!isAuthenticated) {
      setMe(null);
      setClaims(null);
      setStatus('idle');
    }
  }

  // Signing in: the copy on the device at once, then the server's
  const wasSignedIn = useRef(false);
  useLayoutEffect(() => {
    const started = ++generation.current;
    confirmed.current = null;
    pendingUpdates.current.clear();
    mutationQueue.current = Promise.resolve();
    pendingMutations.current = 0;
    if (!isAuthenticated) {
      latest.current = null;
      sequence.current++;
      readSequence.current++;
      // Signed out (not the start, before the session is read): what the phone kept
      // of the account goes too
      if (wasSignedIn.current) {
        forgetAccountData();
        forgetMapChoices();
      }
      wasSignedIn.current = false;
      return () => {
        if (generation.current === started) {
          generation.current++;
          readSequence.current++;
          pendingMutations.current = 0;
        }
      };
    }
    wasSignedIn.current = true;
    let cancelled = false;
    getIdTokenClaims().then(async (idClaims) => {
      if (cancelled || generation.current !== started) return;
      setClaims(idClaims);
      try {
        const stored = await AsyncStorage.getItem(keyOf(idClaims.sub));
        if (stored && !cancelled && generation.current === started && !latest.current) {
          const cached = JSON.parse(stored);
          confirmed.current = cached;
          latest.current = cached;
          setMe(latest.current);
        }
      } catch {
        // No copy: the server's comes in a moment
      }
      if (!cancelled && generation.current === started) load(idClaims, started);
    }).catch(() => {
      if (!cancelled && generation.current === started) setStatus('error');
    });
    return () => {
      cancelled = true;
      // The counters as they are now, on purpose: a newer session may have moved them on
      /* eslint-disable react-hooks/exhaustive-deps */
      if (generation.current === started) {
        generation.current++;
        readSequence.current++;
        pendingMutations.current = 0;
      }
      /* eslint-enable react-hooks/exhaustive-deps */
    };
  }, [isAuthenticated, getIdTokenClaims, load]);

  // Not loaded (offline at start, the server down): tried again every little while
  useEffect(() => {
    if (status !== 'error' || !claims) return undefined;
    const started = generation.current;
    const timer = setInterval(() => load(claims, started), RETRY_MS);
    return () => clearInterval(timer);
  }, [status, claims, load]);

  const recoverProfile = useCallback(() => {
    if (isAuthenticated && claims) load(claims, generation.current);
  }, [isAuthenticated, claims, load]);
  useNetworkRecovery(recoverProfile);

  // PATCH /me: { name, username, bio, style, settings, story } (style, settings and story merge)
  const update = useCallback((fields) => {
    if (!isAuthenticated) return Promise.reject(new Error('Not signed in'));
    const started = generation.current;
    const before = latest.current;
    const mine = ++sequence.current;
    readSequence.current++;
    pendingMutations.current++;
    pendingUpdates.current.set(mine, fields);
    const optimistic = applyPending(confirmed.current ?? before, pendingUpdates.current);
    if (optimistic) publish(optimistic, started, false);

    const operation = mutationQueue.current.catch(() => {}).then(() => {
      if (started !== generation.current) throw new Error('Not signed in');
      return request('/me', { method: 'PATCH', body: JSON.stringify(fields) });
    });
    const committed = operation.then((saved) => {
      if (started === generation.current) {
        confirmed.current = saved;
        pendingUpdates.current.delete(mine);
        pendingMutations.current--;
        publish(applyPending(saved, pendingUpdates.current), started, pendingMutations.current === 0);
      }
      return saved;
    }, (failure) => {
      if (started === generation.current) {
        pendingUpdates.current.delete(mine);
        pendingMutations.current--;
        const visible = applyPending(confirmed.current ?? before, pendingUpdates.current);
        if (visible) publish(visible, started, pendingMutations.current === 0);
      }
      throw failure;
    });
    mutationQueue.current = committed.then(() => {}, () => {});
    return committed;
  }, [request, publish, isAuthenticated]);

  // A picked photo (a file on the phone) becomes the profile picture; null removes it
  const setPicture = useCallback((uri, expectedSession = generation.current) => {
    if (!isAuthenticated || expectedSession !== generation.current) return Promise.reject(new Error('Not signed in'));
    const started = expectedSession;
    const before = latest.current;
    sequence.current++;
    readSequence.current++;
    pendingMutations.current++;
    const operation = mutationQueue.current.catch(() => {}).then(async () => {
      if (started !== generation.current) throw new Error('Not signed in');
      if (!uri) return request('/me/picture', { method: 'DELETE' });
      const uploadId = await uploadFile(request, { purpose: 'profile-picture', uri });
      if (started !== generation.current) throw new Error('Not signed in');
      const saved = await request('/me/picture', { method: 'PUT', body: JSON.stringify({ uploadId }) });
      // The server has it: the copy picked on the phone goes
      discardPickedFile(uri);
      return saved;
    });
    const committed = operation.then((saved) => {
      if (started === generation.current) {
        confirmed.current = saved;
        pendingMutations.current--;
        publish(applyPending(saved, pendingUpdates.current), started, pendingMutations.current === 0);
      }
      if (uri) return saved;
    }, (failure) => {
      if (started === generation.current) {
        pendingMutations.current--;
        const visible = applyPending(confirmed.current ?? before, pendingUpdates.current);
        if (visible) publish(visible, started, pendingMutations.current === 0);
      }
      throw failure;
    });
    mutationQueue.current = committed.then(() => {}, () => {});
    return committed;
  }, [request, publish, isAuthenticated]);

  // The numbers change elsewhere (an event organized, a connection made)
  const refresh = useCallback(() => (isAuthenticated && claims ? load(claims, generation.current) : Promise.resolve()), [isAuthenticated, claims, load]);

  const id = me?.id ?? claims?.sub ?? null;
  useEffect(() => setOwnPerson(id), [id]);

  const value = useMemo(() => ({
    me,
    id,
    email: me?.email ?? claims?.email ?? null,
    status,
    error,
    captureSession,
    update,
    setPicture,
    refresh,
  }), [me, id, claims, status, error, captureSession, update, setPicture, refresh]);

  return <MeContext.Provider value={value}>{children}</MeContext.Provider>;
}

export function useMe() {
  const context = use(MeContext);
  if (!context) throw new Error('useMe must be used inside <MeProvider>');
  return context;
}
