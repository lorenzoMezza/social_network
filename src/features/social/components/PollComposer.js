// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo, useState } from 'react';
import { ActivityIndicator, Alert, KeyboardAvoidingView, Modal, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';

// The limits of API.md (POST /chats/{id}/polls)
const QUESTION_MAX = 200;
const OPTION_MAX = 80;
const OPTIONS_MIN = 2;
const OPTIONS_MAX = 10;

const clean = (text) => text.replace(/\s+/g, ' ').trim();

// A new poll for the chat (its owner and admins): a question, 2 to 10 different answers,
// one or several choices each. onCreate({ question, options, multiple }) sends it.
export function PollComposer({ visible, onClose, onCreate }) {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [question, setQuestion] = useState('');
  const [options, setOptions] = useState(['', '']);
  const [multiple, setMultiple] = useState(false);
  const [sending, setSending] = useState(false);

  const filled = options.map(clean).filter(Boolean);
  const duplicate = new Set(filled.map((option) => option.toLowerCase())).size !== filled.length;
  const ready = clean(question).length > 0 && filled.length >= OPTIONS_MIN && !duplicate && !sending;

  const reset = () => {
    setQuestion('');
    setOptions(['', '']);
    setMultiple(false);
  };
  const close = () => {
    if (sending) return;
    reset();
    onClose();
  };

  const setOption = (index, value) => setOptions((current) => {
    const next = current.map((option, i) => (i === index ? value : option));
    // A new empty answer appears as the last one is written (up to the limit)
    if (index === next.length - 1 && value.trim() && next.length < OPTIONS_MAX) next.push('');
    return next;
  });
  const removeOption = (index) => setOptions((current) => (current.length > OPTIONS_MIN ? current.filter((_, i) => i !== index) : current));

  const create = async () => {
    if (!ready) return;
    setSending(true);
    try {
      await onCreate({ question: clean(question), options: filled, multiple });
      reset();
      onClose();
    } catch {
      Alert.alert('Could not create the poll', 'Try again in a moment.');
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={close}>
      <KeyboardAvoidingView behavior={process.env.EXPO_OS === 'ios' ? 'padding' : undefined} style={styles.page}>
        <View style={styles.header}>
          <Pressable accessibilityRole="button" hitSlop={8} onPress={close}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.title} accessibilityRole="header">New poll</Text>
          <Pressable accessibilityRole="button" accessibilityState={{ disabled: !ready }} hitSlop={8} disabled={!ready} onPress={create}>
            {sending ? <ActivityIndicator color={colors.active} /> : <Text style={[styles.create, !ready && { color: colors.inactive }]}>Create</Text>}
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
          <Text style={styles.label}>Question</Text>
          <TextInput
            value={question}
            onChangeText={setQuestion}
            placeholder="What should we do?"
            placeholderTextColor={colors.inactive}
            maxLength={QUESTION_MAX}
            multiline
            autoFocus
            style={[styles.field, styles.question]}
            accessibilityLabel="Question"
          />
          <Text style={styles.label}>Answers</Text>
          <View style={styles.card}>
            {options.map((option, index) => (
              <View key={index} style={[styles.optionRow, index < options.length - 1 && styles.divider]}>
                <TextInput
                  value={option}
                  onChangeText={(value) => setOption(index, value)}
                  placeholder={`Answer ${index + 1}`}
                  placeholderTextColor={colors.inactive}
                  maxLength={OPTION_MAX}
                  style={styles.option}
                  accessibilityLabel={`Answer ${index + 1}`}
                />
                {options.length > OPTIONS_MIN && (option || index < options.length - 1) ? (
                  <Pressable accessibilityRole="button" accessibilityLabel={`Remove answer ${index + 1}`} hitSlop={8} onPress={() => removeOption(index)}>
                    <Ionicons name="close-circle" size={20} color={colors.inactive} />
                  </Pressable>
                ) : null}
              </View>
            ))}
          </View>
          {duplicate ? <Text style={[styles.hint, { color: colors.error }]}>Two answers are the same.</Text> : (
            <Text style={styles.hint}>{`Up to ${OPTIONS_MAX} answers.`}</Text>
          )}
          <View style={[styles.card, styles.switchRow]}>
            <View style={styles.flex}>
              <Text style={styles.switchTitle}>Several answers</Text>
              <Text style={styles.hint}>Each person can choose more than one</Text>
            </View>
            <Switch value={multiple} onValueChange={setMultiple} trackColor={{ true: colors.accent }} thumbColor={process.env.EXPO_OS === 'android' ? '#FFFFFF' : undefined} accessibilityLabel="Several answers" />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Modal>
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
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 18,
    paddingVertical: 14,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.active,
  },
  cancel: {
    fontSize: 16,
    color: colors.active,
  },
  create: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.active,
  },
  content: {
    padding: 20,
    gap: 8,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.inactive,
    marginTop: 6,
    paddingHorizontal: 4,
  },
  field: {
    borderRadius: 14,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.active,
  },
  question: {
    minHeight: 64,
    textAlignVertical: 'top',
  },
  card: {
    borderRadius: 14,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
  },
  option: {
    flex: 1,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.active,
  },
  divider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  hint: {
    fontSize: 13,
    color: colors.inactive,
    paddingHorizontal: 4,
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
    marginTop: 10,
  },
  switchTitle: {
    fontSize: 16,
    color: colors.active,
  },
});
