// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useEffect, useLayoutEffect, useRef, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useLogto } from '@logto/rn';
import { useRealtime, useRealtimeEvent } from '../../realtime/RealtimeProvider';

// The people around the user on the map, as the server sends them over the socket
// (docs/API.md: `presence.snapshot`, `presence.delta`): one store for the map, its
// cards, the visibility switch and the Social tab's "Nearby now".
//   person: { userId, username, name, pictureUrl, avatarVersion, backdrop, position: { latitude,
//             longitude }, precision: 'precise' | 'area', heading, speed, moving, updatedAt }
// A person's UserSummary comes with their first presence on a connection; later
// presences carry only what moves.

let people = new Map();
let list = [];
// UserSummary of everyone seen on this connection
const summaries = new Map();
const listeners = new Set();
// Where the user is (their last fix sent to the server): distances in the lists
let here = null;
const hereListeners = new Set();
// How many people have the user on their map, as the server says (in a crowd it differs
// from the people the user sees). null: not told yet
let audienceCount = null;
const audienceListeners = new Set();
const setAudienceCount = (count) => {
  if (count === audienceCount) return;
  audienceCount = count;
  for (const listener of audienceListeners) listener();
};

const publish = () => {
  list = [...people.values()];
  for (const listener of listeners) listener();
};
const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const toPerson = (presence) => {
  if (presence.user) summaries.set(presence.userId, presence.user);
  const user = summaries.get(presence.userId);
  return {
    userId: presence.userId,
    username: user?.username ?? '',
    name: user?.name ?? user?.username ?? 'Someone',
    pictureUrl: user?.pictureUrl ?? null,
    avatarVersion: presence.avatarVersion ?? user?.avatarVersion ?? 0,
    backdrop: user?.backdrop ?? null,
    position: presence.position,
    precision: presence.precision,
    heading: presence.heading,
    speed: presence.speed,
    moving: presence.moving,
    updatedAt: presence.updatedAt,
  };
};

function clearNearbyPeople() {
  setAudienceCount(null);
  if (!people.size) return;
  people = new Map();
  publish();
}

// [person], the same array until something changes
export const useNearbyPeople = () => useSyncExternalStore(subscribe, () => list);

// How many people have the user on their map, or null when the server has not said yet
export const useAudienceCount = () => useSyncExternalStore((listener) => {
  audienceListeners.add(listener);
  return () => audienceListeners.delete(listener);
}, () => audienceCount);

// The user's last position ({ latitude, longitude }) or null
export const useHere = () => useSyncExternalStore((listener) => {
  hereListeners.add(listener);
  return () => hereListeners.delete(listener);
}, () => here);

// Calls `listener({ id, from, gesture, at })` for each gesture made to the user
export const useIncomingGestures = (listener) => useRealtimeEvent('gesture', listener);

// Calls `listener({ id, from, text, at })` for each message someone around says to everyone
export const useIncomingBroadcasts = (listener) => useRealtimeEvent('broadcast', listener);

// sendGesture(userId, gestureId): to someone who sees the user now
export function useSendGesture() {
  const { request } = useRealtime();
  return useCallback((to, gesture) => request({ type: 'gesture', to, gesture }), [request]);
}

// sendBroadcast(text) → { recipients }: words to everyone who sees the user now
export function useSendBroadcast() {
  const { request } = useRealtime();
  return useCallback(async (text) => {
    const answer = await request({ type: 'broadcast', text });
    return { recipients: answer.recipients };
  }, [request]);
}

// Changes worth telling the server (it forwards them to everyone who sees the user)
const MIN_MOVE_M = 2;
const MIN_TURN_DEG = 12;
const CHECK_MS = 1000;
const KEEPALIVE_MS = 15_000;
// A GPS fix older than this is not sent again (a GPS silent for long, on the map)
const MAX_POSITION_AGE_MS = 5 * 60 * 1000;
// A fix older than this says nothing about moving now (the GPS stopped with the map, or
// went silent): the user is not shown walking on the spot to the people around
const MOVING_FIX_AGE_MS = 10_000;

const metresBetween = (a, b) => {
  const dLat = (b.latitude - a.latitude) * 111320;
  const dLon = (b.longitude - a.longitude) * 111320 * Math.cos((a.latitude * Math.PI) / 180);
  return Math.hypot(dLat, dLon);
};

/**
 * Listens to what the server sends about the people around, from the moment the
 * connection opens: mounted with the RealtimeProvider (app/_layout.js), not with the
 * map, since a person's UserSummary comes only once per connection, with their first
 * presence (a frame missed would leave them nameless until the next connection).
 */
