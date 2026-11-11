// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// AsyncStorage in memory
const data = new Map();
const AsyncStorage = {
  getItem: async (key) => (data.has(key) ? data.get(key) : null),
  setItem: async (key, value) => void data.set(key, value),
  removeItem: async (key) => void data.delete(key),
  getAllKeys: async () => [...data.keys()],
  multiGet: async (keys) => keys.map((key) => [key, data.has(key) ? data.get(key) : null]),
  multiRemove: async (keys) => keys.forEach((key) => data.delete(key)),
  clear: async () => data.clear(),
};
export default AsyncStorage;
