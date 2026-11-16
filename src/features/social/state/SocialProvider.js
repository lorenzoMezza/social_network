// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { createContext, use, useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef } from 'react';
import { useFocusEffect } from 'expo-router';
import { useLogto } from '@logto/rn';
import { useApi } from '../../api/useApi';
import { useNetworkRecovery } from '../../api/useNetworkRecovery';
import { useMe } from '../../me/MeProvider';
import { useRealtime, useRealtimeEvent } from '../../realtime/RealtimeProvider';
import { useNearbyPeople } from '../../map/state/nearbyPeople';
import { useOfflineCaches } from '../../offline/useOfflineCaches';
import { setConnectedPeople } from '../../offline/peoplePriority';
import { PRIORITY } from '../../../lib/offline/diskCache';
import { INBOX_KEY, OUTBOX_KEY, chatPriority, inboxOf, mergeNewestPage, messagesKey, storedMessages } from './socialCache';
import { uploadFile, discardPickedFile } from '../../api/uploads';

// Connections, blocks and chats, for the whole app (Social tab, chats, profiles, the
// map's cards), on the backend (docs/API.md): loaded at sign-in and again at every
// reconnection of the socket, kept up to date by it (`message`, `chat`,
// `chat.removed`, `connection.created`). People are known by ID; their UserSummary
// ({ id, username, name, pictureUrl }) is kept in `people` from every answer.
//
// The rules (the server enforces them): a connection is a friendship made only in
// person; direct chats with a connection or someone nearby right now (on the map);
// event chats from an event's creation to its end, for who joined it; groups owned by
// their creator. Groups and event chats are run by their owner and the admins they
// name (API.md, Moderation): removing, muting, read-only, pins, polls.
//
// A chat as the screens see it: the API's ChatSummary, with `last` (its last message)
// and, once opened, `members`. Messages carry `at` in milliseconds.
//
// Everything is kept on the phone too (socialCache.js): at sign-in the inbox shows at
// once from there, a chat's messages as soon as it opens, then the server's answers
// replace them. A message written without a connection stays "Sending…" in the
// outbox, also kept on the phone, and goes as soon as the connection is back (its
// clientId makes sending it twice harmless).

const SocialContext = createContext(null);

const initialState = {
  status: 'idle',
  people: {},
  connections: [],
  blocks: [],
  chats: {},
  details: {}, // chat id → members ([{ user, role }])
  messages: {}, // chat id → { items, nextCursor, status }
  outbox: [], // own messages waiting for a connection (pending: true)
};

// The outbox's messages for a chat into its list
const withOutbox = (items, outbox, chatId) => outbox.filter((message) => message.chatId === chatId).reduce(addMessage, items);

const toMessage = (message) => ({ ...message, at: typeof message.at === 'string' ? Date.parse(message.at) : message.at });
const toChat = (chat) => ({ ...chat, last: chat.lastMessage ? toMessage(chat.lastMessage) : null, pinned: (chat.pinned ?? []).map(toMessage) });

const withPeople = (people, list) => {
  let next = people;
  for (const person of list) {
    if (!person?.id) continue;
    const known = people[person.id];
    if (known && known.pictureUrl === person.pictureUrl && known.name === person.name && known.username === person.username && known.avatarVersion === person.avatarVersion) continue;
    if (next === people) next = { ...people };
    next[person.id] = person;
  }
  return next;
};

// A message into its chat's list (once: the echo of an own message replaces the one
// shown while sending, matched by clientId)
const addMessage = (list, message) => {
  const index = list.findIndex((entry) => entry.id === message.id || (message.clientId && entry.clientId === message.clientId && entry.from === message.from));
  const next = index === -1 ? [...list, message] : list.with(index, message);
  // The server's time replaces the phone's, whose clock may be off: everyone reads the same order
  return next.sort((a, b) => a.at - b.at);
};

