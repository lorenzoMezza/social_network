// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo, useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { tapFeedback } from '../../../lib/haptics';

// A poll in a chat (Message.poll, API.md): its answers with how many chose each, the
// user's own choices ticked. A tap votes: one answer replaces the previous one, or
// toggles with several allowed; tapping one's only choice again takes the vote back.
// Votes are not secret: everyone sees the counts at once (`message.updated`).
//   canVote: false while muted or once closed
//   author, time: as in any other message, inside it
export function PollMessage({ poll, canVote, onVote, author, time }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [busy, setBusy] = useState(false);
  const mine = poll.mine ?? [];
  // Shares of the people who voted (with several answers they add up to more than 100 %)
  const votes = poll.voterCount;
  const open = !poll.closed && canVote;

  const choose = async (id) => {
    if (!open || busy) return;
    tapFeedback();
    const next = poll.multiple
      ? (mine.includes(id) ? mine.filter((choice) => choice !== id) : [...mine, id])
      : (mine.length === 1 && mine[0] === id ? [] : [id]);
    setBusy(true);
    try {
      await onVote(next);
    } catch {
      Alert.alert('Your vote was not counted', 'Try again in a moment.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.card}>
      {author}
      <Text style={styles.question}>{poll.question}</Text>
      <Text style={styles.kind}>
        {poll.closed ? 'Poll closed' : poll.multiple ? 'Poll · choose one or more' : 'Poll · choose one'}
      </Text>
      <View style={styles.options}>
        {poll.options.map((option) => {
          const chosen = mine.includes(option.id);
          // A poll kept on the phone from before the counts came as a number
          const count = option.votes ?? option.voters?.length ?? 0;
          const percent = votes ? Math.round((count / votes) * 100) : 0;
          return (
            <Pressable
              key={option.id}
              accessibilityRole={poll.multiple ? 'checkbox' : 'radio'}
              accessibilityState={{ checked: chosen, disabled: !open }}
              accessibilityLabel={`${option.text}, ${count} ${count === 1 ? 'vote' : 'votes'}`}
              disabled={!open}
              onPress={() => choose(option.id)}
              style={({ pressed }) => [styles.option, pressed && styles.pressed]}
            >
              {/* Over the whole answer, its padding too: a percentage of the row alone is
                  measured without it, and 100 % would stop short of the edge */}
              <View style={styles.track} pointerEvents="none">
                <View style={[styles.fill, chosen ? styles.fillChosen : styles.fillOther, { width: `${percent}%` }]} />
              </View>
              <Ionicons
                name={chosen ? (poll.multiple ? 'checkbox' : 'checkmark-circle') : (poll.multiple ? 'square-outline' : 'ellipse-outline')}
                size={20}
                color={chosen ? colors.accent : colors.inactive}
              />
              <Text style={styles.optionText}>{option.text}</Text>
              <Text style={styles.count}>{votes ? `${percent}%` : ''}</Text>
            </Pressable>
          );
        })}
      </View>
      <View style={styles.foot}>
        <Text style={styles.total}>
          {`${poll.voterCount} ${poll.voterCount === 1 ? 'person voted' : 'people voted'}`}
          {!canVote && !poll.closed ? ' · you cannot vote while muted' : ''}
        </Text>
        {time ? <Text style={styles.time}>{time}</Text> : null}
      </View>
    </View>
  );
}

const createStyles = (colors) => StyleSheet.create({
  card: {
    width: 270,
    maxWidth: '100%',
    padding: 12,
    gap: 2,
    borderRadius: 18,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
  },
  question: {
    fontSize: 16,
    fontWeight: '700',
    lineHeight: 21,
    color: colors.active,
  },
  kind: {
    fontSize: 12,
    color: colors.inactive,
    marginBottom: 6,
  },
  options: {
    gap: 6,
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 40,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 12,
    borderCurve: 'continuous',
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  track: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
  },
  fill: {
    height: '100%',
  },
  fillChosen: {
    backgroundColor: colors.accentSoft,
  },
  // A step off the card in both themes: the page's greys are too close to it
  fillOther: {
    backgroundColor: colors.scheme === 'dark' ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.07)',
  },
  pressed: {
    opacity: 0.6,
  },
  optionText: {
    flex: 1,
    fontSize: 15,
    color: colors.active,
  },
  count: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.inactive,
    fontVariant: ['tabular-nums'],
  },
  foot: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    marginTop: 8,
  },
  total: {
    flex: 1,
    fontSize: 12,
    color: colors.inactive,
  },
  time: {
    fontSize: 11,
    color: colors.inactive,
    fontVariant: ['tabular-nums'],
  },
});
