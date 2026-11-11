// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, RefreshControl, SectionList, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useScrollToTop } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { useTabBarHeight } from '../../../components/navigation/tabBarHeight';
import { useTabLinks } from '../../../components/navigation/useTabLinks';
import { IconButton } from '../../../components/ui/IconButton';
import { tapFeedback } from '../../../lib/haptics';
import { useEvents } from '../state/EventsProvider';
import { EventRow } from '../components/EventRow';
import { FilterBar } from '../components/FilterBar';
import { SearchBar } from '../../../components/ui/SearchBar';
import { SegmentedTabs } from '../../../components/ui/SegmentedTabs';
import { EmptyState, ErrorState, ListSkeleton } from '../../../components/ui/StateViews';
import { STATUS, activeFilterCount, applyLocalFilters, cancelledBeforeStart, eventStatus, groupByDay, isPast, matchesSearch } from '../model/eventModel';
import { useAlbums } from '../../album/state/AlbumsProvider';
import { sponsoredFirst } from '../../promotions/model/promotionModel';
import { failureMessage } from '../../api/failureMessage';

const TABS = [
  { key: 'nearby', label: 'Nearby' },
  { key: 'following', label: 'Saved' },
  { key: 'mine', label: 'Yours' },
];
const SUGGESTIONS = 3;

