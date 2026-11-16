// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams } from 'expo-router';
import { useColors } from '../../theme/colors';
import { IconButton } from '../../components/ui/IconButton';
import { SegmentedTabs } from '../../components/ui/SegmentedTabs';
import { DOCUMENTS } from './documents';
import { Markdown } from './Markdown';

const LEGAL_TITLES = {
  privacy: { en: 'Privacy policy', it: 'Informativa privacy' },
  terms: { en: 'Terms of use', it: 'Termini di utilizzo' },
  guidelines: { en: 'Community guidelines', it: 'Linee guida della community' },
};

// Italian for phones set to Italian (consumer information must be given at least in
// Italian to consumers in Italy: Codice del consumo art. 9), English otherwise
const VERSIONS = {
  en: [{ key: 'short', label: 'In short' }, { key: 'full', label: 'Full text' }],
  it: [{ key: 'short', label: 'In breve' }, { key: 'full', label: 'Testo completo' }],
};

const deviceLanguage = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale?.toLowerCase().startsWith('it') ? 'it' : 'en';
  } catch {
    return 'en';
  }
};

// A legal document of the app (legal/, bundled by scripts/legal.mjs): readable before
// signing in too. Two versions: in short, plain words for everyone (shown first), and
// the full text, the one that applies
export function LegalDocumentScreen() {
  const { doc } = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [language, setLanguage] = useState(deviceLanguage);
  const [version, setVersion] = useState('short');
  const document = DOCUMENTS[doc]?.[version];
  const other = language === 'it' ? 'en' : 'it';

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <IconButton icon="chevron-back" label="Back" onPress={() => (router.canGoBack() ? router.back() : router.replace('/'))} />
        <Text style={styles.title} accessibilityRole="header" numberOfLines={1}>{LEGAL_TITLES[doc]?.[language] ?? ''}</Text>
        <View style={styles.spacer} />
      </View>
      {document ? (
        <View style={styles.versions}>
          <SegmentedTabs tabs={VERSIONS[language]} value={version} onChange={setVersion} />
        </View>
      ) : null}
      {/* Each version opens at its top */}
      <ScrollView key={version} contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 32 }]}>
        {document ? <Markdown source={document[language]} /> : <Text style={styles.missing}>This document does not exist.</Text>}
        {document ? (
          <Pressable accessibilityRole="button" onPress={() => setLanguage(other)} hitSlop={8} style={styles.switch}>
            <Text style={styles.switchLabel}>{other === 'it' ? 'Leggi in italiano' : 'Read in English'}</Text>
          </Pressable>
        ) : null}
      </ScrollView>
    </View>
  );
}

const createStyles = (colors) => StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.page },
  topBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 6 },
  title: { flex: 1, textAlign: 'center', fontSize: 17, fontWeight: '700', color: colors.active },
  spacer: { width: 40 },
  versions: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 8 },
  content: { paddingHorizontal: 20, paddingTop: 12 },
  missing: { fontSize: 15, color: colors.inactive },
  switch: { alignSelf: 'center', marginTop: 28, padding: 8 },
  switchLabel: { fontSize: 15, fontWeight: '600', color: colors.active, textDecorationLine: 'underline' },
});
