// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { ActionSheet } from '../../../components/ui/ActionSheet';

// API.md: an event shows at most 6 pictures
const PHOTOS_MAX = 6;
// Compatible: iOS hands over a JPEG, never the HEIC original (it does with several
// photos picked at once otherwise)
const PICK = {
  mediaTypes: ['images'],
  quality: 0.8,
  exif: false,
  preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible,
};

// The pictures at the top of an event's page, swiped through (optional: without any
// the page has no banner). A row of thumbnails, the first one the cover; a tap on one
// makes it the cover or removes it, the last tile adds more (library or camera).
//   photos: addresses (the event's) and files just picked, in order
export function EventPhotosField({ photos, onChange }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [adding, setAdding] = useState(false);
  const [selected, setSelected] = useState(null); // index of the photo whose actions are open
  const room = PHOTOS_MAX - photos.length;

  const fromLibrary = async () => {
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ ...PICK, allowsMultipleSelection: true, selectionLimit: room, orderedSelection: true });
      if (!result.canceled && result.assets?.length) onChange([...photos, ...result.assets.map((asset) => asset.uri)].slice(0, PHOTOS_MAX));
    } catch {
      Alert.alert('Could not open the photos');
    }
  };
  const fromCamera = async () => {
    try {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        Alert.alert('Camera not allowed', 'Allow the camera in Settings to take a photo.');
        return;
      }
      const result = await ImagePicker.launchCameraAsync(PICK);
      if (!result.canceled && result.assets?.[0]) onChange([...photos, result.assets[0].uri].slice(0, PHOTOS_MAX));
    } catch {
      Alert.alert('Could not open the camera');
    }
  };

  const photoActions = (index) => [
    ...(index > 0 ? [{ label: 'Make cover', icon: 'star-outline', onPress: () => onChange([photos[index], ...photos.filter((_, i) => i !== index)]) }] : []),
    { label: 'Remove', icon: 'trash-outline', destructive: true, onPress: () => onChange(photos.filter((_, i) => i !== index)) },
  ];

  return (
    <View>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.strip}>
        {photos.map((photo, index) => (
          <Pressable
            key={photo}
            accessibilityRole="button"
            accessibilityLabel={index === 0 ? 'Cover photo, actions' : `Photo ${index + 1}, actions`}
            onPress={() => setSelected(index)}
            style={({ pressed }) => [styles.tile, pressed && styles.pressed]}
          >
            <Image source={photo} style={StyleSheet.absoluteFill} contentFit="cover" transition={120} />
            {index === 0 ? (
              <View style={styles.coverTag}>
                <Text style={styles.coverText}>Cover</Text>
              </View>
            ) : null}
          </Pressable>
        ))}
        {room > 0 ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add photos"
            onPress={() => setAdding(true)}
            style={({ pressed }) => [styles.tile, styles.add, pressed && styles.pressed]}
          >
            <Ionicons name="add" size={26} color={colors.inactive} />
            <Text style={styles.addText}>{photos.length ? 'Add' : 'Add photos'}</Text>
          </Pressable>
        ) : null}
      </ScrollView>

      <ActionSheet
        visible={adding}
        onClose={() => setAdding(false)}
        title={`Up to ${room} more`}
        items={[
          { label: 'Choose from library', icon: 'images-outline', onPress: fromLibrary },
          { label: 'Take photo', icon: 'camera-outline', onPress: fromCamera },
        ]}
      />
      <ActionSheet
        visible={selected !== null}
        onClose={() => setSelected(null)}
        items={selected !== null ? photoActions(selected) : []}
      />
    </View>
  );
}

const createStyles = (colors) => StyleSheet.create({
  strip: {
    gap: 10,
    paddingVertical: 2,
  },
  tile: {
    width: 128,
    aspectRatio: 16 / 10,
    borderRadius: 14,
    borderCurve: 'continuous',
    overflow: 'hidden',
    backgroundColor: colors.surface,
  },
  pressed: {
    opacity: 0.6,
  },
  add: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  addText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.inactive,
  },
  coverTag: {
    position: 'absolute',
    left: 6,
    bottom: 6,
    paddingHorizontal: 7,
    height: 20,
    borderRadius: 10,
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.55)',
  },
  coverText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});
