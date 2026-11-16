// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useEffect, useMemo } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../theme/colors';
import { tapFeedback } from '../../lib/haptics';
import { SheetHeader } from '../../components/ui/SheetHeader';
import { useMe } from '../me/MeProvider';
import { useApi } from '../api/useApi';
import { failureMessage } from '../api/failureMessage';

// What the user's story shows to others (docs/API.md, Me: story): each kind of
// moment on or off, and the moments hidden one by one (long press in the story) shown
// again at once. The user always sees all of their story, faded where hidden.
const KINDS = [
  { key: 'organized', icon: 'calendar-outline', label: 'Events you organize' },
  { key: 'going', icon: 'walk-outline', label: 'Events you go to' },
  { key: 'reviewed', icon: 'star-outline', label: 'Your reviews' },
  { key: 'connected', icon: 'link-outline', label: 'Your connections', hint: 'On someone else\'s profile only yours with them shows' },
];

export function StorySettingsScreen() {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { me, update, refresh } = useMe();
  const request = useApi();
  // The count of hidden moments as the server has it now (hidden a moment ago)
  useEffect(() => {
    refresh?.();
  }, [refresh]);
  const story = me?.story ?? {};
  const hidden = me?.storyHidden ?? 0;

  const toggle = (key) => (on) => {
    tapFeedback();
    update({ story: { [key]: on } }).catch((error) => Alert.alert('Could not change it', failureMessage(error)));
  };
  const showAll = () => Alert.alert('Show every moment again?', 'The ones you hid one by one come back on your story.', [
    { text: 'Cancel', style: 'cancel' },
    {
      text: 'Show all',
      onPress: () => request('/me/story/hidden', { method: 'DELETE' })
        .then(refresh)
        .catch((error) => Alert.alert('Could not change it', failureMessage(error))),
    },
  ]);

  return (
    <View style={styles.page}>
      <SheetHeader title="Your story" rightLabel="Done" onRight={() => router.back()} />
      {/* Wrapped: in an iOS form sheet a scroll view right under the screen is resized
          by the screens library and drawn out of view */}
      <View collapsable={false} style={styles.flex}>
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}>
          <Text style={styles.intro}>
            {me?.storyAudience === 'everyone'
              ? 'What anyone sees when they open your profile.'
              : 'What your connections see when they open your profile.'}
            {' You always see all of it, faded where it is hidden. Who sees it: Settings › Your story.'}
          </Text>
          <View style={styles.group}>
            {KINDS.map((kind, index) => (
              <View key={kind.key} style={[styles.row, index < KINDS.length - 1 && styles.divider]}>
                <Ionicons name={kind.icon} size={20} color={colors.active} />
                <View style={styles.flex}>
                  <Text style={styles.label}>{kind.label}</Text>
                  {kind.hint ? <Text style={styles.hint}>{kind.hint}</Text> : null}
                </View>
                <Switch
                  value={story[kind.key] !== false}
                  onValueChange={toggle(kind.key)}
                  trackColor={{ true: colors.accent }}
                  thumbColor={process.env.EXPO_OS === 'android' ? '#FFFFFF' : undefined}
                  accessibilityLabel={kind.label}
                />
              </View>
            ))}
          </View>
          <Text style={styles.note}>To hide a single moment, press and hold it in your story.</Text>
          {hidden ? (
            <Pressable accessibilityRole="button" onPress={showAll} style={({ pressed }) => [styles.group, styles.row, pressed && styles.pressed]}>
              <Ionicons name="eye-off-outline" size={20} color={colors.active} />
              <Text style={[styles.label, styles.flex]}>{hidden === 1 ? '1 moment hidden' : `${hidden} moments hidden`}</Text>
              <Text style={styles.action}>Show all</Text>
            </Pressable>
          ) : null}
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
  content: {
    padding: 20,
    gap: 14,
  },
  intro: {
    fontSize: 15,
    lineHeight: 21,
    color: colors.inactive,
  },
  group: {
    borderRadius: 14,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 56,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  divider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  label: {
    fontSize: 16,
    color: colors.active,
  },
  hint: {
    fontSize: 13,
    lineHeight: 17,
    color: colors.inactive,
    marginTop: 2,
  },
  note: {
    fontSize: 13,
    color: colors.inactive,
  },
  action: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.accent,
  },
  pressed: {
    opacity: 0.6,
  },
});
