// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, FlatList, KeyboardAvoidingView, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { Image } from 'expo-image';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useDiscardGuard } from '../../../components/navigation/useDiscardGuard';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { successFeedback, tapFeedback } from '../../../lib/haptics';
import { SheetHeader } from '../../../components/ui/SheetHeader';
import { EmptyState } from '../../../components/ui/StateViews';
import { useChat, useSocial } from '../state/SocialProvider';
import { PersonAvatar } from '../components/PersonAvatar';
import { ActionSheet } from '../../../components/ui/ActionSheet';
import { useGroupPhotoSheet } from '../components/useGroupPhotoSheet';
import { formatSince } from '../model/format';
import { discardPickedFile } from '../../api/uploads';

const COLORS = ['#2F7BFF', '#1F9D63', '#F2546B', '#A855F7', '#E08A00', '#0EA5A4'];
// The server's limits (API.md, Chats)
const GROUP_LIMITS = {
  group_full: 'A group has at most 256 people.',
  too_many_groups: "You've reached the most groups one person can own. Delete one to make room.",
};

// A new group (or, with ?add=<chat id>, people to add to one the user owns). Only the
// user's connections can be picked: groups are among friends.
export function NewGroupScreen() {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { add } = useLocalSearchParams();
  const adding = useChat(add);
  const { connections, createGroup, addMembers, loadChat, setGroupPicture } = useSocial();
  // Its photo, optional: a file on the phone until the group exists
  const [photo, setPhotoState] = useState(null);
  // A picked photo is a copy in the phone's caches folder (expo-image-picker): the one
  // replaced, taken away or left behind with a group never made goes, or it would stay
  // there for good. The one given to the new group is the server's to keep or drop
  const photoFile = useRef(null);
  const setPhoto = (uri) => {
    if (photoFile.current && photoFile.current !== uri) discardPickedFile(photoFile.current);
    photoFile.current = uri;
    setPhotoState(uri);
  };
  // The one held when the screen goes
  useEffect(() => () => discardPickedFile(photoFile.current), []);
  const photoSheet = useGroupPhotoSheet({ onPicked: setPhoto, onRemove: photo ? () => setPhoto(null) : undefined });
  const [name, setName] = useState('');
  const [color, setColor] = useState(COLORS[0]);
  const [picked, setPicked] = useState([]);
  const [saving, setSaving] = useState(false);
  const allowLeaving = useDiscardGuard(picked.length > 0 || name.trim().length > 0);

  // Adding to a group: who is in it already (its members, from the server)
  useEffect(() => {
    if (add) loadChat(add).catch(() => {});
  }, [add, loadChat]);
  const inside = new Set((adding?.members ?? []).map((member) => member.user.id));
  const candidates = adding ? connections.filter((entry) => !inside.has(entry.user.id)) : connections;
  const ready = picked.length > 0 && (adding || name.trim().length > 0) && !saving;

  const toggle = (userId) => {
    tapFeedback();
    setPicked((current) => (current.includes(userId) ? current.filter((entry) => entry !== userId) : [...current, userId]));
  };

  const done = async () => {
    setSaving(true);
    try {
      if (adding) {
        await addMembers(adding.id, picked);
        successFeedback();
        allowLeaving();
        router.back();
        return;
      }
      const id = await createGroup(name.trim(), picked, color);
      // The group is there whatever becomes of its photo, which can be added again from its details
      if (photo) {
        // From here on the upload has it (it drops the copy once sent): not this screen
        photoFile.current = null;
        setGroupPicture(id, photo).catch(() => {
          discardPickedFile(photo);
          Alert.alert('The group has no photo yet', 'You can add it from its details.');
        });
      }
      successFeedback();
      allowLeaving();
      router.back();
      router.push({ pathname: '/chat/[id]', params: { id } });
    } catch (error) {
      Alert.alert(adding ? 'Could not add them' : 'Could not create the group', GROUP_LIMITS[error?.code] ?? 'Try again in a moment.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.page}>
      <SheetHeader
        title={adding ? 'Add people' : 'New group'}
        leftLabel="Cancel"
        onLeft={() => router.back()}
        rightLabel={adding ? 'Add' : 'Create'}
        onRight={done}
        rightDisabled={!ready}
        rightBusy={saving}
      />
      <KeyboardAvoidingView style={styles.flex} behavior={process.env.EXPO_OS === 'ios' ? 'padding' : undefined}>
        <View collapsable={false} style={styles.flex}>
          <FlatList
            data={candidates}
            keyExtractor={(entry) => entry.user.id}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
            ListHeaderComponent={(
              <View style={styles.head}>
                {adding ? null : (
                  <>
                    <View style={styles.nameRow}>
                      <Pressable accessibilityRole="button" accessibilityLabel="Group photo" onPress={photoSheet.open} style={[styles.groupFace, { backgroundColor: `${color}26` }]}>
                        {photo ? <Image source={photo} style={styles.groupPhoto} contentFit="cover" /> : <Ionicons name="camera" size={22} color={color} />}
                      </Pressable>
                      <TextInput
                        value={name}
                        onChangeText={setName}
                        placeholder="Group name"
                        placeholderTextColor={colors.inactive}
                        maxLength={50}
                        style={styles.nameInput}
                        autoFocus
                      />
                    </View>
                    <View style={styles.colors}>
                      {COLORS.map((entry) => (
                        <Pressable
                          key={entry}
                          accessibilityRole="radio"
                          accessibilityState={{ selected: entry === color }}
                          accessibilityLabel={`Colour ${entry}`}
                          onPress={() => setColor(entry)}
                          style={[styles.colorRing, entry === color && { borderColor: entry }]}
                        >
                          <View style={[styles.colorDot, { backgroundColor: entry }]} />
                        </Pressable>
                      ))}
                    </View>
                  </>
                )}
                <Text style={styles.label}>{picked.length ? `${picked.length} selected` : 'Your connections'}</Text>
                <Text style={styles.note}>{picked.length ? "Only people you've connected with in person can be added." : "Pick at least one. Only people you've connected with in person can be added."}</Text>
              </View>
            )}
            ListEmptyComponent={(
              <EmptyState
                icon="link-outline"
                title={adding ? 'Everyone is already in' : 'No connections yet'}
                message={adding ? 'All your connections are in this group.' : 'Connect with friends in person first, then make a group with them.'}
                actionLabel={adding ? undefined : 'Connect'}
                onAction={() => router.replace('/connect')}
              />
            )}
            renderItem={({ item }) => {
              const person = item.user;
              const selected = picked.includes(person.id);
              return (
                <Pressable
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: selected }}
                  accessibilityLabel={person.name}
                  onPress={() => toggle(person.id)}
                  style={({ pressed }) => [styles.person, pressed && styles.pressed]}
                >
                  <PersonAvatar person={person} size={44} />
                  <View style={styles.personText}>
                    <Text style={styles.personName}>{person.name}</Text>
                    <Text style={styles.personMeta}>@{person.username} · connected {formatSince(item.since)}</Text>
                  </View>
                  <Ionicons name={selected ? 'checkmark-circle' : 'ellipse-outline'} size={26} color={selected ? colors.accent : colors.border} />
                </Pressable>
              );
            }}
          />
        </View>
      </KeyboardAvoidingView>
      <ActionSheet {...photoSheet.sheet} />
    </View>
  );
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
  content: {
    paddingHorizontal: 20,
  },
  head: {
    gap: 12,
    paddingTop: 16,
    paddingBottom: 8,
  },
  nameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  groupFace: {
    width: 52,
    height: 52,
    borderRadius: 16,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  groupPhoto: {
    width: 52,
    height: 52,
    borderRadius: 16,
  },
  nameInput: {
    flex: 1,
    height: 48,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderCurve: 'continuous',
    fontSize: 17,
    fontWeight: '600',
    color: colors.active,
    backgroundColor: colors.surface,
  },
  colors: {
    flexDirection: 'row',
    gap: 6,
    marginLeft: 58,
  },
  colorRing: {
    padding: 3,
    borderRadius: 16,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  colorDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.inactive,
    marginTop: 8,
  },
  note: {
    fontSize: 13,
    color: colors.inactive,
    marginTop: -8,
  },
  person: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  personText: {
    flex: 1,
  },
  personName: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.active,
  },
  personMeta: {
    fontSize: 13,
    color: colors.inactive,
  },
});
