// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { successFeedback, tapFeedback } from '../../../lib/haptics';
import { NAME_MAX_LENGTH, USERNAME_MAX_LENGTH, cleanUsername, usernameProblem } from '../model/names';

// The name and the @username at the top of a profile. On the user's own profile a tap
// turns them into two fields, saved with Done, like the bio (BioField).
export function NamesField({ name, username, editable, onSave }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const usernameInput = useRef(null);

  if (!draft) {
    const names = (
      <>
        <Text style={styles.name} accessibilityRole="header" numberOfLines={2} adjustsFontSizeToFit minimumFontScale={0.8} maxFontSizeMultiplier={1.3}>{name}</Text>
        {username || editable ? (
          <Text style={styles.username} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
            {username ? `@${username}` : 'Add a username'}
            {editable ? '  ' : null}
            {editable ? <Ionicons name="pencil" size={13} color={colors.inactive} /> : null}
          </Text>
        ) : null}
      </>
    );
    if (!editable) return <View style={styles.names}>{names}</View>;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${name}${username ? `, @${username}` : ''}`}
        accessibilityHint="Edit your name and username"
        onPress={() => {
          tapFeedback();
          setDraft({ name: name ?? '', username: username ?? '' });
        }}
        style={({ pressed }) => [styles.names, pressed && styles.pressed]}
      >
        {names}
      </Pressable>
    );
  }

  const problem = !draft.name.trim() ? 'Your name can\'t be empty' : usernameProblem(draft.username);
  const save = async () => {
    if (problem) return;
    if (draft.name.trim() === name && draft.username === username) {
      setDraft(null);
      return;
    }
    setSaving(true);
    try {
      await onSave(draft);
      successFeedback();
      setDraft(null);
    } catch (error) {
      Alert.alert('Could not save', error?.message ?? 'Try again in a moment.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <View style={styles.editor}>
      <TextInput
        value={draft.name}
        onChangeText={(value) => setDraft((current) => ({ ...current, name: value }))}
        maxLength={NAME_MAX_LENGTH}
        autoFocus
        autoCapitalize="words"
        autoComplete="name"
        textContentType="name"
        returnKeyType="next"
        submitBehavior="submit"
        onSubmitEditing={() => usernameInput.current?.focus()}
        placeholder="Name"
        placeholderTextColor={colors.inactive}
        style={[styles.input, styles.nameInput]}
        accessibilityLabel="Name"
      />
      <View style={[styles.input, styles.usernameRow]}>
        <Text style={styles.at}>@</Text>
        <TextInput
          ref={usernameInput}
          value={draft.username}
          onChangeText={(value) => setDraft((current) => ({ ...current, username: cleanUsername(value) }))}
          maxLength={USERNAME_MAX_LENGTH}
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="username"
          textContentType="username"
          returnKeyType="done"
          onSubmitEditing={save}
          placeholder="username"
          placeholderTextColor={colors.inactive}
          style={styles.usernameInput}
          accessibilityLabel="Username"
        />
      </View>
      <View style={styles.editorBar}>
        <Text style={[styles.hint, problem && { color: colors.error }]} numberOfLines={1}>
          {problem}
        </Text>
        <View style={styles.editorActions}>
          <Pressable accessibilityRole="button" hitSlop={10} onPress={() => setDraft(null)} disabled={saving}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: !!problem || saving }}
            hitSlop={10}
            onPress={save}
            disabled={!!problem || saving}
            style={[styles.done, problem && styles.doneOff]}
          >
            {saving ? <ActivityIndicator size="small" color={colors.onAccent} /> : <Text style={styles.doneLabel}>Done</Text>}
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const createStyles = (colors) => StyleSheet.create({
  names: {
    flex: 1,
    gap: 1,
  },
  name: {
    fontSize: 26,
    fontWeight: '800',
    letterSpacing: -0.6,
    color: colors.active,
  },
  username: {
    fontSize: 15,
    color: colors.inactive,
  },
  pressed: {
    opacity: 0.6,
  },
  editor: {
    flex: 1,
    gap: 8,
  },
  input: {
    height: 44,
    borderRadius: 14,
    borderCurve: 'continuous',
    paddingHorizontal: 14,
    backgroundColor: colors.surface,
  },
  nameInput: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.active,
  },
  usernameRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  at: {
    fontSize: 15,
    color: colors.inactive,
  },
  usernameInput: {
    flex: 1,
    height: '100%',
    paddingLeft: 2,
    fontSize: 15,
    color: colors.active,
  },
  editorBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
  },
  hint: {
    flexShrink: 1,
    fontSize: 12,
    color: colors.inactive,
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
  doneOff: {
    opacity: 0.35,
  },
  doneLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.onAccent,
  },
});
