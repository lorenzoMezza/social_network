// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useSyncExternalStore } from 'react';

// What the map shows on request: the place of an event being created there (a long
// press: a beacon marks it while the sheet is open) and the event in view (`focus`:
// tapped on the map, or the flash event just created), whose card is open while the
// camera looks at it.
let state = { draft: null, focus: null };
const listeners = new Set();
const publish = (changes) => {
  state = { ...state, ...changes };
  for (const listener of listeners) listener();
};
const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

// { latitude, longitude } or null
export const setMapDraft = (draft) => publish({ draft });
// An event ID, or null for none
export const requestMapFocus = (focus) => publish({ focus });

export const useMapRequests = () => useSyncExternalStore(subscribe, () => state);
