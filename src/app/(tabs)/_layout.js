// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo, useState } from 'react';
import { Tabs } from 'expo-router/js-tabs';
import { TabBar } from '../../components/navigation/TabBar';
import { TabBarHeightContext } from '../../components/navigation/tabBarHeight';

// The bar floats over the pages, translucent: every page (the map too) draws down
// to the bottom of the screen and keeps the bar's height free for its content
// (useTabBarHeight). The map is the first page shown, also right after signing in.
export default function TabsLayout() {
  const [height, setHeight] = useState(0);
  const tabBarHeight = useMemo(() => ({ height, setHeight }), [height]);

  return (
    <TabBarHeightContext.Provider value={tabBarHeight}>
      <Tabs
        tabBar={(props) => <TabBar {...props} />}
        // No freezeOnBlur: freezing the tabs left the map's native view on top of the
        // selected tab after quick switches (the page stayed on the map)
        screenOptions={{ headerShown: false }}
      >
        {/* Most used first (Apple's and Material's guidance): the map, where the app
            opens, then what is done often, then the user's own and the settings */}
        <Tabs.Screen name="index" options={{ title: 'Map' }} />
        <Tabs.Screen name="events" options={{ title: 'Events' }} />
        <Tabs.Screen name="social" options={{ title: 'Social' }} />
        <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
        <Tabs.Screen name="settings" options={{ title: 'Settings' }} />
      </Tabs>
    </TabBarHeightContext.Provider>
  );
}
