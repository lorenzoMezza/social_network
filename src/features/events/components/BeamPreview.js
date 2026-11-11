// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useEffect } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing, cancelAnimation, useAnimatedStyle, useSharedValue, withRepeat, withTiming,
} from 'react-native-reanimated';
import { withAlpha } from '../model/eventTheme';

// The event's beam as views, in the style sheet: the same five looks as on the map
// (webview/map/src/scene/eventBeacons.js), drawn by little parts over a thin bar. In the
// big preview the parts move, on one clock; in the small ones they stand still.
const SKY = '#262255';
const CYCLE_MS = 4000;
const TAU = Math.PI * 2;

// Moving parts of each style, and its bar: width and strength
const PARTS = { beam: 0, pulse: 4, helix: 44, stardust: 26, veil: 40 };
const BARS = { beam: [12, 1], pulse: [3, 0.55], helix: [2, 0.3], stardust: [3, 0.45], veil: [0, 0] };

// Part `index` of a style at time `t` (0 to 1, the loop closes at 1), in a beam `height`
// tall, sized by `scale`: { x, y, w, h, o } from the foot of the beam
function partOf(style, index, t, height, scale) {
  'worklet';
  const fract = (value) => value - Math.floor(value);
  if (style === 'pulse') {
    const up = fract(index / PARTS.pulse + t);
    return { x: 0, y: up * height, w: 26 * scale * (1 - 0.4 * up), h: 6 * scale, o: (1 - up) * 0.95 };
  }
  if (style === 'helix') {
    const strand = index % 2 ? 1 : -1;
    const up = Math.floor(index / 2) / (PARTS.helix / 2);
    const turn = up * 11 - t * TAU;
    const front = strand * Math.cos(turn) * 0.5 + 0.5;
    const size = (2.2 + 2 * front) * scale;
    return { x: strand * Math.sin(turn) * 13 * scale * (1 - 0.4 * up), y: up * height, w: size, h: size, o: (0.35 + 0.65 * front) * (1 - up * 0.85) };
  }
  if (style === 'stardust') {
    const seed = fract(Math.sin(index * 12.9898) * 43758.5453);
    const other = fract(Math.sin(index * 39.346) * 43758.5453);
    const up = fract(seed + t);
    const size = (2 + other * 3) * scale;
    return { x: (other - 0.5) * 34 * scale, y: up * height, w: size, h: size, o: Math.min(1, Math.sin(up * Math.PI) * 1.4) * (0.7 + 0.3 * Math.sin(t * TAU * 3 + index)) };
  }
  if (style === 'veil') {
    const up = index / PARTS.veil;
    const x = Math.sin(up * 5 - t * TAU) * 9 + Math.sin(up * 2 + t * TAU) * 5;
    return { x: x * scale, y: up * height, w: 13 * scale * (1 - 0.3 * up), h: 10 * scale, o: 0.26 * (1 - up) };
  }
  return { x: 0, y: 0, w: 0, h: 0, o: 0 };
}

function MovingPart({ style, index, clock, height, color }) {
  const animated = useAnimatedStyle(() => {
    const part = partOf(style, index, clock.get(), height, 1);
    return {
      width: part.w,
      height: part.h,
      borderRadius: part.h / 2,
      opacity: part.o,
      transform: [{ translateX: part.x - part.w / 2 }, { translateY: -part.y }],
    };
  });
  return <Animated.View style={[styles.part, { backgroundColor: color }, animated]} />;
}

function Bar({ style, color, height, scale }) {
  const [width, strength] = BARS[style];
  if (!width) return null;
  const size = Math.max(width * scale, 1.5);
  return (
    <View
      style={[styles.part, {
        left: -size / 2,
        width: size,
        height,
        borderRadius: size / 2,
        experimental_backgroundImage: `linear-gradient(to top, ${withAlpha(color, strength)}, ${withAlpha(color, 0)})`,
      }]}
    />
  );
}

// The big preview, as it will look on the map: the beam, its badge, its ring
export function BeamPreview({ style, color, emoji }) {
  const clock = useSharedValue(0);
  useEffect(() => {
    clock.set(withRepeat(withTiming(1, { duration: CYCLE_MS, easing: Easing.linear }), -1, false));
    return () => cancelAnimation(clock);
  }, [clock]);
  return (
    <View style={styles.preview} accessibilityRole="image" accessibilityLabel="Preview of the event's light on the map">
      <View style={[styles.ring, { borderColor: withAlpha(color, 0.8) }]} />
      <View style={styles.foot}>
        <Bar style={style} color={color} height={128} scale={1} />
        {Array.from({ length: PARTS[style] }, (_, index) => (
          <MovingPart key={`${style}-${index}`} style={style} index={index} clock={clock} height={128} color={color} />
        ))}
      </View>
      <View style={[styles.badge, { borderColor: color }]}>
        <Text style={styles.emoji}>{emoji}</Text>
      </View>
    </View>
  );
}

// A style in the list to choose from, standing still
export function BeamThumbnail({ style, color }) {
  const height = 38;
  return (
    <View style={styles.thumbnail}>
      <View style={styles.thumbnailFoot}>
        <Bar style={style} color={color} height={height} scale={0.5} />
        {Array.from({ length: PARTS[style] }, (_, index) => {
          const part = partOf(style, index, 0.35, height, 0.5);
          return (
            <View
              key={`${style}-${index}`}
              style={[styles.part, {
                left: part.x - part.w / 2,
                bottom: part.y,
                width: part.w,
                height: part.h,
                borderRadius: part.h / 2,
                opacity: part.o,
                backgroundColor: color,
              }]}
            />
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  preview: {
    height: 150,
    borderRadius: 18,
    borderCurve: 'continuous',
    overflow: 'hidden',
    backgroundColor: SKY,
    alignItems: 'center',
  },
  ring: {
    position: 'absolute',
    bottom: -13,
    width: 76,
    height: 76,
    borderRadius: 38,
    borderWidth: 2.5,
    transform: [{ scaleY: 0.3 }],
  },
  // A point on the ground: the parts are placed from it
  foot: {
    position: 'absolute',
    bottom: 22,
    width: 0,
    height: 0,
  },
  part: {
    position: 'absolute',
    bottom: 0,
    left: 0,
  },
  badge: {
    position: 'absolute',
    top: 44,
    width: 46,
    height: 46,
    borderRadius: 23,
    borderWidth: 4,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: '#FFFFFF',
  },
  emoji: {
    fontSize: 22,
  },
  thumbnail: {
    width: 44,
    height: 46,
    borderRadius: 10,
    borderCurve: 'continuous',
    overflow: 'hidden',
    backgroundColor: SKY,
    alignItems: 'center',
  },
  thumbnailFoot: {
    position: 'absolute',
    bottom: 4,
    width: 0,
    height: 0,
  },
});
