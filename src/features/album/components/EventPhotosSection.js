// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useMemo } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useColors } from '../../../theme/colors';
import { Button } from '../../../components/ui/Button';
import { STATUS, eventStatus } from '../../events/model/eventModel';
import { WHO_CAN_POST, albumOpen, canPost, isOrganizer } from '../model/albumModel';
import { useAlbum } from '../state/AlbumsProvider';
import { PhotoTile } from './PhotoTile';

const STRIP = 4;
const GAP = 6;

export const albumLink = (eventId) => ({ pathname: '/album/[id]', params: { id: eventId } });
export const photoLink = (eventId, photoId) => ({ pathname: '/album-photo', params: { id: eventId, photoId } });

// The "Photos" part of an event page, once the event has started: the first photos
// and the way to all of them; with none yet, an invitation to add them (to the
// organizer above all, once it is over). onAdd: opens the picker (useAddPhotos); without
// it (the page has its own button, after the event) the section only shows.
export function EventPhotosSection({ event, user, onAdd }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { width } = useWindowDimensions();
  const open = albumOpen(event);
  const { album, uploads } = useAlbum(event.id, { enabled: open });
  const openPhoto = useCallback((item) => {
    if (item.photo) router.push(photoLink(event.id, item.photo.id));
    else router.push(albumLink(event.id));
  }, [event.id]);

  if (!open) return null;
  const count = album.status === 'ready' ? album.total : event.photoCount ?? 0;
  const postable = canPost(event, album.settings, user);
  const own = isOrganizer(event, user);
  const ended = eventStatus(event) === STATUS.concluded;

  if (!count && !uploads.length) {
    if (!postable) return null;
    const people = event.followerCount ?? event.followers?.length ?? 0;
    const everyone = (album.settings?.whoCanPost ?? WHO_CAN_POST.everyone) === WHO_CAN_POST.everyone;
    const title = own ? (ended ? 'How did it go?' : 'Taking photos?') : ended ? 'Got photos from the event?' : 'Taking photos?';
    const message = own
      ? `Share the photos of the event${people ? `: the ${people === 1 ? 'person' : `${people} people`} who joined will see them here` : ''}${everyone ? ', and can add theirs' : ''}.`
      : 'Add them to the album of the event: everyone who joined will see them here.';
    return (
      <View style={styles.invite}>
        <View style={styles.inviteTop}>
          <View style={styles.inviteIcon}>
            <Ionicons name="images-outline" size={22} color={colors.active} />
          </View>
          <View style={styles.flex}>
            <Text style={styles.inviteTitle}>{title}</Text>
            <Text style={styles.inviteText}>{message}</Text>
          </View>
        </View>
        {onAdd ? <Button label="Add photos" icon="add" compact onPress={onAdd} style={styles.inviteButton} /> : null}
      </View>
    );
  }

  const tile = Math.floor((width - 40 - GAP * (STRIP - 1)) / STRIP);
  const items = [
    ...uploads.map((upload) => ({ key: upload.key, upload })),
    ...album.photos.map((photo) => ({ key: photo.id, photo })),
  ].slice(0, STRIP);
  const shown = Math.min(count + uploads.length, STRIP);
  const rest = count + uploads.length - shown;

  return (
    <View style={styles.section}>
      <View style={styles.header}>
        <Text style={styles.title}>Photos</Text>
        <Pressable accessibilityRole="button" hitSlop={10} onPress={() => router.push(albumLink(event.id))} style={({ pressed }) => [styles.seeAll, pressed && styles.pressed]}>
          <Text style={styles.seeAllText}>{`See all ${count}`}</Text>
          <Ionicons name="chevron-forward" size={14} color={colors.inactive} />
        </Pressable>
      </View>
      <View style={styles.strip}>
        {items.length ? items.map((item, index) => (
          <PhotoTile key={item.key} item={item} size={tile} radius={12} more={index === items.length - 1 && rest > 0 ? rest : undefined} onPress={index === items.length - 1 && rest > 0 ? () => router.push(albumLink(event.id)) : openPhoto} />
        )) : Array.from({ length: Math.min(count, STRIP) }, (_, index) => (
          <View key={index} style={{ width: tile, height: tile, borderRadius: 12, backgroundColor: colors.surface }} />
        ))}
      </View>
      {postable && onAdd ? (
        <Pressable accessibilityRole="button" onPress={onAdd} hitSlop={6} style={({ pressed }) => [styles.add, pressed && styles.pressed]}>
          <Ionicons name="add" size={16} color={colors.active} />
          <Text style={styles.addText}>Add photos</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const createStyles = (colors) => StyleSheet.create({
  flex: {
    flex: 1,
  },
  pressed: {
    opacity: 0.6,
  },
  section: {
    marginTop: 32,
    gap: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    color: colors.active,
  },
  seeAll: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  seeAllText: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.inactive,
  },
  strip: {
    flexDirection: 'row',
    gap: GAP,
  },
  add: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
  },
  addText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.active,
  },
  invite: {
    marginTop: 32,
    padding: 16,
    gap: 14,
    borderRadius: 20,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
  },
  inviteTop: {
    flexDirection: 'row',
    gap: 12,
  },
  inviteIcon: {
    width: 44,
    height: 44,
    borderRadius: 14,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.page,
  },
  inviteTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.active,
  },
  inviteText: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.inactive,
    marginTop: 2,
  },
  inviteButton: {
    alignSelf: 'flex-start',
  },
});
