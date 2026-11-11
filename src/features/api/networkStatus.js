// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as Network from 'expo-network';

// Whether the phone is online, for the whole app from one native listener (every
// provider used to open its own): 'online', 'offline', or 'unknown' before the first
// answer. subscribeNetwork(listener) calls listener(next, previous) on every change.
let status = 'unknown';
let subscription = null;
const listeners = new Set();

const classify = (state) => {
  if (state.isConnected === false || state.isInternetReachable === false) return 'offline';
  if (state.isInternetReachable === true || state.isConnected === true) return 'online';
  return 'unknown';
};

const update = (state) => {
  const next = classify(state);
  // A reading that says nothing keeps what is known
  if (next === 'unknown' || next === status) return;
  const previous = status;
  status = next;
  for (const listener of listeners) listener(next, previous);
};

export const networkStatus = () => status;

export function subscribeNetwork(listener) {
  listeners.add(listener);
  if (!subscription) {
    let received = false;
    const own = Network.addNetworkStateListener((state) => {
      received = true;
      update(state);
    });
    subscription = own;
    // The state now, unless the listener already told it (or nobody listens any more)
    Network.getNetworkStateAsync()
      .then((state) => {
        if (!received && subscription === own) update(state);
      })
      .catch(() => {
        // A failed read is inconclusive: the native listener reports the next change
      });
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size) return;
    subscription?.remove();
    subscription = null;
    status = 'unknown';
  };
}
