// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { forwardRef } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../theme/colors';

// Round icon button: on the page (`plain`), or as a dark glass disc over banners and photos
// A ref reaches the pressable (e.g. to anchor a menu to the button)
export const IconButton = forwardRef(function IconButton({ icon, onPress, label, variant = 'plain', size = 40, color, style }, ref) {
  const colors = useColors();
  const overBanner = variant === 'banner';
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { width: size, height: size, borderRadius: size / 2 },
        overBanner ? { backgroundColor: colors.scrim } : { backgroundColor: colors.pill },
        pressed && styles.pressed,
        style,
      ]}
    >
      <Ionicons name={icon} size={size * 0.5} color={color ?? (overBanner ? colors.onBanner : colors.active)} />
    </Pressable>
  );
});

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.6,
  },
});
