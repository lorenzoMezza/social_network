// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { createContext, use, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import { Alert } from 'react-native';
import { useLogto } from '@logto/rn';
import { useAlbumApi } from '../api/useAlbumApi';
import { ALBUM_LIMITS } from '../model/albumModel';
import { useRealtime } from '../../realtime/RealtimeProvider';
import { useNetworkRecovery } from '../../api/useNetworkRecovery';
import { discardPickedFile } from '../../api/uploads';

// A photo sent (or dropped) leaves the phone's caches folder a moment later, once the
// grid shows the published one in its place
const DISCARD_DELAY_MS = 3000;
// The server's limits (API.md, Albums): trying again would not help
const NO_ROOM = { album_full: 'This album is full.', photo_limit: "You've added all the photos you can for now." };
const discardLater = (uri) => setTimeout(() => discardPickedFile(uri), DISCARD_DELAY_MS);
// A file the storage has is named again when its photo is sent again, for this long (the
// storage keeps a file not used for an hour: API.md, Uploads)
const SENT_FILE_REUSE_MS = 50 * 60 * 1000;

// The events' photo albums, for the whole app: the event page, the album and the
// viewer show the same photos, and uploads go on when the user leaves the album (a
// queue, a few at a time). A photo being sent is in the grid at once, from the
// phone's file; if it fails it stays there with Retry. Emptied on sign-out.
//   albums[eventId]  { status, error, settings, photos, total, nextCursor, loadingMore }
//   uploads[eventId] [{ key, uri, width, height, status: 'queued'|'uploading'|'failed', error }]

const AlbumsContext = createContext(null);

const initialState = { albums: {}, uploads: {} };
const emptyAlbum = { status: 'idle', error: null, settings: null, room: null, photos: [], total: 0, nextCursor: null, loadingMore: false };

const withAlbum = (state, eventId, change) => ({
  ...state,
  albums: { ...state.albums, [eventId]: { ...emptyAlbum, ...state.albums[eventId], ...change(state.albums[eventId] ?? emptyAlbum) } },
});
const withUploads = (state, eventId, change) => ({
  ...state,
  uploads: { ...state.uploads, [eventId]: change(state.uploads[eventId] ?? []) },
});

function reducer(state, action) {
  const { eventId } = action;
  switch (action.type) {
    case 'reset':
      return initialState;
    case 'loading':
      return withAlbum(state, eventId, (album) => (action.more ? { loadingMore: true } : { status: album.status === 'ready' ? 'ready' : 'loading', error: null, loadingMore: false }));
    case 'loadCancelled':
      return withAlbum(state, eventId, (album) => ({
        status: album.status === 'loading' ? (album.photos.length ? 'ready' : 'idle') : album.status,
        loadingMore: false,
      }));
    case 'loaded':
      return withAlbum(state, eventId, (album) => {
        // A page further on is added after the photos already there
        const photos = action.more ? [...album.photos, ...action.page.photos.filter((photo) => !album.photos.some((known) => known.id === photo.id))] : action.page.photos;
        return { status: 'ready', error: null, settings: action.page.settings, room: action.page.room, photos, total: action.page.total, nextCursor: action.page.nextCursor, loadingMore: false };
      });
    case 'loadError':
      return withAlbum(state, eventId, (album) => (action.more ? { loadingMore: false } : { status: album.status === 'ready' ? 'ready' : 'error', error: action.error }));
    case 'settings':
      return withAlbum(state, eventId, () => ({ settings: action.settings }));
    case 'queued':
      return withUploads(state, eventId, (uploads) => [...action.items, ...uploads]);
    case 'uploadStatus':
      return withUploads(state, eventId, (uploads) => uploads.map((item) => (item.key === action.key ? { ...item, status: action.status, error: action.error ?? null } : item)));
    case 'uploaded':
      return withAlbum(
        withUploads(state, eventId, (uploads) => uploads.filter((item) => item.key !== action.key)),
        eventId,
        (album) => {
          const alreadyLoaded = album.photos.some((photo) => photo.id === action.photo.id);
          return {
            photos: alreadyLoaded ? album.photos : [action.photo, ...album.photos],
            total: alreadyLoaded ? album.total : album.total + 1,
            room: alreadyLoaded ? album.room : Math.max(0, (album.room ?? 0) - 1),
          };
        },
      );
    case 'discard':
      return withUploads(state, eventId, (uploads) => uploads.filter((item) => item.key !== action.key));
    case 'removed':
      return withAlbum(state, eventId, (album) => ({
        photos: album.photos.filter((photo) => photo.id !== action.photoId),
        total: Math.max(0, album.total - (album.photos.some((photo) => photo.id === action.photoId) ? 1 : 0)),
        // Room for one more, as far as the phone can tell: the server has the last word
        room: (album.room ?? 0) + 1,
      }));
    default:
      return state;
  }
}

