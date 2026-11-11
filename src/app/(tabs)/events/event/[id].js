// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useLocalSearchParams } from 'expo-router';
import { EventDetailScreen } from '../../../../features/events/screens/EventDetailScreen';

// An event opened from inside this tab: it stays in the tab, with the tab bar
export default function TabEventRoute() {
  const { id } = useLocalSearchParams();
  return <EventDetailScreen key={id} id={id} />;
}
