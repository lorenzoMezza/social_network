// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useEffect, useState } from 'react';
import { Animated, Easing, StyleSheet, View } from 'react-native';

// Shown while a 3D scene starts (an avatar, the map): two soft arcs turning at different speeds
// around a faint disc, where the avatar will stand, and its shadow on the floor
// breathing below. In the scene's colours (`color`), so it belongs to the profile's
// world, and it fades in after a short moment, so a quick load shows nothing at all.
export function AvatarLoader({ color, size = 46, label = 'Loading avatar' }) {
  const [spin] = useState(() => new Animated.Value(0));
  const [appear] = useState(() => new Animated.Value(0));

  useEffect(() => {
    const loop = Animated.loop(Animated.timing(spin, { toValue: 1, duration: 1400, easing: Easing.linear, useNativeDriver: true }));
    loop.start();
    const fade = Animated.timing(appear, { toValue: 1, duration: 300, delay: 150, useNativeDriver: true });
    fade.start();
    return () => {
      loop.stop();
      fade.stop();
    };
  }, [spin, appear]);

  const turn = (turns) => ({ transform: [{ rotate: spin.interpolate({ inputRange: [0, 1], outputRange: ['0deg', `${360 * turns}deg`] }) }] });
  const breathe = spin.interpolate({ inputRange: [0, 0.5, 1], outputRange: [0.55, 1, 0.55] });
  const inner = size * 0.62;

  return (
    <Animated.View style={[styles.wrap, { opacity: appear }]} pointerEvents="none" accessibilityRole="progressbar" accessibilityLabel={label}>
      <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
        <View style={[styles.disc, { width: size, height: size, borderRadius: size / 2, backgroundColor: color, opacity: 0.12 }]} />
        <Animated.View
          style={[styles.arc, turn(1), {
            width: size, height: size, borderRadius: size / 2, borderWidth: 3,
            borderTopColor: color, borderRightColor: color,
          }]}
        />
        <Animated.View
          style={[styles.arc, turn(-1.5), {
            width: inner, height: inner, borderRadius: inner / 2, borderWidth: 2.5,
            borderBottomColor: color, opacity: 0.6,
          }]}
        />
      </View>
      <Animated.View style={[styles.shadow, { backgroundColor: color, opacity: breathe.interpolate({ inputRange: [0, 1], outputRange: [0, 0.18] }), transform: [{ scaleX: breathe }] }]} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    gap: 14,
  },
  disc: {
    position: 'absolute',
  },
  arc: {
    position: 'absolute',
    borderColor: 'transparent',
  },
  shadow: {
    width: 64,
    height: 10,
    borderRadius: 5,
  },
});
