// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { PRIORITY } from '../../../lib/offline/diskCache';

// How the events are kept on the phone (lib/offline, the `events` cache), so the map
// and the Events tab show them at once and without a connection:
//   lists        the nearby, saved and own lists, with the summaries of their events
//   event:<id>   an event's details (who is going, ratings), once opened
// The user's own and saved events are kept last, the others as they were seen.
// Pure functions: EventsProvider reads and writes the cache.

export const LISTS_KEY = 'lists';
export const eventKey = (id) => `event:${id}`;
export const LIST_NAMES = ['nearby', 'followed', 'created'];

// An event without what only its page shows (a list needs none of it)
const summaryOf = ({ followers, ratings, myRating, ratingCount, ratingAverage, album, ...summary }) => summary;

export function listsOf(state) {
  const ids = new Set(LIST_NAMES.flatMap((name) => state[name].ids));
  return {
    ...Object.fromEntries(LIST_NAMES.map((name) => [name, state[name].ids])),
    events: [...ids].map((id) => state.byId[id]).filter(Boolean).map(summaryOf),
  };
}

export const eventPriority = (state, id) => (
  state.followed.ids.includes(id) || state.created.ids.includes(id) ? PRIORITY.OWN : PRIORITY.RECENT
);
