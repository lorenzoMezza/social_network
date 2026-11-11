// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { IconButton } from '../../../components/ui/IconButton';
import { ActionSheet } from '../../../components/ui/ActionSheet';
import { useTabLinks } from '../../../components/navigation/useTabLinks';
import { useChat, useSocial } from '../state/SocialProvider';
import { usePersonActions } from '../components/usePersonActions';
import { useGroupPhotoSheet } from '../components/useGroupPhotoSheet';
import { CONTENT_REPORT_REASONS } from '../model/reportReasons';
import { failureMessage } from '../../api/failureMessage';
import { discardPickedFile } from '../../api/uploads';
import { ChatAvatar } from '../components/ChatAvatar';
import { PersonAvatar } from '../components/PersonAvatar';
import { formatCloses, formatMutedUntil, formatSince, peopleCount } from '../model/format';

const RANK = { owner: 2, admin: 1, member: 0 };
// How long a mute lasts (API.md: minutes, or null until unmuted)
const MUTE_CHOICES = [
  { label: '1 hour', minutes: 60 },
  { label: '8 hours', minutes: 480 },
  { label: '1 week', minutes: 10080 },
  { label: 'Until I unmute', minutes: null },
];

// What a chat is and who is in it. Groups and event chats are run by their owner (the
// creator, or the event's organizer) and the admins the owner names (API.md,
// Moderation): they add people, make the chat read-only, and manage each member from
// their row (a tap: make admin, mute, remove). The server checks every rule; this
// screen offers only what the user's role allows. An event chat closes when its event
// ends; leaving it leaves the event.
export function ChatInfoScreen({ id }) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const links = useTabLinks();
  const social = useSocial();
  const { me, connections, isConnection, isNearby, loadChat } = social;
  const chat = useChat(id);
  const actions = usePersonActions(chat?.kind === 'direct' ? chat.with : null);
  // The member whose actions are open, and the mute durations for them
  const [managed, setManaged] = useState(null);
  const [muting, setMuting] = useState(null);
  const [reporting, setReporting] = useState(false);
  const [savingPhoto, setSavingPhoto] = useState(false);
  const changePhoto = (uri) => {
    setSavingPhoto(true);
    social.setGroupPicture(id, uri)
      .catch((error) => {
        // Not used: the copy the picker made does not stay on the phone
        discardPickedFile(uri);
        Alert.alert(uri ? 'Could not use this photo' : 'Could not remove the photo', failureMessage(error));
      })
      .finally(() => setSavingPhoto(false));
  };
  const photo = useGroupPhotoSheet({ onPicked: changePhoto, onRemove: chat?.pictureUrl ? () => changePhoto(null) : undefined });
  // Who is in it: loaded from the server each time the details open
  useEffect(() => {
    loadChat(id).catch(() => {});
  }, [id, loadChat]);
  // The chat went away (the person was blocked, the group left or deleted, the user
  // removed): back to the inbox
  const gone = !chat;
  useEffect(() => {
    if (gone) router.dismissTo('/social');
  }, [gone]);
  if (!chat) return null;

  const direct = chat.kind === 'direct';
  const event = chat.kind === 'event';
  const role = chat.role ?? 'member';
  const manager = RANK[role] >= RANK.admin;
  const connection = direct ? connections.find((entry) => entry.user.id === chat.with?.id) : null;
  const members = chat.members ?? [];
  const ownerLabel = event ? 'Organizer' : 'Owner';
  const place = event ? 'event' : 'group';

  const openPerson = (person) => {
    if (!person || person.id === me) return;
    router.push(links.user(person.id, { username: person.username, name: person.name }));
  };

  // Every action reports its own failure; the details are loaded again either way
  const run = (action, failure) => action().catch(() => {
    Alert.alert(failure, 'Try again in a moment.');
    loadChat(id).catch(() => {});
  });

  const confirmRemove = ({ user: person }) => {
    Alert.alert(`Remove ${person.name}?`, event
      ? 'They leave the event and its chat, and cannot join the event again.'
      : 'They leave the group. You can add them again later.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => run(() => social.removeMember(chat.id, person.id), `Could not remove ${person.name}`) },
    ]);
  };

  // What the user can do to a member: only to a lower role (the owner to everyone)
  const memberActions = (entry) => {
    const { user: person, role: theirs, muted } = entry;
    const items = [{ label: 'View profile', icon: 'person-outline', onPress: () => openPerson(person) }];
    if (role === 'owner') {
      items.push(theirs === 'admin'
        ? { label: 'Remove as admin', icon: 'shield-outline', onPress: () => run(() => social.setRole(chat.id, person.id, 'member'), 'Could not change their role') }
        : { label: 'Make admin', icon: 'shield-checkmark-outline', onPress: () => run(() => social.setRole(chat.id, person.id, 'admin'), 'Could not make them an admin') });
    }
    items.push(muted
      ? { label: 'Unmute', icon: 'volume-high-outline', onPress: () => run(() => social.unmute(chat.id, person.id), 'Could not unmute them') }
      : { label: 'Mute…', icon: 'volume-mute-outline', onPress: () => setMuting(entry) });
    items.push({ label: `Remove from ${place}`, icon: 'person-remove-outline', destructive: true, onPress: () => confirmRemove(entry) });
    return items;
  };

  const confirmLeave = () => {
    // The owner too: the group passes on (API.md, Moderation). Alone in it, it ends
    let words = 'An admin can add you again.';
    if (event) words = 'You stop going to it and leave its chat. You can join it again.';
    else if (role === 'owner') {
      words = chat.memberCount > 1
        ? 'The group passes to the admin who has been here longest, or else to whoever has.'
        : 'You are the only one here: the group ends with you.';
    }
    Alert.alert(event ? 'Leave the event?' : `Leave “${chat.title}”?`, words, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Leave',
        style: 'destructive',
        onPress: () => social.leave(chat.id).then(() => router.dismissTo('/social')).catch(() => Alert.alert(`Could not leave the ${place}`, 'Try again in a moment.')),
      },
    ]);
  };

  const confirmDelete = () => {
    Alert.alert(`Delete “${chat.title}”?`, 'The group and its messages go away for everyone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete group',
        style: 'destructive',
        onPress: () => social.deleteGroup(chat.id).then(() => router.dismissTo('/social')).catch(() => Alert.alert('Could not delete the group', 'Try again in a moment.')),
      },
    ]);
  };

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <IconButton icon="chevron-back" label="Back" onPress={() => router.back()} />
      </View>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]} showsVerticalScrollIndicator={false}>
        <View style={styles.hero}>
          {!direct && !event && manager ? (
            <Pressable accessibilityRole="button" accessibilityLabel="Change the group's photo" disabled={savingPhoto} onPress={photo.open} style={({ pressed }) => pressed && styles.pressed}>
              <ChatAvatar chat={chat} size={84} />
              <View style={styles.photoBadge}>
                {savingPhoto ? <ActivityIndicator size="small" color={colors.onAccent} /> : <Ionicons name="camera" size={15} color={colors.onAccent} />}
              </View>
            </Pressable>
          ) : (
            <ChatAvatar chat={chat} size={84} nearby={direct && isNearby(chat.with?.id)} />
          )}
          <Text style={styles.title} accessibilityRole="header">{chat.title}</Text>
          <Text style={styles.subtitle}>
            {direct ? `@${chat.with?.username}` : event ? ['Event chat', chat.closesAt ? formatCloses(chat.closesAt) : null].filter(Boolean).join(' · ') : `Group · ${peopleCount(chat.memberCount)}`}
          </Text>
        </View>

        {direct ? (
          <View style={styles.card}>
            <Row styles={styles} colors={colors} icon={connection ? 'link' : 'radio-outline'}
              title={connection ? `Connected ${formatSince(connection.since)}` : isNearby(chat.with?.id) ? 'Nearby, not connected' : 'Not connected'}
              subtitle={connection ? connection.place : 'Connect in person to chat from anywhere'} />
            <Row styles={styles} colors={colors} icon="person-outline" title="View profile" chevron onPress={() => openPerson(chat.with)} last />
          </View>
        ) : null}
        {direct ? (
          <View style={styles.card}>
            {actions.sheet.items.map((item, index) => (
              <Pressable
                key={item.label}
                accessibilityRole="button"
                onPress={item.onPress}
                style={({ pressed }) => [styles.row, index < actions.sheet.items.length - 1 && styles.divider, pressed && styles.pressed]}
              >
                <Ionicons name={item.icon} size={20} color={item.destructive ? colors.error : colors.active} />
                <Text style={[styles.rowTitle, item.destructive && { color: colors.error }]}>{item.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {event ? (
          <View style={styles.card}>
            <Row styles={styles} colors={colors} icon="calendar-outline" title="Open the event" subtitle="Everyone who joined it is in this chat" chevron
              onPress={chat.event?.id ? () => router.push({ pathname: '/event/[id]', params: { id: chat.event.id } }) : undefined} />
            <Row styles={styles} colors={colors} icon="time-outline" title="Closes when the event ends" subtitle="The chat and its messages go away then" last />
          </View>
        ) : null}

        {!direct && manager ? (
          <>
            <Text style={styles.section}>Settings</Text>
            <View style={styles.card}>
              <View style={styles.row}>
                <Ionicons name="megaphone-outline" size={20} color={colors.active} />
                <View style={styles.flex}>
                  <Text style={styles.rowTitle}>Only admins send messages</Text>
                  <Text style={styles.rowSubtitle}>Everyone still reads and votes in polls</Text>
                </View>
                <Switch
                  value={!!chat.readOnly}
                  onValueChange={(value) => run(() => social.setReadOnly(chat.id, value), 'Could not change who can write')}
                  trackColor={{ true: colors.accent }}
                  thumbColor={process.env.EXPO_OS === 'android' ? '#FFFFFF' : undefined}
                  accessibilityLabel="Only admins send messages"
                />
              </View>
            </View>
          </>
        ) : null}

        {!direct ? (
          <>
            <View style={styles.sectionRow}>
              <Text style={styles.section}>{event ? peopleCount(chat.memberCount) : 'Members'}</Text>
              {manager ? <Text style={styles.ownerNote}>Tap someone to manage them</Text> : null}
            </View>
            <View style={styles.card}>
              {manager && !event ? (
                <Row styles={styles} colors={colors} icon="person-add-outline" title="Add people" subtitle="From your connections"
                  onPress={() => router.push({ pathname: '/new-group', params: { add: chat.id } })} chevron />
              ) : null}
              {members.map((entry, index) => {
                const { user: person, role: theirs, muted, mutedUntil } = entry;
                const self = person.id === me;
                const manageable = !self && RANK[role] > RANK[theirs ?? 'member'];
                return (
                  <Pressable
                    key={person.id}
                    accessibilityRole="button"
                    accessibilityHint={manageable ? 'Opens what you can do' : undefined}
                    disabled={self}
                    onPress={() => (manageable ? setManaged(entry) : openPerson(person))}
                    style={({ pressed }) => [styles.member, index < members.length - 1 && styles.divider, pressed && styles.pressed]}
                  >
                    <PersonAvatar person={person} size={38} ring={!self && isNearby(person.id)} />
                    <View style={styles.flex}>
                      <Text style={styles.memberName}>{self ? 'You' : person.name}</Text>
                      {muted ? (
                        <Text style={[styles.memberMeta, { color: colors.error }]}>{`Muted ${formatMutedUntil(mutedUntil)}`}</Text>
                      ) : !self ? (
                        <Text style={styles.memberMeta}>{isConnection(person.id) ? `Connection · @${person.username}` : `@${person.username}`}</Text>
                      ) : null}
                    </View>
                    {theirs === 'owner' || theirs === 'admin' ? (
                      <View style={styles.badge}>
                        <Text style={styles.badgeText}>{theirs === 'owner' ? ownerLabel : 'Admin'}</Text>
                      </View>
                    ) : null}
                  </Pressable>
                );
              })}
            </View>
            {!manager ? (
              <Text style={styles.footer}>
                {event ? 'The organizer and the admins run this chat.' : 'The owner and the admins add people and run the group.'}
              </Text>
            ) : null}
            {!event || role !== 'owner' ? (
              <Pressable accessibilityRole="button" onPress={confirmLeave} style={({ pressed }) => [styles.leave, pressed && styles.pressed]}>
                <Text style={styles.leaveText}>{event ? 'Leave event' : 'Leave group'}</Text>
              </Pressable>
            ) : null}
            {!event && role !== 'owner' ? (
              <Pressable accessibilityRole="button" onPress={() => setReporting(true)} style={({ pressed }) => [styles.leave, pressed && styles.pressed]}>
                <Text style={styles.leaveText}>Report group</Text>
              </Pressable>
            ) : null}
            {!event && role === 'owner' ? (
              <Pressable accessibilityRole="button" onPress={confirmDelete} style={({ pressed }) => [styles.leave, pressed && styles.pressed]}>
                <Text style={styles.leaveText}>Delete group</Text>
              </Pressable>
            ) : null}
          </>
        ) : null}
      </ScrollView>

      <ActionSheet {...photo.sheet} />
      <ActionSheet
        visible={reporting}
        onClose={() => setReporting(false)}
        title="Why are you reporting this group?"
        items={CONTENT_REPORT_REASONS.map(({ id: reason, label }) => ({
          label,
          onPress: () => {
            setReporting(false);
            social.reportGroup(chat.id, reason)
              .then(() => Alert.alert('Thanks for telling us', 'We will look at it.'))
              .catch((error) => Alert.alert('Could not send the report', failureMessage(error)));
          },
        }))}
      />
      <ActionSheet
        visible={!!managed}
        onClose={() => setManaged(null)}
        title={managed ? managed.user.name : undefined}
        items={managed ? memberActions(managed).map((item) => ({ ...item, onPress: () => { setManaged(null); item.onPress(); } })) : []}
      />
      <ActionSheet
        visible={!!muting}
        onClose={() => setMuting(null)}
        title={muting ? `Mute ${muting.user.name}` : undefined}
        items={MUTE_CHOICES.map(({ label, minutes }) => ({
          label,
          onPress: () => {
            const person = muting.user;
            setMuting(null);
            run(() => social.mute(chat.id, person.id, minutes), `Could not mute ${person.name}`);
          },
        }))}
      />
    </View>
  );
}

function Row({ styles, colors, icon, title, subtitle, onPress, chevron, last }) {
  const content = (
    <View style={[styles.row, !last && styles.divider]}>
      <Ionicons name={icon} size={20} color={colors.active} />
      <View style={styles.flex}>
        <Text style={styles.rowTitle}>{title}</Text>
        {subtitle ? <Text style={styles.rowSubtitle}>{subtitle}</Text> : null}
      </View>
      {chevron ? <Ionicons name="chevron-forward" size={16} color={colors.inactive} /> : null}
    </View>
  );
  return onPress ? <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => pressed && styles.pressed}>{content}</Pressable> : content;
}

const createStyles = (colors) => StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: colors.page,
  },
  flex: {
    flex: 1,
  },
  pressed: {
    opacity: 0.6,
  },
  topBar: {
    paddingHorizontal: 16,
    paddingVertical: 6,
  },
  content: {
    paddingHorizontal: 20,
    gap: 14,
  },
  hero: {
    alignItems: 'center',
    gap: 6,
    paddingBottom: 8,
  },
  photoBadge: {
    position: 'absolute',
    right: -4,
    bottom: -4,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  title: {
    fontSize: 24,
    fontWeight: '800',
    letterSpacing: -0.5,
    color: colors.active,
    textAlign: 'center',
    marginTop: 6,
  },
  subtitle: {
    fontSize: 14,
    color: colors.inactive,
  },
  card: {
    borderRadius: 16,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  divider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  rowTitle: {
    fontSize: 16,
    color: colors.active,
  },
  rowSubtitle: {
    fontSize: 13,
    color: colors.inactive,
    marginTop: 1,
  },
  sectionRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    paddingHorizontal: 4,
    marginTop: 4,
  },
  section: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.inactive,
    paddingHorizontal: 4,
  },
  ownerNote: {
    fontSize: 13,
    color: colors.inactive,
  },
  member: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  memberName: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.active,
  },
  memberMeta: {
    fontSize: 12,
    color: colors.inactive,
  },
  badge: {
    paddingHorizontal: 8,
    height: 22,
    borderRadius: 11,
    justifyContent: 'center',
    backgroundColor: colors.pill,
  },
  badgeText: {
    fontSize: 11,
    fontWeight: '700',
    color: colors.active,
  },
  footer: {
    fontSize: 13,
    color: colors.inactive,
    paddingHorizontal: 4,
  },
  leave: {
    height: 50,
    borderRadius: 16,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    marginTop: 8,
  },
  leaveText: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.error,
  },
});
