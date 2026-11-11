// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { Stack } from 'expo-router';
import { TabNameContext } from '../../../components/navigation/useScreenVisible';

// Stack of this tab: add more screens next to index.js (e.g. settings.js, [id].js)
export default function TabStackLayout() {
  // Its screens know their tab (useScreenVisible), like the other tabs' stacks
  return (
    <TabNameContext.Provider value="settings">
      <Stack screenOptions={{ headerShown: false }} />
    </TabNameContext.Provider>
  );
}
