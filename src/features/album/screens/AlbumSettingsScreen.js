// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useDiscardGuard } from '../../../components/navigation/useDiscardGuard';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { tapFeedback } from '../../../lib/haptics';
import { SheetHeader } from '../../../components/ui/SheetHeader';
import { useEvents } from '../../events/state/EventsProvider';
import { PersonAvatar } from '../../social/components/PersonAvatar';
import { DEFAULT_SETTINGS, WHO_CAN_POST, WHO_CAN_POST_OPTIONS } from '../model/albumModel';
import { useAlbum, useAlbums } from '../state/AlbumsProvider';
import { failureMessage } from '../../api/failureMessage';

// The organizer decides who can add photos to the album: everyone who joined, the
// people they pick among them, or only themselves. Photos already added stay.
export function AlbumSettingsScreen({ id }) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { byId, user } = useEvents();
  const event = byId[id];
  const { album } = useAlbum(id);
  const { saveSettings } = useAlbums();
  // The album's rules as the server has them; the user's changes over them once they
  // make one. Until they are loaded nothing can be saved: saving the defaults would
  // replace the organizer's real choice
  const loaded = !!album.settings;
  const current = album.settings ?? DEFAULT_SETTINGS;
  const [draft, setDraft] = useState(null);
  const whoCanPost = draft?.whoCanPost ?? current.whoCanPost;
  const contributors = draft?.contributors ?? new Set(current.contributors);
  const [saving, setSaving] = useState(false);
  const allowLeaving = useDiscardGuard(draft !== null);
  // Who joined the event (the event's details: UserSummary), the organizer left out
  const joined = (event?.followers ?? []).filter((person) => person.id !== user?.id);

  const setWhoCanPost = (value) => setDraft({ whoCanPost: value, contributors });
  const toggle = (personId) => {
    tapFeedback();
    const next = new Set(contributors);
    if (next.has(personId)) next.delete(personId);
    else next.add(personId);
    setDraft({ whoCanPost, contributors: next });
  };

  // "People you choose" with nobody chosen would be "Only you" under another name
  const choiceComplete = whoCanPost !== WHO_CAN_POST.chosen || contributors.size > 0;

  const save = async () => {
    setSaving(true);
    try {
      await saveSettings(id, { whoCanPost, contributors: whoCanPost === WHO_CAN_POST.chosen ? [...contributors] : [] });
      allowLeaving();
      router.back();
    } catch (error) {
      setSaving(false);
      Alert.alert('Could not save', failureMessage(error));
    }
  };

  return (
    <View style={styles.page}>
      <SheetHeader title="Who can add photos" leftLabel="Cancel" onLeft={() => router.back()} rightLabel="Save" onRight={save} rightBusy={saving} rightDisabled={!loaded || !choiceComplete} />
      {/* Wrapped: in an iOS form sheet a scroll view right under the screen is resized
          by the screens library and drawn out of view */}
      <View collapsable={false} style={styles.flex}>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
        <View style={styles.options} accessibilityRole="radiogroup">
          {WHO_CAN_POST_OPTIONS.map((option) => {
            const selected = option.value === whoCanPost;
            return (
              <Pressable
                key={option.value}
                accessibilityRole="radio"
                accessibilityState={{ checked: selected }}
                onPress={() => {
                  tapFeedback();
                  setWhoCanPost(option.value);
                }}
                style={({ pressed }) => [styles.option, pressed && styles.pressed]}
              >
                <View style={styles.flex}>
                  <Text style={styles.optionLabel}>{option.label}</Text>
                  <Text style={styles.optionText}>
                    {option.value === WHO_CAN_POST.everyone && joined.length ? (joined.length === 1 ? 'The 1 person who joined the event' : `The ${joined.length} people who joined the event`) : option.description}
                  </Text>
                </View>
                <Ionicons name={selected ? 'radio-button-on' : 'radio-button-off'} size={22} color={selected ? colors.accent : colors.inactive} />
              </Pressable>
            );
          })}
        </View>

        {whoCanPost === WHO_CAN_POST.chosen ? (
          <View style={styles.people}>
            <Text style={styles.heading}>{contributors.size ? `${contributors.size} chosen` : 'Choose among who joined'}</Text>
            {joined.length ? joined.map((person) => {
              const chosen = contributors.has(person.id);
              return (
                <Pressable
                  key={person.id}
                  accessibilityRole="checkbox"
                  accessibilityState={{ checked: chosen }}
                  onPress={() => toggle(person.id)}
                  style={({ pressed }) => [styles.person, pressed && styles.pressed]}
                >
                  <PersonAvatar person={person} size={40} />
                  <View style={styles.flex}>
                    <Text style={styles.personName} numberOfLines={1}>{person.name}</Text>
                    <Text style={styles.optionText} numberOfLines={1}>@{person.username}</Text>
                  </View>
                  <Ionicons name={chosen ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={chosen ? colors.accent : colors.inactive} />
                </Pressable>
              );
            }) : <Text style={styles.optionText}>Nobody has joined yet.</Text>}
          </View>
        ) : null}

        <Text style={styles.note}>You can remove any photo, whoever added it. Photos already in the album stay when you change this.</Text>
      </ScrollView>
      </View>
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
    padding: 20,
    gap: 24,
  },
  options: {
    borderRadius: 18,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  optionLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.active,
  },
  optionText: {
    fontSize: 13,
    color: colors.inactive,
    marginTop: 1,
  },
  people: {
    gap: 4,
  },
  heading: {
    fontSize: 14,
    fontWeight: '700',
    color: colors.inactive,
    marginBottom: 4,
  },
  person: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 8,
  },
  personName: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.active,
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.inactive,
  },
});
