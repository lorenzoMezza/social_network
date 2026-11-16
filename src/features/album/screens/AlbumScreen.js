// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { Button } from '../../../components/ui/Button';
import { IconButton } from '../../../components/ui/IconButton';
import { ActionSheet } from '../../../components/ui/ActionSheet';
import { EmptyState, ErrorState } from '../../../components/ui/StateViews';
import { useEvent, useEvents } from '../../events/state/EventsProvider';
import { canPost, isOrganizer, photoCountLabel, whoCanPostLine } from '../model/albumModel';
import { useAlbum, useAlbums } from '../state/AlbumsProvider';
import { useAddPhotos } from '../hooks/useAddPhotos';
import { PhotoTile } from '../components/PhotoTile';
import { photoLink } from '../components/EventPhotosSection';

const COLUMNS = 3;
const GAP = 2;

// An event's album: every photo, newest first, edge to edge in three columns (like
// the phone's Photos). Above them, how many there are and who can add more (the
// organizer changes it from here). Photos being sent come first, dimmed; the ones
// that failed offer Retry. "Add photos" floats within thumb's reach.
export function AlbumScreen({ id }) {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { event } = useEvent(id);
  const { user } = useEvents();
  const { album, uploads, reload, loadMore } = useAlbum(id);
  const { retryUpload, discardUpload } = useAlbums();
  const adder = useAddPhotos(id);
  const [failedItem, setFailedItem] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  const tile = (width - GAP * (COLUMNS - 1)) / COLUMNS;
  const owner = isOrganizer(event, user);
  const postable = !!event && canPost(event, album.settings, user);
  const sending = uploads.filter((upload) => upload.status !== 'failed').length;
  const failed = uploads.filter((upload) => upload.status === 'failed');

  const data = useMemo(() => [
    ...uploads.map((upload) => ({ key: upload.key, upload })),
    ...album.photos.map((photo) => ({ key: photo.id, photo })),
  ], [uploads, album.photos]);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/events'));
  const openSettings = () => router.push({ pathname: '/album-settings', params: { id } });

  const onPressTile = useCallback((item) => {
    if (item.photo) router.push(photoLink(id, item.photo.id));
    else if (item.upload?.status === 'failed') setFailedItem(item.upload);
  }, [id]);

  const onRefresh = async () => {
    setRefreshing(true);
    await reload();
    setRefreshing(false);
  };

  const renderItem = useCallback(({ item, index }) => (
    <View style={{ marginLeft: index % COLUMNS ? GAP : 0, marginBottom: GAP }}>
      <PhotoTile item={item} size={tile} onPress={onPressTile} />
    </View>
  ), [tile, onPressTile]);

  const header = (
    <View style={styles.header}>
      <Text style={styles.title} accessibilityRole="header" numberOfLines={2}>{event?.title ?? 'Photos'}</Text>
      {album.status === 'ready' ? (
        <View style={styles.rule}>
          <Text style={styles.ruleText}>
            {`${photoCountLabel(album.total)}  ·  ${whoCanPostLine(event, album.settings, user)}`}
          </Text>
          {owner ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Change who can add photos" hitSlop={10} onPress={openSettings}>
              <Text style={styles.change}>Change</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      {sending ? (
        <View style={styles.progress}>
          <ActivityIndicator size="small" color={colors.inactive} />
          <Text style={styles.progressText}>{sending === 1 ? 'Sending 1 photo…' : `Sending ${sending} photos…`}</Text>
        </View>
      ) : null}
      {failed.length ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => failed.forEach((upload) => retryUpload(id, upload.key))}
          style={({ pressed }) => [styles.progress, pressed && styles.pressed]}
        >
          <Ionicons name="alert-circle" size={18} color={colors.error} />
          <Text style={[styles.progressText, { color: colors.error }]}>
            {failed.length === 1 ? '1 photo was not sent' : `${failed.length} photos were not sent`}
          </Text>
          <Text style={styles.retryAll}>Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );

  const empty = () => {
    if (album.status === 'error') return <ErrorState error={album.error} onRetry={reload} subject="The photos" />;
    if (album.status !== 'ready') {
      return (
        <View style={styles.skeleton} accessibilityLabel="Loading photos" accessibilityRole="progressbar">
          {Array.from({ length: 9 }, (_, index) => (
            <View key={index} style={{ width: tile, height: tile, marginLeft: index % COLUMNS ? GAP : 0, marginBottom: GAP, backgroundColor: colors.surface }} />
          ))}
        </View>
      );
    }
    return (
      <EmptyState
        icon="images-outline"
        title="No photos yet"
        message={owner
          ? 'Add the photos of the event: everyone who joined will see them here.'
          : postable ? 'Be the first to add one.' : 'The photos of the event will show up here.'}
      />
    );
  };

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <IconButton icon="chevron-back" label="Back" onPress={back} />
        <Text style={styles.barTitle} numberOfLines={1}>Photos</Text>
        <View style={styles.spacer} />
      </View>
      <FlatList
        data={data}
        keyExtractor={(item) => item.key}
        numColumns={COLUMNS}
        renderItem={renderItem}
        ListHeaderComponent={header}
        ListEmptyComponent={empty()}
        onEndReached={loadMore}
        onEndReachedThreshold={0.6}
        ListFooterComponent={album.loadingMore ? <ActivityIndicator style={styles.footer} color={colors.inactive} /> : null}
        contentContainerStyle={{ flexGrow: 1, paddingBottom: insets.bottom + (postable ? 96 : 24) }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.inactive} />}
        removeClippedSubviews
        initialNumToRender={18}
        windowSize={7}
      />
      {postable ? (
        <View style={[styles.addBar, { bottom: insets.bottom + 12 }]} pointerEvents="box-none">
          <Button label="Add photos" icon="add" onPress={adder.open} style={styles.addButton} />
        </View>
      ) : null}
      <ActionSheet {...adder.sheet} />
      <ActionSheet
        visible={!!failedItem}
        onClose={() => setFailedItem(null)}
        title="This photo was not sent"
        items={failedItem ? [
          { label: 'Try again', icon: 'refresh', onPress: () => retryUpload(id, failedItem.key) },
          { label: 'Remove it', icon: 'trash-outline', destructive: true, onPress: () => discardUpload(id, failedItem.key) },
        ] : []}
      />
    </View>
  );
}

const createStyles = (colors) => StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: colors.page,
  },
  pressed: {
    opacity: 0.6,
  },
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  barTitle: {
    flexShrink: 1,
    fontSize: 17,
    fontWeight: '700',
    color: colors.active,
  },
  spacer: {
    width: 40,
  },
  header: {
    paddingHorizontal: 20,
    paddingTop: 6,
    paddingBottom: 16,
    gap: 8,
  },
  title: {
    fontSize: 26,
    fontWeight: '700',
    letterSpacing: -0.5,
    color: colors.active,
  },
  rule: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 10,
  },
  ruleText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 20,
    color: colors.inactive,
  },
  change: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.active,
  },
  progress: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  progressText: {
    flex: 1,
    fontSize: 14,
    color: colors.inactive,
  },
  retryAll: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.active,
  },
  skeleton: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  footer: {
    paddingVertical: 16,
  },
  addBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  addButton: {
    paddingHorizontal: 28,
    boxShadow: '0 6px 20px rgba(0,0,0,0.18)',
  },
});
