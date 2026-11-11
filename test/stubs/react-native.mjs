// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

export const Platform = { OS: 'ios', select: (options) => options.ios ?? options.default };
export const StyleSheet = { create: (styles) => styles, absoluteFill: {} };
export const Appearance = { scheme: null, setColorScheme(scheme) { this.scheme = scheme; } };
export const NativeModules = {};
export const AppState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
