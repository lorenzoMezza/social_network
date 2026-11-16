// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../theme/colors';
import { tapFeedback } from '../../lib/haptics';
import { SheetHeader } from '../../components/ui/SheetHeader';
import { BACKDROPS, EFFECTS, GREETINGS, OUTLINES, PEDESTALS, useOwnProfileStyle } from './state/profileStyle';

// How the user's profile looks: the world around their avatar (backdrop, what it
// stands on, an effect, a line around it) and how it greets (played at once on the avatar above). A half-height sheet: the profile stays in view above it and
// every choice shows there at once, and is kept.
export function ProfileStyleScreen() {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [style, update] = useOwnProfileStyle();
  const accent = BACKDROPS.find((entry) => entry.id === style.backdrop)?.accent ?? colors.active;

  const choose = (changes) => {
    tapFeedback();
    update(changes);
  };

  return (
    <View style={styles.page}>
      <SheetHeader title="Profile style" rightLabel="Done" onRight={() => router.back()} />
      {/* Wrapped: in an iOS form sheet a scroll view right under the screen is resized
          by the screens library, which pushed this one out of view */}
      <View collapsable={false} style={styles.flex}>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]} showsVerticalScrollIndicator={false}>
        <Text style={styles.label}>Backdrop</Text>
        <ScrollRow styles={styles} colors={colors} contentContainerStyle={styles.backdrops}>
          {BACKDROPS.map((backdrop) => {
            const selected = backdrop.id === style.backdrop;
            return (
              <Pressable
                key={backdrop.id}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={backdrop.label}
                onPress={() => !selected && choose({ backdrop: backdrop.id })}
                style={styles.backdrop}
              >
                <View style={[styles.swatchRing, selected && { borderColor: backdrop.accent }]}>
                  <View style={styles.swatch}>
                    <View style={[styles.swatchHalf, { backgroundColor: backdrop.sky[0] }]} />
                    <View style={[styles.swatchHalf, { backgroundColor: backdrop.sky[1] }]} />
                    <View style={[styles.swatchFloor, { backgroundColor: backdrop.floor }]} />
                  </View>
                </View>
                <Text style={[styles.optionLabel, selected && { color: colors.active }]}>{backdrop.label}</Text>
              </Pressable>
            );
          })}
        </ScrollRow>

        <Text style={styles.label}>Greeting</Text>
        <Options scrollable styles={styles} colors={colors} accent={accent} options={GREETINGS} value={style.greeting ?? 'wave'} onChange={(greeting) => choose({ greeting })} />

        <Text style={styles.label}>Under the avatar</Text>
        <Options styles={styles} colors={colors} accent={accent} options={PEDESTALS} value={style.pedestal} onChange={(pedestal) => choose({ pedestal })} />

        <Text style={styles.label}>Around the avatar</Text>
        <Options scrollable styles={styles} colors={colors} accent={accent} options={EFFECTS} value={style.effect} onChange={(effect) => choose({ effect })} />

        <Text style={styles.label}>Outline</Text>
        <Options styles={styles} colors={colors} accent={accent} options={OUTLINES} value={style.outline ?? 'outline'} onChange={(outline) => choose({ outline })} />
      </ScrollView>
      </View>
    </View>
  );
}

// A row of choices. `scrollable`: a row that scrolls sideways, each choice as wide as
// its name (the greetings: too many to share the width without cutting their names)
function Options({ styles, colors, accent, options, value, onChange, scrollable = false }) {
  const items = options.map((option) => {
    const selected = option.id === value;
    return (
      <Pressable
        key={option.id}
        accessibilityRole="radio"
        accessibilityState={{ selected }}
        accessibilityLabel={option.label}
        onPress={() => !selected && onChange(option.id)}
        style={({ pressed }) => [styles.option, scrollable && styles.optionChip, selected && { borderColor: accent }, pressed && styles.pressed]}
      >
        <Ionicons name={option.icon} size={20} color={selected ? accent : colors.inactive} />
        <Text style={[styles.optionLabel, selected && { color: colors.active }]} numberOfLines={1}>{option.label}</Text>
      </Pressable>
    );
  });
  if (!scrollable) return <View style={styles.options}>{items}</View>;
  return (
    <ScrollRow styles={styles} colors={colors} contentContainerStyle={styles.optionRow}>
      {items}
    </ScrollRow>
  );
}

