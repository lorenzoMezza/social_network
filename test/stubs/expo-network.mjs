// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// expo-network under Node: a test drives the phone's network (globalThis.__network.set)
const listeners = new Set();
let current = { isConnected: true, isInternetReachable: true };

export const addNetworkStateListener = (listener) => {
  listeners.add(listener);
  return { remove: () => listeners.delete(listener) };
};
export const getNetworkStateAsync = async () => current;

globalThis.__network = {
  set(state) {
    current = state;
    for (const listener of [...listeners]) listener(state);
  },
  listeners,
};
