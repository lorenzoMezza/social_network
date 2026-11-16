// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, ScrollView, Share, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Image } from 'expo-image';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { Easing, interpolate, useAnimatedStyle, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { StatusBar } from 'expo-status-bar';
import { File, Paths } from 'expo-file-system';
import { IconButton } from '../../../components/ui/IconButton';
import { ActionSheet } from '../../../components/ui/ActionSheet';
import { successFeedback, tapFeedback } from '../../../lib/haptics';
import { formatDay } from '../../events/model/eventModel';
import { useEvent, useEvents } from '../../events/state/EventsProvider';
import { PersonAvatar } from '../../social/components/PersonAvatar';
import { PHOTO_REPORT_REASONS, canRemove } from '../model/albumModel';
import { useAlbum, useAlbums } from '../state/AlbumsProvider';
import { failureMessage } from '../../api/failureMessage';

const EASE_OUT = Easing.bezier(0.23, 1, 0.32, 1);
const FAR = 110; // pt: let go past here and the photo closes
const FLICK = 800; // pt/s: or flicked, however little it moved
const FADED_AT = 320; // pt: the page behind is fully seen by here
const DOUBLE_TAP_ZOOM = 2.5;

// One photo of an album, full screen on black: swipe sideways for the others, up or down
// to close it (the page it came from shows behind), pinch or double-tap to zoom (iOS), a
// tap hides or shows who took it and the actions. Share hands the picture to the phone
// (save it, send it); ⋯ removes it (its author, the organizer) or reports it (everyone else).
export function PhotoViewerScreen({ id, photoId }) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const { event } = useEvent(id);
  const { user } = useEvents();
  const { album, loadMore } = useAlbum(id);
  const { removePhoto, reportPhoto } = useAlbums();
  const photos = album.photos;
  const [index, setIndex] = useState(() => Math.max(0, photos.findIndex((photo) => photo.id === photoId)));
  const list = useRef(null);
  const requestedPhoto = useRef({ key: null, done: false });
  const [chrome, setChrome] = useState(true);
  const [sheet, setSheet] = useState(null);
  const [zoomed, setZoomed] = useState(false);
  const photo = photos[Math.min(index, photos.length - 1)];

  // The viewer can open before this album's first page has loaded. Select the
  // requested photo when it arrives, and scroll the list to keep the page in sync.
  useLayoutEffect(() => {
    const key = JSON.stringify([id, photoId]);
    if (requestedPhoto.current.key !== key) requestedPhoto.current = { key, done: false };
    if (requestedPhoto.current.done) return;
    const target = photos.findIndex((entry) => entry.id === photoId);
    if (target < 0) return;
    const frame = requestAnimationFrame(() => {
      requestedPhoto.current.done = true;
      setIndex(target);
      list.current?.scrollToIndex({ index: target, animated: false });
    });
    return () => cancelAnimationFrame(frame);
  }, [id, photoId, photos, index]);

  // The last photo removed: nothing left to show
  useEffect(() => {
    if (album.status === 'ready' && !photos.length) router.back();
  }, [album.status, photos.length]);

  const getItemLayout = useCallback((_, position) => ({ length: width, offset: width * position, index: position }), [width]);
  const onScrollEnd = useCallback((event) => {
    setIndex(Math.round(event.nativeEvent.contentOffset.x / width));
    setZoomed(false);
  }, [width]);
  const toggleChrome = useCallback(() => setChrome((value) => !value), []);
  const activeId = photo?.id;

  const renderItem = useCallback(({ item }) => (
    <ZoomablePhoto photo={item} width={width} height={height} active={item.id === activeId} onTap={toggleChrome} onZoom={setZoomed} />
  ), [width, height, activeId, toggleChrome]);

  // Dragged up or down, the photo follows the finger and the page behind shows through.
  // Only when not zoomed in (then a drag moves around the photo) and only a drag that
  // starts vertically: sideways is the next photo.
  const dragY = useSharedValue(0);
  const close = useCallback(() => router.back(), []);
  const dismiss = useMemo(() => Gesture.Simultaneous(Gesture.Native(), Gesture.Pan()
    .enabled(!zoomed)
    .activeOffsetY([-12, 12])
    .failOffsetX([-12, 12])
    .onUpdate((event) => {
      dragY.set(event.translationY);
    })
    .onEnd((event) => {
      const flicked = Math.abs(event.velocityY) > FLICK;
      if (flicked || (Math.abs(event.translationY) > FAR && event.velocityY * event.translationY >= 0)) {
        const direction = Math.sign(flicked ? event.velocityY : event.translationY);
        dragY.set(withTiming(direction * height, { duration: 200, easing: EASE_OUT }, (finished) => {
          if (finished) scheduleOnRN(close);
        }));
      } else {
        dragY.set(withSpring(0, { duration: 400, dampingRatio: 0.8, velocity: event.velocityY }));
      }
    })), [zoomed, dragY, height, close]);
  const photoMotion = useAnimatedStyle(() => ({
    transform: [
      { translateY: dragY.get() },
      { scale: interpolate(Math.abs(dragY.get()), [0, FADED_AT], [1, 0.88], 'clamp') },
    ],
  }));
  const backdropMotion = useAnimatedStyle(() => ({ opacity: interpolate(Math.abs(dragY.get()), [0, FADED_AT], [1, 0], 'clamp') }));
  const chromeMotion = useAnimatedStyle(() => ({ opacity: interpolate(Math.abs(dragY.get()), [0, 60], [1, 0], 'clamp') }));

  const share = async () => {
    if (!photo) return;
    tapFeedback();
    // iOS: a file, not a link (the share sheet can then save it to Photos), downloaded
    // for the share sheet only and deleted once it closes
    let copy = null;
    try {
      if (process.env.EXPO_OS === 'ios') {
        let uri = photo.url;
        if (/^https?:/.test(uri)) {
          copy = await File.downloadFileAsync(uri, new File(Paths.cache, `album-${photo.id}.jpg`), { idempotent: true });
          uri = copy.uri;
        }
        await Share.share({ url: uri });
      } else {
        await Share.share({ message: photo.url });
      }
    } catch {
      Alert.alert('Could not share this photo');
    } finally {
      try {
        if (copy?.exists) copy.delete();
      } catch {
        // Already gone
      }
    }
  };

  const confirmRemove = () => {
    const own = photo.authorId === user?.id;
    Alert.alert(own ? 'Remove your photo?' : 'Remove this photo?', 'It will be removed from the album for everyone.', [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Remove',
        style: 'destructive',
        onPress: async () => {
          const removed = photo.id;
          try {
            await removePhoto(id, removed);
            successFeedback();
            setIndex((value) => Math.max(0, Math.min(value, photos.length - 2)));
          } catch (error) {
            Alert.alert('Could not remove the photo', failureMessage(error));
          }
        },
      },
    ]);
  };

  const report = async (reason) => {
    try {
      await reportPhoto(id, photo.id, reason);
      Alert.alert('Thanks for telling us', reason === 'shows_me'
        ? 'The organizer will be asked to remove it, and we will look at it too.'
        : 'We will look at it. The organizer can also remove it.');
    } catch (error) {
      Alert.alert('Could not send the report', failureMessage(error));
    }
  };

  const removable = photo && canRemove(event, photo, user);
  const own = photo?.authorId === user?.id;
  const moreItems = [
    removable && { label: 'Remove photo', icon: 'trash-outline', destructive: true, onPress: confirmRemove },
    !own && { label: 'Report photo', icon: 'flag-outline', destructive: !removable, onPress: () => setSheet('report') },
  ].filter(Boolean);

  return (
    <View style={styles.page}>
      <StatusBar style="light" hidden={!chrome} animated />
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, styles.backdrop, backdropMotion]} />
      {photos.length ? (
        <Animated.View style={[styles.flex, photoMotion]}>
        <GestureDetector gesture={dismiss}>
        <FlatList
          ref={list}
          data={photos}
          keyExtractor={(item) => item.id}
          renderItem={renderItem}
          horizontal
          pagingEnabled
          directionalLockEnabled
          showsHorizontalScrollIndicator={false}
          initialScrollIndex={index}
          getItemLayout={getItemLayout}
          onMomentumScrollEnd={onScrollEnd}
          onEndReached={loadMore}
          onEndReachedThreshold={2}
          windowSize={3}
          initialNumToRender={1}
          maxToRenderPerBatch={2}
        />
        </GestureDetector>
        </Animated.View>
      ) : null}

      {chrome ? (
        <Animated.View style={[styles.top, { paddingTop: insets.top + 6 }, chromeMotion]}>
          <IconButton icon="close" label="Close" variant="banner" onPress={() => router.back()} />
          <Text style={styles.counter}>{photos.length ? `${index + 1} of ${album.total || photos.length}` : ''}</Text>
          <View style={styles.spacer} />
        </Animated.View>
      ) : null}

      {chrome && photo ? (
        <Animated.View style={[styles.bottom, { paddingBottom: insets.bottom + 12 }, chromeMotion]}>
          <View style={styles.author}>
            <PersonAvatar person={photo.author} size={34} />
            <View style={styles.flex}>
              <Text style={styles.authorName} numberOfLines={1}>{own ? 'You' : photo.author?.name ?? 'Someone'}</Text>
              <Text style={styles.date} numberOfLines={1}>{formatDay(new Date(photo.createdAt))}</Text>
            </View>
          </View>
          <IconButton icon="share-outline" label="Share photo" variant="banner" onPress={share} />
          {moreItems.length ? <IconButton icon="ellipsis-horizontal" label="More" variant="banner" onPress={() => setSheet('more')} /> : null}
        </Animated.View>
      ) : null}

      <ActionSheet visible={sheet === 'more'} onClose={() => setSheet(null)} items={moreItems} />
      <ActionSheet
        visible={sheet === 'report'}
        onClose={() => setSheet(null)}
        title="Why are you reporting it?"
        items={PHOTO_REPORT_REASONS.map((reason) => ({ label: reason.label, onPress: () => report(reason.value) }))}
      />
    </View>
  );
}

