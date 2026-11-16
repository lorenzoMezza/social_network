// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { createContext, use, useEffect, useState } from 'react';
import { useNavigation, useRoute } from 'expo-router';

// The name of the tab a screen lives in, given by each tab's stack (_layout.js); none
// for screens outside the tabs
export const TabNameContext = createContext(null);

// Whether this screen can be seen: it is the top of its stack and, inside the tabs,
// its tab is the selected one. A sheet or modal over it (e.g. the profile's Style
// sheet) leaves it visible; another tab, or a page pushed over it, does not. Heavy
// views (the 3D avatar, a WebView with its own ~250 MB process) are only kept alive
// while it is true.
export function useScreenVisible() {
  const navigation = useNavigation();
  const route = useRoute();
  const tab = use(TabNameContext);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const tabs = tab ? navigation.getParent() : null;
    const check = () => {
      const stack = navigation.getState();
      const onTop = !stack || stack.routes[stack.index]?.key === route.key;
      const tabState = tabs?.getState();
      const tabSelected = !tabState || tabState.routes[tabState.index]?.name === tab;
      setVisible(onTop && tabSelected);
    };
    check();
    const unsubscribers = [navigation.addListener('focus', check), navigation.addListener('blur', check)];
    // A tab switch under a sheet does not blur this screen: follow the tabs too
    if (tabs) unsubscribers.push(tabs.addListener('state', check));
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe());
  }, [navigation, route.key, tab]);

  return visible;
}
