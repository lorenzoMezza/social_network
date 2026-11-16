// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useDiscardGuard } from '../../../components/navigation/useDiscardGuard';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { Button } from '../../../components/ui/Button';
import { useEvents } from '../state/EventsProvider';
import { SheetHeader } from '../../../components/ui/SheetHeader';
import { EmptyState } from '../../../components/ui/StateViews';
import { LIMITS, REPORT_REASONS } from '../model/eventModel';
import { failureMessage } from '../../api/failureMessage';

// Reports an event to the moderators (reportEvent): one or more reasons, and details
export function ReportEventScreen({ id }) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { byId, reportEvent } = useEvents();
  const [reasons, setReasons] = useState([]);
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  useDiscardGuard(!sent && (reasons.length > 0 || description.trim().length > 0));

  const toggle = (reason) => setReasons((current) => (current.includes(reason) ? current.filter((value) => value !== reason) : [...current, reason]));

  const submit = async () => {
    setBusy(true);
    try {
      await reportEvent(id, { reportCategories: reasons, description: description.trim() || undefined });
      setSent(true);
    } catch (error) {
      Alert.alert('Could not send the report', failureMessage(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.page}>
      <SheetHeader title="Report event" leftLabel={sent ? 'Done' : 'Cancel'} onLeft={() => router.back()} />
      {sent ? (
        <EmptyState
          icon="checkmark-circle"
          title="Thanks for letting us know"
          message="We will review this event. Reports are anonymous: the organizer will not know who sent them."
          actionLabel="Done"
          onAction={() => router.back()}
        />
      ) : (
        <KeyboardAvoidingView collapsable={false} style={styles.flex} behavior={process.env.EXPO_OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
            <Text style={styles.intro}>What is wrong with “{byId[id]?.title ?? 'this event'}”?</Text>
            <View style={styles.group}>
              {REPORT_REASONS.map((reason, index) => {
                const selected = reasons.includes(reason.id);
                return (
                  <Pressable
                    key={reason.id}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: selected }}
                    onPress={() => toggle(reason.id)}
                    style={[styles.reason, index > 0 && styles.divider]}
                  >
                    <Text style={styles.reasonLabel}>{reason.label}</Text>
                    <Ionicons name={selected ? 'checkmark-circle' : 'ellipse-outline'} size={22} color={selected ? colors.accent : colors.inactive} />
                  </Pressable>
                );
              })}
            </View>
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="More details (optional)"
              placeholderTextColor={colors.inactive}
              maxLength={LIMITS.report}
              multiline
              textAlignVertical="top"
              style={styles.input}
            />
            <Button label="Send report" variant="primary" onPress={submit} busy={busy} disabled={reasons.length === 0} />
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
    gap: 16,
  },
  intro: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.active,
  },
  group: {
    borderRadius: 14,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  reason: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    height: 52,
  },
  divider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  reasonLabel: {
    fontSize: 16,
    color: colors.active,
  },
  input: {
    minHeight: 110,
    borderRadius: 14,
    padding: 14,
    fontSize: 16,
    color: colors.active,
    backgroundColor: colors.surface,
  },
});
