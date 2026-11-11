// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useEffect, useRef } from 'react';

// Messages are the chats' (SocialProvider, from the socket): nothing about them goes
// through the map's own frames. The map only listens: a new message in a direct chat
// with someone on the map shows over the head of who wrote it, the user's own over
// the player's, for a few seconds.
const FRESH_MS = 20000;

export function useMapBubbles(mapRef, people, chats) {
  // chat id → id of the last message already seen (shown or too old)
  const seen = useRef(new Map());

  useEffect(() => {
    const onMap = new Set(people.map((person) => person.userId));
    for (const chat of chats) {
      if (chat.kind !== 'direct' || !onMap.has(chat.with?.id)) continue;
      const last = chat.last;
      if (!last || seen.current.get(chat.id) === last.id) continue;
      seen.current.set(chat.id, last.id);
      // Only what was just said: older messages are old news
      if (last.system || Date.now() - last.at > FRESH_MS) continue;
      mapRef.current?.showBubble({ from: last.from === chat.with.id ? chat.with.id : 'me', text: last.text });
    }
  }, [people, chats, mapRef]);
}
