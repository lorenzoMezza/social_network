// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useLocalSearchParams } from 'expo-router';
import { FlashEventScreen } from '../features/events/screens/FlashEventScreen';

// /flash-event?latitude=…&longitude=…: a flash event at a place held on the map (and
// fromLatitude/fromLongitude: where the user is); /flash-event?id=…: edits one
export default function FlashEventRoute() {
  const { id, latitude, longitude, fromLatitude, fromLongitude } = useLocalSearchParams();
  const from = fromLatitude && fromLongitude ? { latitude: Number(fromLatitude), longitude: Number(fromLongitude) } : null;
  return <FlashEventScreen key={`${id ?? 'new'}:${latitude ?? ''}:${longitude ?? ''}`} id={id} latitude={Number(latitude)} longitude={Number(longitude)} from={from} />;
}
