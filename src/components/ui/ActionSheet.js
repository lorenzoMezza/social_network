// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo, useRef } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../theme/colors';
import { tapFeedback } from '../../lib/haptics';
import { SwipeDownToClose } from './SwipeDownToClose';

// A list of actions sliding up from the bottom, within thumb's reach (the way social
// apps offer "Change photo" or "Block"). A tap outside, a swipe down, or Cancel closes it.
//   title?: a short line above the actions
//   items: [{ label, icon?, onPress, destructive? }]
export function ActionSheet({ visible, onClose, title, items }) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  // The chosen action runs once the sheet is gone: iOS drops an alert or a picker
  // presented while a modal is still closing
  const pending = useRef(null);
  const runPending = () => {
    const action = pending.current;
    pending.current = null;
    action?.();
  };
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      onDismiss={runPending}
    >
      {/* A modal is its own window for the gesture library */}
      <GestureHandlerRootView style={styles.window}>
      <Pressable accessibilityLabel="Close" style={[StyleSheet.absoluteFill, styles.scrim]} onPress={onClose} />
      <SwipeDownToClose onClose={onClose} style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, 12) }]}>
        <View style={styles.grabber} />
        {title ? <Text style={styles.title}>{title}</Text> : null}
        <View style={styles.group}>
          {items.map((item, index) => (
            <Pressable
              key={item.label}
              accessibilityRole="button"
              onPress={() => {
                tapFeedback();
                pending.current = item.onPress;
                onClose();
                // Android has no onDismiss: run it after the closing animation
                if (process.env.EXPO_OS !== 'ios') setTimeout(runPending, 300);
              }}
              style={({ pressed }) => [styles.item, index > 0 && styles.divider, pressed && { backgroundColor: colors.pill }]}
            >
              {item.icon ? <Ionicons name={item.icon} size={21} color={item.destructive ? colors.error : colors.active} /> : null}
              <Text style={[styles.label, item.destructive && { color: colors.error }]}>{item.label}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable accessibilityRole="button" onPress={onClose} style={({ pressed }) => [styles.cancel, pressed && { opacity: 0.6 }]}>
          <Text style={styles.cancelLabel}>Cancel</Text>
        </Pressable>
      </SwipeDownToClose>
      </GestureHandlerRootView>
    </Modal>
  );
}

const createStyles = (colors) => StyleSheet.create({
  window: {
    flex: 1,
  },
  scrim: {
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 12,
    paddingTop: 8,
    gap: 10,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderCurve: 'continuous',
    backgroundColor: colors.page,
  },
  grabber: {
    alignSelf: 'center',
    width: 38,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.border,
    marginBottom: 4,
  },
  title: {
    textAlign: 'center',
    fontSize: 13,
    fontWeight: '600',
    color: colors.inactive,
  },
  group: {
    borderRadius: 16,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  item: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    height: 54,
    paddingHorizontal: 18,
  },
  divider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  label: {
    fontSize: 17,
    color: colors.active,
  },
  cancel: {
    height: 54,
    borderRadius: 16,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  cancelLabel: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.active,
  },
});
