// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useEffect, useState } from 'react';
import { Appearance } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

// This phone's preferences, kept on the device: theme and how the map starts. The
// account's settings (notifications) are the server's (Me.settings, MeProvider).
export const DEFAULT_SETTINGS = {
  theme: 'system', // 'system' | 'light' | 'dark'
  // The map's visibility (features/map/state/mapVisibility.js): invisible each time
  // the app opens, unless switched off; then the last mode chosen
  mapStartInvisible: true,
  mapLastMode: 'invisible', // 'invisible' | 'approximate' | 'visible'
  // The user said "don't show again" to the explanation shown when becoming visible
  mapModeExplained: false,
};

const KEY = 'settings:v1';
let current = { ...DEFAULT_SETTINGS };
let loaded = null;
const listeners = new Set();

// The settings as they are now: read once, then always the latest (never the ones
// read at startup, which a page opened later would show over the user's last choice)
export function loadSettings() {
  loaded ??= AsyncStorage.getItem(KEY)
    .then((stored) => {
      current = { ...DEFAULT_SETTINGS, ...(stored ? JSON.parse(stored) : {}) };
      applyTheme(current.theme);
      for (const listener of listeners) listener(current);
    })
    .catch(() => {});
  return loaded.then(() => current);
}

// 'system' follows the phone; otherwise the whole app (useColorScheme) is forced
function applyTheme(theme) {
  Appearance.setColorScheme(theme === 'light' || theme === 'dark' ? theme : 'unspecified');
}

// Shown at once; written after the saved settings were read, so that a change made
// while they load never overwrites the others (the theme) with their defaults
export async function updateSetting(key, value) {
  current = { ...current, [key]: value };
  if (key === 'theme') applyTheme(value);
  for (const listener of listeners) listener(current);
  await loadSettings();
  current = { ...current, [key]: value };
  if (key === 'theme') applyTheme(value);
  for (const listener of listeners) listener(current);
  await AsyncStorage.setItem(KEY, JSON.stringify(current));
}

export function useSettings() {
  const [settings, setSettings] = useState(current);
  useEffect(() => {
    listeners.add(setSettings);
    loadSettings().then(setSettings);
    return () => listeners.delete(setSettings);
  }, []);
  const set = useCallback((key, value) => updateSetting(key, value), []);
  return [settings, set];
}
