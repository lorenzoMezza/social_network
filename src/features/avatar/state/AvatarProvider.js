// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { createContext, use, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useLogto } from '@logto/rn';
import { useApi } from '../../api/useApi';
import { useMe } from '../../me/MeProvider';
import { useNetworkRecovery } from '../../api/useNetworkRecovery';
import { validateAvatar } from '../../../../avatar-server/shared/avatarFormat';
import { getAvatar, getCatalog, saveAvatar } from '../api/avatarApi';
import { loadViewer } from '../components/viewerSource';
import { useOfflineCaches } from '../../offline/useOfflineCaches';
import { priorityOfPerson } from '../../offline/peoplePriority';

// The avatar catalog and the avatars shown in the app, shared by the profile, other
// people's profiles, the map and the editor. Every avatar shown is also kept on the
// device (the account's `people` cache: the user's own and their connections' last to
// go), so it shows at once, also offline, while the server is asked whether it changed
// (its ETag: an unchanged one costs a 304). Whether someone changed their look is the
// server's to say: their avatarVersion (in every UserSummary and map presence) differs
// from the one kept, and it is loaded again (useMapPeople, useUserAvatar callers).

const AvatarContext = createContext(null);
// userId → { status, avatar, source, version (avatarVersion), mapAvatar (its key on the
// map, or null), loadedAt, error, stale (the device's copy: the server was not reached) }
const CATALOG_KEY = 'avatar:catalog:v1';
const storedKey = (userId) => `avatar:${userId}`;

