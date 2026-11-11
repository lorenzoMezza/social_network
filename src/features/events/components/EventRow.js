// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { memo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { cubicBezier, useReducedMotion } from 'react-native-reanimated';
import Ionicons from '@expo/vector-icons/Ionicons';
import { themedStyles, useColors } from '../../../theme/colors';
import { categoryLine } from '../model/categories';
import { STATUS, distanceMeters, eventStatus, formatDay, formatDistance, goingLine, startsInMinutes, timeLine } from '../model/eventModel';
import { CategoryTile } from './CategoryTile';
import { PersonAvatar } from '../../social/components/PersonAvatar';

// An event in a list, as a card: what it is (title and the start of its description),
// when and how far, who is going (the user's connections first, their faces) and who
// organizes it (tap the name to see their profile). The bookmark saves it (a private
// bookmark: joining is on its page). The handlers get the event (onPress(event),
// onToggleSave(event, saved), onOpenOrganizer(event), onRemove(event)): the list passes
// the same functions to every card, so a card re-renders only when its event changes.
// `onRemove`: an event cancelled before it began can be taken out of the list (×); one that
// took place cannot, so the list does not pass it. `removeLabel` says which list.
// A sponsored event (a promotion pays to show it farther) says so, first on its last line.
// `showDay`: out of the lists by day (the sponsored ones on top), the day comes first.
// Once it is over, its album: `photoInvite` asks its organizer to add the photos
// (none yet), else `photoCount` says how many there are.
const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

// Press feedback: the card gives a little under the finger, at once, and comes back
const PRESS = { transitionProperty: 'transform', transitionDuration: 140, transitionTimingFunction: cubicBezier(0.23, 1, 0.32, 1) };
// What is on now breathes, slowly (not with reduced motion)
const BREATHE = { '0%': { opacity: 1 }, '50%': { opacity: 0.35 }, '100%': { opacity: 1 } };

export const EventRow = memo(function EventRow({ event, position, saved, isOwn, photoCount, photoInvite, removeLabel = 'Remove from the list', showDay, onPress, onToggleSave, onOpenOrganizer, onRemove }) {
  const colors = useColors();
  const styles = useStyles();
  const [down, setDown] = useState(false);
  const reduceMotion = useReducedMotion();
  const status = eventStatus(event);
  const live = status === STATUS.ongoing;
  const over = status === STATUS.concluded || status === STATUS.cancelled;
  const distance = formatDistance(distanceMeters(position, event.location));
  // Starting within the hour: said first, in the accent (and so it is today)
  const soon = startsInMinutes(event);
  const when = showDay && status === STATUS.upcoming && !soon ? `${formatDay(new Date(event.dates?.startDate))} · ${timeLine(event)}` : timeLine(event);
  const kind = categoryLine(event, 2);
  const organizer = isOwn ? 'you' : event.creator ? event.creator.name || (event.creator.username ? `@${event.creator.username}` : null) : null;
  const going = goingLine(event);
  const friends = event.friends ?? [];
  const photos = photoInvite ? { invite: true } : photoCount ? { count: photoCount } : null;

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={`${event.sponsored ? 'Sponsored. ' : ''}${event.title}. ${when}. ${[distance, kind].filter(Boolean).join(', ')}`}
      onPress={() => onPress(event)}
      onPressIn={() => setDown(true)}
      onPressOut={() => setDown(false)}
      style={[
        styles.card,
        // Its edge says what it is, as on the map: sponsored first, or on now
        event.sponsored && !over ? styles.sponsoredCard : live && !over ? styles.liveCard : null,
        PRESS,
        { transform: [{ scale: down ? 0.98 : 1 }] },
      ]}
    >
      <View style={styles.top}>
        <View style={over && styles.faded}>
          <CategoryTile event={event} size={48} />
        </View>
        <View style={styles.heading}>
          <Text style={[styles.title, over && styles.muted]} numberOfLines={2}>{event.title}</Text>
          <View style={styles.meta}>
            {live ? (
              <Animated.View
                style={[styles.liveDot, { backgroundColor: colors.live }, !reduceMotion && { animationName: BREATHE, animationDuration: '1.8s', animationIterationCount: 'infinite', animationTimingFunction: 'ease-in-out' }]}
              />
            ) : null}
            <Text style={[styles.when, live && { color: colors.live }, over && styles.muted]} numberOfLines={2}>
              {soon ? <Text style={{ color: colors.accent }}>{`In ${soon} min  ·  `}</Text> : null}
              {when}
            </Text>
          </View>
        </View>
        {over && onRemove ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={removeLabel}
            hitSlop={10}
            onPress={() => onRemove(event)}
            style={({ pressed }) => [styles.save, pressed && styles.pressed]}
          >
            <Ionicons name="close" size={20} color={colors.inactive} />
          </Pressable>
        ) : isOwn || over || !onToggleSave ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={saved ? 'Remove from saved' : 'Save event'}
            accessibilityState={{ selected: saved }}
            hitSlop={10}
            onPress={() => onToggleSave(event, saved)}
            style={({ pressed }) => [styles.save, pressed && styles.pressed]}
          >
            <Ionicons name={saved ? 'bookmark' : 'bookmark-outline'} size={20} color={saved ? colors.accent : colors.inactive} />
          </Pressable>
        )}
      </View>

      {event.description ? (
        <Text style={[styles.description, over && styles.muted]} numberOfLines={2}>{event.description}</Text>
      ) : null}

      {going ? (
        <View style={styles.going}>
          {friends.length ? (
            <View style={styles.faces}>
              {friends.map((person, index) => (
                <View key={person.id} style={[styles.face, index > 0 && styles.faceOverlap]}>
                  <PersonAvatar person={person} size={22} />
                </View>
              ))}
            </View>
          ) : (
            <Ionicons name={event.following ? 'checkmark-circle' : 'people-outline'} size={16} color={event.following ? colors.accent : colors.inactive} />
          )}
          <Text style={[styles.goingText, event.following && !over && { color: colors.accent }]} numberOfLines={1}>{going}</Text>
        </View>
      ) : null}

      <View style={styles.bottom}>
        {kind || distance || event.sponsored ? (
          <Text style={styles.kind} numberOfLines={1}>
            {event.sponsored ? <Text style={styles.sponsored}>{kind || distance ? 'Sponsored  ·  ' : 'Sponsored'}</Text> : null}
            {[distance, kind].filter(Boolean).join('  ·  ')}
          </Text>
        ) : null}
        {photos ? (
          <View style={[styles.photos, photos.invite && styles.photosInvite]}>
            <Ionicons name="images-outline" size={14} color={colors.active} />
            <Text style={styles.photosText} numberOfLines={1}>{photos.invite ? 'Add the photos' : photos.count === 1 ? '1 photo' : `${photos.count} photos`}</Text>
          </View>
        ) : organizer ? (
          <Pressable
            accessibilityRole="link"
            accessibilityLabel={isOwn ? 'Organized by you' : `Organized by ${organizer}, open profile`}
            disabled={isOwn || !onOpenOrganizer || !event.creatorId}
            hitSlop={8}
            onPress={() => onOpenOrganizer(event)}
            style={({ pressed }) => [styles.organizer, pressed && styles.pressed]}
          >
            <PersonAvatar person={event.creator} size={20} />
            <Text style={styles.organizerName} numberOfLines={1}>
              <Text style={styles.by}>by </Text>
              {organizer}
            </Text>
          </Pressable>
        ) : null}
      </View>
    </AnimatedPressable>
  );
});

