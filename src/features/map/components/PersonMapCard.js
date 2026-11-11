// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { SwipeDownToClose } from '../../../components/ui/SwipeDownToClose';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { GlassFill } from '../../../components/ui/GlassFill';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { Button } from '../../../components/ui/Button';
import { successFeedback, tapFeedback } from '../../../lib/haptics';
import { formatDistance } from '../../events/model/eventModel';
import { PersonAvatar } from '../../social/components/PersonAvatar';
import { MAP_GESTURES } from '../model/gestures';
import { useKeyboardHeight } from '../hooks/useKeyboardHeight';

const MESSAGE_MAX = 300;
// A gesture can be made again after this (no spamming someone's map)
const GESTURE_COOLDOWN_MS = 1800;

// The card of someone tapped on the map, while the camera frames the two of you: who
// they are and how far; a row of gestures (your avatar makes it at them, they see it
// on their map); a line to write to them, when allowed (a connection, or someone
// nearby), shown over your head on the map and kept in your chat. Their name opens
// their profile. It rises with the keyboard.
export function PersonMapCard({ person, distance, connected, canWrite, bottom, onClose, onProfile, onChat, onConnect, onGesture, onSend, onHeight }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [rise] = useState(() => new Animated.Value(0));
  const shown = useRef(null);
  const [draft, setDraft] = useState('');
  const [sent, setSent] = useState(null); // the gesture just made: its tile says so
  const lastGesture = useRef(0);
  const keyboard = useKeyboardHeight();

  useEffect(() => {
    if (!person || shown.current === person.userId) return;
    shown.current = person.userId;
    rise.setValue(0);
    Animated.timing(rise, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
  }, [person, rise]);

  useEffect(() => {
    if (!sent) return undefined;
    const timer = setTimeout(() => setSent(null), 1600);
    return () => clearTimeout(timer);
  }, [sent]);

  // Another person: what was being written to the previous one is dropped
  const personId = person?.userId ?? null;
  const [draftFor, setDraftFor] = useState(personId);
  if (draftFor !== personId) {
    setDraftFor(personId);
    setDraft('');
  }

  if (!person) return null;
  const area = person.precision === 'area';
  // Whole names: "Blue Note TV" cut at its first word would read "Blue"
  const who = person.name;
  const distanceLabel = formatDistance(distance);
  const where = area ? 'Somewhere in this area' : distanceLabel ? `${distanceLabel} away` : 'Nearby';
  const details = [person.username ? `@${person.username}` : null, where, connected ? 'Connected' : null].filter(Boolean).join(' · ');

  // `at`: the time of the tap (ms)
  const gesture = (id, at) => {
    if (at - lastGesture.current < GESTURE_COOLDOWN_MS) return;
    lastGesture.current = at;
    tapFeedback();
    setSent(id);
    onGesture(id);
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;
    successFeedback();
    onSend(text);
    setDraft('');
    Keyboard.dismiss();
  };

  return (
    <SwipeDownToClose onClose={onClose} style={[styles.place, { bottom: keyboard ? keyboard + 8 : bottom }]}>
    <Animated.View
      onLayout={(event) => onHeight?.(event.nativeEvent.layout.height)}
      style={[
        styles.card,
        { opacity: rise, transform: [{ translateY: rise.interpolate({ inputRange: [0, 1], outputRange: [40, 0] }) }] },
      ]}
    >
      <GlassFill />

      <View style={styles.header}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${person.name}, open profile`}
          onPress={onProfile}
          style={({ pressed }) => [styles.who, pressed && styles.pressed]}
        >
          <PersonAvatar id={person.userId} username={person.username} name={person.name} picture={person.pictureUrl} size={46} badge={connected ? <Ionicons name="link" size={10} color="#FFFFFF" /> : null} />
          <View style={styles.titleArea}>
            <View style={styles.nameRow}>
              <Text style={styles.name} numberOfLines={1}>{person.name}</Text>
              <Ionicons name="chevron-forward" size={15} color={colors.barMuted} />
            </View>
            <Text style={styles.details} numberOfLines={1}>{details}</Text>
          </View>
        </Pressable>
        {/* Connect invites them: they scan the code the user shows */}
        {!connected && canWrite ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Connect with ${who}`}
            hitSlop={6}
            onPress={onConnect}
            style={({ pressed }) => [styles.connectPill, pressed && styles.pressed]}
          >
            <Ionicons name="link" size={14} color={colors.active} />
            <Text style={styles.connectPillLabel}>Connect</Text>
          </Pressable>
        ) : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Close" hitSlop={10} onPress={onClose} style={styles.close}>
          <Ionicons name="close" size={18} color={colors.barMuted} />
        </Pressable>
      </View>

      <View style={styles.gestures}>
        {MAP_GESTURES.map((item) => {
          const done = sent === item.id;
          return (
            <Pressable
              key={item.id}
              accessibilityRole="button"
              accessibilityLabel={`${item.label} at ${who}`}
              onPress={(event) => gesture(item.id, event.nativeEvent.timestamp)}
              style={({ pressed }) => [styles.gesture, done && styles.gestureDone, pressed && styles.gesturePressed]}
            >
              <Text style={styles.emoji}>{item.emoji}</Text>
              <Text style={[styles.gestureLabel, done && { color: colors.active }]} numberOfLines={1}>{done ? 'Sent' : item.label}</Text>
            </Pressable>
          );
        })}
      </View>

      {canWrite ? (
        <View style={styles.composer}>
          <Pressable accessibilityRole="button" accessibilityLabel={`Open the chat with ${who}`} hitSlop={6} onPress={onChat} style={styles.chatButton}>
            <Ionicons name="chatbubbles-outline" size={19} color={colors.active} />
          </Pressable>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={`Say something to ${who}…`}
            placeholderTextColor={colors.barMuted}
            maxLength={MESSAGE_MAX}
            returnKeyType="send"
            submitBehavior="submit"
            onSubmitEditing={send}
            style={styles.input}
            accessibilityLabel={`Message to ${who}`}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send"
            accessibilityState={{ disabled: !draft.trim() }}
            disabled={!draft.trim()}
            onPress={send}
            style={[styles.send, !draft.trim() && styles.sendOff]}
          >
            <Ionicons name="arrow-up" size={18} color={colors.onAccent} />
          </Pressable>
        </View>
      ) : (
        <View style={styles.connectRow}>
          <Text style={styles.connectText}>Connect in person to write to {who}.</Text>
          <Button label="Connect" icon="link" compact onPress={onConnect} />
        </View>
      )}
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
    padding: 14,
    gap: 12,
    borderRadius: 24,
    borderCurve: 'continuous',
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.barEdge,
    boxShadow: '0 8px 30px rgba(0, 0, 0, 0.18)',
    zIndex: 20,
  },
  pressed: {
    opacity: 0.6,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  who: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  titleArea: {
    flex: 1,
    gap: 1,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 2,
  },
  name: {
    flexShrink: 1,
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.2,
    color: colors.active,
  },
  details: {
    fontSize: 13,
    color: colors.barMuted,
  },
  connectPill: {
    alignSelf: 'flex-start',
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    height: 30,
    paddingHorizontal: 11,
    borderRadius: 15,
    backgroundColor: colors.barPill,
  },
  connectPillLabel: {
    fontSize: 13,
    fontWeight: '600',
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
  gestures: {
    flexDirection: 'row',
    gap: 8,
  },
  gesture: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
    paddingVertical: 8,
    borderRadius: 16,
    borderCurve: 'continuous',
    borderWidth: 1.5,
    borderColor: 'transparent',
    backgroundColor: colors.barPill,
  },
  gestureDone: {
    borderColor: colors.active,
  },
  gesturePressed: {
    transform: [{ scale: 0.94 }],
  },
  emoji: {
    fontSize: 24,
  },
  gestureLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.barMuted,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  chatButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.barPill,
  },
  input: {
    flex: 1,
    height: 40,
    paddingHorizontal: 14,
    borderRadius: 20,
    fontSize: 15,
    color: colors.active,
    backgroundColor: colors.barPill,
  },
  send: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  sendOff: {
    opacity: 0.3,
  },
  connectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  connectText: {
    flex: 1,
    fontSize: 14,
    color: colors.barMuted,
  },
});
