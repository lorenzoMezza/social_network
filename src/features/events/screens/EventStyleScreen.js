// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useDiscardGuard } from '../../../components/navigation/useDiscardGuard';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { tapFeedback } from '../../../lib/haptics';
import { useEvents } from '../state/EventsProvider';
import { SheetHeader } from '../../../components/ui/SheetHeader';
import { categoryLine, eventColor, mainCategory } from '../model/categories';
import { CategoryTile } from '../components/CategoryTile';
import { EventBackdrop } from '../components/EventBackdrop';
import { BeamPreview, BeamThumbnail } from '../components/BeamPreview';
import {
  BEAM_COLORS, BEAM_STYLES, SPONSORED_BEAM, THEME_BACKGROUNDS, THEME_COLORS, THEME_EMOJIS, THEME_TITLES, cleanTheme, setThemePreview, pageColor, themeToSave, titleFont,
} from '../model/eventTheme';
import { failureMessage } from '../../api/failureMessage';

// The top of the event's page, as it will look, with the page's own parts: the sheet
// covers most of the real one
function PagePreview({ event, theme, colors, styles }) {
  const tone = eventColor({ ...event, theme });
  return (
    <View
      style={[styles.pagePreview, { backgroundColor: pageColor(theme, tone, colors) }]}
      accessibilityRole="image"
      accessibilityLabel="Preview of the event's page"
    >
      <EventBackdrop theme={theme} tone={tone} dark={colors.scheme === 'dark'} height={150} />
      <View style={styles.pagePreviewKind}>
        <CategoryTile event={event} theme={theme} size={30} />
        <Text style={styles.pagePreviewKindText} numberOfLines={1}>{categoryLine(event, 2) || 'Event'}</Text>
      </View>
      <Text style={[styles.pagePreviewTitle, titleFont(theme.title), styles.pagePreviewTitleSize]} numberOfLines={1}>{event?.title}</Text>
      <Text style={[styles.pagePreviewLink, { color: theme.color ?? colors.accent }]}>Add to calendar</Text>
    </View>
  );
}