let keyCounter = 0;

export function AlbumsProvider({ children }) {
  const api = useAlbumApi();
  const { isAuthenticated } = useLogto();
  const { status: socketStatus } = useRealtime();
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  useLayoutEffect(() => {
    stateRef.current = state;
  }, [state]);

  // Answers to requests made before a sign-out are dropped
  const generation = useRef(0);
  const queue = useRef([]);
  const active = useRef(0);
  const reads = useRef(new Map());
  // Photos whose file reached the storage: upload key → { uploadId, at }. A try again
  // names the same upload instead of sending the file a second time: a photo whose
  // answer was lost on the way is then never added twice
  const sentFiles = useRef(new Map());
  const captureSession = useCallback(() => generation.current, []);
  useLayoutEffect(() => {
    if (isAuthenticated) return;
    generation.current += 1;
    for (const read of reads.current.values()) read.controller.abort();
    reads.current.clear();
    queue.current = [];
    sentFiles.current.clear();
    // The photos still waiting to be sent are dropped with the account
    for (const uploads of Object.values(stateRef.current.uploads)) for (const upload of uploads) discardPickedFile(upload.uri);
    dispatch({ type: 'reset' });
  }, [isAuthenticated]);

  const send = useCallback((action, from) => {
    if (from === generation.current) dispatch(action);
  }, []);

  const loadAlbum = useCallback(async (eventId, { more = false } = {}) => {
    const album = stateRef.current.albums[eventId];
    if (more && (!album?.nextCursor || album.loadingMore || reads.current.has(eventId))) return;
    const from = generation.current;
    reads.current.get(eventId)?.controller.abort();
    const read = { more, controller: new AbortController() };
    reads.current.set(eventId, read);
    send({ type: 'loading', eventId, more }, from);
    try {
      const page = await api.getAlbum(eventId, { cursor: more ? album.nextCursor : undefined, signal: read.controller.signal });
      if (reads.current.get(eventId) === read) send({ type: 'loaded', eventId, page, more }, from);
    } catch (error) {
      if (reads.current.get(eventId) === read && error?.name !== 'AbortError') send({ type: 'loadError', eventId, error, more }, from);
    } finally {
      if (reads.current.get(eventId) === read) reads.current.delete(eventId);
    }
  }, [api, send]);

  const retryAfterRead = useRef(new Set());
  const retryFailedAlbums = useCallback(() => {
    for (const [eventId, album] of Object.entries(stateRef.current.albums)) {
      if (reads.current.has(eventId)) retryAfterRead.current.add(eventId);
      else if (album.error) loadAlbum(eventId);
    }
  }, [loadAlbum]);
  useNetworkRecovery(retryFailedAlbums);

  useEffect(() => {
    for (const eventId of retryAfterRead.current) {
      if (reads.current.has(eventId)) continue;
      retryAfterRead.current.delete(eventId);
      if (stateRef.current.albums[eventId]?.error) loadAlbum(eventId);
    }
  }, [state.albums, loadAlbum]);

  // A request can fail just before the socket finishes reconnecting. Retry failed
  // reads on each new connection too, including that race with the first load.
  const socketWasOpen = useRef(false);
  const retryAfterSocketOpen = useRef(false);
  useEffect(() => {
    if (socketStatus !== 'open') {
      socketWasOpen.current = false;
      retryAfterSocketOpen.current = false;
      return;
    }
    if (!isAuthenticated) return;
    if (!socketWasOpen.current) {
      socketWasOpen.current = true;
      const albums = Object.values(stateRef.current.albums);
      const pending = albums.some((album) => album.status === 'idle' || album.status === 'loading');
      if (pending) {
        retryAfterSocketOpen.current = true;
      } else {
        retryFailedAlbums();
      }
      return;
    }
    if (!retryAfterSocketOpen.current) return;
    const albums = Object.values(stateRef.current.albums);
    if (albums.some((album) => album.error)) {
      retryAfterSocketOpen.current = false;
      retryFailedAlbums();
    } else if (albums.every((album) => album.status === 'ready' || album.status === 'idle')) {
      retryAfterSocketOpen.current = false;
    }
  }, [socketStatus, isAuthenticated, state.albums, retryFailedAlbums]);

  const invalidateRead = useCallback((eventId, from) => {
    const read = reads.current.get(eventId);
    if (!read) return false;
    reads.current.delete(eventId);
    read.controller.abort();
    send({ type: 'loadCancelled', eventId, more: read.more }, from);
    return true;
  }, [send]);

  // Sends the queued photos, ALBUM_LIMITS.concurrentUploads at a time
  const pump = useCallback(function pumpQueue() {
    while (active.current < ALBUM_LIMITS.concurrentUploads && queue.current.length) {
      const job = queue.current.shift();
      if (job.from !== generation.current) continue;
      active.current += 1;
      send({ type: 'uploadStatus', eventId: job.eventId, key: job.key, status: 'uploading' }, job.from);
      const kept = sentFiles.current.get(job.key);
      const sent = kept && Date.now() - kept.at < SENT_FILE_REUSE_MS ? kept.uploadId : null;
      if (kept && !sent) sentFiles.current.delete(job.key);
      api.uploadPhoto(job.eventId, job.asset, {
        sent,
        key: job.key,
        onSent: (uploadId) => {
          if (job.from === generation.current) sentFiles.current.set(job.key, { uploadId, at: Date.now() });
        },
      })
        .then((photo) => {
          if (job.from !== generation.current) return;
          sentFiles.current.delete(job.key);
          const album = stateRef.current.albums[job.eventId];
          const needsInitialLoad = album?.status === 'loading' && !album.photos.length;
          const invalidated = invalidateRead(job.eventId, job.from);
          send({ type: 'uploaded', eventId: job.eventId, key: job.key, photo }, job.from);
          discardLater(job.asset.uri);
          if (needsInitialLoad && invalidated) loadAlbum(job.eventId);
        })
        .catch((error) => {
          if (job.from !== generation.current) return;
          if (sent && error?.status === 410) {
            // The upload was used: the try before did add the photo, only its answer was
            // lost. Nothing to send again: the album is read again and shows it
            sentFiles.current.delete(job.key);
            invalidateRead(job.eventId, job.from);
            send({ type: 'discard', eventId: job.eventId, key: job.key }, job.from);
            discardLater(job.asset.uri);
            loadAlbum(job.eventId);
            return;
          }
          // Refused (not "try later"): the server dropped the file with its refusal, or no
          // longer knows the upload. A new try sends the file again, and hears the same
          // refusal again, rather than "already used", which reads as "it was added"
          if (error?.status && error.status !== 429 && error.status < 500) sentFiles.current.delete(job.key);
          if (NO_ROOM[error?.code]) {
            // No room: this photo and the ones waiting behind it go, with one message
            const waiting = queue.current.filter((other) => other.eventId === job.eventId);
            queue.current = queue.current.filter((other) => other.eventId !== job.eventId);
            for (const dropped of [job, ...waiting]) {
              sentFiles.current.delete(dropped.key);
              send({ type: 'discard', eventId: job.eventId, key: dropped.key }, job.from);
              discardLater(dropped.asset.uri);
            }
            Alert.alert('No more photos here', NO_ROOM[error.code]);
            return;
          }
          send({ type: 'uploadStatus', eventId: job.eventId, key: job.key, status: 'failed', error }, job.from);
        })
        .finally(() => {
          active.current -= 1;
          pumpQueue();
        });
    }
  }, [api, send, invalidateRead, loadAlbum]);

  // assets: what expo-image-picker answered ({ uri, width, height, mimeType, fileSize })
  const addPhotos = useCallback((eventId, assets, from = generation.current) => {
    if (!isAuthenticated || from !== generation.current) return false;
    const items = assets.map((asset) => ({
      key: `upload-${Date.now().toString(36)}-${(keyCounter++).toString(36)}`,
      uri: asset.uri,
      width: asset.width,
      height: asset.height,
      mimeType: asset.mimeType ?? 'image/jpeg',
      fileSize: asset.fileSize,
      status: 'queued',
      error: null,
    }));
    // Picked first, shown first: the grid is newest first, so the order is reversed
    dispatch({ type: 'queued', eventId, items: [...items].reverse() });
    for (const item of items) queue.current.push({ eventId, key: item.key, asset: item, from });
    pump();
    return true;
  }, [pump, isAuthenticated]);

  const retryUpload = useCallback((eventId, key) => {
    const item = stateRef.current.uploads[eventId]?.find((upload) => upload.key === key);
    if (!item || item.status !== 'failed') return;
    dispatch({ type: 'uploadStatus', eventId, key, status: 'queued' });
    queue.current.push({ eventId, key, asset: item, from: generation.current });
    pump();
  }, [pump]);

  const discardUpload = useCallback((eventId, key) => {
    const item = stateRef.current.uploads[eventId]?.find((upload) => upload.key === key);
    sentFiles.current.delete(key);
    dispatch({ type: 'discard', eventId, key });
    if (item) discardLater(item.uri);
  }, []);

  const removePhoto = useCallback(async (eventId, photoId) => {
    const from = generation.current;
    await api.deletePhoto(eventId, photoId);
    if (from !== generation.current) return;
    invalidateRead(eventId, from);
    send({ type: 'removed', eventId, photoId }, from);
  }, [api, send, invalidateRead]);

  const reportPhoto = useCallback((eventId, photoId, reason) => api.reportPhoto(eventId, photoId, { reason }), [api]);

  const saveSettings = useCallback(async (eventId, settings) => {
    const from = generation.current;
    const saved = await api.setAlbumSettings(eventId, settings);
    if (from !== generation.current) return saved;
    invalidateRead(eventId, from);
    send({ type: 'settings', eventId, settings: saved }, from);
    return saved;
  }, [api, send, invalidateRead]);

  // How many photos an event has: its album once loaded, else what the event says
  const albums = state.albums;
  const photoCountOf = useCallback((event) => {
    const album = event ? albums[event.id] : null;
    return album?.status === 'ready' ? album.total : event?.photoCount ?? 0;
  }, [albums]);

  const value = useMemo(() => ({
    ...state,
    captureSession,
    loadAlbum,
    addPhotos,
    retryUpload,
    discardUpload,
    removePhoto,
    reportPhoto,
    saveSettings,
    photoCountOf,
  }), [state, captureSession, loadAlbum, addPhotos, retryUpload, discardUpload, removePhoto, reportPhoto, saveSettings, photoCountOf]);

  return <AlbumsContext.Provider value={value}>{children}</AlbumsContext.Provider>;
}

export function useAlbums() {
  const context = use(AlbumsContext);
  if (!context) throw new Error('useAlbums must be used inside <AlbumsProvider>');
  return context;
}

const noUploads = [];

// One event's album, loaded the first time it is shown (when `enabled`)
export function useAlbum(eventId, { enabled = true } = {}) {
  const albums = useAlbums();
  const { loadAlbum } = albums;
  const album = eventId ? albums.albums[eventId] ?? emptyAlbum : emptyAlbum;
  const status = album.status;
  useEffect(() => {
    if (enabled && eventId && status === 'idle') loadAlbum(eventId);
  }, [enabled, eventId, status, loadAlbum]);
  return {
    album,
    uploads: (eventId && albums.uploads[eventId]) || noUploads,
    reload: () => loadAlbum(eventId),
    loadMore: () => loadAlbum(eventId, { more: true }),
  };
}