// One page: the photo fitted to the screen, its thumbnail shown until the large one
// arrives. On iOS, a pinch zooms in and a double tap zooms in where it lands or back out;
// the system does the zooming (a scroll view), so it feels as everywhere else on the phone.
function ZoomablePhoto({ photo, width, height, active, onTap, onZoom }) {
  const ratio = photo.width / photo.height || 1;
  const fitted = useMemo(() => (width / height > ratio ? { width: height * ratio, height } : { width, height: width / ratio }), [width, height, ratio]);
  const [scroller, setScroller] = useState(null);
  const [zoomedIn, setZoomedIn] = useState(false);

  const zoomTo = useCallback((rect, animated) => {
    scroller?.getScrollResponder?.()?.scrollResponderZoomTo?.({ ...rect, animated });
  }, [scroller]);

  // Back to the whole photo once it is swiped away
  useEffect(() => {
    if (!active && zoomedIn) zoomTo({ x: 0, y: 0, width, height }, false);
  }, [active, zoomedIn, zoomTo, width, height]);

  const onScroll = (event) => {
    const now = (event.nativeEvent.zoomScale ?? 1) > 1.01;
    if (now === zoomedIn) return;
    setZoomedIn(now);
    if (active) onZoom(now);
  };

  const taps = useMemo(() => {
    const single = Gesture.Tap().runOnJS(true).onEnd((_, success) => {
      if (success) onTap();
    });
    if (process.env.EXPO_OS !== 'ios') return single;
    const double = Gesture.Tap().numberOfTaps(2).maxDelay(250).runOnJS(true).onEnd((event, success) => {
      if (!success) return;
      if (zoomedIn) {
        zoomTo({ x: 0, y: 0, width, height }, true);
      } else {
        const zoomWidth = width / DOUBLE_TAP_ZOOM;
        const zoomHeight = height / DOUBLE_TAP_ZOOM;
        zoomTo({ x: event.x - zoomWidth / 2, y: event.y - zoomHeight / 2, width: zoomWidth, height: zoomHeight }, true);
      }
    });
    return Gesture.Exclusive(double, single);
  }, [onTap, zoomTo, zoomedIn, width, height]);

  return (
    <ScrollView
      ref={setScroller}
      style={{ width, height }}
      contentContainerStyle={styles.zoomContent}
      maximumZoomScale={3}
      minimumZoomScale={1}
      centerContent
      showsHorizontalScrollIndicator={false}
      showsVerticalScrollIndicator={false}
      bouncesZoom
      // Not zoomed in there is nothing to move around: a vertical drag closes the photo
      scrollEnabled={zoomedIn}
      onScroll={onScroll}
      scrollEventThrottle={32}
    >
      <GestureDetector gesture={taps}>
        <View accessible accessibilityRole="image" accessibilityLabel={`Photo by ${photo.author?.name ?? 'someone'}`} onAccessibilityTap={onTap} style={{ width, height, alignItems: 'center', justifyContent: 'center' }}>
          <Image
            source={photo.url}
            placeholder={photo.thumbUrl ? { uri: photo.thumbUrl } : undefined}
            placeholderContentFit="cover"
            recyclingKey={photo.id}
            style={fitted}
            contentFit="contain"
            transition={150}
          />
        </View>
      </GestureDetector>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  page: {
    flex: 1,
  },
  backdrop: {
    backgroundColor: '#000000',
  },
  flex: {
    flex: 1,
  },
  zoomContent: {
    flexGrow: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  top: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingBottom: 10,
    backgroundColor: 'rgba(0,0,0,0.35)',
  },
  counter: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FFFFFF',
    fontVariant: ['tabular-nums'],
  },
  spacer: {
    width: 40,
  },
  bottom: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingTop: 12,
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  author: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  authorName: {
    fontSize: 15,
    fontWeight: '600',
    color: '#FFFFFF',
  },
  date: {
    fontSize: 13,
    color: 'rgba(255,255,255,0.7)',
  },
});
