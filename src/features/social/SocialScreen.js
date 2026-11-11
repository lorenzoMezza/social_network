// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useScrollToTop } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../theme/colors';
import { useTabBarHeight } from '../../components/navigation/tabBarHeight';
import { IconButton } from '../../components/ui/IconButton';
import { tapFeedback } from '../../lib/haptics';
import { SearchBar } from '../../components/ui/SearchBar';
import { EmptyState } from '../../components/ui/StateViews';
import { useSocial } from './state/SocialProvider';
import { ChatRow } from './components/ChatRow';
import { PersonAvatar } from './components/PersonAvatar';
import { distanceMeters, formatDistance } from '../events/model/eventModel';
import { useHere } from '../map/state/nearbyPeople';

const FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'direct', label: 'People' },
  { key: 'group', label: 'Groups' },
  { key: 'event', label: 'Events' },
];

// Social: the people around and the chats. At the top, who is nearby right now (the
// only people one can write to without being connected; a green ring); then the
// inbox, newest first, filtered by kind. Connect (by QR code) and new
// groups from the header.
export function SocialScreen() {
  const insets = useSafeAreaInsets();
  // Tapping its tab again brings the list back to the top
  const scroller = useRef(null);
  useScrollToTop(scroller);
  const tabBarHeight = useTabBarHeight();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { me, people, nearby, chats, isConnection, isNearby, openDirect, status, refresh } = useSocial();
  // Who the map shows around the user right now, nearest first
  const here = useHere();
  const around = useMemo(() => nearby
    .map((person) => ({ ...person, metres: distanceMeters(here, person.position) }))
    .sort((a, b) => (a.metres ?? Infinity) - (b.metres ?? Infinity)), [nearby, here]);
  const [filter, setFilter] = useState('all');
  const [query, setQuery] = useState('');

  const shown = useMemo(() => {
    const words = query.trim().toLowerCase();
    // A direct chat nobody wrote in yet is not a conversation: someone who opened it and
    // wrote nothing leaves no trace in the other's list
    return chats.filter((chat) => (chat.kind !== 'direct' || chat.last)
      && (filter === 'all' || chat.kind === filter)
      && (!words || (chat.title ?? '').toLowerCase().includes(words) || (chat.with?.username ?? '').toLowerCase().includes(words)));
  }, [chats, filter, query]);

  const openChat = useCallback((chat) => router.push({ pathname: '/chat/[id]', params: { id: chat.id } }), []);
  const message = (userId) => {
    tapFeedback();
    openDirect(userId)
      .then((id) => router.push({ pathname: '/chat/[id]', params: { id } }))
      .catch(() => Alert.alert('You can\'t write to them right now'));
  };

  const [refreshing, setRefreshing] = useState(false);
  const pullToRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await refresh();
    } finally {
      setRefreshing(false);
    }
  }, [refresh]);

  const renderItem = useCallback(({ item }) => (
    <ChatRow chat={item} people={people} me={me} nearby={item.kind === 'direct' && isNearby(item.with?.id)} onPress={openChat} />
  ), [people, me, isNearby, openChat]);

  const header = (
    <View style={styles.listHeader}>
      {around.length && !query ? (
        <View style={styles.nearby}>
          <View style={styles.sectionRow}>
            <View style={[styles.liveDot, { backgroundColor: colors.live }]} />
            <Text style={styles.sectionTitle}>Nearby now</Text>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.nearbyList} style={styles.nearbyScroller}>
            {around.map((person) => {
              const connection = isConnection(person.userId);
              // The same words as on the map's card
              const distance = formatDistance(person.metres) ?? '';
              return (
                <Pressable
                  key={person.userId}
                  accessibilityRole="button"
                  accessibilityLabel={`${person.name}${distance ? `, ${distance} away` : ''}. Send a message`}
                  onPress={() => message(person.userId)}
                  style={({ pressed }) => [styles.nearbyPerson, pressed && styles.pressed]}
                >
                  <PersonAvatar
                    username={person.username}
                    name={person.name}
                    picture={person.pictureUrl}
                    size={58}
                    ring
                    badge={connection ? (
                      <View style={[styles.connectedBadge, { backgroundColor: colors.accent }]}>
                        <Ionicons name="link" size={10} color={colors.onAccent} />
                      </View>
                    ) : null}
                  />
                  <Text style={styles.nearbyName} numberOfLines={1}>{(person.name || person.username || 'Someone').split(' ')[0]}</Text>
                  <Text style={styles.nearbyDistance}>{person.precision === 'area' ? 'around' : distance}</Text>
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
      <View style={styles.filters}>
        {FILTERS.map((entry) => {
          const selected = entry.key === filter;
          const count = entry.key === 'all' ? 0 : chats.filter((chat) => chat.kind === entry.key && chat.unread).length;
          return (
            <Pressable
              key={entry.key}
              accessibilityRole="tab"
              accessibilityState={{ selected }}
              onPress={() => {
                if (selected) return;
                tapFeedback();
                setFilter(entry.key);
              }}
              style={[styles.filter, selected && styles.filterSelected]}
            >
              <Text style={[styles.filterLabel, selected && styles.filterLabelSelected]}>{entry.label}</Text>
              {count ? <View style={[styles.filterDot, { backgroundColor: selected ? colors.onAccent : colors.accent }]} /> : null}
            </Pressable>
          );
        })}
      </View>
    </View>
  );

  return (
    <View style={[styles.page, { paddingTop: insets.top + 6 }]}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.title} accessibilityRole="header">Social</Text>
          <View style={styles.actions}>
            <IconButton icon="qr-code-outline" label="Connect with someone" size={36} onPress={() => router.push('/connect')} />
            <IconButton icon="add" label="New group" size={36} onPress={() => router.push('/new-group')} />
          </View>
        </View>
        <SearchBar value={query} onChangeText={setQuery} placeholder="Search chats" />
      </View>
      <FlatList
        ref={scroller}
        data={shown}
        keyExtractor={(chat) => chat.id}
        renderItem={renderItem}
        ListHeaderComponent={header}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={pullToRefresh} tintColor={colors.inactive} />}
        ListEmptyComponent={status !== 'ready' && !query ? (
          status === 'error' ? (
            <EmptyState icon="cloud-offline-outline" title="Chats did not load" message="Check your connection, then try again." actionLabel="Try again" onAction={refresh} />
          ) : <ActivityIndicator color={colors.inactive} style={styles.loading} />
        ) : (
          <EmptyState
            icon={query ? 'search' : 'chatbubbles-outline'}
            title={query ? 'No chats found' : filter === 'event' ? 'No event chats' : filter === 'group' ? 'No groups yet' : 'No chats yet'}
            message={query ? `Nothing matches "${query.trim()}".` : filter === 'event'
              ? 'Join an event and its chat appears here until the event ends.'
              : filter === 'group' ? 'Start a group with your connections.' : 'Write to someone nearby, or connect with a friend.'}
            actionLabel={filter === 'group' && !query ? 'New group' : undefined}
            onAction={() => router.push('/new-group')}
          />
        )}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.listContent, { paddingBottom: tabBarHeight + 24 }]}
      />
    </View>
  );
}

