// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../theme/colors';
import { Button } from './Button';

// Placeholder rows in the shape of a list's rows (an icon, three lines) while it loads
export function ListSkeleton({ count = 6, label = 'Loading' }) {
  const colors = useColors();
  const block = (width, height) => ({ width, height, borderRadius: height / 2, backgroundColor: colors.surface });
  return (
    <View accessibilityLabel={label} accessibilityRole="progressbar">
      {Array.from({ length: count }, (_, index) => (
        <View key={index} style={styles.row}>
          <View style={{ width: 44, height: 44, borderRadius: 13, borderCurve: 'continuous', backgroundColor: colors.surface }} />
          <View style={styles.lines}>
            <View style={block(90, 10)} />
            <View style={block(index % 2 ? '55%' : '75%', 14)} />
            <View style={block(120, 10)} />
          </View>
        </View>
      ))}
    </View>
  );
}

export function EmptyState({ icon, title, message, actionLabel, onAction }) {
  const colors = useColors();
  const themed = useMemo(() => createStyles(colors), [colors]);
  return (
    <View style={themed.state}>
      <View style={themed.icon}>
        <Ionicons name={icon} size={26} color={colors.accent} />
      </View>
      <Text style={themed.title}>{title}</Text>
      {message ? <Text style={themed.message}>{message}</Text> : null}
      {actionLabel ? <Button label={actionLabel} onPress={onAction} variant="secondary" compact style={themed.action} /> : null}
    </View>
  );
}

// What did not load, said plainly: offline, or a problem on the server's side.
// `subject`: what it is ("Events", "The photos"…)
export function ErrorState({ error, onRetry, subject = 'Events' }) {
  // The events around need where the user is (the map asks for the permission)
  if (error?.code === 'no_position') {
    return (
      <EmptyState
        icon="location-outline"
        title="Where are you?"
        message="The events around you need your position. Allow location for the app in Settings, then try again."
        actionLabel="Try again"
        onAction={onRetry}
      />
    );
  }
  // status 0: useApi could not reach the server (no network, or no answer in time)
  const offline = error?.status === 0 || /network|fetch/i.test(error?.message ?? '');
  return (
    <EmptyState
      icon={offline ? 'cloud-offline-outline' : 'alert-circle-outline'}
      title={offline ? 'You are offline' : `${subject} did not load`}
      message={offline ? 'Check your connection, then try again.' : 'Something went wrong on our side. Try again in a moment.'}
      actionLabel="Try again"
      onAction={onRetry}
    />
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
  },
  lines: {
    flex: 1,
    gap: 7,
  },
});

const createStyles = (colors) => StyleSheet.create({
  // The empty or error state's sign: the accent, in a soft circle
  icon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accentSoft,
  },
  state: {
    alignItems: 'center',
    paddingHorizontal: 40,
    paddingVertical: 56,
    gap: 8,
  },
  title: {
    fontSize: 17,
    fontWeight: '600',
    color: colors.active,
    textAlign: 'center',
    marginTop: 4,
  },
  message: {
    fontSize: 15,
    lineHeight: 21,
    color: colors.inactive,
    textAlign: 'center',
    maxWidth: 300,
  },
  action: {
    marginTop: 12,
  },
});
