// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useLocalSearchParams } from 'expo-router';
import { AlbumSettingsScreen } from '../features/album/screens/AlbumSettingsScreen';

// /album-settings?id=<event id>: who can add photos (the organizer)
export default function AlbumSettingsRoute() {
  const { id } = useLocalSearchParams();
  return <AlbumSettingsScreen key={id} id={id} />;
}
