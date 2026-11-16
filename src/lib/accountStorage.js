// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { responseCache } from '../features/api/responseCache';
import { forgetOfflineData } from './offline/offlineStore';

// What the app keeps on the phone about the signed-in account (to show it at once at
// the next start): forgotten when they sign out, so the next person using the phone
// sees nothing of it, with everything kept to work offline (lib/offline: chats,
// events, profiles), and the last weather (it says where they were). Settings (theme, map),
// the avatar catalog and the map's tiles and avatar files stay: they are the phone's, not
// the account's.
const ACCOUNT_PREFIXES = ['me:v1:', 'avatar:own:', 'avatar:poster:own:', 'map-weather:'];

export async function forgetAccountData() {
  responseCache.clear();
  await forgetOfflineData().catch(() => {});
  try {
    const keys = await AsyncStorage.getAllKeys();
    const mine = keys.filter((key) => ACCOUNT_PREFIXES.some((prefix) => key.startsWith(prefix)));
    if (mine.length) await AsyncStorage.multiRemove(mine);
  } catch {
    // Nothing to forget, or storage unavailable: nothing to do
  }
}
