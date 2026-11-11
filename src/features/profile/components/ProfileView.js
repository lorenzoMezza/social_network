// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, KeyboardAvoidingView, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect, useNavigation, useScrollToTop } from 'expo-router';
import { setStatusBarStyle } from 'expo-status-bar';
import { useColors } from '../../../theme/colors';
import { useTabBarHeight } from '../../../components/navigation/tabBarHeight';
import { useTabLinks } from '../../../components/navigation/useTabLinks';
import { GlassButton } from '../../../components/ui/GlassButton';
import { GlassFill } from '../../../components/ui/GlassFill';
import { useUserAvatar } from '../../avatar/state/AvatarProvider';
import { AvatarView } from '../../avatar/components/AvatarView';
import { useEvents } from '../../events/state/EventsProvider';
import { NamesField } from './NamesField';
import { TimelineItem } from './TimelineItem';
import { isDarkColor } from '../state/profileStyle';
import { OfflineImage } from '../../offline/OfflineImage';
import { priorityOfPerson } from '../../offline/peoplePriority';

// Share of the screen the avatar's world takes at the top, and how much the page
// below overlaps it
const HERO_SHARE = 0.62;
const OVERLAP = 28;
// The room kept free above and below the avatar: above it for the emotes that jump,
// below it for the buttons, centred in that room
const BUTTONS = 52;
const HERO_BUTTON = 38;
const HERO_GAP = (BUTTONS - HERO_BUTTON) / 2;

const compactNumber = (value) => {
  if (value == null) return '–';
  if (value < 1000) return String(value);
  if (value < 1e6) return `${(value / 1000).toFixed(value < 10000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(value / 1e6).toFixed(1).replace(/\.0$/, '')}M`;
};
const initials = (name) => (name ?? '?').split(/\s+/).filter(Boolean).slice(0, 2).map((word) => word[0].toUpperCase()).join('') || '?';

/**
 * A profile, own or someone else's. At the top their avatar stands in its own world
 * (the backdrop they chose), full width, no frame; the page slides up over it as a
 * sheet: who they are, their bio, their numbers, then their story (TimelineItem),
 * newest first. The world moves slower than the page (parallax) and stretches when
 * pulled down.
 *   topLeft / topRight   controls over the world (back, settings)
 *   heroActions          controls at the bottom of the world (edit avatar, style)
 *   names                the name and username, editable (NamesField); else shown as they are
 *   bio                  the bio (BioField)
 *   stats                [{ label, value | text, onPress? }]: a tile opens a list when pressable
 *   onPhotoPress         the photo can be changed (the user's own profile)
 *   timelineLoading      the story is being loaded the first time: no "empty" meanwhile
 *   storyAction          { label, onPress } beside the story's title (the own: what it shows)
 *   onEntryLongPress     a moment of the story long-pressed (the own: hide or show it)
 *   children             overlays (sheets) of the screen
 */