// Events around the user, the saved ones and the user's own, one list at a time,
// grouped by day. Search first, at the top; the filters (a button next to it, and in
// words above the list once changed) apply to the events nearby. Events and organizers
// open inside this tab.
export function EventsScreen() {
  const insets = useSafeAreaInsets();
  // Tapping its tab again brings the list back to the top
  const scroller = useRef(null);
  useScrollToTop(scroller);
  const tabBarHeight = useTabBarHeight();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { byId, nearby, followed, created, filters, position, user, refreshNearby, refreshOwn, setSaved, isSaved, inSaved, removeFromLists, clearCancelledSaved } = useEvents();

  const [tab, setTab] = useState('nearby');
  const [query, setQuery] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const pick = useCallback((ids) => ids.map((id) => byId[id]).filter(Boolean), [byId]);
  const searched = useCallback((list) => list.filter((event) => matchesSearch(event, query)), [query]);

  const sections = useMemo(() => {
    if (tab === 'nearby') {
      const around = searched(applyLocalFilters(pick(nearby.ids), filters));
      // A search shows what matches, nothing placed above it
      if (query.trim()) return groupByDay(around);
      // The nearest two sponsored events first, marked; any other keeps its place
      const { top, rest } = sponsoredFirst(around, position);
      return [...(top.length ? [{ key: 'sponsored', title: 'Sponsored', data: top }] : []), ...groupByDay(rest)];
    }
    if (tab === 'mine') return groupByDay(searched(pick(created.ids)));
    // Following: the followed events by day, then a few suggestions sharing their
    // categories, then the past ones
    const followedEvents = pick(followed.ids);
    const days = groupByDay(searched(followedEvents));
    const past = days.filter((section) => section.key === 'past');
    const liked = new Set();
    for (const event of followedEvents) {
      for (const category of event.categories ?? []) liked.add(category);
    }
    // Never the user's own, nor what they already have
    const suggested = query ? [] : pick(nearby.ids)
      .filter((event) => !inSaved(event.id) && event.creatorId !== user?.id && !isPast(event))
      .map((event) => ({ event, score: (event.categories ?? []).filter((category) => liked.has(category)).length }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, SUGGESTIONS)
      .map(({ event }) => event);
    return [
      ...days.filter((section) => section.key !== 'past'),
      ...(suggested.length ? [{ key: 'suggested', title: 'You might like', data: suggested }] : []),
      ...past,
    ];
  }, [tab, searched, pick, nearby.ids, followed.ids, created.ids, filters, inSaved, user, query, position]);

  const list = { nearby, following: followed, mine: created }[tab];

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    await (tab === 'nearby' ? refreshNearby() : refreshOwn());
    setRefreshing(false);
  }, [tab, refreshNearby, refreshOwn]);

  const links = useTabLinks();
  // The same handlers for every card (they get the event): saving one re-renders only it
  const openEvent = useCallback((event) => router.push(links.event(event.id)), [links]);
  const openOrganizer = useCallback((event) => router.push(links.user(event.creatorId, { username: event.creator?.username, name: event.creator?.name })), [links]);
  const toggleSave = useCallback((event, saved) => {
    tapFeedback();
    setSaved(event.id, !saved).catch(() => {});
  }, [setSaved]);
  // Only an event cancelled before it began leaves the lists: one that took place stays
  const removeEvent = useCallback((event) => {
    tapFeedback();
    removeFromLists(event.id).catch((error) => Alert.alert('Could not remove it', failureMessage(error)));
  }, [removeFromLists]);
  const clearCancelled = useCallback(() => {
    Alert.alert('Clear cancelled events?', 'Events cancelled before they began leave your Saved list.', [
      { text: 'Keep them', style: 'cancel' },
      { text: 'Clear', style: 'destructive', onPress: () => clearCancelledSaved().catch((error) => Alert.alert('Could not clear them', failureMessage(error))) },
    ]);
  }, [clearCancelledSaved]);
  const createEvent = () => router.push('/event-editor');
  const openFilters = () => router.push('/event-filters');

  // Past events show their photos; the user's own, with none yet, ask for them
  const { photoCountOf } = useAlbums();
  const inSavedTab = tab === 'following';
  const removableTab = inSavedTab || tab === 'mine';
  const renderItem = useCallback(({ item, section }) => {
    const isOwn = !!user && item.creatorId === user.id;
    const ended = eventStatus(item) === STATUS.concluded;
    const photoCount = ended ? photoCountOf(item) : 0;
    return (
      <EventRow
        event={item}
        position={position}
        saved={isSaved(item.id)}
        isOwn={isOwn}
        photoCount={photoCount}
        photoInvite={ended && isOwn && !photoCount}
        showDay={section.key === 'sponsored'}
        onPress={openEvent}
        onToggleSave={toggleSave}
        onRemove={removableTab && cancelledBeforeStart(item) ? removeEvent : undefined}
        removeLabel={inSavedTab ? 'Remove from Saved' : 'Remove from your events'}
        onOpenOrganizer={openOrganizer}
      />
    );
  }, [position, isSaved, user, photoCountOf, openEvent, toggleSave, openOrganizer, inSavedTab, removableTab, removeEvent]);

  const empty = () => {
    // Events kept on the phone show while the server answers (EventsProvider)
    if ((list.status === 'idle' || list.status === 'loading') && list.ids.length === 0) return <ListSkeleton label="Loading events" />;
    if (list.status === 'error' && list.ids.length === 0) return <ErrorState error={list.error} onRetry={onRefresh} />;
    if (query.trim()) {
      return <EmptyState icon="search" title="No results" message={`No event matches "${query.trim()}".`} actionLabel="Clear search" onAction={() => setQuery('')} />;
    }
    if (tab === 'nearby') {
      return (
        <EmptyState
          icon="calendar-clear-outline"
          title="Nothing around you"
          message="No events nearby right now. Start something yourself."
          actionLabel="Create an event"
          onAction={createEvent}
        />
      );
    }
    if (tab === 'following') {
      return (
        <EmptyState
          icon="bookmark-outline"
          title="Nothing saved yet"
          message="Save an event with the bookmark, or join it from its page: it shows here."
          actionLabel="See what's nearby"
          onAction={() => setTab('nearby')}
        />
      );
    }
    return null;
  };

  const filterCount = activeFilterCount(filters);

  return (
    <View style={[styles.page, { paddingTop: insets.top + 6 }]}>
      <View style={styles.header}>
        <View style={styles.titleRow}>
          <Text style={styles.title} accessibilityRole="header">Events</Text>
          <IconButton icon="add" label="Create an event" size={36} onPress={createEvent} />
        </View>
        <View style={styles.searchRow}>
          <SearchBar value={query} onChangeText={setQuery} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={filterCount ? `Filters, ${filterCount} on` : 'Filters'}
            hitSlop={4}
            onPress={openFilters}
            style={({ pressed }) => [styles.filterButton, filterCount > 0 && styles.filterButtonOn, pressed && styles.pressed]}
          >
            <Ionicons name="options-outline" size={20} color={filterCount ? colors.onAccent : colors.active} />
            {filterCount ? <Text style={styles.filterCount}>{filterCount}</Text> : null}
          </Pressable>
        </View>
        <SegmentedTabs tabs={TABS} value={tab} onChange={setTab} />
      </View>
      {tab === 'nearby' && filterCount > 0 ? (
        <View style={styles.filters}>
          <FilterBar filters={filters} onPress={openFilters} />
        </View>
      ) : null}
      <SectionList
        ref={scroller}
        key={tab}
        sections={sections}
        keyExtractor={(event) => event.id}
        renderItem={renderItem}
        renderSectionHeader={({ section }) => (
          <View style={styles.sectionHeader}>
            {/* What is on now carries the live colour, as its events do */}
            {section.key === 'now' ? <View style={[styles.liveDot, { backgroundColor: colors.live }]} /> : null}
            <Text style={styles.sectionTitle} accessibilityRole="header">{section.title}</Text>
            {/* What never happened leaves Saved in one tap; what took place stays */}
            {inSavedTab && section.key === 'past' && section.data.some(cancelledBeforeStart) ? (
              <Pressable accessibilityRole="button" accessibilityLabel="Clear cancelled events from Saved" hitSlop={10} onPress={clearCancelled} style={styles.sectionAction}>
                <Text style={styles.sectionActionText}>Clear cancelled</Text>
              </Pressable>
            ) : null}
          </View>
        )}
        ItemSeparatorComponent={Separator}
        SectionSeparatorComponent={SectionGap}
        ListHeaderComponent={tab === 'mine' && !sections.length && !query.trim() ? <CreateRow styles={styles} colors={colors} onPress={createEvent} /> : null}
        ListEmptyComponent={empty()}
        stickySectionHeadersEnabled={false}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={[styles.listContent, { paddingBottom: tabBarHeight + 24 }]}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.inactive} />}
      />
    </View>
  );
}

