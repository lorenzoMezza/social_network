// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { StyleSheet, Text, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../theme/colors';

// A short note inside a form about something to fix, said calmly: an icon and the text
// on a faint tint of the error colour (not red words alone, which read as a failure
// before the user did anything)
export function Notice({ icon = 'alert-circle', text }) {
  const colors = useColors();
  return (
    <View style={[styles.notice, { backgroundColor: `${colors.error}${colors.scheme === 'dark' ? '26' : '14'}` }]} accessibilityLiveRegion="polite">
      <Ionicons name={icon} size={18} color={colors.error} style={styles.icon} />
      <Text style={[styles.text, { color: colors.active }]}>{text}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  notice: {
    flexDirection: 'row',
    gap: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderRadius: 12,
    borderCurve: 'continuous',
  },
  icon: {
    marginTop: 1,
  },
  text: {
    flex: 1,
    fontSize: 14,
    lineHeight: 19,
  },
});
