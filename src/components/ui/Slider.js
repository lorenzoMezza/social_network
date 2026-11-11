// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useColors } from '../../theme/colors';
import { tapFeedback } from '../../lib/haptics';

const THUMB = 28;
const MAX_TICKS = 9;

// A slider over a few values (`values`, in order): it stops only on them, with a light
// tick at each one when they are few (MAX_TICKS; more read as a dotted line). Dragged anywhere on its height (44, the size of a finger), tapped,
// or adjusted one step at a time by screen readers. `format(value)` reads the value out.
// A drag that starts sideways stays the slider's however the finger then wanders: neither
// the scroll view nor the sheet around it takes it over. One that starts vertically is
// theirs and leaves the value alone.
export function Slider({ values, value, onChange, format = String, accessibilityLabel }) {
  const colors = useColors();
  const [width, setWidth] = useState(0);
  const index = Math.max(0, values.indexOf(value));
  const last = values.length - 1;
  const fraction = last > 0 ? index / last : 0;

  // What the finger needs on the UI thread: React hears only when the step changes
  const area = useSharedValue(0);
  const shown = useSharedValue(index);
  useEffect(() => {
    shown.set(index);
  }, [shown, index]);

  const gesture = useMemo(() => {
    const choose = (next) => {
      tapFeedback();
      onChange(values[next]);
    };
    // The touch's place along the slider, from its left edge
    const pick = (x) => {
      'worklet';
      const size = area.get();
      if (size <= 0) return;
      const next = Math.round(Math.min(1, Math.max(0, (x - THUMB / 2) / (size - THUMB))) * last);
      if (next !== shown.get()) {
        shown.set(next);
        scheduleOnRN(choose, next);
      }
    };
    const drag = Gesture.Pan()
      .activeOffsetX([-3, 3])
      .failOffsetY([-14, 14])
      .onStart((event) => pick(event.x))
      .onUpdate((event) => pick(event.x));
    const tap = Gesture.Tap().onEnd((event, success) => {
      if (success) pick(event.x);
    });
    return Gesture.Exclusive(drag, tap);
  }, [area, shown, last, values, onChange]);

  const step = (delta) => {
    const next = Math.min(last, Math.max(0, index + delta));
    if (next !== index) onChange(values[next]);
  };

  const travel = Math.max(0, width - THUMB);
  return (
    <GestureDetector gesture={gesture}>
    <View
      accessible
      accessibilityRole="adjustable"
      accessibilityLabel={accessibilityLabel}
      accessibilityValue={{ text: format(values[index]) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(event) => step(event.nativeEvent.actionName === 'increment' ? 1 : -1)}
      onLayout={(event) => {
        area.set(event.nativeEvent.layout.width);
        setWidth(event.nativeEvent.layout.width);
      }}
      style={styles.area}
    >
      <View pointerEvents="none" style={styles.track}>
        {/* Faded grey: it shows on the page and on the grey of a card alike */}
        <View style={[StyleSheet.absoluteFill, styles.rest, { backgroundColor: colors.inactive }]} />
        <View style={[styles.fill, { width: THUMB / 2 + travel * fraction, backgroundColor: colors.accent }]} />
      </View>
      <View pointerEvents="none" style={[styles.ticks, { left: THUMB / 2, right: THUMB / 2 }]}>
        {values.length > MAX_TICKS ? null : values.map((entry, position) => (
          <View key={entry} style={[styles.tick, { left: `${(position / Math.max(1, last)) * 100}%`, backgroundColor: position <= index ? colors.onAccent : colors.inactive }]} />
        ))}
      </View>
      {/* White in both themes, as the system's own knobs: it shows on any track */}
      <View pointerEvents="none" style={[styles.thumb, { left: travel * fraction }]} />
    </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  area: {
    height: 44,
    justifyContent: 'center',
  },
  track: {
    height: 6,
    borderRadius: 3,
    overflow: 'hidden',
  },
  rest: {
    opacity: 0.3,
  },
  fill: {
    height: 6,
  },
  ticks: {
    position: 'absolute',
    top: 20,
    height: 4,
  },
  tick: {
    position: 'absolute',
    width: 4,
    height: 4,
    marginLeft: -2,
    borderRadius: 2,
    opacity: 0.6,
  },
  thumb: {
    position: 'absolute',
    top: 8,
    width: THUMB,
    height: THUMB,
    borderRadius: THUMB / 2,
    backgroundColor: '#FFFFFF',
    boxShadow: '0 1px 4px rgba(0, 0, 0, 0.25)',
  },
});