function reducer(state, action) {
  switch (action.type) {
    case 'reset':
      return initialState;
    case 'hydrate': {
      // What the phone kept, until the server answers (never over its answer)
      const outbox = action.outbox.reduce((list, message) => (list.some((entry) => entry.clientId === message.clientId) ? list : [...list, message]), state.outbox);
      if (state.status === 'ready' || !action.inbox) return { ...state, outbox };
      const { people, connections, blocks, chats, details } = action.inbox;
      return { ...state, status: 'ready', people: { ...people, ...state.people }, connections, blocks, chats, details, outbox };
    }
    case 'outboxAdd':
      return state.outbox.some((message) => message.clientId === action.message.clientId) ? state : { ...state, outbox: [...state.outbox, action.message] };
    case 'outboxRemove':
      return { ...state, outbox: state.outbox.filter((message) => message.clientId !== action.clientId) };
    case 'messagesCached':
      // A chat's messages from the phone, shown while the server's come
      if (state.messages[action.id]?.items?.length) return state;
      return { ...state, messages: { ...state.messages, [action.id]: { items: withOutbox(action.items, state.outbox, action.id), nextCursor: action.nextCursor, status: 'ready' } } };
    case 'messagesFill': {
      // Messages written while the phone was away, after the ones it has
      const current = state.messages[action.id];
      if (!current) return state;
      return { ...state, messages: { ...state.messages, [action.id]: { ...current, items: action.items.map(toMessage).reduce(addMessage, current.items) } } };
    }
    case 'loading':
      return { ...state, status: state.status === 'ready' ? 'ready' : 'loading' };
    case 'loaded': {
      const chats = Object.fromEntries(action.chats.map((chat) => [chat.id, toChat(chat)]));
      const activeChatIds = new Set(action.chats.map((chat) => chat.id));
      const people = withPeople(state.people, [
        ...action.connections.map((entry) => entry.user),
        ...action.blocks.map((entry) => entry.user),
        ...action.chats.flatMap((chat) => [chat.with, chat.lastAuthor]).filter(Boolean),
      ]);
      const keepActiveChats = (entries) => Object.fromEntries(Object.entries(entries).filter(([id]) => activeChatIds.has(id)));
      return {
        ...state,
        status: 'ready',
        people,
        connections: action.connections,
        blocks: action.blocks,
        chats,
        details: keepActiveChats(state.details),
        messages: keepActiveChats(state.messages),
      };
    }
    case 'failed':
      return { ...state, status: state.status === 'ready' ? 'ready' : 'error' };
    case 'people':
      return { ...state, people: withPeople(state.people, action.people) };
    case 'chat': {
      const chat = toChat(action.chat);
      // The chat on screen has nothing new, whatever was counted a moment ago
      if (action.open === chat.id) chat.unread = 0;
      const people = withPeople(state.people, [chat.with, chat.lastAuthor].filter(Boolean));
      return { ...state, people, chats: { ...state.chats, [chat.id]: chat } };
    }
    case 'detail': {
      const { members, ...summary } = action.chat;
      const chat = toChat(summary);
      return {
        ...state,
        people: withPeople(state.people, [...members.map((member) => member.user), chat.with].filter(Boolean)),
        chats: { ...state.chats, [chat.id]: chat },
        details: { ...state.details, [chat.id]: members },
      };
    }
    case 'chatRemoved': {
      const chats = { ...state.chats };
      const details = { ...state.details };
      const messages = { ...state.messages };
      delete chats[action.id];
      delete details[action.id];
      delete messages[action.id];
      return { ...state, chats, details, messages };
    }
    case 'messagesLoading':
      return { ...state, messages: { ...state.messages, [action.id]: { items: [], nextCursor: null, ...state.messages[action.id], status: 'loading' } } };
    case 'messages': {
      const current = state.messages[action.id];
      const page = action.items.map(toMessage);
      // An older page goes before what is loaded; the newest page over it, keeping what
      // arrived meanwhile and what the phone had before it (socialCache.js)
      if (action.older) {
        const existing = current?.items ?? [];
        const known = new Set(existing.map((message) => message.id));
        const items = [...page.filter((message) => !known.has(message.id)), ...existing];
        return { ...state, messages: { ...state.messages, [action.id]: { items, nextCursor: action.nextCursor, status: 'ready' } } };
      }
      const merged = mergeNewestPage(current, page, action.nextCursor);
      const items = withOutbox(merged.items, state.outbox, action.id);
      return { ...state, messages: { ...state.messages, [action.id]: { items, nextCursor: merged.nextCursor, status: 'ready' } } };
    }
    case 'message': {
      const message = toMessage(action.message);
      const chat = state.chats[message.chatId];
      const loaded = state.messages[message.chatId];
      const mine = message.from === action.me;
      const fresh = chat?.last?.id !== message.id && !loaded?.items.some((entry) => entry.id === message.id);
      const chats = chat ? {
        ...state.chats,
        [chat.id]: {
          ...chat,
          last: !chat.last || message.at >= chat.last.at ? message : chat.last,
          // Writing means having read: also what was new on this phone, from another one
          unread: mine ? 0 : action.open === chat.id || !fresh || message.system ? chat.unread : chat.unread + 1,
        },
      } : state.chats;
      const messages = loaded ? { ...state.messages, [message.chatId]: { ...loaded, items: addMessage(loaded.items, message) } } : state.messages;
      return { ...state, chats, messages };
    }
    case 'messageUpdated': {
      // A poll's votes, or closed: in place, wherever the message is shown
      const message = toMessage(action.message);
      // What goes to the whole chat does not say what this person chose (`mine`): it stays
      const replace = (entry) => (entry?.id === message.id
        ? { ...entry, ...message, poll: message.poll ? { ...message.poll, mine: message.poll.mine ?? entry.poll?.mine ?? [] } : null }
        : entry);
      const chat = state.chats[message.chatId];
      const loaded = state.messages[message.chatId];
      return {
        ...state,
        chats: chat ? { ...state.chats, [chat.id]: { ...chat, last: replace(chat.last), pinned: chat.pinned.map(replace) } } : state.chats,
        messages: loaded ? { ...state.messages, [message.chatId]: { ...loaded, items: loaded.items.map(replace) } } : state.messages,
      };
    }
    case 'messagesFailed': {
      const current = state.messages[action.id];
      return { ...state, messages: { ...state.messages, [action.id]: { items: [], nextCursor: null, ...current, status: current?.items?.length ? 'ready' : 'error' } } };
    }
    case 'messageFailed': {
      const loaded = state.messages[action.chatId];
      if (!loaded) return state;
      return { ...state, messages: { ...state.messages, [action.chatId]: { ...loaded, items: loaded.items.map((entry) => (entry.clientId === action.clientId ? { ...entry, pending: false, failed: true } : entry)) } } };
    }
    case 'read': {
      const chat = state.chats[action.id];
      return chat && chat.unread ? { ...state, chats: { ...state.chats, [action.id]: { ...chat, unread: 0 } } } : state;
    }
    case 'chatRead': {
      // Read on another device of the user's
      const chat = state.chats[action.id];
      if (!chat) return state;
      return { ...state, chats: { ...state.chats, [action.id]: { ...chat, unread: action.open === action.id ? 0 : action.unread } } };
    }
    case 'connection': {
      const others = state.connections.filter((entry) => entry.user.id !== action.connection.user.id);
      return { ...state, people: withPeople(state.people, [action.connection.user]), connections: [action.connection, ...others] };
    }
    case 'disconnected':
      return { ...state, connections: state.connections.filter((entry) => entry.user.id !== action.id) };
    case 'blocks':
      return { ...state, blocks: action.blocks, people: withPeople(state.people, action.blocks.map((entry) => entry.user)) };
    default:
      return state;
  }
}