const createStyles = (colors) => StyleSheet.create({
  loading: {
    paddingVertical: 32,
  },
  page: {
    flex: 1,
    backgroundColor: colors.page,
  },
  header: {
    paddingHorizontal: 20,
    gap: 12,
    paddingBottom: 6,
  },
  titleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 30,
    fontWeight: '700',
    letterSpacing: -0.6,
    color: colors.active,
  },
  actions: {
    flexDirection: 'row',
    gap: 8,
  },
  listContent: {
    paddingHorizontal: 20,
    flexGrow: 1,
  },
  listHeader: {
    gap: 14,
    paddingTop: 8,
    paddingBottom: 6,
  },
  nearby: {
    gap: 10,
  },
  sectionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
  },
  liveDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  sectionTitle: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.active,
  },
  nearbyScroller: {
    marginHorizontal: -20,
  },
  nearbyList: {
    paddingHorizontal: 20,
    gap: 14,
  },
  nearbyPerson: {
    width: 64,
    alignItems: 'center',
    gap: 4,
  },
  connectedBadge: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: 'center',
    justifyContent: 'center',
  },
  nearbyName: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.active,
  },
  nearbyDistance: {
    fontSize: 11,
    color: colors.inactive,
    marginTop: -3,
  },
  pressed: {
    opacity: 0.6,
  },
  filters: {
    flexDirection: 'row',
    gap: 8,
  },
  filter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 32,
    paddingHorizontal: 14,
    borderRadius: 16,
    backgroundColor: colors.surface,
  },
  filterSelected: {
    backgroundColor: colors.accent,
  },
  filterLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.active,
  },
  filterLabelSelected: {
    color: colors.onAccent,
  },
  filterDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
