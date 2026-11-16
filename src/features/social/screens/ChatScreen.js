// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, FlatList, Keyboard, KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { IconButton } from '../../../components/ui/IconButton';
import { ActionSheet } from '../../../components/ui/ActionSheet';
import { tapFeedback } from '../../../lib/haptics';
import { EmptyState } from '../../../components/ui/StateViews';
import { useChat, useChatMessages, useSocial } from '../state/SocialProvider';
import { ChatAvatar } from '../components/ChatAvatar';
import { toneOf } from '../components/PersonAvatar';
import { PollComposer } from '../components/PollComposer';
import { PollMessage } from '../components/PollMessage';
import { formatCloses, formatDaySeparator, formatMutedUntil, formatTime, peopleCount } from '../model/format';
import { CONTENT_REPORT_REASONS } from '../model/reportReasons';
import { failureMessage } from '../../api/failureMessage';
import { useConnectInvite } from '../connect/connectInvites';

// Message.text in docs/API.md
const MESSAGE_MAX_LENGTH = 1000;

// One chat. The header says what it is (a person: connected or only nearby; a group:
// its size; an event: until when it stays open) and opens its details; a banner
// explains the rule when it matters (a person not connected yet, an event chat that
// closes). Messages are grouped by day, with names in groups and event chats. In
// groups and event chats the owner and the admins pin messages (a long press; the bar
// under the header goes through them) and start polls (the chart button).
export function ChatScreen({ id }) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { me, people, isConnection, isNearby, canMessage, loadChat, send, pin, unpin, createPoll, vote, closePoll, reportMessage, deleteMessage } = useSocial();
  const chat = useChat(id);
  const connectWith = useConnectInvite();
  // Loaded when the chat opens, read as they arrive, older ones while scrolling up
  const { items: messages, status, hasMore, loadOlder, retry: retryLoad } = useChatMessages(id);
  const [text, setText] = useState('');
  const list = useRef(null);
  // The message whose actions are open (a long press), the poll being written, the pin shown
  const [actionsFor, setActionsFor] = useState(null);
  const [reporting, setReporting] = useState(null);
  const [pollOpen, setPollOpen] = useState(false);
  const [pinIndex, setPinIndex] = useState(0);

  const back = () => (router.canGoBack() ? router.back() : router.replace('/social'));

  // A mute runs out by itself, with nothing from the server to say so: asked again then
  const mutedUntil = chat?.mutedUntil ? Date.parse(chat.mutedUntil) : null;
  useEffect(() => {
    if (!mutedUntil) return undefined;
    const timer = setTimeout(() => loadChat(id).catch(() => {}), Math.max(mutedUntil - Date.now(), 0) + 500);
    return () => clearTimeout(timer);
  }, [id, mutedUntil, loadChat]);

  // Newest first for the inverted list, with a day separator after each day's last item
  const items = useMemo(() => {
    const list = [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      const older = messages[i - 1];
      list.push({ type: 'message', message, firstOfRun: !older || older.from !== message.from || new Date(older.at).toDateString() !== new Date(message.at).toDateString() });
      if (!older || new Date(older.at).toDateString() !== new Date(message.at).toDateString()) {
        list.push({ type: 'day', key: `day-${message.at}`, label: formatDaySeparator(message.at) });
      }
    }
    return list;
  }, [messages]);

  if (!chat) {
    return (
      <View style={[styles.page, { paddingTop: insets.top }]}>
        <View style={styles.header}><IconButton icon="chevron-back" label="Back" onPress={back} /></View>
        <EmptyState icon="chatbubbles-outline" title="Chat not available" message="It may have closed with its event." actionLabel="Back" onAction={back} />
      </View>
    );
  }

  const direct = chat.kind === 'direct';
  // With someone nearby it changes as they walk, and nothing says so: from who is around
  // now (a past disconnection stays; the server has the last word on the message)
  const canWrite = direct ? chat.why !== 'disconnected' && canMessage(chat.with?.id) : chat.canWrite;
  const connected = direct && isConnection(chat.with?.id);
  const nearby = direct && isNearby(chat.with?.id);
  const subtitle = direct
    ? (connected ? (nearby ? 'Connected · nearby now' : 'Connected') : chat.why === 'disconnected' ? 'Disconnected' : nearby ? 'Nearby now · not connected' : 'Not connected')
    : chat.kind === 'event'
      ? [peopleCount(chat.memberCount), chat.closesAt ? formatCloses(chat.closesAt) : null].filter(Boolean).join(' · ')
      : `Group · ${peopleCount(chat.memberCount)}`;
  const showNames = !direct;
  const manager = chat.role === 'owner' || chat.role === 'admin';
  const pinned = chat.pinned ?? [];
  const shownPin = pinned.length ? pinned[pinIndex % pinned.length] : null;

  // A tap on the bar: to the pinned message (when loaded), then the next one next time
  const goToPin = () => {
    const index = items.findIndex((item) => item.type === 'message' && item.message.id === shownPin.id);
    if (index >= 0) list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
    setPinIndex((value) => value + 1);
  };

  // What a long press offers: pinning (owner, admins), closing a poll (them, its author)
  const messageActions = (message) => {
    const result = [];
    if (message.deleted) return result;
    if (manager && !message.system && !message.pending && !message.failed) {
      result.push(pinned.some((entry) => entry.id === message.id)
        ? { label: 'Unpin', icon: 'pin-outline', onPress: () => unpin(chat.id, message.id).catch(() => Alert.alert('Could not unpin it', 'Try again in a moment.')) }
        : { label: pinned.length >= 3 ? 'Pin (replaces the oldest pin)' : 'Pin', icon: 'pin', onPress: () => pin(chat.id, message.id).catch(() => Alert.alert('Could not pin it', 'Try again in a moment.')) });
    }
    if (message.poll && !message.poll.closed && (manager || message.poll.creator === me)) {
      result.push({ label: 'Close poll', icon: 'lock-closed-outline', onPress: () => closePoll(chat.id, message.id).catch(() => Alert.alert('Could not close the poll', 'Try again in a moment.')) });
    }
    if ((message.from === me || manager) && !message.system && !message.pending && !message.failed) {
      result.push({
        label: 'Delete for everyone',
        icon: 'trash-outline',
        destructive: true,
        onPress: () => Alert.alert('Delete this message?', 'It goes away for everyone in the chat.', [
          { text: 'Cancel', style: 'cancel' },
          { text: 'Delete', style: 'destructive', onPress: () => deleteMessage(chat.id, message.id).catch((error) => Alert.alert('Could not delete it', failureMessage(error))) },
        ]),
      });
    }
    if (message.from !== me && !message.system && !message.pending && !message.failed) {
      result.push({ label: 'Report', icon: 'flag-outline', destructive: true, onPress: () => setReporting(message) });
    }
    return result;
  };

  const submit = () => {
    const value = text.trim();
    if (!value || !canWrite) return;
    tapFeedback();
    send(chat.id, value);
    setText('');
    // Sent: the keyboard goes away, the conversation is in full view
    Keyboard.dismiss();
  };

  const openInfo = () => router.push({ pathname: '/chat-info/[id]', params: { id: chat.id } });

  const renderItem = ({ item }) => {
    if (item.type === 'day') return <Text style={styles.day}>{item.label}</Text>;
    const { message, firstOfRun } = item;
    if (message.system) return <Text style={styles.system}>{message.text}</Text>;
    if (message.deleted) return <Text style={styles.system}>Message removed</Text>;
    const mine = message.from === me;
    const owner = !direct && message.from === chat.ownerId;
    const author = people[message.from];
    const longPress = messageActions(message).length ? () => setActionsFor(message) : undefined;
    if (message.poll) {
      return (
        <Pressable onLongPress={longPress} delayLongPress={350} style={[styles.messageRow, mine && styles.messageRowMine, firstOfRun && styles.runStart]}>
          <View style={styles.pollWrap}>
            <PollMessage
              poll={message.poll}
              canVote={!chat.muted}
              onVote={(optionIds) => vote(chat.id, message.id, optionIds)}
              author={showNames && !mine && firstOfRun ? (
                <Text style={[styles.author, { color: toneOf(author?.username) }]}>
                  {author?.name ?? 'Someone'}
                  {owner ? <Text style={styles.ownerTag}>  · {chat.kind === 'event' ? 'Organizer' : 'Owner'}</Text> : null}
                </Text>
              ) : null}
              time={formatTime(message.at)}
            />
          </View>
        </Pressable>
      );
    }
    return (
      <Pressable onLongPress={longPress} delayLongPress={350} style={[styles.messageRow, mine && styles.messageRowMine, firstOfRun && styles.runStart]}>
        <View style={[styles.bubble, mine ? styles.bubbleMine : styles.bubbleTheirs]}>
          {showNames && !mine && firstOfRun ? (
            <Text style={[styles.author, { color: toneOf(author?.username) }]}>
              {author?.name ?? 'Someone'}
              {owner ? <Text style={styles.ownerTag}>  · {chat.kind === 'event' ? 'Organizer' : 'Owner'}</Text> : null}
            </Text>
          ) : null}
          <Text style={[styles.messageText, mine && { color: colors.onAccent }]}>{message.text}</Text>
          {message.failed ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Not sent. Send again" hitSlop={8} onPress={() => send(chat.id, message.text, message)}>
              <Text style={[styles.time, styles.timeMine, { color: colors.error }]}>Not sent · tap to retry</Text>
            </Pressable>
          ) : (
            <Text style={[styles.time, mine && styles.timeMine]}>{message.pending ? 'Sending…' : formatTime(message.at)}</Text>
          )}
        </View>
      </Pressable>
    );
  };

  return (
    <KeyboardAvoidingView behavior={process.env.EXPO_OS === 'ios' ? 'padding' : undefined} style={styles.page}>
      <View style={[styles.header, { paddingTop: insets.top + 4 }]}>
        <IconButton icon="chevron-back" label="Back" onPress={back} />
        <Pressable accessibilityRole="button" accessibilityLabel={`${chat.title}, details`} onPress={openInfo} style={({ pressed }) => [styles.headerMain, pressed && styles.pressed]}>
          <ChatAvatar chat={chat} size={38} nearby={nearby} />
          <View style={styles.headerText}>
            <Text style={styles.headerTitle} numberOfLines={1}>{chat.title}</Text>
            {/* Green only for what is happening now: someone nearby (an event chat exists before its event starts) */}
            <Text style={[styles.headerSubtitle, nearby && { color: colors.live }]} numberOfLines={1}>{subtitle}</Text>
          </View>
        </Pressable>
        <IconButton icon="information-circle-outline" label="Chat details" onPress={openInfo} />
      </View>

      {direct && !connected && nearby && chat.why !== 'disconnected' ? (
        <Banner styles={styles} colors={colors} icon="radio-outline"
          text="You can write to each other while you're close by. Connect in person to keep chatting anywhere."
          action="Connect" onAction={() => (chat.with ? connectWith({ id: chat.with.id, name: chat.with.name }) : router.push('/connect'))} />
      ) : null}
      {chat.kind === 'event' ? (
        <Banner styles={styles} colors={colors} icon="calendar-outline"
          text="This chat closes when the event ends."
          action={chat.event?.id ? 'See event' : null} onAction={() => router.push({ pathname: '/event/[id]', params: { id: chat.event.id } })} />
      ) : null}

      {shownPin ? (
        <Pressable accessibilityRole="button" accessibilityLabel={`Pinned message: ${shownPin.poll?.question ?? shownPin.text}`} onPress={goToPin}
          style={({ pressed }) => [styles.pinBar, pressed && styles.pressed]}>
          <Ionicons name="pin" size={16} color={colors.accent} />
          <View style={styles.flex}>
            <Text style={styles.pinLabel}>{pinned.length > 1 ? `Pinned ${(pinIndex % pinned.length) + 1} of ${pinned.length}` : 'Pinned'}</Text>
            <Text style={styles.pinText} numberOfLines={1}>{shownPin.poll ? `Poll: ${shownPin.poll.question}` : shownPin.text}</Text>
          </View>
        </Pressable>
      ) : null}

      <FlatList
        ref={list}
        inverted
        onScrollToIndexFailed={({ index, averageItemLength }) => {
          // Not measured yet: near it first, then exactly
          list.current?.scrollToOffset({ offset: index * averageItemLength, animated: false });
          setTimeout(() => list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true }), 80);
        }}
        data={items}
        keyExtractor={(item) => (item.type === 'day' ? item.key : item.message.id)}
        renderItem={renderItem}
        contentContainerStyle={styles.messages}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        onEndReached={hasMore ? loadOlder : undefined}
        onEndReachedThreshold={0.3}
        ListFooterComponent={status === 'loading' ? <ActivityIndicator color={colors.inactive} style={styles.loading} /> : status === 'error' ? (
          <Pressable accessibilityRole="button" onPress={retryLoad} style={styles.loading}>
            <Text style={styles.system}>Could not load the messages. Tap to try again.</Text>
          </Pressable>
        ) : messages.length === 0 ? (
          <Text style={styles.system}>{direct ? `This is the start of your chat with ${chat.title}.` : 'No messages yet.'}</Text>
        ) : null}
      />

      <View style={[styles.composer, { paddingBottom: Math.max(insets.bottom, 10) }]}>
        {canWrite ? (
          <>
            {manager ? (
              <Pressable accessibilityRole="button" accessibilityLabel="New poll" hitSlop={6} onPress={() => setPollOpen(true)}
                style={({ pressed }) => [styles.tool, pressed && styles.pressed]}>
                <Ionicons name="stats-chart" size={19} color={colors.active} />
              </Pressable>
            ) : null}
            <TextInput
              value={text}
              onChangeText={setText}
              placeholder="Message"
              placeholderTextColor={colors.inactive}
              maxLength={MESSAGE_MAX_LENGTH}
              multiline
              style={styles.input}
              accessibilityLabel="Message"
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Send"
              disabled={!text.trim()}
              onPress={submit}
              style={({ pressed }) => [styles.send, { backgroundColor: text.trim() ? colors.accent : colors.pill }, pressed && styles.pressed]}
            >
              <Ionicons name="arrow-up" size={20} color={text.trim() ? colors.onAccent : colors.inactive} />
            </Pressable>
          </>
        ) : (
          <Text style={styles.cannot}>
            {chat.why === 'muted'
              ? `An admin muted you ${formatMutedUntil(chat.mutedUntil)}. You can still read the chat.`
              : chat.why === 'readonly'
                ? 'Only the admins send messages here. You can still read and vote in polls.'
                : chat.why === 'disconnected'
                  ? `You disconnected from ${chat.title}. Connect again in person to message each other.`
                  : `You can write to ${chat.title} when you're nearby, or once you connect in person.`}
          </Text>
        )}
      </View>

      <ActionSheet
        visible={!!actionsFor}
        onClose={() => setActionsFor(null)}
        items={actionsFor ? messageActions(actionsFor) : []}
      />
      <ActionSheet
        visible={!!reporting}
        onClose={() => setReporting(null)}
        title="Why are you reporting this message?"
        items={CONTENT_REPORT_REASONS.map(({ id: reason, label }) => ({
          label,
          onPress: () => {
            const message = reporting;
            setReporting(null);
            reportMessage(message.id, reason)
              .then(() => Alert.alert('Thanks for telling us', 'We will look at it.'))
              .catch((error) => Alert.alert('Could not send the report', failureMessage(error)));
          },
        }))}
      />
      {manager ? <PollComposer visible={pollOpen} onClose={() => setPollOpen(false)} onCreate={(poll) => createPoll(chat.id, poll)} /> : null}
    </KeyboardAvoidingView>
  );
}

