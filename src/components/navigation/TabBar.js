// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useContext, useEffect, useMemo, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../theme/colors';
import { GlassFill } from '../ui/GlassFill';
import { tapFeedback } from '../../lib/haptics';
import { TabBarHeightContext } from './tabBarHeight';
import { useSocial } from '../../features/social/state/SocialProvider';
import { useNotifications } from '../../features/notifications/state/NotificationsProvider';

// Icons per route: [inactive, active]
const ICONS = {
  events: ['calendar-outline', 'calendar'],
  social: ['people-outline', 'people'],
  index: ['map-outline', 'map'],
  profile: ['person-outline', 'person'],
  settings: ['settings-outline', 'settings'],
};

// The selection glides to the tab pressed: a finger started it, so a spring, settling
// without a bounce (a tab is chosen dozens of times a day); still for reduced motion
const GLIDE = { duration: 320, dampingRatio: 0.9, reduceMotion: ReduceMotion.System };

const BAR_HEIGHT = 62;

// The lens under the chosen tab: lighter than the bar in light (white on glass, a shade
// on Android's white veil), a faint light on dark
const lens = (colors) => {
  if (colors.scheme === 'dark') return { backgroundColor: 'rgba(255,255,255,0.12)' };
  if (Platform.OS === 'ios') return { backgroundColor: 'rgba(255,255,255,0.72)', boxShadow: '0 1px 6px rgba(20, 24, 40, 0.10)' };
  return { backgroundColor: 'rgba(17,17,17,0.06)' };
};
const BAR_PADDING = 5;

// The bar floats over the pages (the map shows through it): a capsule of the app's glass
// (GlassFill) above the bottom edge. A capsule behind the chosen tab glides to it.
export function TabBar({ state, descriptors, emitter, navigateToTab }) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { setHeight } = useContext(TabBarHeightContext);
  // New messages on the Social tab, new notifications on the Profile tab (its bell)
  const { unreadTotal } = useSocial();
  const { unread } = useNotifications();
  const badges = { social: unreadTotal, profile: unread };

  // Where the selection sits: one slot per tab, measured once laid out
  const [slot, setSlot] = useState(0);
  const offset = useSharedValue(0);
  useEffect(() => {
    if (slot > 0) offset.set(withSpring(state.index * slot, GLIDE));
  }, [state.index, slot, offset]);
  const glide = useAnimatedStyle(() => ({ transform: [{ translateX: offset.get() }] }));

  const items = state.routes.map((route, index) => {
    const { options } = descriptors[route.key];
    const focused = state.index === index;
    const label = options.title ?? route.name;
    const [iconOff, iconOn] = ICONS[route.name] ?? ['ellipse-outline', 'ellipse'];
    // The chosen one in the accent, on its lens; the page's ink, softened, for the others
    // (grey is lost on glass over the map's colours)
    const color = focused ? colors.barAccent : colors.active;

    const onPress = () => {
      const event = emitter.emit({ type: 'tabPress', target: route.key, canPreventDefault: true });
      if (!focused && !event.defaultPrevented) {
        tapFeedback();
        navigateToTab(route.key);
      }
    };

    return (
      <Pressable
        key={route.key}
        onPress={onPress}
        accessibilityRole="button"
        accessibilityState={focused ? { selected: true } : {}}
        accessibilityLabel={label}
        style={styles.item}
      >
        <View style={styles.iconBox}>
          {/* The others softened; their badge never: it is news */}
          <Ionicons name={focused ? iconOn : iconOff} size={22} color={color} style={!focused && styles.idle} />
          {badges[route.name] ? (
            <View style={styles.badge} accessibilityLabel={`${badges[route.name]} new`}>
              <Text style={styles.badgeText}>{badges[route.name] > 99 ? '99+' : badges[route.name]}</Text>
            </View>
          ) : null}
        </View>
        <Text style={[styles.label, { color }, focused ? styles.labelActive : styles.idle]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} maxFontSizeMultiplier={1.2}>{label}</Text>
      </Pressable>
    );
  });

  const row = (
    <View style={styles.row} onLayout={(event) => setSlot((event.nativeEvent.layout.width - BAR_PADDING * 2) / state.routes.length)}>
      {slot > 0 ? <Animated.View pointerEvents="none" style={[styles.selection, { width: slot }, glide]} /> : null}
      {items}
    </View>
  );

  return (
    <View
      pointerEvents="box-none"
      style={[styles.dock, { paddingBottom: Math.max(insets.bottom - 6, 10) }]}
      onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
    >
      <View style={styles.shadow}>
        <View style={styles.capsule}>
          <GlassFill />
          {row}
        </View>
      </View>
    </View>
  );
}

const createStyles = (colors) => StyleSheet.create({
  // The space the bar takes at the bottom of every page (its height is published)
  dock: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: 14,
  },
  // The shadow outside, the clipped glass inside (a clipped view drops its shadow)
  shadow: {
    borderRadius: BAR_HEIGHT / 2,
    boxShadow: colors.scheme === 'dark' ? '0 6px 24px rgba(0, 0, 0, 0.45)' : '0 6px 24px rgba(20, 24, 40, 0.14)',
  },
  capsule: {
    height: BAR_HEIGHT,
    borderRadius: BAR_HEIGHT / 2,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.barEdge,
  },
  row: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    padding: BAR_PADDING,
  },
  // Behind the chosen tab: a lens, a little lighter than the bar (as the system's own
  // tab bar), gliding. Neutral: only the chosen icon and label carry the accent. An
  // absolute, childless view: only its transform moves
  selection: {
    position: 'absolute',
    left: BAR_PADDING,
    top: BAR_PADDING,
    bottom: BAR_PADDING,
    borderRadius: (BAR_HEIGHT - BAR_PADDING * 2) / 2,
    ...lens(colors),
  },
  item: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 2,
  },
  idle: {
    opacity: 0.72,
  },
  iconBox: {
    height: 28,
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: -2,
    left: 14,
    minWidth: 18,
    height: 18,
    paddingHorizontal: 5,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.error,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#FFFFFF',
  },
  label: {
    fontSize: 11,
    fontWeight: '500',
  },
  labelActive: {
    fontWeight: '700',
  },
});
