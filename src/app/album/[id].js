// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useLocalSearchParams } from 'expo-router';
import { AlbumScreen } from '../../features/album/screens/AlbumScreen';

// /album/<event id>: the event's photos
export default function AlbumRoute() {
  const { id } = useLocalSearchParams();
  return <AlbumScreen key={id} id={id} />;
}
