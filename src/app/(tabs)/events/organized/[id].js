// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useLocalSearchParams } from 'expo-router';
import { OrganizedEventsScreen } from '../../../../features/profile/OrganizedEventsScreen';

// The events someone organized, opened from a profile inside this tab: it stays in the tab
export default function TabOrganizedRoute() {
  const { id, name } = useLocalSearchParams();
  return <OrganizedEventsScreen key={id} id={id} name={name} />;
}
