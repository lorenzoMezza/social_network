// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { Pressable, StyleSheet, Text } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../theme/colors';

// Small pill. Selectable when it has onPress; `tint` colours its icon (e.g. categories).
export function Chip({ label, icon, tint, selected = false, onPress, size = 'regular' }) {
  const colors = useColors();
  const small = size === 'small';
  const textColor = selected ? colors.onAccent : colors.active;
  return (
    <Pressable
      accessibilityRole={onPress ? 'checkbox' : 'text'}
      accessibilityState={onPress ? { checked: selected } : undefined}
      accessibilityLabel={label}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.chip,
        small && styles.small,
        { backgroundColor: selected ? colors.accent : colors.pill },
        pressed && styles.pressed,
      ]}
    >
      {icon ? <Ionicons name={icon} size={small ? 12 : 15} color={selected ? colors.onAccent : tint ?? colors.active} /> : null}
      <Text style={[styles.label, small && styles.smallLabel, { color: textColor }]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 36,
    paddingHorizontal: 14,
    borderRadius: 18,
  },
  small: {
    height: 24,
    paddingHorizontal: 9,
    gap: 4,
    borderRadius: 12,
  },
  label: {
    fontSize: 14,
    fontWeight: '500',
  },
  smallLabel: {
    fontSize: 12,
  },
  pressed: {
    opacity: 0.7,
  },
});
