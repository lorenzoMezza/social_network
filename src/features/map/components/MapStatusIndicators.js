// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

const WARNING_COLOR = '#FF453A';

function PulsingWarningIcon({ name }) {
  const [pulse] = useState(() => new Animated.Value(0));

  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1_100,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
          isInteraction: false,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1_100,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
          isInteraction: false,
        }),
      ]),
    );

    animation.start();
    return () => animation.stop();
  }, [pulse]);

  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.08, 1] });

  return (
    <Animated.View style={{ opacity }}>
      <Ionicons name={name} size={20} color={WARNING_COLOR} />
    </Animated.View>
  );
}

export function MapStatusIndicators({ gpsIssue, internetIssue, onLocationPermissionPress }) {
  const insets = useSafeAreaInsets();

  if (!gpsIssue && !internetIssue) return null;

  return (
    <View
      style={[styles.position, { top: insets.top + 12 }]}
    >
      {gpsIssue ? (
        gpsIssue === 'permission' ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Location not allowed. Tap to try again or open Settings."
            accessibilityHint="Needed to show your avatar on the map."
            accessibilityLiveRegion="polite"
            onPress={onLocationPermissionPress}
            style={({ pressed }) => [styles.badge, pressed && styles.badgePressed]}
          >
            <PulsingWarningIcon name="location-outline" />
          </Pressable>
        ) : (
          <View
            accessible
            accessibilityRole="image"
            accessibilityLabel={gpsIssue === 'mocked' ? 'A fake location app is on: your position is not updated' : 'GPS issue'}
            accessibilityLiveRegion="polite"
            style={styles.badge}
          >
            <PulsingWarningIcon name="location-outline" />
          </View>
        )
      ) : null}
      {internetIssue ? (
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel="No internet connection"
          accessibilityLiveRegion="polite"
          style={styles.badge}
        >
          <PulsingWarningIcon name="cloud-offline-outline" />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  position: {
    position: 'absolute',
    right: 14,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    zIndex: 10,
  },
  badge: {
    width: 38,
    height: 38,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 19,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255,69,58,0.36)',
    backgroundColor: 'rgba(20,25,34,0.92)',
    shadowColor: '#000000',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 5,
  },
  badgePressed: {
    opacity: 0.7,
  },
});
