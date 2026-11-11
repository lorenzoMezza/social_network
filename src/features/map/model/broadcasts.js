// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Words said to everyone around on the map (the user taps their own avatar): shown
// over the head of who said them, on the map of everyone who can see them right now.
// Never kept: they are moments, like gestures. Sent over the socket (a `broadcast`
// frame, docs/API.md); the server applies these limits too.
export const BROADCAST_MAX_LENGTH = 120;
// One message every this long (no flooding everyone's map)
export const BROADCAST_COOLDOWN_MS = 10 * 1000;
