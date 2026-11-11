// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useLocalSearchParams } from 'expo-router';
import { EventStyleScreen } from '../features/events/screens/EventStyleScreen';

// /event-style?id=<event id>: how the organizer dresses their event's page
export default function EventStyleRoute() {
  const { id } = useLocalSearchParams();
  return <EventStyleScreen key={id} id={id} />;
}
