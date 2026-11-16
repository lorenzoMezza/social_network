// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useState } from 'react';
import { Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';

// A square photo, cropped by the system's editor, like a profile picture. iOS hands over a
// JPEG, never the HEIC original
const PICK_OPTIONS = {
  mediaTypes: ['images'],
  allowsEditing: true,
  aspect: [1, 1],
  quality: 0.85,
  exif: false,
  preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
};

// The photo of a group: the library or the camera, as a sheet of actions.
//   const photo = useGroupPhotoSheet({ onPicked: (uri) => …, onRemove })  (onRemove only when
//   there is one to remove);  photo.open();  <ActionSheet {...photo.sheet} />
export function useGroupPhotoSheet({ onPicked, onRemove }) {
  const [visible, setVisible] = useState(false);

  const fromLibrary = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync(PICK_OPTIONS);
      if (!result.canceled && result.assets?.[0]) onPicked(result.assets[0].uri);
    } catch {
      Alert.alert('Could not open your photos');
    }
  };
  const fromCamera = async () => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Camera not allowed', 'Allow the camera in Settings to take a photo.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync(PICK_OPTIONS);
      if (!result.canceled && result.assets?.[0]) onPicked(result.assets[0].uri);
    } catch {
      Alert.alert('No camera available');
    }
  };

  return {
    open: () => setVisible(true),
    sheet: {
      visible,
      onClose: () => setVisible(false),
      title: 'Group photo',
      items: [
        { label: 'Choose from library', icon: 'images-outline', onPress: fromLibrary },
        { label: 'Take photo', icon: 'camera-outline', onPress: fromCamera },
        ...(onRemove ? [{ label: 'Remove photo', icon: 'trash-outline', destructive: true, onPress: onRemove }] : []),
      ],
    },
  };
}
