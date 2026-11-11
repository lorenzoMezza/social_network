// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../theme/colors';

// Rounded button of the app. variant: primary (filled), secondary (tinted), danger,
// ghost (text only). `busy` shows a spinner and blocks presses.
export function Button({ label, icon, onPress, variant = 'primary', busy = false, disabled = false, style, compact = false }) {
  const colors = useColors();
  const palette = {
    primary: { background: colors.accent, text: colors.onAccent },
    secondary: { background: colors.pill, text: colors.active },
    danger: { background: colors.pill, text: colors.error },
    ghost: { background: 'transparent', text: colors.active },
  }[variant];
  const inactive = disabled || busy;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: inactive, busy }}
      disabled={inactive}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        compact && styles.compact,
        { backgroundColor: palette.background },
        disabled && styles.disabled,
        pressed && styles.pressed,
        style,
      ]}
    >
      {busy ? (
        <ActivityIndicator color={palette.text} />
      ) : (
        <View style={styles.content}>
          {icon ? <Ionicons name={icon} size={compact ? 16 : 18} color={palette.text} /> : null}
          <Text style={[styles.label, compact && styles.compactLabel, { color: palette.text }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>{label}</Text>
        </View>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  button: {
    height: 50,
    borderRadius: 25,
    borderCurve: 'continuous',
    paddingHorizontal: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  compact: {
    height: 36,
    borderRadius: 18,
    paddingHorizontal: 14,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  label: {
    fontSize: 16,
    fontWeight: '600',
  },
  compactLabel: {
    fontSize: 14,
  },
  disabled: {
    opacity: 0.4,
  },
  pressed: {
    opacity: 0.85,
    transform: [{ scale: 0.98 }],
  },
});
