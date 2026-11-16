// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { createContext, use, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import { AppState } from 'react-native';
import { useLogto } from '@logto/rn';
import { useFocusEffect } from 'expo-router';
import { useEventsApi } from '../api/useEventsApi';
import { normalizeEvent } from '../api/eventsApi';
import { useMe } from '../../me/MeProvider';
import { useRealtime, useRealtimeEvent } from '../../realtime/RealtimeProvider';
import { useNetworkRecovery } from '../../api/useNetworkRecovery';
import { getUserPosition } from '../hooks/useUserPosition';
import { DEFAULT_FILTERS, NEARBY_RANGE, cancelledBeforeStart, distanceMeters, savedFilters, searchPoint } from '../model/eventModel';
import { CATEGORIES } from '../model/categories';
import { loadSettings, updateSetting } from '../../settings/settingsStore';
import { useOfflineCaches } from '../../offline/useOfflineCaches';
import { LISTS_KEY, LIST_NAMES, eventKey, eventPriority, listsOf } from './eventsCache';
import { PRIORITY } from '../../../lib/offline/diskCache';

const CATEGORY_IDS = new Set(CATEGORIES.map((category) => category.id));
// The events around are asked for from a rounded point (eventModel searchPoint), again
// when the app comes back to the front and after the user moved this far from where
// they were asked for; in between new and changed events arrive over the socket (`event`)
const MOVED_FOR_NEW_SEARCH_M = 500;
const RETRY_SEARCH_MS = 30_000;
// A position this close to the one the lists measure from is not worth a re-render
const POSITION_STEP_M = 20;

// Events of the app in one place, shared by the list, the details and the sheets
// (rating, report, editor): an event changed on one screen is changed everywhere, and
// an event the user saved or organizes changed by someone else arrives over the
// socket (`event`). Lists keep only IDs; the events themselves are in `byId`, where
// the summaries of the lists and the details are merged.
// Everything belongs to the signed-in user: it is emptied on sign-out, and answers to
// requests made before it are dropped, so the next user never sees the previous one's.
// The lists and the events opened are kept on the phone too (eventsCache.js): shown
// at once at the next start, and without a connection, until the server answers.

const EventsContext = createContext(null);

const emptyList = { ids: [], status: 'idle', error: null };

const initialState = {
  byId: {},
  nearby: emptyList,
  followed: emptyList,
  created: emptyList,
  details: {}, // id → { status, error }
  position: null,
  filters: DEFAULT_FILTERS,
};

// The Saved list holds what the user saved or joins: an event in it, or out of it
const savedList = (list, event) => {
  const ids = list.ids.filter((id) => id !== event.id);
  const keep = event.saved || event.following;
  // Back where it was, or first when new
  const at = list.ids.indexOf(event.id);
  if (keep && at >= 0) return list;
  return { ...list, ids: keep ? [event.id, ...ids] : ids };
};

const mergeEvents = (byId, events) => {
  const next = { ...byId };
  for (const event of events) next[event.id] = { ...next[event.id], ...event };
  return next;
};

