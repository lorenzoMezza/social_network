// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useLocalSearchParams } from 'expo-router';
import { EventDetailScreen } from '../../features/events/screens/EventDetailScreen';

export default function EventRoute() {
  const { id } = useLocalSearchParams();
  return <EventDetailScreen key={id} id={id} />;
}
