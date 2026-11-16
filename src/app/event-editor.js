// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useLocalSearchParams } from 'expo-router';
import { EventEditorScreen } from '../features/events/screens/EventEditorScreen';

// /event-editor creates an event, /event-editor?id=… edits it
export default function EventEditorRoute() {
  const { id } = useLocalSearchParams();
  return <EventEditorScreen key={id ?? 'new'} id={id} />;
}
