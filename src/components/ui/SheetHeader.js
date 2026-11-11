// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useColors } from '../../theme/colors';

// Header of modal screens: a text action on each side (e.g. Cancel / Save) and a title.
// rightBusy: the right action is under way (a spinner in its place, whatever it does:
// save, send, create). grabber: the bar at the top that shows the sheet can be dragged;
// iOS draws its own (sheetGrabberVisible, app/_layout.js), Android has none. false on
// full-screen modals
export function SheetHeader({ title, leftLabel, onLeft, rightLabel, onRight, rightDisabled = false, rightBusy = false, style, textColor, grabber = true, onLayout }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const drawGrabber = grabber && process.env.EXPO_OS === 'android';
  const action = (label, onPress, { disabled, emphasized, busy } = {}) => (label ? (
    <Pressable accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled, busy }} disabled={disabled || busy} hitSlop={10} onPress={onPress}>
      {busy ? <ActivityIndicator color={textColor ?? colors.active} /> : (
        <Text style={[styles.action, emphasized && styles.emphasized, disabled && styles.disabled, textColor && { color: textColor }, disabled && textColor && styles.disabledOver]}>{label}</Text>
      )}
    </Pressable>
  ) : <View />);

  return (
    // One native view (not flattened): in an iOS form sheet the screens library lays
    // out the header and the scroll view below it only when they are two views
    <View collapsable={false} style={[styles.header, style]} onLayout={onLayout}>
      {drawGrabber && <View style={[styles.grabber, textColor && { backgroundColor: textColor }]} />}
      <View style={[styles.bar, drawGrabber && styles.barUnderGrabber]}>
        <View style={styles.side}>{action(leftLabel, onLeft)}</View>
        <Text style={[styles.title, textColor && { color: textColor }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75} accessibilityRole="header">{title}</Text>
        <View style={[styles.side, styles.right]}>{action(rightLabel, onRight, { disabled: rightDisabled, busy: rightBusy, emphasized: true })}</View>
      </View>
    </View>
  );
}

const createStyles = (colors) => StyleSheet.create({
  // Opaque: what scrolls below never shows through it
  header: {
    zIndex: 1,
    backgroundColor: colors.page,
    paddingHorizontal: 16,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  // The Material drag handle (32 × 4, faded), in its own band above the title
  grabber: {
    alignSelf: 'center',
    marginTop: 10,
    width: 32,
    height: 4,
    borderRadius: 2,
    backgroundColor: colors.inactive,
    opacity: 0.4,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 56,
  },
  // Below the handle: the title and actions sit a little lower, clear of it
  barUnderGrabber: {
    height: 50,
  },
  side: {
    width: 84,
  },
  right: {
    alignItems: 'flex-end',
  },
  title: {
    flex: 1,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '700',
    color: colors.active,
  },
  action: {
    fontSize: 16,
    color: colors.active,
  },
  emphasized: {
    fontWeight: '700',
  },
  disabled: {
    color: colors.inactive,
  },
  // Disabled over a coloured backdrop (textColor): faded, in its colour
  disabledOver: {
    opacity: 0.5,
  },
});
