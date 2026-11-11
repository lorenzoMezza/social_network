// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useColors } from '../../theme/colors';
import { shortDayFormatter } from '../../lib/dateFormatters';
import { IconButton } from '../../components/ui/IconButton';
import { useTabBarHeight } from '../../components/navigation/tabBarHeight';
import { useTabLinks } from '../../components/navigation/useTabLinks';
import { CategoryTile } from '../events/components/CategoryTile';
import { EmptyState, ErrorState, ListSkeleton } from '../../components/ui/StateViews';
import { useEvents } from '../events/state/EventsProvider';
import { useOrganizedEvents } from './state/profileData';

const thisYear = new Date().getFullYear();
const yearFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
const formatDate = (date) => (date.getFullYear() === thisYear ? shortDayFormatter : yearFormat).format(date);

// The events a user organized (from the Events tile of a profile), newest first, each
// with how many people took part: "went" once it is over, "going" before. A tap opens
// the event.
export function OrganizedEventsScreen({ id, name }) {
  const insets = useSafeAreaInsets();
  const tabBarHeight = useTabBarHeight();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const links = useTabLinks();
  const { user } = useEvents();
  const { list, loading, error, reload } = useOrganizedEvents(id);
  const isOwn = !!id && id === user?.id;
  const back = () => (router.canGoBack() ? router.back() : router.replace('/profile'));

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <IconButton icon="chevron-back" label="Back" onPress={back} />
        <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>{loading ? 'Organized' : `Organized · ${list.length}`}</Text>
        <View style={styles.spacer} />
      </View>
      <FlatList
        data={list}
        keyExtractor={(item) => item.event.id}
        contentContainerStyle={[styles.content, { paddingBottom: (links.tab ? tabBarHeight : insets.bottom) + 24 }]}
        ListEmptyComponent={loading ? <ListSkeleton count={4} label="Loading events" /> : error ? (
          <ErrorState error={error} onRetry={reload} />
        ) : (
          <EmptyState
            icon="calendar-outline"
            title="No events yet"
            message={isOwn ? 'The events you organize show up here, with how many people came.' : `${name ? `${name} has` : 'They have'} not organized anything yet.`}
            actionLabel={isOwn ? 'Create an event' : undefined}
            onAction={() => router.push('/event-editor')}
          />
        )}
        renderItem={({ item: { event, people, past } }) => {
          const label = past ? 'went' : 'going';
          return (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${event.title}, ${formatDate(new Date(event.dates.startDate))}, ${people} ${people === 1 && past ? 'person' : 'people'} ${label}`}
              onPress={() => router.push(links.event(event.id))}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            >
              <View style={past && styles.faded}>
                <CategoryTile event={event} size={44} />
              </View>
              <View style={styles.text}>
                <Text style={styles.name} numberOfLines={2}>{event.title}</Text>
                <Text style={styles.meta} numberOfLines={1}>{past ? formatDate(new Date(event.dates.startDate)) : `Coming up · ${formatDate(new Date(event.dates.startDate))}`}</Text>
              </View>
              <View style={styles.people}>
                <View style={styles.count}>
                  <Ionicons name="people-outline" size={14} color={colors.inactive} />
                  <Text style={styles.countValue}>{people}</Text>
                </View>
                <Text style={styles.countLabel}>{label}</Text>
              </View>
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
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  title: {
    flexShrink: 1,
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  pressed: {
    opacity: 0.6,
  },
  faded: {
    opacity: 0.5,
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
  people: {
    alignItems: 'flex-end',
  },
  count: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  countValue: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.active,
    fontVariant: ['tabular-nums'],
  },
  countLabel: {
    fontSize: 12,
    color: colors.inactive,
  },
});