const rgba = (hex, alpha) => {
  const value = parseInt(hex.slice(1), 16);
  return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
};

// A row that scrolls sideways, edge to edge of the sheet. Where more is hidden, its
// edge fades into the page (and, on the right, a small chevron): a row cut by the
// screen's edge is easy to miss otherwise
function ScrollRow({ styles, colors, contentContainerStyle, children }) {
  const [edges, setEdges] = useState({ start: false, end: false });
  const update = ({ nativeEvent: { contentOffset, contentSize, layoutMeasurement } }) => {
    const start = contentOffset.x > 4;
    const end = contentOffset.x + layoutMeasurement.width < contentSize.width - 4;
    if (start !== edges.start || end !== edges.end) setEdges({ start, end });
  };
  const [width, setWidth] = useState(0);
  const [contentWidth, setContentWidth] = useState(0);
  const moreAtEnd = edges.end || (!edges.start && contentWidth > width + 4);
  return (
    <View style={styles.scrollRow}>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={contentContainerStyle}
        onScroll={update}
        scrollEventThrottle={32}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
        onContentSizeChange={(contentSizeWidth) => setContentWidth(contentSizeWidth)}
      >
        {children}
      </ScrollView>
      {edges.start && (
        <View pointerEvents="none" style={[styles.edgeFade, styles.edgeStart, { experimental_backgroundImage: `linear-gradient(to right, ${rgba(colors.page, 1)} 0%, ${rgba(colors.page, 0)} 100%)` }]} />
      )}
      {moreAtEnd && (
        <View pointerEvents="none" style={[styles.edgeFade, styles.edgeEnd, { experimental_backgroundImage: `linear-gradient(to left, ${rgba(colors.page, 1)} 15%, ${rgba(colors.page, 0)} 100%)` }]}>
          <Ionicons name="chevron-forward" size={16} color={colors.inactive} />
        </View>
      )}
    </View>
  );
}

const createStyles = (colors) => StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: colors.page,
  },
  flex: {
    flex: 1,
  },
  content: {
    padding: 20,
    gap: 12,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.inactive,
    marginTop: 4,
  },
  // One row, scrolling sideways (bleeding to the sheet's edges): the sections below
  // stay in view in the half-height sheet, the avatar above
  backdrops: {
    paddingHorizontal: 14,
    gap: 2,
  },
  backdrop: {
    width: 76,
    alignItems: 'center',
    gap: 6,
  },
  swatchRing: {
    padding: 3,
    borderRadius: 34,
    borderWidth: 2.5,
    borderColor: 'transparent',
  },
  swatch: {
    width: 56,
    height: 56,
    borderRadius: 28,
    overflow: 'hidden',
  },
  swatchHalf: {
    flex: 1,
  },
  swatchFloor: {
    position: 'absolute',
    left: 14,
    right: 14,
    bottom: 9,
    height: 8,
    borderRadius: 4,
    opacity: 0.9,
  },
  options: {
    flexDirection: 'row',
    gap: 8,
  },
  option: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 16,
    borderCurve: 'continuous',
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: colors.surface,
  },
  optionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inactive,
  },
  scrollRow: {
    marginHorizontal: -20,
  },
  edgeFade: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    width: 44,
    justifyContent: 'center',
  },
  edgeStart: {
    left: 0,
  },
  edgeEnd: {
    right: 0,
    alignItems: 'flex-end',
    paddingRight: 6,
  },
  optionRow: {
    paddingHorizontal: 20,
    gap: 8,
  },
  optionChip: {
    flex: 0,
    minWidth: 82,
    paddingHorizontal: 14,
  },
  pressed: {
    opacity: 0.7,
  },
});
