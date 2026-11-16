// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo } from 'react';
import { Pressable, ScrollView, StyleSheet, Text } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { categoryInfo } from '../model/categories';
import { DEFAULT_FILTERS, WHEN_OPTIONS } from '../model/eventModel';

// The current filters as plain words ("Any time", "All categories"):
// the user sees what the list shows, and taps any of them to change it
export function FilterBar({ filters, onPress }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const categories = filters.categories.length === 0
    ? 'All categories'
    : filters.categories.length === 1 ? categoryInfo(filters.categories[0]).label : `${filters.categories.length} categories`;
  const items = [
    { key: 'when', label: WHEN_OPTIONS.find((option) => option.id === filters.when)?.label, active: filters.when !== DEFAULT_FILTERS.when },
    { key: 'categories', label: categories, active: filters.categories.length > 0 },
  ];

  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.bar} style={styles.scroller}>
      {items.map((item) => (
        <Pressable
          key={item.key}
          accessibilityRole="button"
          accessibilityHint="Opens the filters"
          onPress={onPress}
          style={({ pressed }) => [styles.chip, item.active && styles.active, pressed && styles.pressed]}
        >
          <Text style={[styles.label, item.active && styles.activeLabel]}>{item.label}</Text>
          <Ionicons name="chevron-down" size={13} color={item.active ? colors.onAccent : colors.inactive} />
        </Pressable>
      ))}
    </ScrollView>
  );
}

const createStyles = (colors) => StyleSheet.create({
  scroller: {
    height: 40,
    flexGrow: 0,
  },
  bar: {
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 20,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    height: 32,
    paddingHorizontal: 12,
    borderRadius: 16,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  active: {
    backgroundColor: colors.accent,
    borderColor: colors.accent,
  },
  pressed: {
    opacity: 0.6,
  },
  label: {
    fontSize: 13,
    fontWeight: '500',
    color: colors.active,
  },
  activeLabel: {
    color: colors.onAccent,
  },
});
