// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { NativeModules } from 'react-native';
import Constants from 'expo-constants';

// The computer running Expo in development, where the local servers live (API, map
// tiles, avatars): from the Expo manifest, or else from the bundle URL (a plain
// development build launched without the Expo CLI has no manifest host). Release
// builds get explicit endpoint URLs at build time instead.
function findDevHost() {
  if (!__DEV__) return null;
  const fromManifest = Constants.expoConfig?.hostUri?.split(':')[0];
  if (fromManifest) return fromManifest;
  const scriptURL = NativeModules.SourceCode?.getConstants?.().scriptURL ?? NativeModules.SourceCode?.scriptURL;
  return /^https?:\/\/([^/:]+)/.exec(scriptURL ?? '')?.[1] ?? null;
}

export const devHost = findDevHost();
