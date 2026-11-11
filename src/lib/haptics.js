// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import * as Haptics from 'expo-haptics';

// Light touch feedback for choices and toggles (iOS only: Android's vibrations feel
// heavier and the system adds its own on standard controls)
export function tapFeedback() {
  if (process.env.EXPO_OS === 'ios') Haptics.selectionAsync().catch(() => {});
}

export function successFeedback() {
  if (process.env.EXPO_OS === 'ios') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => {});
}

// A firmer tap: something was made happen by holding (a long press on the map)
export function pressFeedback() {
  if (process.env.EXPO_OS === 'ios') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {});
}
