// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, SectionList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { IconButton } from '../../../components/ui/IconButton';
import { useTabBarHeight } from '../../../components/navigation/tabBarHeight';
import { useTabLinks } from '../../../components/navigation/useTabLinks';
import { SearchBar } from '../../../components/ui/SearchBar';
import { EmptyState } from '../../../components/ui/StateViews';
import { useUserConnections } from '../../profile/state/profileData';
import { PersonAvatar } from '../components/PersonAvatar';

// Someone else's connections (GET /users/{id}/connections): the ones the user shares
// with them first ("In common"), then the others, by name. A tap opens a profile.
export function TheirConnectionsScreen({ id, name }) {
  const insets = useSafeAreaInsets();
  const tabBarHeight = useTabBarHeight();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const links = useTabLinks();
  const { list, total, mutual, loading, error, reload } = useUserConnections(id);
  const [query, setQuery] = useState('');
  const who = name || null;

  const sections = useMemo(() => {
    const words = query.trim().toLowerCase();
    const shown = list.filter(({ user }) => !words || (user.username ?? '').includes(words) || (user.name ?? '').toLowerCase().includes(words));
    const common = shown.filter((entry) => entry.mutual);
    const others = shown.filter((entry) => !entry.mutual);
    if (!common.length) return others.length ? [{ key: 'all', title: null, data: others }] : [];
    return [
      { key: 'common', title: `In common · ${common.length}`, data: common },
      ...(others.length ? [{ key: 'others', title: 'Others', data: others }] : []),
    ];
  }, [list, query]);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/'));

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <IconButton icon="chevron-back" label="Back" onPress={back} />
        <View style={styles.heading}>
          <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>
            {who ? `${who}'s connections` : 'Connections'}
          </Text>
          {total != null ? <Text style={styles.subtitle}>{`${total} in all${mutual ? ` · ${mutual} in common` : ''}`}</Text> : null}
        </View>
        <View style={styles.spacer} />
      </View>
      <SectionList
        sections={sections}
        keyExtractor={(entry) => entry.user.id}
        stickySectionHeadersEnabled={false}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingBottom: (tabBarHeight || insets.bottom) + 24 }]}
        ListHeaderComponent={list.length > 8 ? <View style={styles.search}><SearchBar value={query} onChangeText={setQuery} placeholder="Search" /></View> : null}
        renderSectionHeader={({ section }) => (section.title ? <Text style={styles.section}>{section.title}</Text> : null)}
        ListEmptyComponent={loading ? <ActivityIndicator color={colors.inactive} style={styles.loading} /> : error ? (
          <EmptyState icon="cloud-offline-outline" title="Could not load" message="Check your connection, then try again." actionLabel="Try again" onAction={reload} />
        ) : (
          <EmptyState icon="link-outline" title={query ? 'Nobody found' : 'No connections yet'} message={query ? undefined : `${who ? `${who} has` : 'They have'} not connected with anyone yet.`} />
        )}
        renderItem={({ item }) => {
          const person = item.user;
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${person.name}${item.mutual ? ', in common' : ''}`}
              onPress={() => router.push(links.user(person.id, { username: person.username, name: person.name }))}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            >
              <PersonAvatar person={person} size={48} />
              <View style={styles.text}>
                <Text style={styles.name} numberOfLines={1}>{person.name}</Text>
                <Text style={styles.meta} numberOfLines={1}>@{person.username}</Text>
              </View>
              {item.mutual ? <Ionicons name="link" size={16} color={colors.accent} accessibilityElementsHidden /> : null}
              <Ionicons name="chevron-forward" size={16} color={colors.inactive} />
            </Pressable>
          );
        }}
      />
    </View>
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
  heading: {
    flex: 1,
    alignItems: 'center',
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.active,
  },
  subtitle: {
    fontSize: 12,
    color: colors.inactive,
    marginTop: 1,
  },
  spacer: {
    width: 40,
  },
  content: {
    paddingHorizontal: 20,
  },
  search: {
    paddingVertical: 8,
  },
  section: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.inactive,
    paddingTop: 18,
    paddingBottom: 6,
  },
  loading: {
    paddingVertical: 32,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 10,
  },
  pressed: {
    opacity: 0.6,
  },
  text: {
    flex: 1,
    gap: 2,
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
});
