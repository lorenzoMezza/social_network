// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo, useState } from 'react';
import { FlatList, Linking, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../theme/colors';
import { IconButton } from '../../components/ui/IconButton';
import { NOTICES } from '../legal/thirdParty';

// The notices the app must carry (scripts/legal.mjs: only what it really ships, under
// a licence that asks for its notice): the map and weather data first, then the avatar
// assets, then the software, one row per licence text, each opening to the works
// under it, their copyright lines and the text itself.
const ITEMS = [
  { key: 'title-data', kind: 'title', text: 'Map and weather data' },
  ...NOTICES.data.map((item) => ({ key: `data-${item.name}`, kind: 'plain', name: item.name, detail: item.detail, url: item.url })),
  { key: 'title-assets', kind: 'title', text: 'Avatars and animations' },
  ...NOTICES.assets.map((item) => ({ key: `asset-${item.name}`, kind: 'text', name: item.name, detail: `${item.detail} · ${item.license}`, text: item.text })),
  { key: 'title-software', kind: 'title', text: 'Software' },
  ...NOTICES.groups.map((group, index) => ({
    key: `group-${index}`,
    kind: 'group',
    name: group.license,
    detail: group.packages.length === 1 ? group.packages[0][0] : `${group.packages.length} packages`,
    packages: group.packages,
    text: group.text,
  })),
];

export function LicensesScreen() {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [open, setOpen] = useState(() => new Set());
  const toggle = (key) => setOpen((current) => {
    const next = new Set(current);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
  });

  const renderItem = ({ item }) => {
    if (item.kind === 'title') return <Text style={styles.section} accessibilityRole="header">{item.text}</Text>;
    if (item.kind === 'plain') {
      return (
        <View style={styles.credit}>
          <Text style={styles.name}>{item.name}</Text>
          <Text style={styles.detail} selectable>{item.detail}</Text>
          {item.url ? (
            <Text style={styles.link} accessibilityRole="link" onPress={() => Linking.openURL(item.url).catch(() => {})}>
              {item.url.replace(/^https:\/\/(www\.)?/, '')}
            </Text>
          ) : null}
        </View>
      );
    }
    const expanded = open.has(item.key);
    return (
      <View style={styles.credit}>
        <Pressable accessibilityRole="button" accessibilityState={{ expanded }} onPress={() => toggle(item.key)} style={styles.header}>
          <View style={styles.headerText}>
            <Text style={styles.name}>{item.name}</Text>
            <Text style={styles.detail}>{item.detail}</Text>
          </View>
          <Ionicons name={expanded ? 'chevron-up' : 'chevron-down'} size={18} color={colors.inactive} />
        </Pressable>
        {expanded ? (
          <View style={styles.body}>
            {item.packages ? (
              <Text style={styles.packages} selectable>
                {item.packages.map(([name, version, copyright]) => `${name} ${version}${copyright ? `\n   ${copyright}` : ''}`).join('\n')}
              </Text>
            ) : null}
            <Text style={styles.license} selectable>{item.text}</Text>
          </View>
        ) : null}
      </View>
    );
  };

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <IconButton icon="chevron-back" label="Back" onPress={() => router.back()} />
        <Text style={styles.title} accessibilityRole="header">Licenses</Text>
        <View style={styles.spacer} />
      </View>
      <FlatList
        data={ITEMS}
        renderItem={renderItem}
        extraData={open}
        initialNumToRender={20}
        contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]}
      />
    </View>
  );
}

const createStyles = (colors) => StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.page },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 6 },
  title: { fontSize: 17, fontWeight: '700', color: colors.active },
  spacer: { width: 40 },
  content: { paddingHorizontal: 20, paddingTop: 8 },
  section: { fontSize: 13, fontWeight: '600', color: colors.inactive, textTransform: 'uppercase', marginTop: 20, marginBottom: 4 },
  credit: { paddingVertical: 14, gap: 4, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: colors.border },
  header: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  headerText: { flex: 1, gap: 4 },
  name: { fontSize: 16, fontWeight: '600', color: colors.active },
  detail: { fontSize: 14, lineHeight: 20, color: colors.inactive },
  link: { fontSize: 14, lineHeight: 20, color: colors.active, textDecorationLine: 'underline', alignSelf: 'flex-start' },
  body: { gap: 12, paddingTop: 10 },
  packages: { fontSize: 13, lineHeight: 19, color: colors.active },
  license: { fontSize: 12, lineHeight: 17, color: colors.inactive },
});
