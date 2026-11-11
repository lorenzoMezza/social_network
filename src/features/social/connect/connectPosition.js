// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as Location from 'expo-location';
import { SHOWCASE } from '../../../showcase/useShowcaseDirector';

// The phone's position sent with connect requests, for the server's distance check
// (100 m, CONNECT-PROTOCOL.md). It never blocks connecting here: null when there is no
// permission or no position (the map asks for the permission, not this).
export async function getConnectPosition() {
  try {
    const { granted } = await Location.getForegroundPermissionsAsync();
    if (!granted) return null;
    const position = await Location.getLastKnownPositionAsync({ maxAge: 60 * 1000 })
      ?? await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    if (!position) return null;
    return {
      latitude: position.coords.latitude,
      longitude: position.coords.longitude,
      accuracy: position.coords.accuracy,
      timestamp: position.timestamp,
      // The server refuses to connect on a fake position (development: an emulator's counts as one)
      mocked: !!position.mocked && !__DEV__ && !SHOWCASE,
    };
  } catch {
    return null;
  }
}