export function AvatarProvider({ children }) {
  const { isAuthenticated } = useLogto();
  const request = useApi();
  const [catalog, setCatalog] = useState({ status: 'idle', data: null, error: null });
  const [avatars, setAvatars] = useState({}); // userId → { status, avatar, source, error }
  // The user's ID as the API knows them (MeProvider): the same everywhere in the app
  const { id: meId } = useMe();
  const userId = isAuthenticated ? meId : null;
  const store = useOfflineCaches()?.people ?? null;
  const generation = useRef(0);
  const retryAfterLoad = useRef(new Map());
  const avatarsRef = useRef(avatars);
  useEffect(() => {
    avatarsRef.current = avatars;
  }, [avatars]);

  // An AvatarEntry of the API kept on the device, with its ETag
  const keep = useCallback((id, entry, etag) => {
    store?.writeJson(storedKey(id), { entry, etag }, { priority: priorityOfPerson(id) });
  }, [store]);

  // Signing out forgets the user and the avatars loaded for them; the catalog (the
  // same for everyone) stays
  useLayoutEffect(() => {
    const started = ++generation.current;
    if (!isAuthenticated) {
      setAvatars({});
      retryAfterLoad.current.clear();
    }
    return () => {
      // The counter as it is now, on purpose: a newer session already moved it on
      // eslint-disable-next-line react-hooks/exhaustive-deps
      if (generation.current === started) generation.current++;
    };
  }, [isAuthenticated]);

  // The catalog kept on the device is used at once; the server is then asked whether
  // it changed (ETag), which costs nothing when it did not
  const inflight = useRef(new Map()); // one request at a time per resource
  const once = (key, run) => {
    if (!inflight.current.has(key)) inflight.current.set(key, run().finally(() => inflight.current.delete(key)));
    return inflight.current.get(key);
  };

  const loadCatalog = useCallback(() => once('catalog', async () => {
    setCatalog((current) => ({ ...current, status: current.data ? 'ready' : 'loading', error: null }));
    let cached = null;
    try {
      const stored = await AsyncStorage.getItem(CATALOG_KEY);
      cached = stored ? JSON.parse(stored) : null;
      if (cached?.catalog) setCatalog((current) => (current.data ? current : { status: 'ready', data: cached.catalog, error: null }));
    } catch {
      cached = null;
    }
    try {
      const result = await getCatalog(cached?.etag);
      if (result.notModified) return;
      setCatalog({ status: 'ready', data: result.catalog, error: null });
      AsyncStorage.setItem(CATALOG_KEY, JSON.stringify({ etag: result.etag, catalog: result.catalog })).catch(() => {});
    } catch (error) {
      if (!cached?.catalog) setCatalog((current) => ({ ...current, status: 'error', error }));
    }
  }), []);

  const setEntry = useCallback((id, entry) => setAvatars((current) => ({ ...current, [id]: { ...current[id], ...entry } })), []);

  const fromEntry = ({ avatar, source, avatarVersion, mapAvatar }) => ({ avatar, source, version: avatarVersion, mapAvatar: mapAvatar ?? null });

  const loadAvatar = useCallback((id) => {
    const started = generation.current;
    return isAuthenticated && id ? once(`avatar:${id}:${started}`, async () => {
      if (started !== generation.current) return;
      setEntry(id, { status: 'loading', error: null });
      // The device's copy shows at once (the map wears it, the profile shows it)
      const kept = store ? await store.readJson(storedKey(id)).catch(() => null) : null;
      if (started !== generation.current) return;
      if (kept?.entry && !avatarsRef.current[id]?.avatar) setEntry(id, fromEntry(kept.entry));
      try {
        const answer = await getAvatar(request, id, kept?.entry ? kept.etag ?? null : null);
        if (started !== generation.current) return;
        const entry = answer.notModified ? kept.entry : answer.body;
        setEntry(id, { status: 'ready', ...fromEntry(entry), loadedAt: Date.now(), stale: false });
        if (!answer.notModified) keep(id, entry, answer.etag);
      } catch (error) {
        if (started !== generation.current) return;
        // Offline, the device's copy stands in (and is checked again when back online)
        setEntry(id, kept?.entry ? { status: 'ready', stale: true, error, loadedAt: Date.now() } : { status: 'error', error, loadedAt: Date.now() });
      }
    }) : Promise.resolve();
  }, [isAuthenticated, request, setEntry, store, keep]);

  const recoverAvatarData = useCallback(() => {
    const runOrDefer = (key, target, run) => {
      if (inflight.current.has(key)) retryAfterLoad.current.set(key, target);
      else run();
    };
    if (catalog.status === 'error' || (catalog.status === 'loading' && !catalog.data)) {
      runOrDefer('catalog', { type: 'catalog' }, loadCatalog);
    }
    for (const [id, entry] of Object.entries(avatars)) {
      if (entry.status === 'error' || entry.status === 'loading' || entry.stale) {
        const key = `avatar:${id}:${generation.current}`;
        runOrDefer(key, { type: 'avatar', id }, () => loadAvatar(id));
      }
    }
  }, [catalog.status, catalog.data, avatars, loadCatalog, loadAvatar]);
  useNetworkRecovery(recoverAvatarData);
  useEffect(() => {
    for (const [key, target] of retryAfterLoad.current) {
      if (inflight.current.has(key)) continue;
      retryAfterLoad.current.delete(key);
      if (target.type === 'catalog' && catalog.status === 'error') loadCatalog();
      if (target.type === 'avatar' && (avatars[target.id]?.status === 'error' || avatars[target.id]?.stale)) loadAvatar(target.id);
    }
  }, [catalog, avatars, loadCatalog, loadAvatar]);

  // Right after sign-in: the viewer page, the catalog and the own avatar start loading
  // now, so the profile has them ready instead of starting from zero when opened
  useEffect(() => {
    if (!isAuthenticated || !userId) return;
    loadViewer().catch(() => {});
    loadCatalog();
    loadAvatar(userId);
  }, [isAuthenticated, userId, loadCatalog, loadAvatar]);

  const saveOwnAvatar = useCallback(async (avatar) => {
    if (!isAuthenticated || !userId) throw new Error('Not signed in');
    const started = generation.current;
    const saved = await saveAvatar(request, avatar);
    if (started !== generation.current) return saved.avatar;
    setEntry(userId, { status: 'ready', avatar: saved.avatar, source: 'saved', version: saved.avatarVersion, mapAvatar: saved.mapAvatar ?? null, loadedAt: Date.now(), error: null, stale: false });
    // Without an ETag: the next load asks for it in full once
    keep(userId, saved, null);
    return saved.avatar;
  }, [userId, isAuthenticated, request, setEntry, keep]);

  const value = useMemo(() => ({
    catalog, avatars, userId, loadCatalog, loadAvatar, saveOwnAvatar,
  }), [catalog, avatars, userId, loadCatalog, loadAvatar, saveOwnAvatar]);

  return <AvatarContext.Provider value={value}>{children}</AvatarContext.Provider>;
}

export function useAvatars() {
  const context = use(AvatarContext);
  if (!context) throw new Error('useAvatars must be used inside <AvatarProvider>');
  return context;
}

// The catalog, loaded once for the whole app
export function useAvatarCatalog() {
  const { catalog, loadCatalog } = useAvatars();
  useEffect(() => {
    if (catalog.status === 'idle') loadCatalog();
  }, [catalog.status, loadCatalog]);
  return { ...catalog, reload: loadCatalog };
}

// One person's avatar (the user's own when userId is omitted), repaired against the
// catalog so an item removed since it was saved never breaks the view
export function useUserAvatar(id) {
  const { avatars, userId, loadAvatar } = useAvatars();
  const catalog = useAvatarCatalog();
  const target = id ?? userId;
  const entry = target ? avatars[target] : null;
  useEffect(() => {
    if (target && !entry) loadAvatar(target);
  }, [target, entry, loadAvatar]);
  const stored = entry?.avatar;
  const catalogData = catalog.data;
  const avatar = useMemo(
    () => (stored && catalogData ? validateAvatar(stored, catalogData).avatar : null),
    [stored, catalogData],
  );
  return {
    avatar,
    source: entry?.source ?? null,
    status: catalog.status === 'error' ? 'error' : entry?.status ?? 'loading',
    error: entry?.error ?? catalog.error,
    catalog: catalog.data,
    reload: () => {
      if (catalog.status === 'error') catalog.reload();
      loadAvatar(target);
    },
  };
}
