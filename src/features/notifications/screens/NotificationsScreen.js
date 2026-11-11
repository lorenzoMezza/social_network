// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { IconButton } from '../../../components/ui/IconButton';
import { CategoryTile } from '../../events/components/CategoryTile';
import { EmptyState, ErrorState } from '../../../components/ui/StateViews';
import { PersonAvatar } from '../../social/components/PersonAvatar';
import { formatChatTime } from '../../social/model/format';
import { useNotifications } from '../state/NotificationsProvider';
import { notificationLink, notificationText } from '../model/notificationModel';

// The notifications panel, from the bell on the user's profile: only what matters
// (docs/API.md, Notifications), newest first. Seen when opened: the count goes at
// once, the dots of the new ones stay until the panel is left.
export function NotificationsScreen() {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { items, status, error, refresh, markRead, settle, setPanelOpen } = useNotifications();
  const [refreshing, setRefreshing] = useState(false);
  const pull = useCallback(async () => {
    setRefreshing(true);
    await refresh();
    setRefreshing(false);
  }, [refresh]);

  useFocusEffect(useCallback(() => {
    markRead();
    // While it is on screen, what arrives is read as it arrives (no badge left behind)
    setPanelOpen(true);
    return () => {
      setPanelOpen(false);
      settle();
    };
  }, [markRead, settle, setPanelOpen]));

  const back = () => (router.canGoBack() ? router.back() : router.replace('/profile'));
  const open = (item) => {
    const link = notificationLink(item);
    if (link) router.push(link);
  };

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <IconButton icon="chevron-back" label="Back" onPress={back} />
        <Text style={styles.title} accessibilityRole="header">Notifications</Text>
        <View style={styles.spacer} />
      </View>
      <FlatList
        data={items}
        keyExtractor={(item) => item.id}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }, !items.length && styles.fill]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pull} tintColor={colors.inactive} />}
        renderItem={({ item }) => <Row item={item} styles={styles} colors={colors} onPress={open} />}
        ItemSeparatorComponent={Gap}
        ListEmptyComponent={status === 'error' ? (
          <ErrorState error={error} subject="Notifications" onRetry={pull} />
        ) : status === 'ready' ? (
          <EmptyState
            icon="notifications-outline"
            title="Nothing new"
            message="People joining your events, changes to the events you join and requests to connect show up here."
          />
        ) : <ActivityIndicator color={colors.inactive} style={styles.loading} />}
      />
    </View>
  );
}

// The new ones stand on a tint: air between them, or they read as one block
const Gap = () => <View style={GAP} />;
const GAP = { height: 8 };

function Row({ item, styles, colors, onPress }) {
  const { text, icon } = notificationText(item);
  const actor = item.actors[0];
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.read ? '' : 'New. '}${text}. ${formatChatTime(item.at)}`}
      onPress={() => onPress(item)}
      style={({ pressed }) => [styles.row, !item.read && styles.rowNew, pressed && styles.pressed]}
    >
      <View style={styles.lead}>
        {actor ? <PersonAvatar person={actor} size={44} /> : item.event ? <CategoryTile event={item.event} size={44} /> : (
          <View style={styles.iconTile}><Ionicons name={icon} size={22} color={colors.accent} /></View>
        )}
        {actor || item.event ? (
          <View style={styles.kindBadge}><Ionicons name={icon} size={11} color={colors.onAccent} /></View>
        ) : null}
      </View>
      <View style={styles.body}>
        <Text style={[styles.text, !item.read && styles.textNew]} numberOfLines={3}>{text}</Text>
        <Text style={styles.time}>{formatChatTime(item.at)}</Text>
      </View>
      {item.read ? null : <View style={styles.dot} accessibilityElementsHidden />}
    </Pressable>
  );
}

const createStyles = (colors) => StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: colors.page,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.active,
  },
  spacer: {
    width: 40,
  },
  content: {
    paddingHorizontal: 12,
    paddingTop: 4,
  },
  fill: {
    flexGrow: 1,
  },
  loading: {
    paddingVertical: 32,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 12,
    paddingVertical: 12,
    borderRadius: 16,
    borderCurve: 'continuous',
  },
  // New ones stand on a faint tint of the accent
  rowNew: {
    backgroundColor: colors.accentSoft,
  },
  pressed: {
    opacity: 0.6,
  },
  lead: {
    width: 44,
    height: 44,
  },
  iconTile: {
    width: 44,
    height: 44,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft,
  },
  kindBadge: {
    position: 'absolute',
    right: -4,
    bottom: -4,
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    borderColor: colors.page,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  body: {
    flex: 1,
    gap: 3,
  },
  text: {
    fontSize: 15,
    lineHeight: 20,
    color: colors.active,
  },
  textNew: {
    fontWeight: '600',
  },
  time: {
    fontSize: 13,
    color: colors.inactive,
  },
  dot: {
    width: 9,
    height: 9,
    borderRadius: 5,
    backgroundColor: colors.accent,
  },
});
