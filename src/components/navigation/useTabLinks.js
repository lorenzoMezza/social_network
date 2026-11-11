// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useMemo } from 'react';
import { useSegments } from 'expo-router';

// Tabs with their own copy of the event and profile pages (app/(tabs)/<tab>/event,
// app/(tabs)/<tab>/user, app/(tabs)/<tab>/organized, app/(tabs)/<tab>/people): what is opened from inside
// one stays in it, under the same tab bar, and Back returns where the user was
const TABS_WITH_PAGES = new Set(['events', 'profile']);

// Links to events and profiles in the current tab; outside those tabs (the map, a
// chat) the pages open over everything, and Back returns there
export function useTabLinks() {
  const segments = useSegments();
  const tab = segments[0] === '(tabs)' && TABS_WITH_PAGES.has(segments[1]) ? segments[1] : null;
  const base = tab ? `/${tab}` : '';
  const event = useCallback((id) => ({ pathname: `${base}/event/[id]`, params: { id } }), [base]);
  const user = useCallback(
    (id, { name, username } = {}) => ({ pathname: `${base}/user/[id]`, params: { id, ...(name ? { name } : {}), ...(username ? { username } : {}) } }),
    [base],
  );
  // The events a user organized (the Events tile of a profile)
  const organized = useCallback((id, { name } = {}) => ({ pathname: `${base}/organized/[id]`, params: { id, ...(name ? { name } : {}) } }), [base]);
  // Someone's connections (the Connections tile of their profile)
  const people = useCallback((id, { name } = {}) => ({ pathname: `${base}/people/[id]`, params: { id, ...(name ? { name } : {}) } }), [base]);
  // The same object while the tab is the same: handlers built on it stay stable
  return useMemo(() => ({ tab, event, user, organized, people }), [tab, event, user, organized, people]);
}