// How the organizer dresses their event, in the order people meet it: its light on the
// map, the symbol that goes everywhere, then its page (its photos are content: the event
// editor). A sheet over the page: each choice shows at once (the page under it, the beam
// in its preview), and is kept with Save.
export function EventStyleScreen({ id }) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { byId, saveEventLook } = useEvents();
  const event = byId[id];
  const category = mainCategory(event);
  const [theme, setTheme] = useState(() => cleanTheme(event?.theme));
  const [saving, setSaving] = useState(false);
  const allowLeaving = useDiscardGuard(JSON.stringify(theme) !== JSON.stringify(cleanTheme(event?.theme)));
  const previewGeneration = useRef(0);
  const previewOwner = useRef(null);
  const accent = theme.color ?? category.color;
  // Gold while sponsored, whatever was chosen: on the map it means paid for
  const sponsored = !!event?.sponsored;
  const beam = sponsored ? SPONSORED_BEAM : theme.beam ?? '#FFFFFF';

  // The page under the sheet shows what is being tried; leaving puts it back
  useEffect(() => {
    previewGeneration.current++;
    const owner = { active: true };
    previewOwner.current = owner;
    return () => {
      owner.active = false;
      setThemePreview(id, null);
    };
  }, [id]);

  const isCurrentPreview = (started) => previewOwner.current?.active && started === previewGeneration.current;
  const change = (next, started = previewGeneration.current) => {
    if (!isCurrentPreview(started)) return;
    tapFeedback();
    setTheme(next.theme);
    setThemePreview(id, { theme: next.theme });
  };
  const choose = (fields) => change({ theme: { ...theme, ...fields } });
  // A plain page has nothing to show a colour on: choosing one gives it a background
  // to show it, and Plain stays one tap away
  const choosePageColor = (color) => choose(theme.background === 'plain' ? { color, background: 'glow' } : { color });

  const save = async () => {
    const started = previewGeneration.current;
    setSaving(true);
    try {
      await saveEventLook(id, { theme: themeToSave(theme) });
      if (!isCurrentPreview(started)) return;
      allowLeaving();
      router.back();
    } catch (error) {
      if (!isCurrentPreview(started)) return;
      setSaving(false);
      Alert.alert('Could not save the style', failureMessage(error));
    }
  };

  return (
    <View style={styles.page}>
      <SheetHeader title="Style" leftLabel="Cancel" onLeft={() => router.back()} rightLabel="Save" onRight={save} rightBusy={saving} />
      {/* Wrapped: in an iOS form sheet a scroll view right under the header is
          resized by the screens library (see ProfileStyleScreen) */}
      <View collapsable={false} style={styles.flex}>
        <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 24 }]} showsVerticalScrollIndicator={false}>
          <Text style={styles.section}>On the map</Text>
          <BeamPreview style={theme.beamStyle} color={beam} emoji={theme.emoji ?? category.emoji} />
          <Text style={styles.label}>Beam style</Text>
          <View style={styles.options}>
            {BEAM_STYLES.map((option) => {
              const selected = theme.beamStyle === option.id;
              return (
                <Pressable
                  key={option.id}
                  accessibilityRole="radio"
                  accessibilityLabel={`${option.label} beam style`}
                  accessibilityState={{ selected }}
                  onPress={() => !selected && choose({ beamStyle: option.id })}
                  style={({ pressed }) => [styles.option, selected && { borderColor: colors.active }, pressed && styles.pressed]}
                >
                  <BeamThumbnail style={option.id} color={beam} />
                  <Text style={[styles.optionLabel, selected && { color: colors.active }]} numberOfLines={1} adjustsFontSizeToFit>{option.label}</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.label}>Beam colour</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} style={styles.bleed}>
            <Pressable
              accessibilityRole="radio"
              accessibilityLabel="Automatic beam colour"
              accessibilityState={{ selected: !theme.beam }}
              onPress={() => theme.beam && choose({ beam: null })}
              style={[styles.swatchRing, !theme.beam && { borderColor: colors.active }]}
            >
              <View style={[styles.swatch, styles.autoSwatch, { borderColor: colors.inactive }]}>
                <Text style={[styles.autoText, { color: colors.active }]}>A</Text>
              </View>
            </Pressable>
            {BEAM_COLORS.map(({ color, label }) => {
              const selected = theme.beam === color;
              return (
                <Pressable
                  key={color}
                  accessibilityRole="radio"
                  accessibilityLabel={`${label} beam`}
                  accessibilityState={{ selected }}
                  onPress={() => !selected && choose({ beam: color })}
                  style={[styles.swatchRing, selected && { borderColor: colors.active }]}
                >
                  <View style={[styles.swatch, { backgroundColor: color }]} />
                </Pressable>
              );
            })}
          </ScrollView>
          <Text style={styles.note}>
            {sponsored ? 'Gold while it is sponsored. Your colour comes back after.' : 'A: white, green while it is on, blue for who is going.'}
          </Text>

          <Text style={styles.section}>Symbol</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} style={styles.bleed}>
            <Pressable
              accessibilityRole="radio"
              accessibilityLabel="Icon of its category"
              accessibilityState={{ selected: !theme.emoji }}
              onPress={() => theme.emoji && choose({ emoji: null })}
              style={[styles.symbol, !theme.emoji && { borderColor: accent }]}
            >
              <Ionicons name={category.icon} size={22} color={accent} />
            </Pressable>
            {THEME_EMOJIS.map((emoji) => {
              const selected = theme.emoji === emoji;
              return (
                <Pressable
                  key={emoji}
                  accessibilityRole="radio"
                  accessibilityLabel={emoji}
                  accessibilityState={{ selected }}
                  onPress={() => !selected && choose({ emoji })}
                  style={[styles.symbol, selected && { borderColor: accent }]}
                >
                  <Text style={styles.emoji}>{emoji}</Text>
                </Pressable>
              );
            })}
          </ScrollView>

          <Text style={styles.section}>Page</Text>
          <PagePreview event={event} theme={theme} colors={colors} styles={styles} />
          <Text style={styles.label}>Colour</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row} style={styles.bleed}>
            <Pressable
              accessibilityRole="radio"
              accessibilityLabel="Page colour of its category"
              accessibilityState={{ selected: !theme.color }}
              onPress={() => theme.color && choose({ color: null })}
              style={[styles.swatchRing, !theme.color && { borderColor: colors.active }]}
            >
              <View style={[styles.swatch, styles.autoSwatch, { borderColor: category.color }]}>
                <Text style={[styles.autoText, { color: category.color }]}>A</Text>
              </View>
            </Pressable>
            {THEME_COLORS.map((color) => {
              const selected = theme.color === color;
              return (
                <Pressable
                  key={color}
                  accessibilityRole="radio"
                  accessibilityLabel={`Page colour ${color}`}
                  accessibilityState={{ selected }}
                  onPress={() => !selected && choosePageColor(color)}
                  style={[styles.swatchRing, selected && { borderColor: colors.active }]}
                >
                  <View style={[styles.swatch, { backgroundColor: color }]} />
                </Pressable>
              );
            })}
          </ScrollView>

          <Text style={styles.label}>Background</Text>
          <View style={styles.options}>
            {THEME_BACKGROUNDS.map((option) => {
              const selected = theme.background === option.id;
              return (
                <Pressable
                  key={option.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  onPress={() => !selected && choose({ background: option.id })}
                  style={({ pressed }) => [styles.option, selected && { borderColor: accent }, pressed && styles.pressed]}
                >
                  <Ionicons name={option.icon} size={20} color={selected ? accent : colors.inactive} />
                  <Text style={[styles.optionLabel, selected && { color: colors.active }]}>{option.label}</Text>
                </Pressable>
              );
            })}
          </View>

          <Text style={styles.label}>Title</Text>
          <View style={styles.options}>
            {THEME_TITLES.map((option) => {
              const selected = theme.title === option.id;
              return (
                <Pressable
                  key={option.id}
                  accessibilityRole="radio"
                  accessibilityLabel={option.label}
                  accessibilityState={{ selected }}
                  onPress={() => !selected && choose({ title: option.id })}
                  style={({ pressed }) => [styles.option, selected && { borderColor: accent }, pressed && styles.pressed]}
                >
                  <Text style={[styles.sample, titleFont(option.id), styles.sampleSize, { color: selected ? accent : colors.inactive }]}>Aa</Text>
                  <Text style={[styles.optionLabel, selected && { color: colors.active }]} numberOfLines={1}>{option.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>
      </View>

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
  pressed: {
    opacity: 0.6,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 8,
  },
  section: {
    fontSize: 17,
    fontWeight: '700',
    color: colors.active,
    marginTop: 22,
    marginBottom: 12,
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.inactive,
    marginTop: 18,
    marginBottom: 10,
  },
  pagePreview: {
    height: 150,
    borderRadius: 18,
    borderCurve: 'continuous',
    overflow: 'hidden',
    padding: 16,
    justifyContent: 'flex-end',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.border,
  },
  pagePreviewKind: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  pagePreviewKindText: {
    flex: 1,
    fontSize: 13,
    fontWeight: '500',
    color: colors.inactive,
  },
  pagePreviewTitle: {
    marginTop: 8,
    fontWeight: '700',
    color: colors.active,
  },
  pagePreviewTitleSize: {
    fontSize: 22,
    lineHeight: 28,
    letterSpacing: 0,
  },
  pagePreviewLink: {
    marginTop: 4,
    fontSize: 13,
    fontWeight: '600',
  },
  note: {
    fontSize: 13,
    color: colors.inactive,
    marginTop: 8,
  },
  bleed: {
    marginHorizontal: -20,
  },
  row: {
    paddingHorizontal: 20,
    gap: 8,
  },
  swatchRing: {
    width: 42,
    height: 42,
    borderRadius: 21,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatch: {
    width: 32,
    height: 32,
    borderRadius: 16,
  },
  autoSwatch: {
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  autoText: {
    fontSize: 13,
    fontWeight: '800',
  },
  symbol: {
    width: 44,
    height: 44,
    borderRadius: 14,
    borderCurve: 'continuous',
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  emoji: {
    fontSize: 22,
  },
  options: {
    flexDirection: 'row',
    gap: 8,
  },
  option: {
    flex: 1,
    alignItems: 'center',
    gap: 4,
    paddingVertical: 10,
    borderRadius: 14,
    borderCurve: 'continuous',
    borderWidth: 2,
    borderColor: 'transparent',
    backgroundColor: colors.surface,
  },
  optionLabel: {
    fontSize: 12,
    fontWeight: '600',
    color: colors.inactive,
  },
  sample: {
    color: colors.inactive,
  },
  sampleSize: {
    fontSize: 20,
    lineHeight: 24,
    letterSpacing: 0,
  },
});