let clientCounter = 0;
// Pages of 100 asked for at most to fill a hole in a chat
const GAP_PAGES = 20;
// Chats brought up to date in the background after each load of the inbox
const SYNC_CHATS = 50;
// The same thing often says "load again" twice (the network and then the socket are back):
// once within this long
const AUTO_REFRESH_GAP_MS = 4000;
// A chat on screen tells the server what was read a moment after the last message, not
// at each of them (a busy event chat would be one request per message per reader)
const READ_DELAY_MS = 1500;
// Messages waiting while the server cannot take them (busy, a limit reached) are tried
// again this often, also with the connection up
const OUTBOX_RETRY_MS = 15_000;

// A member's path in a chat (moderation)
const member = (userId) => `/members/${encodeURIComponent(userId)}`;

export function SocialProvider({ children }) {
  const { isAuthenticated } = useLogto();
  const request = useApi();
  const { me } = useMe();
  const meId = me?.id ?? null;
  const { status: socketStatus } = useRealtime();
  const caches = useOfflineCaches();
  const store = caches?.chats ?? null;
  const [state, dispatch] = useReducer(reducer, initialState);
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  const authenticated = useRef(isAuthenticated);
  const generation = useRef(0);
  const refreshRequest = useRef(0);
  const dispatchIfCurrent = useCallback((action, started) => {
    if (authenticated.current && (started === undefined || started === generation.current)) dispatch(action);
  }, []);
  // The chat on screen: its new messages are read at once
  const openChat = useRef(null);

  // Everything belongs to the signed-in user: the next one starts clean
  useLayoutEffect(() => {
    authenticated.current = isAuthenticated;
    if (!isAuthenticated) {
      generation.current++;
      openChat.current = null;
      dispatch({ type: 'reset' });
    }
  }, [isAuthenticated]);

  // The messages written after `newestId` (one the phone has) up to the newest page
  // (`pageIds`), asked for with `after`: null when they are too many (GAP_PAGES) or the
  // server cannot tell (then the chat restarts from the newest page)
  const fetchMissed = useCallback(async (id, newestId, pageIds) => {
    let after = newestId;
    const missed = [];
    try {
      for (let i = 0; i < GAP_PAGES; i++) {
        const next = await request(`/chats/${encodeURIComponent(id)}/messages?${new URLSearchParams({ after, limit: '100' })}`);
        missed.push(...next.items.map(toMessage));
        if (!next.nextCursor || next.items.some((message) => pageIds.has(message.id))) return missed;
        after = next.nextCursor;
      }
    } catch {
      return null;
    }
    return null;
  }, [request]);

  // More was written while the phone was away than the newest page holds: the
  // messages between what it has and that page are filled in first, so no hole is
  // left in the chat
  const fillGap = useCallback(async (id, page, started) => {
    const current = stateRef.current.messages[id];
    if (!mergeNewestPage(current, page.items.map(toMessage), page.nextCursor).gap) return;
    const newest = current.items.filter((message) => !message.pending && !message.failed).at(-1);
    const missed = await fetchMissed(id, newest.id, new Set(page.items.map((message) => message.id)));
    if (missed) dispatchIfCurrent({ type: 'messagesFill', id, items: missed }, started);
  }, [fetchMissed, dispatchIfCurrent]);

  // The chats written in since the phone last had them, in the background after each
  // load of the inbox (the most recent first, SYNC_CHATS at most): every chat page can
  // then be shown without a connection, also one never opened. Chats on screen or
  // already loaded are kept by the state itself.
  const syncing = useRef(false);
  const syncChats = useCallback(async (chats, started) => {
    if (!store || syncing.current) return;
    syncing.current = true;
    try {
      const recent = chats
        .map(toChat)
        .filter((chat) => chat.last)
        .sort((a, b) => b.last.at - a.last.at)
        .slice(0, SYNC_CHATS);
      for (const chat of recent) {
        if (started !== generation.current) return;
        if (stateRef.current.messages[chat.id]) continue;
        const kept = await store.readJson(messagesKey(chat.id)).catch(() => null);
        if (kept?.items?.at(-1)?.id === chat.last.id) continue;
        const page = await request(`/chats/${encodeURIComponent(chat.id)}/messages?limit=50`);
        const pageItems = page.items.map(toMessage);
        let base = kept ?? { items: [], nextCursor: null };
        if (mergeNewestPage(base, pageItems, page.nextCursor).gap) {
          const missed = await fetchMissed(chat.id, base.items.at(-1).id, new Set(pageItems.map((message) => message.id)));
          if (missed) base = { ...base, items: [...base.items, ...missed] };
        }
        const merged = mergeNewestPage(base, pageItems, page.nextCursor);
        if (started === generation.current && !stateRef.current.messages[chat.id]) {
          store.writeJson(messagesKey(chat.id), storedMessages(merged), { priority: chatPriority(chat) });
        }
      }
    } catch {
      // Offline again: the next load of the inbox carries on
    } finally {
      syncing.current = false;
    }
  }, [store, request, fetchMissed]);

  // What the phone kept, at once (the server's answers follow)
  useEffect(() => {
    if (!isAuthenticated || !store) return;
    const started = generation.current;
    Promise.all([store.readJson(INBOX_KEY), store.readJson(OUTBOX_KEY)])
      .then(([inbox, outbox]) => dispatchIfCurrent({ type: 'hydrate', inbox, outbox: outbox ?? [] }, started))
      .catch(() => {});
  }, [isAuthenticated, store, dispatchIfCurrent]);

  // …and everything kept as it changes (the cache writes a moment later, once)
  const { people, connections, blocks, chats: chatsById, details, messages, outbox, status } = state;
  useEffect(() => {
    if (store && status === 'ready') store.writeJson(INBOX_KEY, inboxOf({ people, connections, blocks, chats: chatsById, details }), { priority: PRIORITY.OWN });
  }, [store, status, people, connections, blocks, chatsById, details]);
  useEffect(() => {
    if (store) store.writeJson(OUTBOX_KEY, outbox, { priority: PRIORITY.OWN });
  }, [store, outbox]);
  const stored = useRef(new Map()); // chat id → its messages as last written
  useEffect(() => {
    if (!store) return;
    for (const [id, entry] of Object.entries(messages)) {
      if (entry.status !== 'ready' || stored.current.get(id) === entry) continue;
      stored.current.set(id, entry);
      store.writeJson(messagesKey(id), storedMessages(entry), { priority: chatPriority(chatsById[id]) });
    }
  }, [store, messages, chatsById]);
  // A chat gone (left, deleted, removed from it) goes from the phone too
  useEffect(() => {
    if (!store || status !== 'ready') return;
    for (const key of store.keys('messages:')) {
      const id = key.slice('messages:'.length);
      if (!chatsById[id]) {
        stored.current.delete(id);
        store.remove(key);
      }
    }
  }, [store, status, chatsById]);
  useLayoutEffect(() => {
    if (!isAuthenticated) stored.current.clear();
  }, [isAuthenticated]);
  // Connections are close to the user: what the phone keeps of them goes last
  useEffect(() => {
    setConnectedPeople(connections.map((entry) => entry.user.id));
    for (const { user } of connections) if (user.pictureUrl) caches?.people.setPriority(user.pictureUrl, PRIORITY.CLOSE);
  }, [connections, caches]);

  const refresh = useCallback(async () => {
    if (!isAuthenticated) return;
    const started = generation.current;
    const requestId = ++refreshRequest.current;
    const isLatest = () => started === generation.current && requestId === refreshRequest.current;
    dispatchIfCurrent({ type: 'loading' }, started);
    try {
      const [connections, blocks, chats] = await Promise.all([
        request('/me/connections', { revalidate: true }),
        request('/me/blocks', { revalidate: true }),
        request('/chats', { revalidate: true }),
      ]);
      if (!isLatest()) return;
      dispatchIfCurrent({ type: 'loaded', connections: connections.items, blocks: blocks.items, chats: chats.items }, started);
      if (!isLatest()) return;
      syncChats(chats.items, started);
      // The chat on screen catches up on what it missed while offline
      const open = openChat.current;
      if (open) {
        const page = await request(`/chats/${encodeURIComponent(open)}/messages?limit=50`);
        if (!isLatest()) return;
        await fillGap(open, page, started);
        if (!isLatest()) return;
        dispatchIfCurrent({ type: 'messages', id: open, items: page.items, nextCursor: page.nextCursor }, started);
      }
    } catch {
      if (isLatest()) dispatchIfCurrent({ type: 'failed' }, started);
    }
  }, [request, isAuthenticated, dispatchIfCurrent, fillGap, syncChats]);


  const lastAutoRefresh = useRef(0);
  const autoRefresh = useCallback(() => {
    if (Date.now() - lastAutoRefresh.current < AUTO_REFRESH_GAP_MS) return;
    lastAutoRefresh.current = Date.now();
    refresh();
  }, [refresh]);

  // At sign-in, and at every (re)connection of the socket: what changed meanwhile
  useEffect(() => {
    if (isAuthenticated && meId) refresh();
  }, [isAuthenticated, meId, refresh]);
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
      if (stateRef.current.status === 'idle' || stateRef.current.status === 'loading') {
        refreshAfterInitialLoad.current = true;
      } else {
        autoRefresh();
      }
      return;
    }
    if (!refreshAfterInitialLoad.current) return;
    if (stateRef.current.status === 'error') {
      refreshAfterInitialLoad.current = false;
      autoRefresh();
    } else if (stateRef.current.status === 'ready') {
      refreshAfterInitialLoad.current = false;
    }
  }, [socketStatus, isAuthenticated, state.status, autoRefresh]);

  const loadChat = useCallback(async (id) => {
    if (!isAuthenticated) return null;
    const started = generation.current;
    const chat = await request(`/chats/${encodeURIComponent(id)}`);
    dispatchIfCurrent({ type: 'detail', chat }, started);
    return chat;
  }, [request, isAuthenticated, dispatchIfCurrent]);

  useRealtimeEvent('message', useCallback(async ({ message, author }) => {
    if (!isAuthenticated || !message?.chatId) return;
    const started = generation.current;
    if (author) dispatchIfCurrent({ type: 'people', people: [author] }, started);
    if (!stateRef.current.chats[message.chatId]) {
      // A chat the app did not know yet (someone wrote first)
      try {
        const chat = await request(`/chats/${encodeURIComponent(message.chatId)}`);
        dispatchIfCurrent({ type: 'chat', chat }, started);
      } catch {
        return;
      }
    }
    dispatchIfCurrent({ type: 'message', message, me: meId, open: openChat.current }, started);
  }, [request, meId, isAuthenticated, dispatchIfCurrent]));
  useRealtimeEvent('chat', useCallback(({ chat }) => chat && dispatchIfCurrent({ type: 'chat', chat, open: openChat.current }), [dispatchIfCurrent]));
  useRealtimeEvent('chat.read', useCallback(({ chatId, unread }) => chatId && dispatchIfCurrent({ type: 'chatRead', id: chatId, unread: unread ?? 0, open: openChat.current }), [dispatchIfCurrent]));
  useRealtimeEvent('message.updated', useCallback(({ message }) => message?.chatId && dispatchIfCurrent({ type: 'messageUpdated', message }), [dispatchIfCurrent]));
  useRealtimeEvent('chat.removed', useCallback(({ chatId }) => dispatchIfCurrent({ type: 'chatRemoved', id: chatId }), [dispatchIfCurrent]));
  useRealtimeEvent('connection.created', useCallback(({ connection }) => connection && dispatchIfCurrent({ type: 'connection', connection }), [dispatchIfCurrent]));
  useRealtimeEvent('connection.removed', useCallback(({ userId }) => userId && dispatchIfCurrent({ type: 'disconnected', id: userId }), [dispatchIfCurrent]));

  // --- messages ---

  const loadMessages = useCallback(async (id, { older = false } = {}) => {
    if (!isAuthenticated) return;
    const started = generation.current;
    // Opening a chat: what the phone has shows at once
    if (!older && !stateRef.current.messages[id] && store) {
      const cached = await store.readJson(messagesKey(id)).catch(() => null);
      if (cached?.items?.length) dispatchIfCurrent({ type: 'messagesCached', id, items: cached.items, nextCursor: cached.nextCursor }, started);
    }
    const current = stateRef.current.messages[id];
    if (current?.status === 'loading' || (older && !current?.nextCursor)) return;
    dispatchIfCurrent({ type: 'messagesLoading', id }, started);
    const path = `/chats/${encodeURIComponent(id)}/messages`;
    const query = new URLSearchParams({ limit: '50', ...(older ? { before: current.nextCursor } : {}) });
    try {
      const page = await request(`${path}?${query}`);
      if (!older) await fillGap(id, page, started);
      dispatchIfCurrent({ type: 'messages', id, items: page.items, nextCursor: page.nextCursor, older }, started);
    } catch {
      dispatchIfCurrent({ type: 'messagesFailed', id }, started);
    }
  }, [request, isAuthenticated, dispatchIfCurrent, store, fillGap]);

  // One message to the server: true when it is settled (stored, or refused: then it
  // shows as not sent), false when there is no connection (it waits in the outbox)
  const deliver = useCallback(async (message, started) => {
    try {
      const saved = await request(`/chats/${encodeURIComponent(message.chatId)}/messages`, { method: 'POST', body: JSON.stringify({ text: message.text, clientId: message.clientId }) });
      dispatchIfCurrent({ type: 'message', message: saved, me: meId, open: message.chatId }, started);
      dispatchIfCurrent({ type: 'outboxRemove', clientId: message.clientId }, started);
      return true;
    } catch (error) {
      const later = error?.status === 0 || error?.status === 429 || error?.status >= 500;
      if (later) {
        dispatchIfCurrent({ type: 'outboxAdd', message }, started);
        return false;
      }
      dispatchIfCurrent({ type: 'outboxRemove', clientId: message.clientId }, started);
      dispatchIfCurrent({ type: 'messageFailed', chatId: message.chatId, clientId: message.clientId }, started);
      return true;
    }
  }, [request, meId, dispatchIfCurrent]);

  // The outbox, in order, as soon as there is a connection (it stops at the first that
  // cannot go yet)
  const flushing = useRef(false);
  const flushOutbox = useCallback(async () => {
    if (!isAuthenticated || flushing.current) return;
    flushing.current = true;
    const started = generation.current;
    try {
      for (const message of [...stateRef.current.outbox]) {
        if (started !== generation.current || !(await deliver(message, started))) break;
      }
    } finally {
      flushing.current = false;
    }
  }, [isAuthenticated, deliver]);

  // Shown at once while it goes; the server answers the stored message (the same one
  // if this is sent twice: clientId). Without a connection it waits in the outbox
  // (behind the ones already waiting, so they keep their order); a refused one is sent
  // again with its own clientId.
  // One at a time, in the order they were written: two requests at once on a bad network
  // could reach the server, and so everyone's screen, the other way round.
  const sending = useRef(Promise.resolve());
  const holding = useRef(false); // one could not go: the next ones wait behind it
  const send = useCallback((chatId, text, retryOf = null) => {
    if (!isAuthenticated) return Promise.resolve();
    const started = generation.current;
    const clientId = retryOf?.clientId ?? `c${Date.now().toString(36)}${(clientCounter++).toString(36)}`;
    const message = { id: clientId, clientId, chatId, from: meId, text, at: retryOf?.at ?? Date.now(), pending: true };
    dispatchIfCurrent({ type: 'message', me: meId, open: chatId, message }, started);
    sending.current = sending.current.then(async () => {
      if (started !== generation.current) return;
      if (holding.current || stateRef.current.outbox.length) {
        dispatchIfCurrent({ type: 'outboxAdd', message }, started);
        flushOutbox();
        return;
      }
      if (!(await deliver(message, started))) holding.current = true;
    });
    return sending.current;
  }, [meId, isAuthenticated, dispatchIfCurrent, deliver, flushOutbox]);
  const outboxEmpty = state.outbox.length === 0;
  useEffect(() => {
    if (outboxEmpty) holding.current = false;
  }, [outboxEmpty]);

  // Back online (or the socket open again): what changed meanwhile, and the outbox
  useNetworkRecovery(useCallback(() => {
    autoRefresh();
    flushOutbox();
  }, [autoRefresh, flushOutbox]));
  const hasOutbox = state.outbox.length > 0;
  useEffect(() => {
    if (!hasOutbox) return undefined;
    if (socketStatus === 'open') flushOutbox();
    const timer = setInterval(flushOutbox, OUTBOX_RETRY_MS);
    return () => clearInterval(timer);
  }, [socketStatus, hasOutbox, flushOutbox]);

  const readTimers = useRef(new Map());
  const markRead = useCallback((chatId) => {
    if (!isAuthenticated) return;
    const started = generation.current;
    const chat = stateRef.current.chats[chatId];
    const last = stateRef.current.messages[chatId]?.items.filter((message) => !message.pending && !message.failed).at(-1) ?? chat?.last;
    dispatchIfCurrent({ type: 'read', id: chatId }, started);
    if (!last?.id || last.pending) return;
    clearTimeout(readTimers.current.get(chatId));
    readTimers.current.set(chatId, setTimeout(() => {
      readTimers.current.delete(chatId);
      if (started !== generation.current) return;
      request(`/chats/${encodeURIComponent(chatId)}/read`, { method: 'POST', body: JSON.stringify({ messageId: last.id }) }).catch(() => {});
    }, READ_DELAY_MS));
  }, [request, isAuthenticated, dispatchIfCurrent]);

  const setOpenChat = useCallback((chatId, closingId) => {
    if (chatId) openChat.current = chatId;
    else if (!closingId || openChat.current === closingId) openChat.current = null;
  }, []);

  // --- chats ---

  // The direct chat with someone (made when first opened; only with a connection or
  // someone nearby): its ID
  const openDirect = useCallback(async (userId) => {
    if (!isAuthenticated) return null;
    const started = generation.current;
    const existing = Object.values(stateRef.current.chats).find((chat) => chat.kind === 'direct' && chat.with?.id === userId);
    if (existing) return existing.id;
    const chat = await request('/chats/direct', { method: 'POST', body: JSON.stringify({ userId }) });
    dispatchIfCurrent({ type: 'chat', chat }, started);
    return chat.id;
  }, [request, isAuthenticated, dispatchIfCurrent]);

  const createGroup = useCallback(async (title, memberIds, color) => {
    if (!isAuthenticated) return null;
    const started = generation.current;
    const chat = await request('/chats', { method: 'POST', body: JSON.stringify({ title, memberIds, color }) });
    dispatchIfCurrent({ type: 'detail', chat }, started);
    return chat.id;
  }, [request, isAuthenticated, dispatchIfCurrent]);

  // The owner and admins: add their own connections, rename
  const addMembers = useCallback(async (chatId, userIds) => {
    if (!isAuthenticated) return;
    const started = generation.current;
    const chat = await request(`/chats/${encodeURIComponent(chatId)}/members`, { method: 'POST', body: JSON.stringify({ userIds }) });
    dispatchIfCurrent({ type: 'detail', chat }, started);
  }, [request, isAuthenticated, dispatchIfCurrent]);

  const renameGroup = useCallback(async (chatId, fields) => {
    if (!isAuthenticated) return;
    const started = generation.current;
    const chat = await request(`/chats/${encodeURIComponent(chatId)}`, { method: 'PATCH', body: JSON.stringify(fields) });
    dispatchIfCurrent({ type: 'detail', chat }, started);
  }, [request, isAuthenticated, dispatchIfCurrent]);

  // The group's picture (its owner and admins): a file picked on the phone, or null to
  // take it away. Everyone in the group hears of it (`chat`)
  const setGroupPicture = useCallback(async (chatId, uri) => {
    if (!isAuthenticated) return;
    const started = generation.current;
    const path = `/chats/${encodeURIComponent(chatId)}/picture`;
    let chat;
    if (uri) {
      const uploadId = await uploadFile(request, { purpose: 'group-picture', chatId, uri });
      chat = await request(path, { method: 'PUT', body: JSON.stringify({ uploadId }) });
      discardPickedFile(uri);
    } else {
      chat = await request(path, { method: 'DELETE' });
    }
    dispatchIfCurrent({ type: 'detail', chat }, started);
  }, [request, isAuthenticated, dispatchIfCurrent]);

  // Leaving a group or an event chat (which leaves the event)
  const leave = useCallback(async (chatId) => {
    if (!isAuthenticated) return;
    const started = generation.current;
    await request(`/chats/${encodeURIComponent(chatId)}/members/me`, { method: 'DELETE' });
    dispatchIfCurrent({ type: 'chatRemoved', id: chatId }, started);
  }, [request, isAuthenticated, dispatchIfCurrent]);

  // A group gone for everyone (only its owner)
  const deleteGroup = useCallback(async (chatId) => {
    if (!isAuthenticated) return;
    const started = generation.current;
    await request(`/chats/${encodeURIComponent(chatId)}`, { method: 'DELETE' });
    dispatchIfCurrent({ type: 'chatRemoved', id: chatId }, started);
  }, [request, isAuthenticated, dispatchIfCurrent]);

  // Moderation (the owner and the admins; API.md): each answers the chat's details
  const moderate = useCallback(async (chatId, path, options) => {
    if (!isAuthenticated) return;
    const started = generation.current;
    const chat = await request(`/chats/${encodeURIComponent(chatId)}${path}`, options);
    dispatchIfCurrent({ type: 'detail', chat }, started);
  }, [request, isAuthenticated, dispatchIfCurrent]);
  const setRole = useCallback((chatId, userId, role) => moderate(chatId, `${member(userId)}/role`, { method: 'PUT', body: JSON.stringify({ role }) }), [moderate]);
  // minutes: 60, 480, 10080, or null (until unmuted)
  const mute = useCallback((chatId, userId, minutes) => moderate(chatId, `${member(userId)}/mute`, { method: 'PUT', body: JSON.stringify({ minutes }) }), [moderate]);
  const unmute = useCallback((chatId, userId) => moderate(chatId, `${member(userId)}/mute`, { method: 'DELETE' }), [moderate]);
  const setReadOnly = useCallback((chatId, readOnly) => moderate(chatId, '', { method: 'PATCH', body: JSON.stringify({ readOnly }) }), [moderate]);
  const pin = useCallback((chatId, messageId) => moderate(chatId, `/pins/${encodeURIComponent(messageId)}`, { method: 'PUT' }), [moderate]);
  const unpin = useCallback((chatId, messageId) => moderate(chatId, `/pins/${encodeURIComponent(messageId)}`, { method: 'DELETE' }), [moderate]);
  const removeMember = useCallback(async (chatId, userId) => {
    if (!isAuthenticated) return;
    await request(`/chats/${encodeURIComponent(chatId)}${member(userId)}`, { method: 'DELETE' });
    await loadChat(chatId);
  }, [request, isAuthenticated, loadChat]);

  // Polls: made by the owner and the admins, voted by every member not muted
  const createPoll = useCallback(async (chatId, poll) => {
    if (!isAuthenticated) return;
    const started = generation.current;
    const message = await request(`/chats/${encodeURIComponent(chatId)}/polls`, { method: 'POST', body: JSON.stringify(poll) });
    dispatchIfCurrent({ type: 'message', message, me: meId, open: chatId }, started);
  }, [request, meId, isAuthenticated, dispatchIfCurrent]);
  // A message taken back (their own) or removed (who runs the chat): its text goes for everyone
  const deleteMessage = useCallback(async (chatId, messageId) => {
    if (!isAuthenticated) return;
    const started = generation.current;
    const message = await request(`/chats/${encodeURIComponent(chatId)}/messages/${encodeURIComponent(messageId)}`, { method: 'DELETE' });
    dispatchIfCurrent({ type: 'messageUpdated', message }, started);
  }, [request, isAuthenticated, dispatchIfCurrent]);
  const pollAction = useCallback(async (chatId, messageId, action, body) => {
    if (!isAuthenticated) return;
    const started = generation.current;
    const message = await request(`/chats/${encodeURIComponent(chatId)}/polls/${encodeURIComponent(messageId)}/${action}`, { method: 'POST', body: body ? JSON.stringify(body) : undefined });
    dispatchIfCurrent({ type: 'messageUpdated', message }, started);
  }, [request, isAuthenticated, dispatchIfCurrent]);
  const vote = useCallback((chatId, messageId, optionIds) => pollAction(chatId, messageId, 'votes', { optionIds }), [pollAction]);
  const closePoll = useCallback((chatId, messageId) => pollAction(chatId, messageId, 'close'), [pollAction]);

  // --- people ---

  // A connection just made in person (the scanning phone's answer; the other phone
  // hears it over the socket)
  const addConnection = useCallback((connection) => dispatchIfCurrent({ type: 'connection', connection }), [dispatchIfCurrent]);

  // No more messages until they connect again in person; they leave the user's groups
  const disconnect = useCallback(async (userId) => {
    if (!isAuthenticated) return;
    const started = generation.current;
    await request(`/me/connections/${encodeURIComponent(userId)}`, { method: 'DELETE' });
    dispatchIfCurrent({ type: 'disconnected', id: userId }, started);
    if (started === generation.current) refresh();
  }, [request, refresh, isAuthenticated, dispatchIfCurrent]);

  const block = useCallback(async (userId) => {
    if (!isAuthenticated) return;
    const started = generation.current;
    await request(`/me/blocks/${encodeURIComponent(userId)}`, { method: 'PUT' });
    if (started !== generation.current) return;
    await refresh();
  }, [request, refresh, isAuthenticated]);

  const unblock = useCallback(async (userId) => {
    if (!isAuthenticated) return;
    const started = generation.current;
    await request(`/me/blocks/${encodeURIComponent(userId)}`, { method: 'DELETE' });
    if (started !== generation.current) return;
    await refresh();
  }, [request, refresh, isAuthenticated]);

  // Reasons: model/reportReasons.js
  const reportUser = useCallback((userId, reason, details) => request('/reports', {
    method: 'POST',
    body: JSON.stringify({ kind: 'user', targetId: userId, reasons: [reason], details: details || undefined }),
  }), [request]);

  const reportMessage = useCallback((messageId, reason) => request('/reports', {
    method: 'POST',
    body: JSON.stringify({ kind: 'message', targetId: messageId, reasons: [reason] }),
  }), [request]);
  const reportGroup = useCallback((chatId, reason) => request('/reports', {
    method: 'POST',
    body: JSON.stringify({ kind: 'group', targetId: chatId, reasons: [reason] }),
  }), [request]);

  const rememberPeople = useCallback((people) => dispatchIfCurrent({ type: 'people', people }), [dispatchIfCurrent]);

  // People nearby right now: who the map shows (the presence), when the user is visible
  const around = useNearbyPeople();

  const connectedIds = useMemo(() => new Set(state.connections.map((entry) => entry.user.id)), [state.connections]);
  const blockedIds = useMemo(() => new Set(state.blocks.map((entry) => entry.user.id)), [state.blocks]);
  const nearbyIds = useMemo(() => new Set(around.map((person) => person.userId)), [around]);
  const chats = useMemo(() => Object.values(state.chats).sort((a, b) => (b.last?.at ?? 0) - (a.last?.at ?? 0)), [state.chats]);

  const value = useMemo(() => ({
    status: state.status,
    me: meId,
    people: state.people,
    connections: state.connections,
    blocks: state.blocks,
    nearby: around,
    chats,
    details: state.details,
    messages: state.messages,
    unreadTotal: chats.reduce((sum, chat) => sum + (chat.unread ?? 0), 0),
    isConnection: (userId) => connectedIds.has(userId),
    isNearby: (userId) => nearbyIds.has(userId),
    isBlocked: (userId) => blockedIds.has(userId),
    // What the screens offer; the server has the last word (a past disconnection)
    canMessage: (userId) => !!userId && userId !== meId && !blockedIds.has(userId) && (connectedIds.has(userId) || nearbyIds.has(userId)),
    refresh,
    loadChat,
    loadMessages,
    send,
    markRead,
    setOpenChat,
    openDirect,
    createGroup,
    addMembers,
    renameGroup,
    setGroupPicture,
    leave,
    deleteGroup,
    setRole,
    mute,
    unmute,
    removeMember,
    setReadOnly,
    pin,
    unpin,
    createPoll,
    vote,
    closePoll,
    deleteMessage,
    addConnection,
    disconnect,
    block,
    unblock,
    reportUser,
    reportMessage,
    reportGroup,
    rememberPeople,
  }), [state.status, state.people, state.connections, state.blocks, state.details, state.messages, meId, around, chats, connectedIds, blockedIds, nearbyIds, refresh, loadChat, loadMessages, send, markRead, setOpenChat, openDirect, createGroup, addMembers, renameGroup, setGroupPicture, leave, deleteGroup, setRole, mute, unmute, removeMember, setReadOnly, pin, unpin, createPoll, vote, closePoll, deleteMessage, addConnection, disconnect, block, unblock, reportUser, reportMessage, reportGroup, rememberPeople]);

  return <SocialContext.Provider value={value}>{children}</SocialContext.Provider>;
}

