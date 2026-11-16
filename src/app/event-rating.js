// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useLocalSearchParams } from 'expo-router';
import { RateEventScreen } from '../features/events/screens/RateEventScreen';

export default function EventRatingRoute() {
  const { id } = useLocalSearchParams();
  return <RateEventScreen key={id} id={id} />;
}