function reducer(state, action) {
  switch (action.type) {
    case 'reset':
      return initialState;
    case 'hydrate': {
      // What the phone kept: under anything already loaded, and only into lists the
      // server has not answered yet (their status stays, so they are still asked for)
      const { lists } = action;
      const next = { ...state, byId: { ...Object.fromEntries(lists.events.map((event) => [event.id, event])), ...state.byId } };
      for (const name of LIST_NAMES) {
        if (state[name].status !== 'ready' && !state[name].ids.length && Array.isArray(lists[name])) next[name] = { ...state[name], ids: lists[name] };
      }
      return next;
    }
    case 'eventCached':
      // An event's page from the phone, under what is loaded
      return { ...state, byId: { ...state.byId, [action.event.id]: { ...action.event, ...state.byId[action.event.id] } } };
    case 'position':
      return { ...state, position: action.position };
    case 'filters':
      return { ...state, filters: action.filters };
    case 'listLoading':
      return { ...state, ...Object.fromEntries(action.lists.map((name) => [name, { ...state[name], status: 'loading', error: null }])) };
    case 'listError':
      return { ...state, ...Object.fromEntries(action.lists.map((name) => [name, { ...state[name], status: 'error', error: action.error }])) };
    case 'listLoaded':
      return {
        ...state,
        byId: mergeEvents(state.byId, action.events),
        [action.list]: { ids: action.events.map((event) => event.id), status: 'ready', error: null },
      };
    case 'detailLoading':
      return { ...state, details: { ...state.details, [action.id]: { status: 'loading', error: null } } };
    case 'detailError':
      return { ...state, details: { ...state.details, [action.id]: { status: 'error', error: action.error } } };
    case 'event': {
      // An event the server says is around (created just now, by anyone): in the
      // nearby list too, when it matches the filters and the user is within its reach,
      // so the map shows it at once. One whose reach shrank (a promotion's day ended)
      // leaves the list when the user is now beyond it.
      const { id, categories, location, reach } = action.event;
      const wanted = state.filters.categories;
      const known = state.nearby.ids.includes(id) || state.created.ids.includes(id) || state.followed.ids.includes(id);
      const fits = !wanted.length || (categories ?? []).some((category) => wanted.includes(category));
      const metres = distanceMeters(state.position, location);
      const within = metres == null || metres <= Math.min(reach ?? Infinity, NEARBY_RANGE);
      let { nearby } = state;
      if (action.live && !known && fits && within) nearby = { ...nearby, ids: [...nearby.ids, id] };
      else if (action.live && !within && nearby.ids.includes(id)) nearby = { ...nearby, ids: nearby.ids.filter((other) => other !== id) };
      // Removed by the organizer, or left on another device: out of the Saved list too
      const byId = mergeEvents(state.byId, [action.event]);
      const inSaved = state.followed.ids.includes(id);
      const keep = byId[id].saved || byId[id].following;
      const followed = action.live && inSaved !== !!keep ? savedList(state.followed, byId[id]) : state.followed;
      return {
        ...state,
        nearby,
        followed,
        byId,
        details: action.full ? { ...state.details, [action.event.id]: { status: 'ready', error: null } } : state.details,
      };
    }
    case 'following': {
      // Joined or left (going). `me`: the user's UserSummary, first among who is going;
      // `count`: the server's
      const { id, following, me, count } = action;
      const event = state.byId[id];
      if (!event) return state;
      const was = !!event.following;
      // The count of the summaries (beacons on the map) moves with it
      const followerCount = count ?? (was === following ? event.followerCount : Math.max(0, (event.followerCount ?? 0) + (following ? 1 : -1)));
      const others = event.followers?.filter((person) => person.id !== me?.id);
      const next = {
        ...event,
        following,
        followerCount,
        ...(others ? { followers: following && me ? [me, ...others] : others } : {}),
      };
      return { ...state, followed: savedList(state.followed, next), byId: { ...state.byId, [id]: next } };
    }
    case 'saved': {
      // Saved or not (a bookmark)
      const event = state.byId[action.id];
      if (!event) return state;
      const next = { ...event, saved: action.saved };
      return { ...state, followed: savedList(state.followed, next), byId: { ...state.byId, [action.id]: next } };
    }
    case 'removedFromLists': {
      const out = (list) => ({ ...list, ids: list.ids.filter((id) => !action.ids.includes(id)) });
      return { ...state, followed: out(state.followed), created: out(state.created) };
    }
    case 'me': {
      // The user changed their name or picture: their entries in the events loaded
      const swap = (person) => (person?.id === action.me.id ? { ...person, ...action.me } : person);
      const byId = {};
      for (const [id, event] of Object.entries(state.byId)) {
        byId[id] = {
          ...event,
          creator: swap(event.creator),
          ...(event.followers ? { followers: event.followers.map(swap) } : {}),
          ...(event.ratings ? { ratings: event.ratings.map((rating) => ({ ...rating, user: swap(rating.user) })) } : {}),
          ...(event.myRating ? { myRating: { ...event.myRating, user: swap(event.myRating.user) } } : {}),
        };
      }
      return { ...state, byId };
    }
    case 'created':
      return { ...state, created: { ...state.created, ids: [action.id, ...state.created.ids.filter((id) => id !== action.id)] } };
    default:
      return state;
  }
}

