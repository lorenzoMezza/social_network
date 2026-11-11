// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useEffect, useState } from 'react';
import { AppState, Platform } from 'react-native';

// The most frames a second the map's page can show now, when the app knows of a limit
// under the frame rate the map asks for; null when it knows of none.
//
// An iPhone in Low Power Mode calls a web page's frame loop 30 times a second, whatever
// the page draws. The map must hear it: frames then come "late" for good, and it would
// lower its resolution for nothing (webview/map adaptiveResolution.js). On Android power
// saving differs from phone to phone (many keep 60 Hz), so nothing is said: the map
// measures the display's rate by itself, which also covers 30 Hz and 90/120 Hz screens.
//
// expo-battery is a native module: a build made before it was added does not have it,
// and must go on working (the map then measures, as on Android).
const IOS_LOW_POWER_FPS = 30;

let Battery = null;
try {
  Battery = require('expo-battery');
} catch {
  Battery = null;
}

export function useDisplayLimit() {
  const [lowPower, setLowPower] = useState(false);

  useEffect(() => {
    if (Platform.OS !== 'ios' || !Battery) return undefined;
    let alive = true;
    const read = () => {
      Battery.isLowPowerModeEnabledAsync()
        .then((enabled) => {
          if (alive) setLowPower(enabled === true);
        })
        .catch(() => {});
    };
    read();
    const subscriptions = [
      Battery.addLowPowerModeListener(({ lowPowerMode }) => setLowPower(lowPowerMode === true)),
      // Switched in Control Centre or Settings while the app was away
      AppState.addEventListener('change', (state) => {
        if (state === 'active') read();
      }),
    ];
    return () => {
      alive = false;
      subscriptions.forEach((subscription) => subscription.remove());
    };
  }, []);

  return lowPower ? IOS_LOW_POWER_FPS : null;
}
