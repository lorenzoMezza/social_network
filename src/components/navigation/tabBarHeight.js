// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { createContext, useContext } from 'react';

// The tab bar floats over the pages, so they can show through it: every page draws
// down to the bottom of the screen and keeps this much space free for its content.
// TabBar measures itself and publishes its height here (tabs _layout.js).
export const TabBarHeightContext = createContext({ height: 0, setHeight: () => {} });

export function useTabBarHeight() {
  return useContext(TabBarHeightContext).height;
}