// The lists of the user's events asked for once within this long by the socket coming back
const OWN_REFRESH_GAP_MS = 4000;

export function EventsProvider({ children }) {
  const api = useEventsApi();
  const { isAuthenticated } = useLogto();
  const store = useOfflineCaches()?.events ?? null;
  const { status: socketStatus } = useRealtime();
  const authenticatedRef = useRef(isAuthenticated);
  const [state, dispatch] = useReducer(reducer, initialState);
  // The signed-in user as events show them (organizer, first of who is going)
  const { me } = useMe();
  const user = useMemo(() => (me ? { id: me.id, username: me.username, name: me.name, pictureUrl: me.pictureUrl, avatarVersion: me.avatarVersion } : null), [me]);
  const userRef = useRef(user);
  useEffect(() => {
    userRef.current = user;
    if (user) dispatch({ type: 'me', me: user });
  }, [user]);
  // The latest state for the actions, without re-creating them on every change
  const stateRef = useRef(state);
  const lastFilters = useRef(null); // the saved filters (restoreFilters)
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const nearbyRequest = useRef(null);
  // Where the last search for the events around was made from (the exact position), and when
  const searchedFrom = useRef(null);
  const lastSearch = useRef(0);
  const ownRequest = useRef(0);
  const lastOwnRefresh = useRef(0);
  const followRequestId = useRef(0);
  const followRequests = useRef(new Map());
  const saveRequests = useRef(new Map());

  // One session per sign-in: what arrives for an older one is dropped
  const session = useRef(0);
  useLayoutEffect(() => {
    authenticatedRef.current = isAuthenticated;
    if (isAuthenticated) return;
    session.current++;
    nearbyRequest.current?.abort();
    searchedFrom.current = null;
    followRequests.current.clear();
    saveRequests.current.clear();
    dispatch({ type: 'reset' });
    lastFilters.current = null; // read into the state again at the next sign-in
  }, [isAuthenticated]);
  const dispatchFor = useCallback((started) => (action) => {
    if (session.current === started) dispatch(action);
  }, []);

  // The lists the phone kept, at once (the server's answers follow)
  useEffect(() => {
    if (!isAuthenticated || !store) return;
    const send = dispatchFor(session.current);
    store.readJson(LISTS_KEY).then((lists) => {
      if (lists?.events) send({ type: 'hydrate', lists });
    }).catch(() => {});
  }, [isAuthenticated, store, dispatchFor]);

  // …and kept as they change: the lists once the server answered one of them, every
  // event page opened (the user's own and saved ones last to go)
  const { byId, details, nearby, followed, created } = state;
  useEffect(() => {
    if (!store || ![nearby, followed, created].some((list) => list.status === 'ready')) return;
    store.writeJson(LISTS_KEY, listsOf({ byId, nearby, followed, created }), { priority: PRIORITY.OWN });
  }, [store, byId, nearby, followed, created]);
  const storedEvents = useRef(new Map()); // id → the event as last written
  useEffect(() => {
    if (!store) return;
    for (const [id, detail] of Object.entries(details)) {
      const event = byId[id];
      if (detail.status !== 'ready' || !event || storedEvents.current.get(id) === event) continue;
      storedEvents.current.set(id, event);
      store.writeJson(eventKey(id), event, { priority: eventPriority({ followed, created }, id) });
    }
  }, [store, byId, details, followed, created]);
  // Saving an event or no longer: it is kept longer, or as long as any other
  useEffect(() => {
    if (!store) return;
    for (const id of store.keys('event:').map((key) => key.slice('event:'.length))) {
      store.setPriority(eventKey(id), eventPriority({ followed, created }, id));
    }
  }, [store, followed, created]);
  useLayoutEffect(() => {
    if (!isAuthenticated) storedEvents.current.clear();
  }, [isAuthenticated]);

  // fresh: ask for the position again (the user moves; it is recent enough when the
  // phone already has a fix from the last minutes, see getUserPosition)
  const ensurePosition = useCallback(async ({ fresh = false } = {}) => {
    const send = dispatchFor(session.current);
    let { position } = stateRef.current;
    if (!position || fresh) {
      position = (await getUserPosition()) ?? position;
      if (position) send({ type: 'position', position });
    }
    return position;
  }, [dispatchFor]);

  // The filters chosen last on this phone (settingsStore: they are the phone's, kept
  // across sign-outs), read once before the first search
  const restoreFilters = useCallback(() => (lastFilters.current ??= loadSettings().then((settings) => (
    savedFilters(settings.eventFilters, CATEGORY_IDS) ?? DEFAULT_FILTERS
  ))), []);

  // given: filters chosen now; at: the user's position when the caller knows it (the map)
  const refreshNearby = useCallback(async (given, { at } = {}) => {
    if (!isAuthenticated) return;
    const started = session.current;
    const send = dispatchFor(started);
    nearbyRequest.current?.abort();
    const controller = new AbortController();
    nearbyRequest.current = controller;
    lastSearch.current = Date.now();
    try {
      // Restore local filters without letting an old read overwrite a choice made
      // while storage was loading, or start work in a later auth session.
      const restored = await restoreFilters();
      if (started !== session.current || !authenticatedRef.current || controller.signal.aborted) return;
      const currentFilters = stateRef.current.filters;
      const filters = given ?? (currentFilters === DEFAULT_FILTERS ? restored : currentFilters);
      if (!given && currentFilters === DEFAULT_FILTERS && restored !== DEFAULT_FILTERS) send({ type: 'filters', filters: restored });
      send({ type: 'listLoading', lists: ['nearby'] });
      if (at) send({ type: 'position', position: at });
      const position = at ?? await ensurePosition({ fresh: true });
      if (started !== session.current || !authenticatedRef.current || controller.signal.aborted) return;
      if (!position) throw Object.assign(new Error('Your position is needed to find the events around you'), { code: 'no_position' });
      searchedFrom.current = position;
      const events = await api.getEvents({
        range: NEARBY_RANGE,
        categories: filters.categories.length ? filters.categories : undefined,
        ...searchPoint(position),
      }, { signal: controller.signal });
      if (started === session.current && authenticatedRef.current && !controller.signal.aborted) send({ type: 'listLoaded', list: 'nearby', events });
    } catch (error) {
      if (started === session.current && authenticatedRef.current && !controller.signal.aborted && error?.name !== 'AbortError') send({ type: 'listError', lists: ['nearby'], error });
    } finally {
      if (nearbyRequest.current === controller) nearbyRequest.current = null;
    }
  }, [api, ensurePosition, dispatchFor, restoreFilters, isAuthenticated]);

  // Only the latest call writes its answer (a pull-to-refresh can overlap the first load)
  const refreshOwn = useCallback(async () => {
    if (!isAuthenticated) return;
    lastOwnRefresh.current = Date.now();
    const request = ++ownRequest.current;
    const started = session.current;
    const send = dispatchFor(started);
    const latest = (action) => {
      if (ownRequest.current === request) send(action);
    };
    latest({ type: 'listLoading', lists: ['followed', 'created'] });
    try {
      const { followed, created } = await api.getOwnEvents();
      latest({ type: 'listLoaded', list: 'followed', events: followed });
      latest({ type: 'listLoaded', list: 'created', events: created });
    } catch (error) {
      latest({ type: 'listError', lists: ['followed', 'created'], error });
    }
  }, [api, dispatchFor, isAuthenticated]);

  // The nearby list first: the first time an area is asked about, the development
  // server places its demo events there (and the user's own)
  const refreshAll = useCallback(async () => {
    if (!isAuthenticated) return;
    const started = session.current;
    await refreshNearby();
    if (started !== session.current || !authenticatedRef.current) return;
    await refreshOwn();
  }, [refreshNearby, refreshOwn, isAuthenticated]);

  useNetworkRecovery(refreshAll);

  const loadEvent = useCallback(async (id) => {
    const send = dispatchFor(session.current);
    // Its page as the phone kept it, while the server's comes
    if (store && !stateRef.current.byId[id]?.followers) {
      const cached = await store.readJson(eventKey(id)).catch(() => null);
      if (cached?.id === id) send({ type: 'eventCached', event: cached });
    }
    send({ type: 'detailLoading', id });
    try {
      send({ type: 'event', event: await api.getEvDetails(id), full: true });
    } catch (error) {
      send({ type: 'detailError', id, error });
    }
  }, [api, dispatchFor, store]);

  const reloadEvent = useCallback(async (id) => {
    const send = dispatchFor(session.current);
    try {
      send({ type: 'event', event: await api.getEvDetails(id), full: true });
    } catch {
      // The screen keeps what it shows; the next visit loads it again
    }
  }, [api, dispatchFor]);

  // Join or leave (going): shown at once, undone if the server refuses; the server's
  // count wins
  const setGoing = useCallback(async (id, following) => {
    const started = session.current;
    const send = dispatchFor(started);
    const requestId = ++followRequestId.current;
    followRequests.current.set(id, requestId);
    const isLatest = () => session.current === started && followRequests.current.get(id) === requestId;
    const me = userRef.current;
    send({ type: 'following', id, following, me });
    try {
      const answer = await (following ? api.followEvent(id) : api.unfollowEvent(id));
      if (isLatest()) {
        followRequests.current.delete(id);
        send({ type: 'following', id, following, me, count: answer?.followerCount });
      }
    } catch (error) {
      if (!isLatest()) return;
      followRequests.current.delete(id);
      send({ type: 'following', id, following: !following, me });
      throw error;
    }
  }, [api, dispatchFor]);

  // Create (no id) or edit: the server answers the saved event
  const saveEvent = useCallback(async (id, fields, { key } = {}) => {
    const send = dispatchFor(session.current);
    const saved = id ? await api.modifyEvent(id, fields) : await api.createEvent(fields, { key });
    send({ type: 'event', event: saved, full: true });
    if (!id) send({ type: 'created', id: saved.id });
    return saved.id;
  }, [api, dispatchFor]);

  // The look of the event's page (eventTheme.js)
  const saveEventLook = useCallback(async (id, { theme }) => {
    const send = dispatchFor(session.current);
    send({ type: 'event', event: await api.modifyEvent(id, { theme }), full: true });
  }, [api, dispatchFor]);

  // Its pictures, in order (the first is the cover): files just picked are uploaded;
  // nothing is sent when they did not change
  const saveEventImages = useCallback(async (id, photos) => {
    const current = stateRef.current.byId[id]?.imageUrls ?? [];
    if (photos.length === current.length && photos.every((photo, index) => photo === current[index])) return;
    const send = dispatchFor(session.current);
    send({ type: 'event', event: await api.setImages(id, photos), full: true });
  }, [api, dispatchFor]);

  // Save or unsave (a private bookmark): shown at once, undone if the server refuses.
  // Taps in a row: only the last one's failure puts the bookmark back
  const setSaved = useCallback(async (id, saved) => {
    const started = session.current;
    const send = dispatchFor(started);
    const requestId = ++followRequestId.current;
    saveRequests.current.set(id, requestId);
    send({ type: 'saved', id, saved });
    try {
      await (saved ? api.bookmarkEvent(id) : api.unbookmarkEvent(id));
      if (saveRequests.current.get(id) === requestId) saveRequests.current.delete(id);
    } catch (error) {
      if (session.current !== started || saveRequests.current.get(id) !== requestId) return;
      saveRequests.current.delete(id);
      send({ type: 'saved', id, saved: !saved });
      throw error;
    }
  }, [api, dispatchFor]);

  // Out of the Saved list and of the user's own: only one cancelled before it began (one
  // that took place stays, docs/API.md). Shown at once, brought back if the server refuses
  const removeFromLists = useCallback(async (id) => {
    const started = session.current;
    const send = dispatchFor(started);
    send({ type: 'removedFromLists', ids: [id] });
    try {
      await api.unbookmarkEvent(id);
    } catch (error) {
      if (session.current === started) await refreshOwn();
      throw error;
    }
  }, [api, dispatchFor, refreshOwn]);

  // Everything cancelled before it began out of the Saved list
  const clearCancelledSaved = useCallback(async () => {
    const send = dispatchFor(session.current);
    await api.clearCancelledSaved();
    const ids = stateRef.current.followed.ids.filter((id) => cancelledBeforeStart(stateRef.current.byId[id]));
    send({ type: 'removedFromLists', ids });
  }, [api, dispatchFor]);

  // Its promotion (docs/PROMOTIONS.md): started, resumed or changed, and stopped
  const promoteEvent = useCallback(async (id, { radius, daily }) => {
    const send = dispatchFor(session.current);
    send({ type: 'event', event: await api.promote(id, { radius, daily }), full: true });
  }, [api, dispatchFor]);

  const stopPromotion = useCallback(async (id) => {
    const send = dispatchFor(session.current);
    send({ type: 'event', event: await api.stopPromotion(id), full: true });
  }, [api, dispatchFor]);

  const cancelEvent = useCallback(async (id) => {
    const send = dispatchFor(session.current);
    send({ type: 'event', event: await api.cancelEvent(id), full: true });
  }, [api, dispatchFor]);

  const saveRating = useCallback(async (id, rating, isUpdate) => {
    await (isUpdate ? api.modifyRating(id, rating) : api.rateEvent(id, rating));
    await reloadEvent(id);
  }, [api, reloadEvent]);

  const deleteRating = useCallback(async (id) => {
    await api.deleteRating(id);
    await reloadEvent(id);
  }, [api, reloadEvent]);

  const reportEvent = useCallback((id, report) => api.reportEvent(id, report), [api]);

  // An event the user saved or organizes, changed by someone else (its organizer)
  useRealtimeEvent('event', useCallback((frame) => {
    if (authenticatedRef.current && frame.event?.id) dispatch({ type: 'event', event: normalizeEvent(frame.event), live: true });
  }, []));
  // What events the user sees changed (someone blocked, or an organizer's account gone)
  useRealtimeEvent('events.stale', useCallback(() => {
    if (authenticatedRef.current) refreshAll();
  }, [refreshAll]));

  // The events around, loaded as soon as someone is signed in (the map shows them,
  // whether or not the Events tab was opened), then kept fresh: when the app comes
  // back to the front and when the user moved away (new and changed events arrive
  // over the socket meanwhile: no polling)
  const nearbyStatus = state.nearby.status;
  useEffect(() => {
    if (isAuthenticated && nearbyStatus === 'idle') refreshAll();
  }, [isAuthenticated, nearbyStatus, refreshAll]);
  useEffect(() => {
    if (!isAuthenticated) return undefined;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && stateRef.current.nearby.status !== 'loading') refreshNearby();
    });
    return () => subscription.remove();
  }, [isAuthenticated, refreshNearby]);

  // Where the user is now, from the map (every few metres while it is on screen): the
  // distances in the lists follow, and the events around are asked for again once the
  // user is MOVED_FOR_NEW_SEARCH_M from where they were searched for
  const notePosition = useCallback((position) => {
    if (!isAuthenticated || !Number.isFinite(position?.latitude) || !Number.isFinite(position?.longitude)) return;
    const at = { latitude: position.latitude, longitude: position.longitude };
    const from = searchedFrom.current;
    const { status } = stateRef.current.nearby;
    // Moved far, or the last search failed (often: no position yet, before the map got
    // the permission), tried again at most every RETRY_SEARCH_MS
    const moved = from && distanceMeters(from, at) >= MOVED_FOR_NEW_SEARCH_M;
    const retry = status === 'error' && Date.now() - lastSearch.current >= RETRY_SEARCH_MS;
    if ((moved || retry) && status !== 'loading') {
      refreshNearby(undefined, { at });
      return;
    }
    const shown = stateRef.current.position;
    if (!shown || distanceMeters(shown, at) >= POSITION_STEP_M) dispatch({ type: 'position', position: at });
  }, [isAuthenticated, refreshNearby]);

  // Own and saved lists do not receive every missed update over the socket. Refresh
  // after reconnect; if the first load was still running, retry only if it failed.
  const followedStatus = state.followed.status;
  const createdStatus = state.created.status;
  const socketWasOpen = useRef(false);
  const refreshAfterInitialLoad = useRef(false);
  useEffect(() => {
    if (socketStatus !== 'open') {
      socketWasOpen.current = false;
      refreshAfterInitialLoad.current = false;
      return;
    }
    if (!isAuthenticated) return;

    if (!socketWasOpen.current) {
      socketWasOpen.current = true;
      const loading = ['idle', 'loading'].includes(stateRef.current.followed.status)
        || ['idle', 'loading'].includes(stateRef.current.created.status);
      if (loading) {
        refreshAfterInitialLoad.current = true;
      } else if (Date.now() - lastOwnRefresh.current >= OWN_REFRESH_GAP_MS) {
        // Not again right after the return of the network asked for it
        refreshOwn();
      }
      return;
    }

    if (!refreshAfterInitialLoad.current) return;
    const statuses = [stateRef.current.followed.status, stateRef.current.created.status];
    if (statuses.some((status) => status === 'error')) {
      refreshAfterInitialLoad.current = false;
      refreshOwn();
    } else if (statuses.every((status) => status === 'ready')) {
      refreshAfterInitialLoad.current = false;
    }
  }, [socketStatus, isAuthenticated, followedStatus, createdStatus, refreshOwn]);

  const setFilters = useCallback((filters) => {
    dispatch({ type: 'filters', filters });
    lastFilters.current = Promise.resolve(filters);
    updateSetting('eventFilters', filters).catch(() => {});
    refreshNearby(filters);
  }, [refreshNearby]);

  useEffect(() => () => nearbyRequest.current?.abort(), []);

  // Going (joined) and saved, from the events themselves; in the Saved list (stable
  // while that list does not change)
  const isGoing = useCallback((id) => !!byId[id]?.following, [byId]);
  const isSaved = useCallback((id) => !!byId[id]?.saved, [byId]);
  const followedIds = state.followed.ids;
  const inSaved = useMemo(() => {
    const ids = new Set(followedIds);
    return (id) => ids.has(id);
  }, [followedIds]);

  const value = useMemo(() => ({
    ...state,
    user,
    isGoing,
    isSaved,
    inSaved,
    refreshNearby,
    refreshOwn,
    refreshAll,
    notePosition,
    loadEvent,
    reloadEvent,
    setGoing,
    setSaved,
    removeFromLists,
    clearCancelledSaved,
    saveEvent,
    saveEventLook,
    saveEventImages,
    promoteEvent,
    stopPromotion,
    cancelEvent,
    saveRating,
    deleteRating,
    reportEvent,
    setFilters,
  }), [state, user, isGoing, isSaved, inSaved, refreshNearby, refreshOwn, refreshAll, notePosition, loadEvent, reloadEvent, setGoing, setSaved, removeFromLists, clearCancelledSaved, saveEvent, saveEventLook, saveEventImages, promoteEvent, stopPromotion, cancelEvent, saveRating, deleteRating, reportEvent, setFilters]);

  return <EventsContext.Provider value={value}>{children}</EventsContext.Provider>;
}

