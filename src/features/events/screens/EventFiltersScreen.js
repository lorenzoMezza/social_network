// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useColors } from '../../../theme/colors';
import { Button } from '../../../components/ui/Button';
import { Chip } from '../../../components/ui/Chip';
import { useEvents } from '../state/EventsProvider';
import { SheetHeader } from '../../../components/ui/SheetHeader';
import { CATEGORIES } from '../model/categories';
import { DEFAULT_FILTERS, WHEN_OPTIONS } from '../model/eventModel';

// Filters of the events around: the categories go to the API (getEvents), the time
// window is applied on the device. There is no distance to choose: each event's reach
// keeps the list local
export function EventFiltersScreen() {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { filters, setFilters } = useEvents();
  const [draft, setDraft] = useState(filters);
  const update = (fields) => setDraft((current) => ({ ...current, ...fields }));

  const apply = () => {
    setFilters(draft);
    router.back();
  };

  const toggleCategory = (id) => update({
    categories: draft.categories.includes(id) ? draft.categories.filter((value) => value !== id) : [...draft.categories, id],
  });

  return (
    <View style={styles.page}>
      <SheetHeader title="Filters" leftLabel="Close" onLeft={() => router.back()} rightLabel="Reset" onRight={() => setDraft(DEFAULT_FILTERS)} />
      {/* Wrapped: in an iOS form sheet a scroll view right under the screen is resized
          by the screens library and drawn out of view */}
      <View collapsable={false} style={styles.scrollArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Section styles={styles} title="When">
          {WHEN_OPTIONS.map((option) => (
            <Chip key={option.id} label={option.label} selected={draft.when === option.id} onPress={() => update({ when: option.id })} />
          ))}
        </Section>
        <Section styles={styles} title="Categories" hint={draft.categories.length ? `${draft.categories.length} selected` : 'All categories'}>
          {CATEGORIES.map((category) => (
            <Chip
              key={category.id}
              label={category.label}
              icon={category.icon}
              tint={category.color}
              selected={draft.categories.includes(category.id)}
              onPress={() => toggleCategory(category.id)}
            />
          ))}
        </Section>
      </ScrollView>
      </View>
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <Button label="Show events" onPress={apply} />
      </View>
    </View>
  );
}

function Section({ styles, title, hint, children }) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionHeader}>
        <Text style={styles.sectionTitle}>{title}</Text>
        {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      </View>
      <View style={styles.chips}>{children}</View>
    </View>
  );
}

const createStyles = (colors) => StyleSheet.create({
  scrollArea: {
    flex: 1,
  },
  page: {
    flex: 1,
    backgroundColor: colors.page,
  },
  content: {
    padding: 20,
    gap: 28,
  },
  section: {
    gap: 12,
  },
  sectionHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  sectionTitle: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.active,
  },
  hint: {
    fontSize: 13,
    color: colors.inactive,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  footer: {
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
});
