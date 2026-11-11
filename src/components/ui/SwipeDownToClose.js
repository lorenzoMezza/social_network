// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo } from 'react';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const FAR = 80; // pt: let go past here and it closes
const FLICK = 800; // pt/s: or flicked down, however little it moved
const OFF_SCREEN = 700;

// A card or sheet that follows the finger downwards and closes when let go low enough or
// flicked; otherwise it springs back. Only a drag that starts downwards takes it, so the
// buttons and the rows that scroll sideways inside it keep working. Upwards it stays put.
export function SwipeDownToClose({ onClose, style, children }) {
  const y = useSharedValue(0);

  const gesture = useMemo(() => Gesture.Pan()
    .activeOffsetY(10)
    .failOffsetY(-10)
    .failOffsetX([-24, 24])
    .onUpdate((event) => {
      y.set(Math.max(0, event.translationY));
    })
    .onEnd((event) => {
      const closes = event.velocityY > FLICK || (event.translationY > FAR && event.velocityY >= 0);
      if (closes) {
        y.set(withTiming(OFF_SCREEN, { duration: 180, easing: EASE_OUT }, (finished) => {
          if (finished) scheduleOnRN(onClose);
        }));
      } else {
        y.set(withSpring(0, { duration: 400, dampingRatio: 0.8, velocity: event.velocityY }));
      }
    }), [y, onClose]);

  const motion = useAnimatedStyle(() => ({ transform: [{ translateY: y.get() }] }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={[style, motion]}>{children}</Animated.View>
    </GestureDetector>
  );
}
