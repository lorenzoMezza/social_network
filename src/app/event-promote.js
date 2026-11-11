// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useLocalSearchParams } from 'expo-router';
import { PromoteEventScreen } from '../features/promotions/screens/PromoteEventScreen';

// /event-promote?id=<event id>: promoting one of the user's events
export default function EventPromoteRoute() {
  const { id } = useLocalSearchParams();
  return <PromoteEventScreen key={id} id={id} />;
}
