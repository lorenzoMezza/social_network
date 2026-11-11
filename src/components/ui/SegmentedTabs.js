// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { useColors } from '../../theme/colors';
import { tapFeedback } from '../../lib/haptics';

// The selection glides to the segment pressed (a spring, no bounce, still for reduced
// motion); the content below switches at once (no slide: tabs are not a hierarchy)
const GLIDE = { duration: 300, dampingRatio: 0.9, reduceMotion: ReduceMotion.System };

// Switches between peers
export function SegmentedTabs({ tabs, value, onChange }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const index = Math.max(0, tabs.findIndex((tab) => tab.key === value));
  const [slot, setSlot] = useState(0);
  const offset = useSharedValue(0);
  useEffect(() => {
    if (slot > 0) offset.set(withSpring(index * slot, GLIDE));
  }, [index, slot, offset]);
  const glide = useAnimatedStyle(() => ({ transform: [{ translateX: offset.get() }] }));
  return (
    <View style={styles.track} accessibilityRole="tablist" onLayout={(event) => setSlot((event.nativeEvent.layout.width - 6) / tabs.length)}>
      {slot > 0 ? <Animated.View pointerEvents="none" style={[styles.selected, styles.selection, { width: slot }, glide]} /> : null}
      {tabs.map((tab) => {
        const selected = tab.key === value;
        return (
          <Pressable
            key={tab.key}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => {
              if (selected) return;
              tapFeedback();
              onChange(tab.key);
            }}
            style={styles.tab}
          >
            <Text style={[styles.label, { color: selected ? colors.accent : colors.inactive }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}>
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const createStyles = (colors) => StyleSheet.create({
  track: {
    flexDirection: 'row',
    height: 36,
    padding: 3,
    borderRadius: 10,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    borderCurve: 'continuous',
  },
  // Behind the chosen segment, gliding (absolute, childless: only its transform moves)
  selection: {
    position: 'absolute',
    left: 3,
    top: 3,
    bottom: 3,
    borderRadius: 8,
    borderCurve: 'continuous',
  },
  selected: {
    backgroundColor: colors.scheme === 'dark' ? colors.pill : colors.page,
    boxShadow: colors.scheme === 'dark' ? undefined : '0 1px 3px rgba(0, 0, 0, 0.08)',
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
  },
});