export function ProfileView({ userId, isOwn, name, username, picture, stage, stats, timeline, timelineLoading, topLeft, topRight, heroActions, names, bio, emptyTimeline, onPhotoPress, storyAction, onEntryLongPress, children }) {
  const insets = useSafeAreaInsets();
  // Tapping the Profile tab again brings one's own page back to the top (only the
  // first page of a tab's stack listens)
  const scroller = useRef(null);
  useScrollToTop(scroller);
  const { height: windowHeight } = useWindowDimensions();
  const tabBarHeight = useTabBarHeight();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const links = useTabLinks();
  const { position } = useEvents();
  const { avatar, catalog, status, error, reload } = useUserAvatar(isOwn ? undefined : userId);
  const [turning, setTurning] = useState(false);
  const [scrollY] = useState(() => new Animated.Value(0));
  const heroHeight = Math.round(windowHeight * HERO_SHARE);
  const accent = stage.accent;

  // Since iOS 26 a swipe to the right from anywhere goes back: over someone's avatar it
  // would take the page away from the finger turning it. There, only the edge of the screen
  // goes back (the system's own swipe, always on); from anywhere below it, a swipe does.
  const navigation = useNavigation();
  const [scrolled, setScrolled] = useState(0);
  const heroBottom = Math.max(0, heroHeight - OVERLAP - scrolled);
  useLayoutEffect(() => {
    if (!isOwn) navigation.setOptions({ gestureResponseDistance: { top: heroBottom } });
  }, [navigation, isOwn, heroBottom]);
  const onScrollSettled = useCallback((event) => setScrolled(Math.max(0, event.nativeEvent.contentOffset.y)), []);

  const openEntry = useCallback((entry) => {
    if (entry.event) router.push(links.event(entry.event.id));
    else if (entry.person && !entry.withYou) router.push(links.user(entry.person.id, { username: entry.person.username, name: entry.person.name }));
  }, [links]);

  // Past the world, a glass bar with the name covers the top (nothing scrolls bare
  // under the clock); the status bar reads over the backdrop, then over the bar
  const barFrom = heroHeight - OVERLAP - insets.top - 56;
  const barOpacity = scrollY.interpolate({ inputRange: [barFrom, barFrom + 24], outputRange: [0, 1], extrapolate: 'clamp' });
  const [pastHero, setPastHero] = useState(false);
  useEffect(() => {
    const id = scrollY.addListener(({ value }) => setPastHero(value > barFrom + 12));
    return () => scrollY.removeListener(id);
  }, [scrollY, barFrom]);
  const darkSky = isDarkColor(stage.theme.sky[0]);
  useFocusEffect(useCallback(() => {
    setStatusBarStyle(pastHero ? 'auto' : darkSky ? 'light' : 'dark');
    return () => setStatusBarStyle('auto');
  }, [darkSky, pastHero]));

  const onScroll = useMemo(() => Animated.event([{ nativeEvent: { contentOffset: { y: scrollY } } }], { useNativeDriver: true }), [scrollY]);
  const heroMotion = {
    transform: [
      { translateY: scrollY.interpolate({ inputRange: [-heroHeight, 0, heroHeight], outputRange: [-heroHeight / 2, 0, heroHeight * 0.45] }) },
      { scale: scrollY.interpolate({ inputRange: [-heroHeight, 0], outputRange: [1.6, 1], extrapolateRight: 'clamp' }) },
    ],
  };

  return (
    <KeyboardAvoidingView behavior={process.env.EXPO_OS === 'ios' ? 'padding' : undefined} style={styles.page}>
      <Animated.ScrollView
        ref={scroller}
        onScroll={onScroll}
        scrollEventThrottle={16}
        onScrollEndDrag={onScrollSettled}
        onMomentumScrollEnd={onScrollSettled}
        scrollEnabled={!turning}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentContainerStyle={{ paddingBottom: tabBarHeight + 32 }}
      >
        <Animated.View style={[{ height: heroHeight }, heroMotion]}>
          <AvatarView
            avatar={avatar}
            catalog={catalog}
            status={status}
            error={error}
            onRetry={reload}
            stage={stage.theme}
            greeting={stage.greeting}
            greet
            waveOnTap={!isOwn}
            // Per user: after a change of account the previous one's picture never shows
            posterKey={isOwn && userId ? `own:${userId}` : undefined}
            // The user's own: kept (paused out of sight), never started again on return
            persistent={isOwn}
            onTap={isOwn ? () => router.push('/avatar-editor') : undefined}
            onDragChange={setTurning}
            insets={{ top: insets.top + BUTTONS, bottom: OVERLAP + (heroActions ? BUTTONS : 8) }}
            style={StyleSheet.absoluteFill}
          />
          {heroActions ? <View style={[styles.heroActions, { bottom: OVERLAP + HERO_GAP }]}>{heroActions}</View> : null}
        </Animated.View>

        <View style={[styles.sheet, { marginTop: -OVERLAP }]}>
          <View style={styles.identity}>
            <Pressable
              accessibilityRole={onPhotoPress ? 'button' : 'image'}
              accessibilityLabel={onPhotoPress ? 'Change profile photo' : `Photo of ${name}`}
              disabled={!onPhotoPress}
              onPress={onPhotoPress}
              style={({ pressed }) => pressed && styles.pressed}
            >
              <View style={[styles.photo, { borderColor: accent }]}>
                {picture ? (
                  <OfflineImage url={picture} kind="people" priority={priorityOfPerson(userId)} style={styles.photoImage} contentFit="cover" transition={150} />
                ) : (
                  <Text style={[styles.initials, { color: accent }]}>{initials(name)}</Text>
                )}
              </View>
              {onPhotoPress ? (
                <View style={[styles.photoBadge, { backgroundColor: accent }]}>
                  <Ionicons name="camera" size={12} color="#FFFFFF" />
                </View>
              ) : null}
            </Pressable>
            {names ?? <NamesField name={name} username={username} />}
          </View>
          {bio}

          <View style={styles.stats}>
            {stats.map((stat) => (
              <Pressable
                key={stat.label}
                accessibilityRole={stat.onPress ? 'button' : 'text'}
                accessibilityLabel={[stat.text ?? stat.value, stat.label].filter((part) => part != null).join(' ')}
                disabled={!stat.onPress}
                onPress={stat.onPress}
                style={({ pressed }) => [styles.stat, pressed && styles.pressed]}
              >
                <Text style={[styles.statValue, stat.muted ? styles.statValueMuted : { color: accent }]} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.55} maxFontSizeMultiplier={1.2}>{stat.text ?? compactNumber(stat.value)}</Text>
                <Text style={styles.statLabel} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75} maxFontSizeMultiplier={1.2}>{stat.label}</Text>
                {stat.onPress ? <Ionicons name="chevron-forward" size={12} color={colors.inactive} style={styles.statChevron} /> : null}
              </Pressable>
            ))}
          </View>

          <View style={styles.storyHeader}>
            <Text style={styles.sectionTitle} accessibilityRole="header">{isOwn ? 'Your story' : 'Their story'}</Text>
            {storyAction ? (
              <Pressable accessibilityRole="button" hitSlop={10} onPress={storyAction.onPress} style={({ pressed }) => pressed && styles.pressed}>
                <Text style={[styles.storyAction, { color: accent }]}>{storyAction.label}</Text>
              </Pressable>
            ) : null}
          </View>
          {timeline.length || timelineLoading ? timeline.map((section) => (
            <View key={section.key} style={styles.section}>
              <Text style={styles.month}>{section.title}</Text>
              {section.data.map((entry, index) => (
                <TimelineItem
                  key={entry.key}
                  entry={entry}
                  own={isOwn}
                  accent={accent}
                  position={position}
                  last={index === section.data.length - 1}
                  onPress={openEntry}
                  onLongPress={onEntryLongPress}
                />
              ))}
            </View>
          )) : (
            <View style={styles.empty}>
              <Text style={styles.emptyTitle}>{emptyTimeline.title}</Text>
              <Text style={styles.emptyText}>{emptyTimeline.message}</Text>
            </View>
          )}
        </View>
      </Animated.ScrollView>

      <Animated.View style={[styles.glassBar, { height: insets.top + 50, opacity: barOpacity }]} pointerEvents="none">
        <GlassFill />
        <Text style={[styles.barTitle, { top: insets.top + 14 }]} numberOfLines={1}>{name}</Text>
      </Animated.View>
      {children}
      <View style={[styles.topBar, { top: insets.top + 6 }]} pointerEvents="box-none">
        <View>{topLeft}</View>
        <View>{topRight}</View>
      </View>
    </KeyboardAvoidingView>
  );
}