const useStyles = themedStyles((colors) => StyleSheet.create({
  // Lifted off the page by a soft shadow in light; on dark, a surface with a faint edge
  card: {
    padding: 14,
    gap: 10,
    borderRadius: 20,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.scheme === 'dark' ? 'rgba(255,255,255,0.07)' : colors.border,
    backgroundColor: colors.scheme === 'dark' ? colors.surface : colors.page,
    boxShadow: colors.cardShadow,
  },
  liveCard: {
    borderWidth: 1,
    borderColor: colors.liveEdge,
  },
  sponsoredCard: {
    borderWidth: 1,
    borderColor: colors.goldEdge,
  },
  pressed: {
    opacity: 0.7,
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  faded: {
    opacity: 0.5,
  },
  heading: {
    flex: 1,
    gap: 3,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    lineHeight: 22,
    letterSpacing: -0.2,
    color: colors.active,
  },
  meta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
  },
  liveDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
  },
  when: {
    flexShrink: 1,
    fontSize: 14,
    fontWeight: '700',
    color: colors.active,
    fontVariant: ['tabular-nums'],
  },
  muted: {
    color: colors.inactive,
  },
  save: {
    width: 36,
    height: 36,
    alignSelf: 'flex-start',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: -4,
    marginRight: -6,
  },
  description: {
    fontSize: 14,
    lineHeight: 20,
    color: colors.inactive,
  },
  bottom: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  kind: {
    flexShrink: 1,
    fontSize: 12,
    fontWeight: '600',
    color: colors.inactive,
  },
  sponsored: {
    color: colors.gold,
    fontWeight: '600',
  },
  going: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  faces: {
    flexDirection: 'row',
  },
  face: {
    borderRadius: 13,
    borderWidth: 2,
    borderColor: colors.scheme === 'dark' ? colors.surface : colors.page,
  },
  faceOverlap: {
    marginLeft: -8,
  },
  goingText: {
    flexShrink: 1,
    fontSize: 13,
    fontWeight: '600',
    color: colors.active,
  },
  by: {
    fontWeight: '400',
    color: colors.inactive,
  },
  organizer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    maxWidth: '60%',
  },
  organizerName: {
    flexShrink: 1,
    fontSize: 13,
    fontWeight: '600',
    color: colors.active,
  },
  photos: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
  },
  photosInvite: {
    paddingHorizontal: 10,
    paddingVertical: 5,
    borderRadius: 12,
    backgroundColor: colors.pill,
  },
  photosText: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.active,
  },
}));
