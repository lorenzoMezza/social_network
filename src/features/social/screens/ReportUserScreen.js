// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useDiscardGuard } from '../../../components/navigation/useDiscardGuard';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { Button } from '../../../components/ui/Button';
import { successFeedback, tapFeedback } from '../../../lib/haptics';
import { SheetHeader } from '../../../components/ui/SheetHeader';
import { useSocial } from '../state/SocialProvider';
import { USER_REPORT_REASONS } from '../model/reportReasons';
import { failureMessage } from '../../api/failureMessage';

const DETAILS_MAX = 500;

// Reports a person to the moderators: a reason, optional details, and the offer to
// block them too. The person is not told who reported them.
export function ReportUserScreen() {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { id, username, name } = useLocalSearchParams();
  const { reportUser, block, isBlocked } = useSocial();
  const [reason, setReason] = useState(null);
  const [details, setDetails] = useState('');
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);
  useDiscardGuard(!sent && (!!reason || details.trim().length > 0));
  const shown = name || `@${username}`;

  const send = async () => {
    setSending(true);
    try {
      await reportUser(id, reason, details.trim());
      successFeedback();
      setSent(true);
    } catch (error) {
      Alert.alert('Could not send the report', failureMessage(error));
    } finally {
      setSending(false);
    }
  };

  return (
    <View style={styles.page}>
      <SheetHeader title="Report" leftLabel={sent ? 'Done' : 'Cancel'} onLeft={() => router.back()} />
      {sent ? (
        <View style={styles.done}>
          <Ionicons name="checkmark-circle" size={44} color={colors.live} />
          <Text style={styles.doneTitle}>Thanks for telling us</Text>
          <Text style={styles.doneText}>{`Our team will review your report about ${shown}. They won't know it was you.`}</Text>
          {!isBlocked(id) ? (
            <Button label={`Block ${shown}`} variant="danger" compact onPress={() => { block(id).catch(() => {}); router.back(); }} style={styles.doneAction} />
          ) : null}
        </View>
      ) : (
        <KeyboardAvoidingView collapsable={false} style={styles.flex} behavior={process.env.EXPO_OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
            <Text style={styles.question}>{`What is wrong with ${shown}?`}</Text>
            <View style={styles.group}>
              {USER_REPORT_REASONS.map((entry, index) => {
                const selected = reason === entry.id;
                return (
                  <Pressable
                    key={entry.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    onPress={() => {
                      tapFeedback();
                      setReason(entry.id);
                    }}
                    style={[styles.option, index > 0 && styles.divider]}
                  >
                    <Text style={styles.optionLabel}>{entry.label}</Text>
                    <Ionicons name={selected ? 'radio-button-on' : 'radio-button-off'} size={20} color={selected ? colors.accent : colors.inactive} />
                  </Pressable>
                );
              })}
            </View>
            <TextInput
              value={details}
              onChangeText={setDetails}
              maxLength={DETAILS_MAX}
              multiline
              placeholder="More details (optional)"
              placeholderTextColor={colors.inactive}
              style={styles.input}
            />
            <Button label="Send report" onPress={send} busy={sending} disabled={!reason} />
            <Text style={styles.note}>Reports are confidential. If someone is in danger, call the emergency services.</Text>
          </ScrollView>
        </KeyboardAvoidingView>
      )}
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
  question: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.active,
  },
  group: {
    borderRadius: 16,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    height: 48,
  },
  divider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  optionLabel: {
    fontSize: 15,
    color: colors.active,
  },
  input: {
    minHeight: 90,
    borderRadius: 14,
    borderCurve: 'continuous',
    padding: 14,
    fontSize: 15,
    color: colors.active,
    backgroundColor: colors.surface,
    textAlignVertical: 'top',
  },
  note: {
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
    color: colors.inactive,
  },
  done: {
    alignItems: 'center',
    gap: 10,
    padding: 32,
  },
  doneTitle: {
    fontSize: 20,
    fontWeight: '800',
    color: colors.active,
  },
  doneText: {
    fontSize: 15,
    lineHeight: 21,
    textAlign: 'center',
    color: colors.inactive,
  },
  doneAction: {
    marginTop: 10,
  },
});
