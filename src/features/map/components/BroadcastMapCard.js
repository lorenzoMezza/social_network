// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { SwipeDownToClose } from '../../../components/ui/SwipeDownToClose';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Keyboard, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { GlassFill } from '../../../components/ui/GlassFill';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { successFeedback } from '../../../lib/haptics';
import { BROADCAST_MAX_LENGTH } from '../model/broadcasts';
import { useKeyboardHeight } from '../hooks/useKeyboardHeight';

// The user's own card, opened by tapping their avatar on the map (the view stays as
// it is): one line to say something to everyone who can see them right now, shown
// over their head on everyone's map. It says how many will see it; when
// nobody can (invisible, or nobody around) there is nothing to send. It rises with the
// keyboard.
export function BroadcastMapCard({ open, audience, invisible, bottom, onClose, onSend, onHeight }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [rise] = useState(() => new Animated.Value(0));
  const [draft, setDraft] = useState('');
  const wasOpen = useRef(false);
  const keyboard = useKeyboardHeight();

  useEffect(() => {
    if (open && !wasOpen.current) {
      rise.setValue(0);
      Animated.timing(rise, { toValue: 1, duration: 260, easing: Easing.out(Easing.cubic), useNativeDriver: true }).start();
    }
    wasOpen.current = open;
  }, [open, rise]);

  if (!open) return null;
  const canSend = !invisible && audience > 0;
  const details = invisible
    ? 'You are invisible: nobody sees you'
    : audience === 0
      ? 'Nobody nearby can see you right now'
      : audience === 1 ? '1 person nearby will see it' : `${audience} people nearby will see it`;

  const send = () => {
    const text = draft.trim();
    if (!text || !canSend) return;
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
        <View style={styles.icon}>
          <Ionicons name="megaphone-outline" size={20} color={colors.active} />
        </View>
        <View style={styles.titleArea}>
          <Text style={styles.title} numberOfLines={1}>Everyone nearby</Text>
          <Text style={styles.details} numberOfLines={1}>{details}</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" hitSlop={10} onPress={onClose} style={styles.close}>
          <Ionicons name="close" size={18} color={colors.barMuted} />
        </Pressable>
      </View>

      {canSend && (
        <View style={styles.composer}>
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Say something to everyone…"
            placeholderTextColor={colors.barMuted}
            maxLength={BROADCAST_MAX_LENGTH}
            returnKeyType="send"
            submitBehavior="submit"
            onSubmitEditing={send}
            style={styles.input}
            accessibilityLabel="Message to everyone nearby"
          />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Send to everyone nearby"
            accessibilityState={{ disabled: !draft.trim() }}
            disabled={!draft.trim()}
            onPress={send}
            style={[styles.send, !draft.trim() && styles.sendOff]}
          >
            <Ionicons name="arrow-up" size={18} color={colors.onAccent} />
          </Pressable>
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  icon: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.barPill,
  },
  titleArea: {
    flex: 1,
    gap: 1,
  },
  title: {
    fontSize: 18,
    fontWeight: '700',
    letterSpacing: -0.2,
    color: colors.active,
  },
  details: {
    fontSize: 13,
    color: colors.barMuted,
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
  composer: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
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
});
