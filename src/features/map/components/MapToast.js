// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useEffect, useMemo, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';
import { GlassFill } from '../../../components/ui/GlassFill';
import { useColors } from '../../../theme/colors';

const SHOWN_MS = 2400;
// A longer line stays longer, to be read to the end
const MS_PER_CHARACTER = 45;

// A short line at the bottom of the map that confirms something (a visibility switch),
// then fades. `message` is { text, id }: a new id shows it again with the same text. A
// longer one (a refusal naming an event) wraps on a few lines, never cut.
export function MapToast({ message, bottom }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [opacity] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!message) return undefined;
    opacity.stopAnimation();
    const animation = Animated.sequence([
      Animated.timing(opacity, { toValue: 1, duration: 180, useNativeDriver: true }),
      Animated.delay(Math.max(SHOWN_MS, (message.text?.length ?? 0) * MS_PER_CHARACTER)),
      Animated.timing(opacity, { toValue: 0, duration: 300, useNativeDriver: true }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [message, opacity]);

  if (!message?.text) return null;
  return (
    <View style={[styles.position, { bottom }]} pointerEvents="none">
      <Animated.View style={[styles.toast, { opacity }]} accessibilityLiveRegion="polite" accessibilityRole="alert">
        <GlassFill />
        <Text style={styles.text}>{message.text}</Text>
      </Animated.View>
    </View>
  );
}

const createStyles = (colors) => StyleSheet.create({
  position: {
    position: 'absolute',
    left: 0,
    right: 0,
    paddingHorizontal: 24,
    alignItems: 'center',
    zIndex: 30,
  },
  toast: {
    minHeight: 40,
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 20,
    borderCurve: 'continuous',
    justifyContent: 'center',
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.barEdge,
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.15)',
  },
  text: {
    fontSize: 14,
    lineHeight: 19,
    fontWeight: '600',
    textAlign: 'center',
    color: colors.active,
  },
});
