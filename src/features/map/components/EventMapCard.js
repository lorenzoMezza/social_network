// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { SwipeDownToClose } from '../../../components/ui/SwipeDownToClose';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Animated, Easing, Pressable, StyleSheet, Text, View } from 'react-native';
import { GlassFill } from '../../../components/ui/GlassFill';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { Button } from '../../../components/ui/Button';
import { successFeedback, tapFeedback } from '../../../lib/haptics';
import { CategoryTile } from '../../events/components/CategoryTile';
import { categoryLine } from '../../events/model/categories';
import {
  LEAVE_EVENT, STATUS, distanceMeters, eventStatus, formatDistance, goingLine, isFull, joinRefusal, spotsLine, whenLine,
} from '../../events/model/eventModel';
import { useEvents } from '../../events/state/EventsProvider';
import { failureMessage } from '../../api/failureMessage';

// The short card of an event tapped on the map, over the bottom of the map while the
// camera looks at it: what, when, how far, who is going, and Join right there.
// "Details" opens the full page.
export function EventMapCard({ event, bottom, onClose, onOpen, onHeight }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { user, position, isGoing, setGoing, reloadEvent } = useEvents();
  const [busy, setBusy] = useState(false);
  const [rise] = useState(() => new Animated.Value(0));
  const shown = useRef(null);

  // Slides up when an event is chosen (again when another one is)
  useEffect(() => {
    if (!event || shown.current === event.id) return;
    shown.current = event.id;
    rise.setValue(0);
    Animated.timing(rise, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [event, rise]);

  if (!event) return null;
  const status = eventStatus(event);
  const live = status === STATUS.ongoing;
  const following = isGoing(event.id);
  const isOwner = !!user && event.creatorId === user.id;
  const distance = formatDistance(distanceMeters(position, event.location));
  const spots = spotsLine(event);
  const details = [distance, goingLine(event), spots].filter(Boolean).join(' · ');

  const finished = status === STATUS.concluded || status === STATUS.cancelled;
  const full = !following && isFull(event);

  // As on the event's page: leaving asks first, and a refusal says why. The store has
  // undone the change, so the button already shows the real state again
  const setJoined = async (going) => {
    setBusy(true);
    try {
      await setGoing(event.id, going);
      if (going) successFeedback();
      else tapFeedback();
    } catch (error) {
      // What the server knows and this card did not: shown as it is now
      if (error?.status && error.status < 500) reloadEvent(event.id);
      const refusal = joinRefusal(error);
      if (refusal) Alert.alert(refusal.title, refusal.message);
      else Alert.alert('Could not update', failureMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const toggle = () => {
    if (!following) {
      setJoined(true);
      return;
    }
    Alert.alert(LEAVE_EVENT.title, LEAVE_EVENT.message, [
      { text: 'Stay', style: 'cancel' },
      { text: 'Leave', style: 'destructive', onPress: () => setJoined(false) },
    ]);
  };

  return (
    <SwipeDownToClose onClose={onClose} style={[styles.place, { bottom }]}>
    <Animated.View
      onLayout={(layoutEvent) => onHeight?.(layoutEvent.nativeEvent.layout.height)}
      style={[
        styles.card,
        { opacity: rise, transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }) }] },
      ]}
    >
      <GlassFill />
      <View style={styles.header}>
        <CategoryTile event={event} size={44} />
        <Pressable accessibilityRole="button" accessibilityHint="Opens the event" onPress={onOpen} style={styles.titleArea}>
          <Text style={styles.kind} numberOfLines={1}>
            {event.sponsored ? <Text style={styles.sponsored}>Sponsored · </Text> : null}{event.flash ? '⚡ Flash · ' : ''}{categoryLine(event, 2) || 'Event'}
          </Text>
          <Text style={styles.title} numberOfLines={2}>{event.title}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" hitSlop={10} onPress={onClose} style={styles.close}>
          <Ionicons name="close" size={18} color={colors.barMuted} />
        </Pressable>
      </View>
      <Text style={[styles.when, live && { color: colors.live }]}>{whenLine(event)}</Text>
      {details ? <Text style={styles.details}>{details}</Text> : null}
      <View style={styles.actions}>
        {isOwner || finished ? (
          <View style={[styles.own, { backgroundColor: colors.pill }]}>
            <Text style={styles.ownText}>{isOwner ? 'Your event' : status === STATUS.cancelled ? 'Cancelled' : 'Ended'}</Text>
          </View>
        ) : (
          <Button
            label={following ? 'Going' : full ? 'Full' : 'Join'}
            icon={following ? 'checkmark' : undefined}
            variant={following ? 'secondary' : 'primary'}
            busy={busy}
            disabled={full}
            onPress={toggle}
            style={styles.action}
          />
        )}
        <Button label="Details" variant="secondary" onPress={onOpen} style={styles.action} />
      </View>
    </Animated.View>
    </SwipeDownToClose>
  );
}

const createStyles = (colors) => StyleSheet.create({
  place: {
    position: 'absolute',
    left: 12,
    right: 12,
  },
  card: {
    padding: 16,
    gap: 6,
    borderRadius: 24,
    borderCurve: 'continuous',
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.barEdge,
    boxShadow: '0 8px 30px rgba(0, 0, 0, 0.18)',
    zIndex: 20,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  titleArea: {
    flex: 1,
    gap: 2,
  },
  kind: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.barMuted,
  },
  sponsored: {
    color: colors.gold,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.2,
    color: colors.active,
  },
  close: {
    alignSelf: 'flex-start',
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.barPill,
  },
  when: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.active,
    marginTop: 4,
  },
  details: {
    fontSize: 14,
    color: colors.barMuted,
  },
  actions: {
    flexDirection: 'row',
    gap: 10,
    marginTop: 8,
  },
  action: {
    flex: 1,
  },
  own: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 22,
  },
  ownText: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.active,
  },
});
