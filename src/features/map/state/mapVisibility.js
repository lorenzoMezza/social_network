// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useSyncExternalStore } from 'react';
import { loadSettings, updateSetting } from '../../settings/settingsStore';

// How the user is on the map right now, one of three modes (rules in mapPresence.js):
//  - visible: people visible to you see where you are; you see them
//  - approximate: only your area is shown (APPROXIMATE_RADIUS_M), and you see areas
//  - invisible: no one sees you, and you see no one
// Invisible by default: each time the app opens, unless the setting "Invisible when
// the app opens" is off (then the last mode chosen). The server hears it with every
// presence frame (nearbyPeople.js usePresenceSync).
const MAP_MODES = ['visible', 'approximate', 'invisible'];

let mode = null;
const listeners = new Set();
const publish = (value) => {
  mode = value;
  for (const listener of listeners) listener();
};
loadSettings().then((settings) => {
  if (mode !== null) return;
  const last = MAP_MODES.includes(settings.mapLastMode) ? settings.mapLastMode : 'invisible';
  publish(settings.mapStartInvisible === false ? last : 'invisible');
});

const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
const snapshot = () => mode ?? 'invisible';

// Signing out: how this person chose to be on the map, and that they read what it means, goes
// with them. Whoever signs in next starts invisible and is asked: showing themselves is their
// own consent, never one left on the phone by someone else
export function forgetMapChoices() {
  publish('invisible');
  updateSetting('mapLastMode', 'invisible').catch(() => {});
  updateSetting('mapStartInvisible', true).catch(() => {});
  updateSetting('mapModeExplained', false).catch(() => {});
}

export function useMapMode() {
  const value = useSyncExternalStore(subscribe, snapshot);
  const setMode = useCallback((next) => {
    if (!MAP_MODES.includes(next)) return;
    publish(next);
    updateSetting('mapLastMode', next).catch(() => {});
  }, []);
  return [value, setMode];
}
