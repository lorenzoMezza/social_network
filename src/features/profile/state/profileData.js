// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';
import { useApi } from '../../api/useApi';
import { useNetworkRecovery } from '../../api/useNetworkRecovery';
import { normalizeEvent } from '../../events/api/eventsApi';
import { useMe } from '../../me/MeProvider';
import { useOfflineCaches } from '../../offline/useOfflineCaches';
import { priorityOfPerson } from '../../offline/peoplePriority';
import { storySections } from '../model/story';

// Profiles on the backend (docs/API.md, People): someone's profile (with their
// relation to the user), their story and the events they organized. Each answer is
// kept for the session, so a profile opened again shows at once, and on the phone
// (the account's `people` cache: the user's own and their connections' longest), so
// it also shows after a restart and without a connection. It is checked every time
// its screen comes into view (the numbers change): with its ETag, so an unchanged
// profile costs a 304 and no download.

const cache = new Map(); // viewer + path → answer, the most recent last
const MAX_CACHED = 60;
const listeners = new Set();
const set = (path, value) => {
  cache.delete(path);
  cache.set(path, value);
  // The profiles looked at longest ago go first
  while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value);
  for (const listener of listeners) listener();
};
const remove = (path) => {
  if (!cache.delete(path)) return;
  for (const listener of listeners) listener();
};
const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const storedKey = (path) => `api:${path}`;
// /users/{id}…: that person's
const personOf = (path) => /^\/users\/([^/?]+)/.exec(path)?.[1] ?? null;

// GET `path` when the screen shows (and on reload), the last answer meanwhile
function useResource(path, viewerId) {
  const request = useApi();
  const store = useOfflineCaches()?.people ?? null;
  // Profile responses include the relation to the viewer, and may be hidden when
  // either user has blocked the other. Never reuse one account's answer for another.
  const cachePath = path && viewerId ? JSON.stringify([viewerId, path]) : null;
  const data = useSyncExternalStore(subscribe, () => (cachePath ? cache.get(cachePath) : undefined));
  const [errorState, setErrorState] = useState({ key: null, error: null });
  const [loadingKey, setLoadingKey] = useState(null);
  const requestSequence = useRef(0);
  const focused = useRef(false);
  const requestKey = cachePath ?? path;
  useLayoutEffect(() => {
    requestSequence.current++;
  }, [path, cachePath]);
  const load = useCallback(async () => {
    if (!path) return;
    const requestId = ++requestSequence.current;
    setLoadingKey(requestKey);
    setErrorState({ key: requestKey, error: null });
    try {
      // The phone's copy shows at once, and is what the server is asked about
      const kept = store ? await store.readJson(storedKey(path)).catch(() => null) : null;
      if (requestId !== requestSequence.current) return;
      if (cachePath && kept?.body && cache.get(cachePath) === undefined) set(cachePath, kept.body);
      const answer = await request(path, { etag: kept?.etag ?? null });
      if (requestId !== requestSequence.current) return;
      if (!answer.notModified) {
        if (cachePath) set(cachePath, answer.body);
        store?.writeJson(storedKey(path), { body: answer.body, etag: answer.etag }, { priority: priorityOfPerson(personOf(path)) });
      }
      setErrorState({ key: requestKey, error: null });
    } catch (failure) {
      if (requestId !== requestSequence.current) return;
      // A 404/403 can mean access was revoked after this profile was cached.
      if (failure?.status === 403 || failure?.status === 404) {
        if (cachePath) remove(cachePath);
        store?.remove(storedKey(path));
      }
      setErrorState({ key: requestKey, error: failure });
    } finally {
      if (requestId === requestSequence.current) setLoadingKey(null);
    }
  }, [path, cachePath, request, requestKey, store]);
  const recover = useCallback(() => {
    if (focused.current) load();
  }, [load]);
  useNetworkRecovery(recover);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    load();
    return () => {
      focused.current = false;
    };
  }, [load]));
  return {
    data,
    error: errorState.key === requestKey ? errorState.error : null,
    loading: !!path && loadingKey === requestKey && data === undefined,
    reload: load,
  };
}

const userPath = (id, rest = '') => (id ? `/users/${encodeURIComponent(id)}${rest}` : null);

// { profile: Profile | undefined, error, loading, reload }
export function useProfile(id) {
  const { id: viewerId } = useMe();
  const { data, ...rest } = useResource(userPath(id), viewerId);
  return { profile: data, ...rest };
}

// The events they organized, newest first: { list: [{ event, people, past }], loading, error }
export function useOrganizedEvents(id) {
  const { id: viewerId } = useMe();
  const { data, loading, error, reload } = useResource(userPath(id, '/events'), viewerId);
  const list = useMemo(() => (data?.items ?? []).filter((item) => item.event).map((item) => ({ ...item, event: normalizeEvent(item.event) })), [data]);
  return { list, loading, error: data === undefined ? error : null, reload };
}

// Someone's connections, the ones shared with the user first: { list: [{ user, mutual }],
// total, mutual, loading }
export function useUserConnections(id) {
  const { id: viewerId } = useMe();
  const { data, loading, error, reload } = useResource(userPath(id, '/connections'), viewerId);
  return { list: data?.items ?? [], total: data?.total ?? null, mutual: data?.mutual ?? 0, loading, error, reload };
}

// A profile's story in sections (model/story.js)
export function useActivity(id, viewerId) {
  const { data, loading, error, reload } = useResource(userPath(id, '/activity?limit=100'), viewerId);
  const sections = useMemo(() => storySections(data?.items, viewerId), [data, viewerId]);
  return { sections, loading, error, reload };
}
