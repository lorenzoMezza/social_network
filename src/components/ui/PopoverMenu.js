// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../theme/colors';
import { tapFeedback } from '../../lib/haptics';

// A short menu opening right under the button that shows it (top: its bottom edge,
// right: its distance from the screen's right edge), like the system's pull-down
// menus. A tap outside closes it.
//   items: [{ label, icon?, onPress, destructive? }]
export function PopoverMenu({ visible, onClose, top, right = 16, items }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable accessibilityLabel="Close menu" style={StyleSheet.absoluteFill} onPress={onClose} />
      <View style={[styles.menu, { top, right }]} accessibilityRole="menu">
        {items.map((item, index) => (
          <Pressable
            key={item.label}
            accessibilityRole="menuitem"
            onPress={() => {
              tapFeedback();
              onClose();
              // After the menu has gone: an alert opened from it stays on screen
              setTimeout(item.onPress, 250);
            }}
            style={({ pressed }) => [styles.item, index > 0 && styles.divider, pressed && { backgroundColor: colors.pill }]}
          >
            <Text style={[styles.label, item.destructive && { color: colors.error }]}>{item.label}</Text>
            {item.icon ? <Ionicons name={item.icon} size={18} color={item.destructive ? colors.error : colors.active} /> : null}
          </Pressable>
        ))}
      </View>
    </Modal>
  );
}

const createStyles = (colors) => StyleSheet.create({
  menu: {
    position: 'absolute',
    minWidth: 220,
    borderRadius: 14,
    borderCurve: 'continuous',
    backgroundColor: colors.scheme === 'dark' ? colors.pill : colors.page,
    boxShadow: '0 8px 30px rgba(0, 0, 0, 0.18)',
    overflow: 'hidden',
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    paddingHorizontal: 16,
    height: 46,
  },
  divider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  label: {
    fontSize: 16,
    color: colors.active,
  },
});
