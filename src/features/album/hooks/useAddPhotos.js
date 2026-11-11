// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useState } from 'react';
import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { successFeedback } from '../../../lib/haptics';
import { ALBUM_LIMITS, PICK_QUALITY } from '../model/albumModel';
import { useAlbums } from '../state/AlbumsProvider';

const LIBRARY_OPTIONS = {
  mediaTypes: ['images'],
  allowsMultipleSelection: true,
  orderedSelection: true,
  quality: PICK_QUALITY,
  exif: false,
  // iOS hands over a JPEG, never the HEIC original (several picked at once otherwise)
  preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
};
const CAMERA_OPTIONS = { mediaTypes: ['images'], quality: PICK_QUALITY, exif: false };

// "Add photos": the library (many at once) or the camera (during the event), as a
// sheet of two actions. The photos join the album's upload queue at once.
//   const adder = useAddPhotos(eventId, { onAdded })
//   adder.open()  ...  <ActionSheet {...adder.sheet} />
export function useAddPhotos(eventId, { onAdded } = {}) {
  const { addPhotos, captureSession, albums, uploads } = useAlbums();
  const [visible, setVisible] = useState(false);
  // How many more this person may add here, those on their way counted
  const room = Math.max(0, (albums[eventId]?.room ?? ALBUM_LIMITS.perPick) - (uploads[eventId]?.length ?? 0));

  const add = (result, session) => {
    if (captureSession() !== session) return;
    if (result.canceled || !result.assets?.length) return;
    const fitting = result.assets.filter((asset) => !asset.fileSize || asset.fileSize <= ALBUM_LIMITS.maxBytes);
    const skipped = result.assets.length - fitting.length;
    if (skipped) {
      Alert.alert(
        skipped === 1 ? 'One photo is too big' : `${skipped} photos are too big`,
        `Photos up to ${Math.round(ALBUM_LIMITS.maxBytes / 1024 / 1024)} MB can be added.`,
      );
    }
    if (!fitting.length) return;
    if (!addPhotos(eventId, fitting, session)) return;
    successFeedback();
    onAdded?.(fitting.length);
  };

  const fromLibrary = async () => {
    const session = captureSession();
    try {
      add(await ImagePicker.launchImageLibraryAsync({ ...LIBRARY_OPTIONS, selectionLimit: Math.min(ALBUM_LIMITS.perPick, room) }), session);
    } catch {
      Alert.alert('Could not open your photos');
    }
  };

  const fromCamera = async () => {
    const session = captureSession();
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (captureSession() !== session) return;
      if (!permission.granted) {
        Alert.alert('Camera not allowed', 'Allow the camera in Settings to take a photo.');
        return;
      }
      add(await ImagePicker.launchCameraAsync(CAMERA_OPTIONS), session);
    } catch {
      Alert.alert('No camera available');
    }
  };

  return {
    open: () => {
      if (room > 0) setVisible(true);
      else Alert.alert('No more photos here', "You've added all the photos you can to this album. Removing one makes room.");
    },
    sheet: {
      visible,
      onClose: () => setVisible(false),
      title: 'Add photos',
      items: [
        { label: 'Choose from library', icon: 'images-outline', onPress: fromLibrary },
        { label: 'Take photo', icon: 'camera-outline', onPress: fromCamera },
      ],
    },
  };
}
