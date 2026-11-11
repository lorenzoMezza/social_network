// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { memo } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { themedStyles, useColors } from '../../../theme/colors';
import { formatChatTime, formatCloses, peopleCount } from '../model/format';
import { ChatAvatar } from './ChatAvatar';

const KIND_LABEL = { group: 'Group', event: 'Event' };

// A chat in the inbox: its face, its name, who said the last thing and when, how many
// messages are new. Event chats say when they close; groups show their size.
export const ChatRow = memo(function ChatRow({ chat, people, me, nearby, onPress }) {
  const colors = useColors();
  const styles = useStyles();
  const unread = chat.unread > 0;
  const last = chat.last;
  const authorName = people[last?.from]?.name || people[last?.from]?.username;
  const author = !last || chat.kind === 'direct' || last.system ? '' : last.from === me ? 'You: ' : authorName ? `${authorName}: ` : '';
  const text = last?.deleted ? 'Message removed' : last?.poll ? `📊 ${last.poll.question}` : last?.text;
  const preview = last ? (last.from === me && chat.kind === 'direct' ? `You: ${text}` : `${author}${text}`) : chat.kind === 'direct' ? 'Say hi 👋' : 'No messages yet';

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${chat.title}. ${preview}${unread ? `. ${chat.unread} new` : ''}`}
      onPress={() => onPress(chat)}
      style={({ pressed }) => [styles.row, pressed && styles.pressed]}
    >
      <ChatAvatar chat={chat} size={52} nearby={nearby} />
      <View style={styles.text}>
        <View style={styles.top}>
          <Text style={[styles.title, unread && styles.titleUnread]} numberOfLines={1}>{chat.title}</Text>
          {last ? <Text style={[styles.time, unread && { color: colors.accent, fontWeight: '600' }]}>{formatChatTime(last.at)}</Text> : null}
        </View>
        <View style={styles.bottom}>
          <Text style={[styles.preview, unread && styles.previewUnread]} numberOfLines={1}>{preview}</Text>
          {unread ? (
            <View style={[styles.count, { backgroundColor: colors.accent }]}>
              <Text style={[styles.countText, { color: colors.onAccent }]}>{chat.unread}</Text>
            </View>
          ) : null}
        </View>
        {chat.kind !== 'direct' ? (
          <View style={styles.tags}>
            <Text style={styles.tag}>{KIND_LABEL[chat.kind]}</Text>
            {chat.kind === 'event' ? (
              chat.closesAt ? (
                // Neutral: the chat may close before or after its event started
                <View style={[styles.closes, { backgroundColor: colors.pill }]}>
                  <Ionicons name="time-outline" size={11} color={colors.inactive} />
                  <Text style={[styles.closesText, { color: colors.inactive }]}>{formatCloses(chat.closesAt)}</Text>
                </View>
              ) : null
            ) : (
              <Text style={styles.tag}>{`· ${peopleCount(chat.memberCount)}`}</Text>
            )}
          </View>
        ) : null}
      </View>
    </Pressable>
  );
});

const useStyles = themedStyles((colors) => StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 10,
  },
  pressed: {
    opacity: 0.6,
  },
  text: {
    flex: 1,
    gap: 2,
  },
  top: {
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 8,
  },
  title: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    color: colors.active,
  },
  titleUnread: {
    fontWeight: '800',
  },
  time: {
    fontSize: 13,
    color: colors.inactive,
    fontVariant: ['tabular-nums'],
  },
  bottom: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  preview: {
    flex: 1,
    fontSize: 14,
    color: colors.inactive,
  },
  previewUnread: {
    color: colors.active,
    fontWeight: '500',
  },
  count: {
    minWidth: 20,
    height: 20,
    paddingHorizontal: 6,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  countText: {
    fontSize: 12,
    fontWeight: '700',
  },
  tags: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    marginTop: 2,
  },
  tag: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inactive,
  },
  closes: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 6,
    height: 18,
    borderRadius: 9,
  },
  closesText: {
    fontSize: 11,
    fontWeight: '700',
  },
}));
