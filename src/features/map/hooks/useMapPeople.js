// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { BODY_SHAPES, emoteUrl } from '../../../../avatar-server/shared/avatarFormat';
import { getStandIn, mapAvatarFiles } from '../../avatar/api/avatarApi';
import { AVATAR_FILES_URL } from '../../avatar/api/avatarServer';
import { useAvatarCatalog, useAvatars } from '../../avatar/state/AvatarProvider';
import { distanceMeters } from '../../events/model/eventModel';
import { toneOf } from '../../social/components/PersonAvatar';
import { useNearbyPeople } from '../state/nearbyPeople';
import { useSocial } from '../../social/state/SocialProvider';
import { backdropAccent } from '../../profile/state/profileStyle';

// Everyone the server sends goes on the map (at most 25, its choice: docs/API.md,
// Presence rules), drawn together in a few draw calls (webview/map crowd), each in their
// map avatar (made by the server, API.md Avatars). Their avatars are asked for nearest
// first, a few at a time (each answer brings the next ones), so they fill in from the
// people closest.
const LOADS_AT_ONCE = 12;
// An avatar that did not load, or whose map avatar could not be made yet, is asked
// again after this long
const MAP_AVATAR_RETRY_MS = 60_000;
// The stand-in asked again after a failure
const STAND_IN_RETRY_MS = 30_000;

/**
 * The people around, from the presence store (the socket) to the map (mapRef: MapWebView):
 * nearest first, with their distance (metres, from `here`: { latitude, longitude }). Their looks
 * are loaded once (AvatarProvider) and again only when their avatarVersion changes.
 * Answers { people, emoteFor(userId | 'me', emoteId) → URL of that emote for their body }.
 */
export function useMapPeople(mapRef, here) {
  const people = useNearbyPeople();
  const { avatars, loadAvatar, userId: ownId } = useAvatars();
  const catalog = useAvatarCatalog();
  // userId → map avatar key sent to the map
  const sent = useRef(new Map());

  const shown = useMemo(() => {
    return people
      .map((person) => ({ ...person, distance: here ? distanceMeters(here, person.position) : null }))
      .sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
  }, [people, here]);

  // The stand-in, once (again later if the avatar server did not answer)
  useEffect(() => {
    let cancelled = false;
    let retry = null;
    const ask = () => {
      getStandIn()
        .then((files) => {
          if (!cancelled && files) mapRef.current?.setPeopleStandIn(files);
        })
        .catch(() => {
          if (!cancelled) retry = setTimeout(ask, STAND_IN_RETRY_MS);
        });
    };
    ask();
    return () => {
      cancelled = true;
      clearTimeout(retry);
    };
  }, [mapRef]);

  // The user's connections: a ring at their feet on the map
  const { connections } = useSocial();
  const connectedIds = useMemo(() => new Set(connections.map((entry) => entry.user.id)), [connections]);

  // Positions to the map, in its short form
  useEffect(() => {
    const ids = new Set();
    const peopleForMap = shown.map((person) => {
      ids.add(person.userId);
      return {
        id: person.userId,
        name: person.name,
        lat: person.position.latitude,
        lon: person.position.longitude,
        precision: person.precision,
        heading: person.heading,
        speed: person.speed,
        // Their profile's colour (its backdrop); one from their @handle without it
        tone: backdropAccent(person.backdrop) ?? toneOf(person.username),
        connected: connectedIds.has(person.userId),
      };
    });
    mapRef.current?.setPeople(peopleForMap);
    // Someone who left the map gets their look again if they come back
    for (const id of sent.current.keys()) if (!ids.has(id)) sent.current.delete(id);
  }, [shown, mapRef, connectedIds]);

  // Their avatars: when first shown, when they changed it, or when their map avatar
  // was not ready a while ago. Nearest first, a few at a time.
  useEffect(() => {
    let started = 0;
    for (const person of shown) {
      if (started >= LOADS_AT_ONCE) break;
      const entry = avatars[person.userId];
      if (entry?.status === 'loading') {
        started++;
        continue;
      }
      const late = Date.now() - (entry?.loadedAt ?? 0) > MAP_AVATAR_RETRY_MS;
      const stale = (entry?.status === 'ready' && (entry.version !== person.avatarVersion || (!entry.mapAvatar && late)))
        || (entry?.status === 'error' && late);
      if (!entry || stale) {
        loadAvatar(person.userId);
        started++;
      }
    }
  }, [shown, avatars, loadAvatar]);

  // …and their map avatars to the map once known (the map keeps the stand-in until then)
  useEffect(() => {
    for (const person of shown) {
      const key = avatars[person.userId]?.mapAvatar;
      if (!key || sent.current.get(person.userId) === key) continue;
      const files = mapAvatarFiles(key);
      if (!files) continue;
      mapRef.current?.setPersonAvatar(person.userId, files);
      sent.current.set(person.userId, key);
    }
  }, [shown, avatars, mapRef]);

  // The map avatars of the user's connections stay on the device after everyone
  // else's (the map page's file cache), so friends show at once, also offline
  const keptKey = useRef('');
  useEffect(() => {
    const files = connections
      .map((entry) => mapAvatarFiles(avatars[entry.user.id]?.mapAvatar))
      .filter(Boolean);
    const key = files.map((entry) => entry.model).sort().join('|');
    if (key === keptKey.current) return;
    keptKey.current = key;
    mapRef.current?.keepPeopleAvatars(files);
  }, [connections, avatars, mapRef]);

  // An emote is made for a body shape: the one of who plays it
  const emoteFor = useCallback((who, emoteId) => {
    const avatar = avatars[who === 'me' ? ownId : who]?.avatar;
    if (!catalog.data || !AVATAR_FILES_URL) return null;
    return emoteUrl(catalog.data, emoteId, avatar?.bodyShape ?? BODY_SHAPES.female, AVATAR_FILES_URL);
  }, [avatars, ownId, catalog.data]);

  return { people: shown, emoteFor };
}
