// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Gestures one can make to someone on the map: an emote of the avatar catalog (the
// profile's greetings), played by the sender's avatar turned towards them and seen by
// both, with its emoji over the head. Sent over the socket (a `gesture` frame, docs/API.md).
export const MAP_GESTURES = [
  { id: 'wave', emoji: '👋', label: 'Wave' },
  { id: 'handsair', emoji: '🙌', label: 'Cheer' },
  { id: 'fistpump', emoji: '💪', label: 'Yes!' },
  { id: 'dab', emoji: '🕺', label: 'Dab' },
];

export const gestureInfo = (id) => MAP_GESTURES.find((gesture) => gesture.id === id) ?? null;
