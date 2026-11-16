// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

const STUBS = {
  'expo/fetch': 'expo-fetch.mjs',
  'expo-constants': 'expo-constants.mjs',
  'expo-file-system': 'expo-file-system.mjs',
  'expo-network': 'expo-network.mjs',
  'react-native': 'react-native.mjs',
  '@react-native-async-storage/async-storage': 'async-storage.mjs',
};

export function resolve(specifier, context, next) {
  if (STUBS[specifier]) return { url: new URL(`./stubs/${STUBS[specifier]}`, import.meta.url).href, shortCircuit: true };
  try {
    return next(specifier, context);
  } catch (error) {
    if (specifier.startsWith('.') && (error.code === 'ERR_MODULE_NOT_FOUND' || error.code === 'ERR_UNSUPPORTED_DIR_IMPORT')) {
      return next(`${specifier}.js`, context);
    }
    throw error;
  }
}