// "Yours" with nothing in it: how to start (with events, the + above is the one way)
function CreateRow({ styles, colors, onPress }) {
  return (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => [styles.createRow, pressed && styles.pressed]}>
      <View style={styles.createIcon}>
        <Ionicons name="add" size={22} color={colors.active} />
      </View>
      <View style={styles.createText}>
        <Text style={styles.createTitle}>Create an event</Text>
        <Text style={styles.createSubtitle}>A match, a party, a walk: anything goes</Text>
      </View>
      <Ionicons name="chevron-forward" size={18} color={colors.inactive} />
    </Pressable>
  );
}

// Cards stand apart by a little air, no lines
function Separator() {
  return <View style={{ height: 10 }} />;
}

function SectionGap() {
  return <View style={{ height: 10 }} />;
}

const createStyles = (colors) => StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: colors.page,
  },
  header: {
    paddingHorizontal: 20,
    gap: 12,
    paddingBottom: 8,
  },
  searchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  filterButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
    minWidth: 44,
    height: 44,
    paddingHorizontal: 12,
    borderRadius: 22,
    backgroundColor: colors.surface,
  },
  filterButtonOn: {
    backgroundColor: colors.accent,
  },
  filterCount: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.onAccent,
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
  filters: {
    paddingBottom: 4,
  },
  listContent: {
    paddingHorizontal: 20,
    flexGrow: 1,
  },
  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingTop: 18,
  },
  sectionAction: {
    marginLeft: 'auto',
  },
  sectionActionText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.accent,
  },
  liveDot: {
    width: 9,
    height: 9,
    borderRadius: 5,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '700',
    letterSpacing: -0.3,
    color: colors.active,
  },
  pressed: {
    opacity: 0.6,
  },
  createRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    marginTop: 12,
    padding: 14,
    borderRadius: 16,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
  },
  createIcon: {
    width: 44,
    height: 44,
    borderRadius: 13,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.page,
  },
  createText: {
    flex: 1,
    gap: 2,
  },
  createTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.active,
  },
  createSubtitle: {
    fontSize: 13,
    color: colors.inactive,
  },
});