export function useSocial() {
  const context = use(SocialContext);
  if (!context) throw new Error('useSocial must be used inside <SocialProvider>');
  return context;
}

// One chat (its summary, and its members once loaded)
export function useChat(id) {
  const { chats, details } = useSocial();
  return useMemo(() => {
    const chat = chats.find((entry) => entry.id === id);
    return chat ? { ...chat, members: details[id] ?? null } : null;
  }, [chats, details, id]);
}

// The messages of a chat on screen: loaded when it opens (and its members, for the
// names in groups and event chats), read as they arrive, older pages on demand
export function useChatMessages(id) {
  const { messages, loadMessages, loadChat, setOpenChat, markRead, chats } = useSocial();
  const kind = chats.find((chat) => chat.id === id)?.kind;
  useFocusEffect(useCallback(() => {
    if (!id) return undefined;
    setOpenChat(id);
    loadMessages(id);
    return () => setOpenChat(null, id);
  }, [id, loadMessages, setOpenChat]));
  useEffect(() => {
    if (id && kind && kind !== 'direct') loadChat(id).catch(() => {});
  }, [id, kind, loadChat]);
  const entry = messages[id];
  const lastId = entry?.items.at(-1)?.id;
  useFocusEffect(useCallback(() => {
    if (id && lastId) markRead(id);
  }, [id, lastId, markRead]));
  return {
    items: entry?.items ?? [],
    status: entry?.status ?? 'loading',
    hasMore: !!entry?.nextCursor,
    loadOlder: () => loadMessages(id, { older: true }),
    retry: () => loadMessages(id),
  };
}
