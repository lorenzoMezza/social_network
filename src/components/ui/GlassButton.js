// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../theme/colors';
import { GlassFill } from './GlassFill';

// A button of the app's glass, for controls over colourful content (the map, a profile's
// backdrop). Round with only an icon, a pill with a label. The shadow on the button, the
// clipped glass inside it: a view that clips and casts a shadow at once loses its true curve.
export function GlassButton({ icon, label, onPress, accessibilityLabel, size = 40 }) {
  const colors = useColors();
  const round = !label;
  const radius = size / 2;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        { height: size, borderRadius: radius },
        round ? { width: size } : styles.pill,
        pressed && styles.pressed,
      ]}
    >
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.clip, { borderRadius: radius, borderColor: colors.barEdge }]}>
        <GlassFill />
      </View>
      {icon ? <Ionicons name={icon} size={round ? Math.round(size * 0.5) : 16} color={colors.active} /> : null}
      {label ? <Text style={[styles.label, { color: colors.active }]} numberOfLines={1} maxFontSizeMultiplier={1.3}>{label}</Text> : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    boxShadow: '0 2px 10px rgba(0, 0, 0, 0.12)',
  },
  clip: {
    overflow: 'hidden',
    borderCurve: 'circular',
    borderWidth: StyleSheet.hairlineWidth,
  },
  pill: {
    paddingHorizontal: 14,
  },
  pressed: {
    opacity: 0.75,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
  },
});