export function HeroButton(props) {
  return <GlassButton size={HERO_BUTTON} {...props} />;
}

// The notifications' bell over the world, with how many are new
export function BellButton({ count, onPress }) {
  const colors = useColors();
  return (
    <View>
      <HeroButton icon={count ? 'notifications' : 'notifications-outline'} accessibilityLabel={count ? `Notifications, ${count} new` : 'Notifications'} onPress={onPress} />
      {count ? (
        <View pointerEvents="none" style={[bellStyles.badge, { backgroundColor: colors.error, borderColor: colors.page }]}>
          <Text style={bellStyles.badgeText}>{count > 99 ? '99+' : count}</Text>
        </View>
      ) : null}
    </View>
  );
}

const bellStyles = StyleSheet.create({
  badge: {
    position: 'absolute',
    top: -4,
    right: -4,
    minWidth: 20,
    height: 20,
    paddingHorizontal: 5,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: '#FFFFFF',
  },
});

const createStyles = (colors) => StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: colors.page,
  },
  heroActions: {
    position: 'absolute',
    left: 0,
    right: 0,
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 10,
  },
  glassBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.barEdge,
    overflow: 'hidden',
  },
  barTitle: {
    position: 'absolute',
    left: 72,
    right: 72,
    textAlign: 'center',
    fontSize: 17,
    fontWeight: '700',
    color: colors.active,
  },
  topBar: {
    position: 'absolute',
    left: 16,
    right: 16,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
  sheet: {
    paddingHorizontal: 20,
    paddingTop: 22,
    gap: 14,
    borderTopLeftRadius: OVERLAP,
    borderTopRightRadius: OVERLAP,
    borderCurve: 'continuous',
    backgroundColor: colors.page,
  },
  identity: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
  },
  photo: {
    width: 58,
    height: 58,
    borderRadius: 29,
    borderWidth: 2,
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  photoImage: {
    width: '100%',
    height: '100%',
  },
  initials: {
    fontSize: 22,
    fontWeight: '700',
  },
  stats: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 4,
  },
  // The three tiles alike: number and name centred, whatever the width of the phone
  stat: {
    flex: 1,
    minHeight: 84,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 12,
    paddingHorizontal: 8,
    borderRadius: 18,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
    gap: 2,
  },
  statValue: {
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '800',
    letterSpacing: -0.8,
    fontVariant: ['tabular-nums'],
  },
  // Not a number yet: quieter, on the same line as the others' numbers
  statValueMuted: {
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.2,
    color: colors.inactive,
  },
  statChevron: {
    position: 'absolute',
    top: 10,
    right: 10,
  },
  pressed: {
    opacity: 0.7,
  },
  photoBadge: {
    position: 'absolute',
    right: -2,
    bottom: -2,
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 2,
    borderColor: colors.page,
    alignItems: 'center',
    justifyContent: 'center',
  },
  statLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.inactive,
  },
  storyHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  storyAction: {
    fontSize: 15,
    fontWeight: '600',
    // Level with the title (which keeps its own space above)
    marginTop: 14,
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: '800',
    letterSpacing: -0.4,
    color: colors.active,
    marginTop: 14,
  },
  section: {
    gap: 10,
  },
  month: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.inactive,
    marginTop: 4,
  },
  empty: {
    paddingVertical: 24,
    gap: 6,
    alignItems: 'center',
  },
  emptyTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.active,
  },
  emptyText: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    color: colors.inactive,
  },
});