function Banner({ styles, colors, icon, text, action, onAction }) {
  return (
    <View style={styles.banner}>
      <Ionicons name={icon} size={18} color={colors.inactive} />
      <Text style={styles.bannerText}>{text}</Text>
      {action ? (
        <Pressable accessibilityRole="button" hitSlop={8} onPress={onAction}>
          <Text style={styles.bannerAction}>{action}</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const createStyles = (colors) => StyleSheet.create({
  flex: {
    flex: 1,
  },
  pinBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    backgroundColor: colors.page,
  },
  pinLabel: {
    fontSize: 12,
    fontWeight: '700',
    color: colors.accent,
  },
  pinText: {
    fontSize: 14,
    color: colors.active,
  },
  pollWrap: {
    maxWidth: '85%',
  },
  tool: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  loading: {
    paddingVertical: 16,
  },
  page: {
    flex: 1,
    backgroundColor: colors.page,
  },
  pressed: {
    opacity: 0.6,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 12,
    paddingBottom: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerMain: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  headerText: {
    flex: 1,
  },
  headerTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.active,
  },
  headerSubtitle: {
    fontSize: 12,
    fontWeight: '500',
    color: colors.inactive,
  },
  banner: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    marginHorizontal: 12,
    marginTop: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
  },
  bannerText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    color: colors.inactive,
  },
  bannerAction: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.active,
  },
  messages: {
    paddingHorizontal: 12,
    paddingVertical: 12,
  },
  day: {
    alignSelf: 'center',
    marginVertical: 12,
    fontSize: 12,
    fontWeight: '600',
    color: colors.inactive,
  },
  system: {
    alignSelf: 'center',
    marginVertical: 10,
    fontSize: 13,
    color: colors.inactive,
    textAlign: 'center',
  },
  messageRow: {
    flexDirection: 'row',
    marginTop: 2,
  },
  messageRowMine: {
    justifyContent: 'flex-end',
  },
  runStart: {
    marginTop: 8,
  },
  bubble: {
    maxWidth: '80%',
    paddingHorizontal: 12,
    paddingTop: 7,
    paddingBottom: 7,
    borderRadius: 18,
    borderCurve: 'continuous',
  },
  bubbleTheirs: {
    backgroundColor: colors.surface,
  },
  bubbleMine: {
    backgroundColor: colors.accent,
  },
  author: {
    fontSize: 12,
    fontWeight: '700',
    marginBottom: 2,
  },
  ownerTag: {
    fontWeight: '500',
    color: colors.inactive,
  },
  messageText: {
    fontSize: 16,
    lineHeight: 21,
    color: colors.active,
  },
  time: {
    alignSelf: 'flex-end',
    marginTop: 1,
    fontSize: 11,
    color: colors.inactive,
    fontVariant: ['tabular-nums'],
  },
  timeMine: {
    color: colors.onAccent,
    opacity: 0.6,
  },
  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 8,
    paddingHorizontal: 12,
    paddingTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.page,
  },
  input: {
    flex: 1,
    minHeight: 40,
    maxHeight: 120,
    paddingHorizontal: 16,
    paddingTop: 10,
    paddingBottom: 10,
    borderRadius: 20,
    fontSize: 16,
    color: colors.active,
    backgroundColor: colors.surface,
  },
  send: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: 'center',
    justifyContent: 'center',
  },
  cannot: {
    flex: 1,
    textAlign: 'center',
    fontSize: 14,
    lineHeight: 20,
    color: colors.inactive,
    paddingVertical: 6,
  },
});
