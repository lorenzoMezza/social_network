// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { successFeedback, tapFeedback } from '../../../lib/haptics';

// The bio, edited where it is shown: on the user's own profile a tap on it (or on
// "Add a bio" when there is none) turns it into a field, saved with Done. Someone
// else's bio is plain text.
export function BioField({ bio, editable, maxLength, onSave }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const editing = draft !== null;

  if (!editable) {
    return bio ? <Text style={styles.bio} selectable>{bio}</Text> : null;
  }

  const start = () => {
    tapFeedback();
    setDraft(bio ?? '');
  };

  const save = async () => {
    if (draft.trim() === (bio ?? '').trim()) {
      setDraft(null);
      return;
    }
    setSaving(true);
    try {
      await onSave(draft);
      successFeedback();
      setDraft(null);
    } catch {
      Alert.alert('Could not save your bio', 'Try again in a moment.');
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <View style={styles.editor}>
        <TextInput
          value={draft}
          onChangeText={setDraft}
          maxLength={maxLength}
          multiline
          autoFocus
          placeholder="What you like, what you organize, where to find you"
          placeholderTextColor={colors.inactive}
          style={styles.input}
          accessibilityLabel="Bio"
        />
        <View style={styles.editorBar}>
          <Text style={styles.counter}>{draft.length}/{maxLength}</Text>
          <View style={styles.editorActions}>
            <Pressable accessibilityRole="button" hitSlop={10} onPress={() => setDraft(null)} disabled={saving}>
              <Text style={styles.cancel}>Cancel</Text>
            </Pressable>
            <Pressable accessibilityRole="button" hitSlop={10} onPress={save} disabled={saving} style={styles.done}>
              {saving ? <ActivityIndicator size="small" color={colors.onAccent} /> : <Text style={styles.doneLabel}>Done</Text>}
            </Pressable>
          </View>
        </View>
      </View>
    );
  }

  return bio ? (
    <Pressable accessibilityRole="button" accessibilityLabel={`Bio: ${bio}`} accessibilityHint="Edit your bio" onPress={start} style={({ pressed }) => pressed && styles.pressed}>
      <Text style={styles.bio}>
        {bio}
        {'  '}
        <Ionicons name="pencil" size={13} color={colors.inactive} />
      </Text>
    </Pressable>
  ) : (
    <Pressable accessibilityRole="button" onPress={start} hitSlop={8} style={({ pressed }) => [styles.add, pressed && styles.pressed]}>
      <Ionicons name="add" size={16} color={colors.inactive} />
      <Text style={styles.addLabel}>Add a bio</Text>
    </Pressable>
  );
}

const createStyles = (colors) => StyleSheet.create({
  bio: {
    fontSize: 15,
    lineHeight: 21,
    color: colors.active,
  },
  pressed: {
    opacity: 0.6,
  },
  add: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 4,
  },
  addLabel: {
    fontSize: 15,
    color: colors.inactive,
  },
  editor: {
    gap: 8,
  },
  input: {
    minHeight: 72,
    maxHeight: 140,
    borderRadius: 14,
    borderCurve: 'continuous',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    fontSize: 15,
    lineHeight: 21,
    color: colors.active,
    backgroundColor: colors.surface,
  },
  editorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  counter: {
    fontSize: 12,
    color: colors.inactive,
    fontVariant: ['tabular-nums'],
  },
  editorActions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 16,
  },
  cancel: {
    fontSize: 15,
    color: colors.inactive,
  },
  done: {
    height: 30,
    minWidth: 60,
    paddingHorizontal: 14,
    borderRadius: 15,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  doneLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.onAccent,
  },
});
