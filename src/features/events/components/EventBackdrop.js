// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { shiftHue, withAlpha } from '../model/eventTheme';

// Where the symbols of the pattern background sit in its band, as fractions of its
// width and height, with their turn (degrees) and size: scattered, never on a grid
const SPOTS = [
  [0.06, 0.08, -14, 26], [0.3, 0.03, 10, 20], [0.55, 0.1, -6, 30], [0.82, 0.05, 16, 22],
  [0.16, 0.3, 12, 20], [0.42, 0.27, -18, 26], [0.7, 0.32, 8, 20], [0.92, 0.25, -10, 28],
  [0.04, 0.52, 6, 24], [0.28, 0.55, -8, 30], [0.6, 0.5, 14, 22], [0.85, 0.56, -16, 26],
  [0.18, 0.78, -12, 22], [0.48, 0.8, 18, 26], [0.76, 0.76, -6, 20],
];

// The background its organizer chose behind the top of the event's page
// (eventTheme.js), in the event's colour (`tone`): a glow from the top, an aurora (two
// colours) or a pattern of its symbol. Plain and tinted have none.
//   inset: the status bar's height, kept clear of symbols
export function EventBackdrop({ theme, tone, dark, height, inset = 0 }) {
  const style = useMemo(() => {
    if (theme.background === 'glow') {
      return { experimental_backgroundImage: `linear-gradient(to bottom, ${withAlpha(tone, dark ? 0.4 : 0.3)} 0%, ${withAlpha(tone, 0)} 100%)` };
    }
    if (theme.background === 'aurora') {
      // Two glows from the top corners; each reaches down exactly to the band's bottom
      // edge (a diagonal gradient left a visible cut in the bottom-left corner)
      const second = shiftHue(tone, 48);
      return {
        experimental_backgroundImage: [
          `radial-gradient(ellipse 115% 100% at 0% 0%, ${withAlpha(tone, dark ? 0.5 : 0.38)} 0%, ${withAlpha(tone, 0)} 100%)`,
          `radial-gradient(ellipse 115% 85% at 100% 0%, ${withAlpha(second, dark ? 0.38 : 0.28)} 0%, ${withAlpha(second, 0)} 100%)`,
        ].join(', '),
      };
    }
    return null;
  }, [theme.background, tone, dark]);

  if (theme.background === 'pattern') {
    return (
      <View pointerEvents="none" style={[styles.band, { height }]} importantForAccessibility="no-hide-descendants">
        {SPOTS.map(([x, y, turn, size], index) => (
          <Text
            key={index}
            style={[styles.symbol, {
              left: `${x * 100}%`,
              top: inset + y * (height - inset),
              fontSize: size,
              transform: [{ rotate: `${turn}deg` }],
              opacity: (dark ? 0.22 : 0.16) * (1 - y * 0.8),
              color: tone,
            }]}
          >
            {theme.emoji ?? '✦'}
          </Text>
        ))}
      </View>
    );
  }
  return style ? <View pointerEvents="none" style={[styles.band, { height }, style]} /> : null;
}

const styles = StyleSheet.create({
  band: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    overflow: 'hidden',
  },
  symbol: {
    position: 'absolute',
  },
});
