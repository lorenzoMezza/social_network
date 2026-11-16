// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// How much the app may keep on the phone, in one place: the map's and the avatars'
// pages (IndexedDB, shared/httpCache.js) and the app itself (files, src/lib/offline/)
// read their limits here. About 1 GB in all at most; in practice far less (each
// cache only holds what was really seen). Every cache drops what matters least
// first: within a priority, what was used longest ago.
const MB = 1024 * 1024;

export const CACHE_BUDGETS = {
  // Map tiles around where the user has been (map page)
  tiles: 40 * MB,
  // People, 350 MB in all: the avatar files of the avatars shown (avatar and map pages:
  // item models, textures, map avatars) …
  avatarFiles: 250 * MB,
  // … and their profiles, avatar documents and pictures (app). The user's own come
  // first, then their connections, then the people seen recently
  people: 100 * MB,
  // Events: the user's own and saved ones first, then those seen nearby; their
  // details and pictures (not the albums' photos)
  events: 350 * MB,
  // Chats, text only: the inbox, every chat's messages, polls, members, so the Social
  // tab can be rebuilt without a connection (250 MB is some hundreds of thousands of
  // messages)
  chats: 250 * MB,
};
