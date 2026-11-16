// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useDiscardGuard } from '../../../components/navigation/useDiscardGuard';
import { useColors } from '../../../theme/colors';
import { Button } from '../../../components/ui/Button';
import { useEvents } from '../state/EventsProvider';
import { SheetHeader } from '../../../components/ui/SheetHeader';
import { StarInput } from '../components/Stars';
import { LIMITS } from '../model/eventModel';
import { failureMessage } from '../../api/failureMessage';

const LABELS = { 2: 'Not for me', 4: 'Could be better', 6: 'Good', 8: 'Really good', 10: 'Loved it!' };

// Rates an event (0–10, as five stars) with an optional comment, or changes or
// deletes the user's rating
export function RateEventScreen({ id }) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { byId, saveRating, deleteRating } = useEvents();
  const event = byId[id];
  const existing = event?.myRating ?? null;
  const [rating, setRating] = useState(existing?.rating ?? 0);
  const [comment, setComment] = useState(existing?.comment ?? '');
  const [busy, setBusy] = useState(null);
  const allowLeaving = useDiscardGuard(rating !== (existing?.rating ?? 0) || comment.trim() !== (existing?.comment ?? ''));

  const submit = async () => {
    setBusy('save');
    try {
      await saveRating(id, { rating, comment: comment.trim() }, !!existing);
      allowLeaving();
      router.back();
    } catch (error) {
      setBusy(null);
      Alert.alert('Could not save your rating', failureMessage(error));
    }
  };

  const remove = () => {
    Alert.alert('Delete your rating?', undefined, [
      { text: 'Keep', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          setBusy('delete');
          try {
            await deleteRating(id);
            allowLeaving();
            router.back();
          } catch (error) {
            setBusy(null);
            Alert.alert('Could not delete your rating', failureMessage(error));
          }
        },
      },
    ]);
  };

  return (
    <View style={styles.page}>
      <SheetHeader title={existing ? 'Your rating' : 'Rate event'} leftLabel="Cancel" onLeft={() => router.back()} />
      <KeyboardAvoidingView collapsable={false} style={styles.flex} behavior={process.env.EXPO_OS === 'ios' ? 'padding' : undefined}>
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
          <Text style={styles.eventTitle} numberOfLines={2}>{event?.title}</Text>
          <StarInput value={rating} onChange={setRating} />
          <Text style={styles.ratingLabel}>{LABELS[rating] ?? 'Tap a star'}</Text>
          <View style={styles.field}>
            <TextInput
              value={comment}
              onChangeText={setComment}
              placeholder="Tell others how it was (optional)"
              placeholderTextColor={colors.inactive}
              maxLength={LIMITS.comment}
              multiline
              textAlignVertical="top"
              style={styles.input}
            />
            <Text style={styles.counter}>{comment.length}/{LIMITS.comment}</Text>
          </View>
          <Button label={existing ? 'Save changes' : 'Post rating'} onPress={submit} busy={busy === 'save'} disabled={rating === 0 || !!busy} />
          {existing ? <Button label="Delete rating" variant="ghost" onPress={remove} busy={busy === 'delete'} disabled={!!busy} /> : null}
        </ScrollView>
      </KeyboardAvoidingView>
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
    gap: 16,
    alignItems: 'stretch',
  },
  eventTitle: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.inactive,
    textAlign: 'center',
  },
  ratingLabel: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.active,
    textAlign: 'center',
  },
  field: {
    gap: 6,
  },
  input: {
    minHeight: 110,
    borderRadius: 14,
    padding: 14,
    fontSize: 16,
    color: colors.active,
    backgroundColor: colors.surface,
  },
  counter: {
    alignSelf: 'flex-end',
    fontSize: 13,
    color: colors.inactive,
  },
});
