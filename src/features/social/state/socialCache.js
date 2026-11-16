// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { PRIORITY } from '../../../lib/offline/diskCache';

// How the chats are kept on the phone (lib/offline, the `chats` cache), so the Social
// tab and every chat open at once and without a connection:
//   inbox            connections, blocks, the chats with their members, the people
//                    they mention (the user's own: kept last)
//   messages:<chat>  a chat's messages, the newest MAX_STORED_MESSAGES (older ones are
//                    asked for again when scrolled to)
//   outbox           messages written without a connection, sent when it is back
// Pure functions: SocialProvider reads and writes the cache.

export const INBOX_KEY = 'inbox';
export const OUTBOX_KEY = 'outbox';
export const messagesKey = (chatId) => `messages:${chatId}`;

const MAX_STORED_MESSAGES = 3000;
// A chat written in within this long is close to the user: kept after the others
const ACTIVE_MS = 30 * 24 * 3600 * 1000;

export const inboxOf = (state) => ({
  people: state.people,
  connections: state.connections,
  blocks: state.blocks,
  chats: state.chats,
  details: state.details,
});

// A chat's messages as stored: only those the server has (not the ones still being
// sent, kept in the outbox), the newest ones, and the cursor to the ones before them
export function storedMessages(entry) {
  const confirmed = entry.items.filter((message) => !message.pending && !message.failed);
  const start = Math.max(0, confirmed.length - MAX_STORED_MESSAGES);
  return {
    items: confirmed.slice(start),
    nextCursor: start > 0 ? confirmed[start].id : entry.nextCursor,
  };
}

export const chatPriority = (chat, now = Date.now()) => (
  chat?.last && now - chat.last.at < ACTIVE_MS ? PRIORITY.CLOSE : PRIORITY.RECENT
);

// A chat's newest page from the server (old → new, `pageCursor`: before its first
// message, or null when it is the whole chat) over what the phone has: the page wins
// for the messages it holds (a poll's votes), what arrived after it and the user's own
// messages still being sent stay, and so do the older ones when the page reaches them.
// When it does not (more was written meanwhile than one page) the older ones would
// leave a hole: `gap` is then true and only the page is kept, unless the caller fills
// the hole first (SocialProvider, `after`).
export function mergeNewestPage(existing, pageItems, pageCursor) {
  const current = existing?.items ?? [];
  if (!current.length) return { items: pageItems, nextCursor: pageCursor, gap: false };
  const pageIds = new Set(pageItems.map((message) => message.id));
  const lastAt = pageItems.at(-1)?.at ?? -Infinity;
  const firstAt = pageItems[0]?.at ?? Infinity;
  const confirmed = current.filter((message) => !message.pending && !message.failed);
  const newer = current.filter((message) => !pageIds.has(message.id) && (message.pending || message.failed || message.at > lastAt));
  // The whole chat came: anything older the phone had is gone from it (a block)
  if (pageCursor === null) return { items: [...pageItems, ...newer], nextCursor: null, gap: false };
  const reaches = !pageItems.length || confirmed.some((message) => pageIds.has(message.id));
  if (!reaches) return { items: [...pageItems, ...newer], nextCursor: pageCursor, gap: confirmed.length > 0 };
  const older = confirmed.filter((message) => !pageIds.has(message.id) && message.at < firstAt);
  return {
    items: [...older, ...pageItems, ...newer],
    nextCursor: older.length ? existing.nextCursor : pageCursor,
    gap: false,
  };
}