export function useEvents() {
  const context = use(EventsContext);
  if (!context) throw new Error('useEvents must be used inside <EventsProvider>');
  return context;
}

// One event: loaded in full the first time it is shown, and again quietly every time
// its screen comes back into view (people join, rate, add photos)
export function useEvent(id) {
  const events = useEvents();
  const { loadEvent, reloadEvent } = events;
  const event = id ? events.byId[id] : null;
  const detail = id ? events.details[id] : null;
  // Whether it was loaded already, read when the screen shows (not a reason to reload)
  const known = useRef({ id: null, ready: false });
  const focused = useRef(false);
  useEffect(() => {
    known.current = { id, ready: detail?.status === 'ready' };
  }, [id, detail]);
  useFocusEffect(useCallback(() => {
    focused.current = true;
    if (!id) {
      focused.current = false;
      return undefined;
    }
    if (known.current.id === id && known.current.ready) reloadEvent(id);
    else loadEvent(id);
    return () => {
      focused.current = false;
    };
  }, [id, loadEvent, reloadEvent]));
  useNetworkRecovery(useCallback(() => {
    if (id && focused.current) reloadEvent(id);
  }, [id, reloadEvent]));
  return {
    event,
    status: detail?.status ?? 'loading',
    error: detail?.error ?? null,
    reload: () => loadEvent(id),
  };
}
