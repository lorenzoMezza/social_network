// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import Constants from 'expo-constants';

// Which app is asking (docs/API.md, Conventions): every request says so, and a version
// the server no longer serves answers 426. The app then asks to update, whatever screen it
// is on: nothing else it could do would work.
export const CLIENT = `${Constants.expoConfig?.version ?? '0'} (${Platform.OS})`;

let required = false;
const listeners = new Set();

export function markUpdateRequired() {
  if (required) return;
  required = true;
  for (const listener of listeners) listener();
}

export const useUpdateRequired = () => useSyncExternalStore((listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
}, () => required);
