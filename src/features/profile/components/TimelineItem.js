// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { themedStyles, useColors } from '../../../theme/colors';
import { shortDayFormatter } from '../../../lib/dateFormatters';
import { CategoryTile } from '../../events/components/CategoryTile';
import { Stars } from '../../events/components/Stars';
import { distanceMeters, eventAddress, formatDistance } from '../../events/model/eventModel';
import { PersonAvatar } from '../../social/components/PersonAvatar';

const VERBS = {
  organized: (own) => (own ? 'You organized' : 'Organized'),
  going: (own) => (own ? "You're going" : 'Going'),
  there: (own) => (own ? "You're there now" : 'There now'),
  went: (own) => (own ? 'You went' : 'Went'),
  reviewed: (own) => (own ? 'You reviewed' : 'Reviewed'),
  connected: (own) => (own ? 'You connected' : 'Connected'),
};
// One moment of a profile's story, on a rail: what happened (organized, went, going,
// reviewed), which event, when and where. Taps open the event (onPress(event): the
// same function for every item, so an item re-renders only when its entry changes).
// In one's own story a long press chooses whether others see it (onLongPress(entry));
// one they don't is faded and says "Only you".
export const TimelineItem = memo(function TimelineItem({ entry, own, accent, position, last, onPress, onLongPress }) {
  const colors = useColors();
  const styles = useStyles();
  const { event, kind, rating, person } = entry;
  const hidden = own && entry.hidden;
  const longPress = own && onLongPress ? () => onLongPress(entry) : undefined;
  const onlyYou = hidden ? (
    <Text style={styles.onlyYou}>
      {'  ·  '}
      <Ionicons name="eye-off-outline" size={12} color={colors.inactive} />
      {' Only you'}
    </Text>
  ) : null;
  if (kind === 'connected') {
    const { withYou } = entry;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${VERBS.connected(own)} with ${withYou ? 'you' : person.name ?? person.username}, ${shortDayFormatter.format(entry.date)}`}
        disabled={withYou && !longPress}
        onPress={withYou ? undefined : () => onPress(entry)}
        onLongPress={longPress}
        delayLongPress={350}
        style={({ pressed }) => [styles.row, pressed && styles.pressed]}
      >
        <View style={styles.rail}>
          <View style={[styles.dot, { backgroundColor: accent, borderColor: accent }]} />
          {last ? null : <View style={styles.line} />}
        </View>
        <View style={styles.body}>
          <Text style={[styles.verb, { color: accent }]}>
            {VERBS.connected(own)}
            <Text style={styles.date}>{`  ·  ${shortDayFormatter.format(entry.date)}`}</Text>
            {onlyYou}
          </Text>
          <View style={[styles.card, hidden && styles.hiddenCard]}>
            <PersonAvatar person={person} size={40} />
            <View style={styles.text}>
              <Text style={styles.title} numberOfLines={1}>{withYou ? 'With you' : person.name}</Text>
              {person.place ? (
                <View style={styles.place}>
                  <Ionicons name="location-outline" size={13} color={colors.inactive} />
                  <Text style={styles.placeText} numberOfLines={2}>{person.place}</Text>
                </View>
              ) : null}
            </View>
            {withYou ? null : <Ionicons name="chevron-forward" size={16} color={colors.inactive} />}
          </View>
        </View>
      </Pressable>
    );
  }
  const address = eventAddress(event);
  const distance = formatDistance(distanceMeters(position, event.location));
  const place = address ?? (distance ? `${distance} from you` : null);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${VERBS[kind](own)} ${event.title}, ${shortDayFormatter.format(entry.date)}${place ? `, ${place}` : ''}`}
      onPress={() => onPress(entry)}
      onLongPress={longPress}
      delayLongPress={350}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <View style={styles.rail}>
        <View style={[styles.dot, { backgroundColor: kind === 'going' || kind === 'there' ? colors.page : accent, borderColor: accent }]} />
        {last ? null : <View style={styles.line} />}
      </View>
      <View style={styles.body}>
        <Text style={[styles.verb, { color: accent }]}>
          {VERBS[kind](own)}
          <Text style={styles.date}>{`  ·  ${shortDayFormatter.format(entry.date)}`}</Text>
          {onlyYou}
        </Text>
        <View style={[styles.card, hidden && styles.hiddenCard]}>
          <CategoryTile event={event} size={40} />
          <View style={styles.text}>
            <Text style={styles.title} numberOfLines={2}>{event.title}</Text>
            {place ? (
              <View style={styles.place}>
                <Ionicons name="location-outline" size={13} color={colors.inactive} />
                <Text style={styles.placeText} numberOfLines={2}>{place}</Text>
              </View>
            ) : null}
            {rating ? (
              <View style={styles.rating}>
                <Stars value={rating.rating} size={12} />
                {rating.comment ? <Text style={styles.comment} numberOfLines={2}>{`“${rating.comment}”`}</Text> : null}
              </View>
            ) : null}
          </View>
          <Ionicons name="chevron-forward" size={16} color={colors.inactive} />
        </View>
      </View>
    </Pressable>
  );
});

const useStyles = themedStyles((colors) => StyleSheet.create({
  row: {
    flexDirection: 'row',
    gap: 12,
  },
  pressed: {
    opacity: 0.7,
  },
  rail: {
    width: 14,
    alignItems: 'center',
    paddingTop: 3,
  },
  dot: {
    width: 12,
    height: 12,
    borderRadius: 6,
    borderWidth: 2.5,
  },
  line: {
    flex: 1,
    width: 2,
    marginTop: 4,
    marginBottom: -3,
    borderRadius: 1,
    backgroundColor: colors.border,
  },
  body: {
    flex: 1,
    gap: 8,
    paddingBottom: 18,
  },
  verb: {
    fontSize: 13,
    fontWeight: '700',
  },
  date: {
    fontWeight: '500',
    color: colors.inactive,
  },
  onlyYou: {
    fontWeight: '600',
    color: colors.inactive,
  },
  hiddenCard: {
    opacity: 0.45,
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 12,
    borderRadius: 18,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
  },
  text: {
    flex: 1,
    gap: 3,
  },
  title: {
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 21,
    color: colors.active,
  },
  place: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
  },
  placeText: {
    flexShrink: 1,
    fontSize: 13,
    color: colors.inactive,
  },
  rating: {
    gap: 3,
    marginTop: 2,
  },
  comment: {
    fontSize: 13,
    fontStyle: 'italic',
    color: colors.inactive,
  },
}));