export function NearbyPeopleListener() {
  const { isAuthenticated } = useLogto();
  const { status } = useRealtime();
  // This module-level store outlives the socket and navigation tree. Drop it at
  // sign-out so another account cannot briefly see the previous session's people.
  useLayoutEffect(() => {
    if (isAuthenticated) return;
    summaries.clear();
    clearNearbyPeople();
    here = null;
    for (const listener of hereListeners) listener();
  }, [isAuthenticated]);

  // Nearby people are live presence. Do not leave them in the map or Social tab
  // while this phone has no socket; the next snapshot repopulates the shared store.
  useEffect(() => {
    if (status !== 'open') clearNearbyPeople();
  }, [status]);

  // A new connection: the server sends everyone's summary again with their first
  // presence, so the ones kept from the last connection can go
  useRealtimeEvent('ready', useCallback(() => summaries.clear(), []));
  // What the server sends about the people around
  useRealtimeEvent('presence.snapshot', useCallback(({ people: entries }) => {
    people = new Map((entries ?? []).map((entry) => [entry.userId, toPerson(entry)]));
    publish();
  }, []));
  useRealtimeEvent('presence.delta', useCallback(({ people: entries, removed, audience }) => {
    if (typeof audience === 'number') setAudienceCount(audience);
    if (!entries?.length && !removed?.length) return;
    people = new Map(people);
    for (const id of removed ?? []) people.delete(id);
    for (const entry of entries ?? []) people.set(entry.userId, toPerson(entry));
    publish();
  }, []));
  return null;
}

/**
 * Keeps the server told where the user is while the app is in front, `sharing` is on
 * (sharingWindow.js: on the map, and a minute after leaving it) and the user is not
 * invisible: on every real change (moved 2 m, turned, started or stopped walking, at
 * most once a second), every 15 s otherwise, and again after each reconnection. Turning
 * invisible or `sharing` ending is said once (the server forgets the position) and
 * empties the map. positionRef: the latest fused position ({ latitude, longitude,
 * accuracy, heading, speed, moving, timestamp }) or null.
 */
export function usePresenceSync({ mode, positionRef, sharing }) {
  const { send, status } = useRealtime();
  const sent = useRef(null);

  useEffect(() => {
    if (status !== 'open') {
      sent.current = null;
      return undefined;
    }
    if (mode === 'invisible') {
      send({ type: 'presence', mode: 'invisible', position: null });
      sent.current = null;
      clearNearbyPeople();
      return undefined;
    }
    if (!sharing) {
      // Off the map for good now: out of everyone's, and nobody on the user's. Their mode
      // stays: it applies again when the map opens
      if (sent.current) send({ type: 'presence', mode, position: null });
      sent.current = null;
      clearNearbyPeople();
      return undefined;
    }
    const tell = () => {
      if (AppState.currentState !== 'active') return;
      const latest = positionRef.current;
      const age = Date.now() - (latest?.timestamp ?? 0);
      if (!latest || age > MAX_POSITION_AGE_MS) return;
      const fix = age > MOVING_FIX_AGE_MS ? { ...latest, moving: false, speed: 0 } : latest;
      const last = sent.current;
      const turned = Number.isFinite(fix.heading) && Number.isFinite(last?.heading)
        && Math.abs(((fix.heading - last.heading + 540) % 360) - 180) >= MIN_TURN_DEG;
      const due = !last
        || last.mode !== mode
        || metresBetween(last, fix) >= MIN_MOVE_M
        || turned
        || !!fix.moving !== !!last.moving
        || Date.now() - last.at >= KEEPALIVE_MS;
      if (!due) return;
      const position = {
        latitude: fix.latitude,
        longitude: fix.longitude,
        accuracy: fix.accuracy ?? null,
        heading: Number.isFinite(fix.heading) && fix.heading >= 0 ? fix.heading : null,
        speed: Number.isFinite(fix.speed) && fix.speed >= 0 ? fix.speed : null,
        moving: typeof fix.moving === 'boolean' ? fix.moving : null,
      };
      if (send({ type: 'presence', mode, position })) {
        sent.current = { ...position, mode, at: Date.now() };
        here = { latitude: fix.latitude, longitude: fix.longitude };
        for (const listener of hereListeners) listener();
      }
    };
    tell();
    const timer = setInterval(tell, CHECK_MS);
    return () => clearInterval(timer);
  }, [status, mode, send, positionRef, sharing]);
}
