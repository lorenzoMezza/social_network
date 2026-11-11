// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useLocalSearchParams } from 'expo-router';
import { OrganizedEventsScreen } from '../../features/profile/OrganizedEventsScreen';

// /organized/<user id>?name=… : the events someone organized, from a profile opened
// outside the tabs with pages (the map, a chat)
export default function OrganizedRoute() {
  const { id, name } = useLocalSearchParams();
  return <OrganizedEventsScreen key={id} id={id} name={name} />;
}
