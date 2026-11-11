// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useColors } from '../../../theme/colors';
import { IconButton } from '../../../components/ui/IconButton';
import { useTabBarHeight } from '../../../components/navigation/tabBarHeight';
import { useTabLinks } from '../../../components/navigation/useTabLinks';
import { SearchBar } from '../../../components/ui/SearchBar';
import { EmptyState } from '../../../components/ui/StateViews';
import { useSocial } from '../state/SocialProvider';
import { PersonAvatar } from '../components/PersonAvatar';
import { formatSince } from '../model/format';

// A list of people: the user's connections (newest first, how and where they met;
// a tap opens the profile, the chat bubble a chat), or the people they blocked
// (`blocked`, each with Unblock)
export function PeopleListScreen({ blocked: showBlocked = false }) {
  const insets = useSafeAreaInsets();
  const tabBarHeight = useTabBarHeight();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const links = useTabLinks();
  const { connections, blocks, unblock, openDirect, isNearby, status, refresh } = useSocial();
  const [query, setQuery] = useState('');

  // Entries of the API: { user, since, how?, place? }
  const list = useMemo(() => {
    const words = query.trim().toLowerCase();
    const entries = showBlocked ? blocks : connections;
    return entries.filter(({ user }) => !words || (user.username ?? '').includes(words) || (user.name ?? '').toLowerCase().includes(words));
  }, [showBlocked, blocks, connections, query]);

  const message = (userId) => openDirect(userId)
    .then((chatId) => router.push({ pathname: '/chat/[id]', params: { id: chatId } }))
    .catch(() => Alert.alert('You can\'t write to them right now'));

  const back = () => (router.canGoBack() ? router.back() : router.replace('/profile'));

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <IconButton icon="chevron-back" label="Back" onPress={back} />
        <Text style={styles.title} accessibilityRole="header">{showBlocked ? 'Blocked people' : `Connections · ${connections.length}`}</Text>
        {showBlocked ? <View style={styles.spacer} /> : (
          <IconButton icon="qr-code-outline" label="Connect with someone" onPress={() => router.push('/connect')} />
        )}
      </View>
      <FlatList
        data={list}
        keyExtractor={(entry) => entry.user.id}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingBottom: (showBlocked ? insets.bottom : tabBarHeight) + 24 }]}
        ListHeaderComponent={!showBlocked && connections.length > 6 ? (
          <View style={styles.search}><SearchBar value={query} onChangeText={setQuery} placeholder="Search connections" /></View>
        ) : showBlocked && blocks.length ? (
          <Text style={styles.note}>Blocked people cannot find you nearby, message you or connect with you. They are not told.</Text>
        ) : null}
        ListEmptyComponent={status !== 'ready' && !query ? (
          status === 'error'
            ? <EmptyState icon="cloud-offline-outline" title="Could not load" message="Check your connection, then try again." actionLabel="Try again" onAction={refresh} />
            : <ActivityIndicator color={colors.inactive} style={styles.loading} />
        ) : showBlocked
          ? <EmptyState icon="hand-left-outline" title="Nobody blocked" message="People you block appear here, and you can unblock them." />
          : (
            <EmptyState
              icon="link-outline"
              title={query ? 'Nobody found' : 'No connections yet'}
              message={query ? undefined : 'Connect with friends in person: scan their code, or let them scan yours.'}
              actionLabel={query ? undefined : 'Connect'}
              onAction={() => router.push('/connect')}
            />
          )}
        renderItem={({ item }) => {
          const person = item.user;
          return (
            <Pressable
              accessibilityRole="button"
              onPress={() => router.push(links.user(person.id, { username: person.username, name: person.name }))}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            >
              <PersonAvatar person={person} size={48} ring={!showBlocked && isNearby(person.id)} />
              <View style={styles.text}>
                <Text style={styles.name} numberOfLines={1}>{person.name}</Text>
                <Text style={styles.meta} numberOfLines={1}>
                  {showBlocked ? `@${person.username}` : `Connected ${formatSince(item.since)}`}
                </Text>
                {/* Where you met, on its own line */}
                {!showBlocked && item.place ? <Text style={styles.meta} numberOfLines={1}>{item.place}</Text> : null}
              </View>
              {showBlocked ? (
                <Pressable accessibilityRole="button" onPress={() => unblock(person.id).catch(() => {})} style={({ pressed }) => [styles.unblock, pressed && styles.pressed]}>
                  <Text style={styles.unblockLabel}>Unblock</Text>
                </Pressable>
              ) : (
                <IconButton
                  icon="chatbubble-outline"
                  label={`Message ${person.name}`}
                  size={38}
                  onPress={() => message(person.id)}
                />
              )}
            </Pressable>
          );
        }}
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
    paddingHorizontal: 20,
    flexGrow: 1,
  },
  search: {
    paddingBottom: 10,
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.inactive,
    paddingBottom: 10,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  pressed: {
    opacity: 0.6,
  },
  text: {
    flex: 1,
  },
  name: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.active,
  },
  meta: {
    fontSize: 13,
    color: colors.inactive,
  },
  unblock: {
    height: 32,
    paddingHorizontal: 14,
    borderRadius: 16,
    justifyContent: 'center',
    backgroundColor: colors.pill,
  },
  unblockLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.active,
  },
});
