// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { Pressable, StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { MAX_RATING, STARS } from '../model/eventModel';

const POINTS_PER_STAR = MAX_RATING / STARS;

// A 0–10 rating as five stars, halves included
export function Stars({ value, size = 14 }) {
  const colors = useColors();
  const stars = (value ?? 0) / POINTS_PER_STAR;
  return (
    <View style={styles.row} accessibilityLabel={`${stars.toFixed(1)} out of ${STARS} stars`}>
      {Array.from({ length: STARS }, (_, index) => {
        const fill = stars - index;
        const name = fill >= 0.75 ? 'star' : fill >= 0.25 ? 'star-half' : 'star-outline';
        return <Ionicons key={index} name={name} size={size} color={fill >= 0.25 ? colors.star : colors.inactive} />;
      })}
    </View>
  );
}

// Five stars to tap; `value` and onChange are 0–10 (one star = 2 points)
export function StarInput({ value, onChange, size = 40 }) {
  const colors = useColors();
  return (
    <View style={[styles.row, styles.inputRow]} accessibilityRole="radiogroup" accessibilityLabel={`Rating, ${value / POINTS_PER_STAR} of ${STARS} stars`}>
      {Array.from({ length: STARS }, (_, index) => {
        const selected = value >= (index + 1) * POINTS_PER_STAR;
        return (
          <Pressable
            key={index}
            accessibilityRole="radio"
            accessibilityState={{ selected: value === (index + 1) * POINTS_PER_STAR }}
            accessibilityLabel={`${index + 1} star${index ? 's' : ''}`}
            hitSlop={4}
            onPress={() => onChange((index + 1) * POINTS_PER_STAR)}
          >
            <Ionicons name={selected ? 'star' : 'star-outline'} size={size} color={selected ? colors.star : colors.inactive} />
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 1,
  },
  // The stars to tap: centred wherever they are placed
  inputRow: {
    gap: 10,
    alignSelf: 'center',
  },
});
