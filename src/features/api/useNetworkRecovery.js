// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useEffect, useRef } from 'react';
import { subscribeNetwork } from './networkStatus';

// Run a small refresh after an offline → online transition. The initial online
// state is deliberately ignored: providers already load their data on sign-in.
export function useNetworkRecovery(onRecovery) {
  const callback = useRef(onRecovery);

  useEffect(() => {
    callback.current = onRecovery;
  }, [onRecovery]);

  useEffect(() => subscribeNetwork((next, previous) => {
    if (next === 'online' && previous === 'offline') callback.current?.();
  }), []);
}
