// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as Location from 'expo-location';
import { SHOWCASE } from '../../../showcase/useShowcaseDirector';

// This goes to the server (GET /events), which takes it as where the user is: as fresh as the
// map's GPS fixes. Older, a train or a car has moved on by kilometres: the wrong events, and
// the server's check (position_guard) would refuse the real position that follows
const MAX_AGE_MS = 30 * 1000;

// The user's position for distances and the search radius, or null. It never asks for
// the permission itself (the map does, with its explanation): without it the events
// are listed without distances.
export async function getUserPosition() {
  try {
    const { granted } = await Location.getForegroundPermissionsAsync();
    if (!granted) return null;
    const fix = await Location.getLastKnownPositionAsync({ maxAge: MAX_AGE_MS })
      ?? await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    // A fake-GPS app's position is not where the user is (development: an emulator's)
    if (!fix || (fix.mocked && !__DEV__ && !SHOWCASE)) return null;
    return { latitude: fix.coords.latitude, longitude: fix.coords.longitude };
  } catch {
    return null;
  }
}
