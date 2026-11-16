// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useLocalSearchParams } from 'expo-router';
import { PhotoViewerScreen } from '../features/album/screens/PhotoViewerScreen';

// /album-photo?id=<event id>&photoId=… : one photo of the album, full screen
export default function AlbumPhotoRoute() {
  const { id, photoId } = useLocalSearchParams();
  return <PhotoViewerScreen key={`${id}:${photoId}`} id={id} photoId={photoId} />;
}
