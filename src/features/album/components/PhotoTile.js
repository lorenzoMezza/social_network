// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { memo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';

// A square photo of an album: a published one (item.photo), or one being sent
// (item.upload: dimmed with a spinner, or "Retry" when it failed). `more`: "+12" over
// the last photo of a strip. onPress(item): the same function for every tile.
export const PhotoTile = memo(function PhotoTile({ item, size, radius = 0, more, onPress }) {
  const colors = useColors();
  const { photo, upload } = item;
  const failed = upload?.status === 'failed';
  const label = upload
    ? failed ? 'Photo not sent, tap to retry or remove' : 'Photo being sent'
    : `Photo by ${photo.author?.name ?? 'someone'}${more ? `, ${more} more` : ''}`;

  return (
    <Pressable
      accessibilityRole={upload && !failed ? 'image' : 'button'}
      accessibilityLabel={label}
      disabled={!!upload && !failed}
      onPress={() => onPress(item)}
      style={({ pressed }) => [{ width: size, height: size, borderRadius: radius, backgroundColor: colors.surface }, styles.tile, pressed && styles.pressed]}
    >
      <Image
        source={upload ? upload.uri : photo.thumbUrl}
        recyclingKey={upload?.key ?? photo.id}
        style={StyleSheet.absoluteFill}
        contentFit="cover"
        transition={120}
      />
      {upload ? (
        <View style={[StyleSheet.absoluteFill, styles.overlay, { backgroundColor: failed ? 'rgba(0,0,0,0.55)' : 'rgba(0,0,0,0.35)' }]}>
          {failed ? (
            <>
              <Ionicons name="refresh" size={22} color="#FFFFFF" />
              <Text style={styles.overlayText}>Retry</Text>
            </>
          ) : <ActivityIndicator color="#FFFFFF" />}
        </View>
      ) : null}
      {more ? (
        <View style={[StyleSheet.absoluteFill, styles.overlay, { backgroundColor: 'rgba(0,0,0,0.45)' }]}>
          <Text style={styles.more}>+{more}</Text>
        </View>
      ) : null}
    </Pressable>
  );
});

const styles = StyleSheet.create({
  tile: {
    overflow: 'hidden',
    borderCurve: 'continuous',
  },
  pressed: {
    opacity: 0.75,
  },
  overlay: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  overlayText: {
    fontSize: 12,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  more: {
    fontSize: 20,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});
