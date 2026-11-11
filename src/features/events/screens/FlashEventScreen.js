// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useDiscardGuard } from '../../../components/navigation/useDiscardGuard';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { successFeedback, tapFeedback } from '../../../lib/haptics';
import { requestMapFocus, setMapDraft } from '../../map/state/mapRequests';
import { useEvents } from '../state/EventsProvider';
import { SheetHeader } from '../../../components/ui/SheetHeader';
import { SegmentedTabs } from '../../../components/ui/SegmentedTabs';
import { QUICK_CATEGORIES, categoryInfo } from '../model/categories';
import { Notice } from '../../../components/ui/Notice';
import { FLASH, LIMITS, crowdingEvent, formatTime, newEventKey, placementMessage, tooCloseMessage } from '../model/eventModel';
import { failureMessage } from '../../api/failureMessage';

// The start of a flash event made now, starting in `minutes`
const startingIn = (minutes) => new Date(Date.now() + minutes * 60000);

// A flash event: something happening right here, soon ("five-a-side at the park in
// an hour, 2 missing"), made in a few seconds from a long press on the map. It starts
// now or within the hour, lasts a few hours and disappears from the map when it ends.
// With an `id` it edits one of the user's flash events: what it is and who is wanted
// (its place and time stay).
// `from`: where the user is ({ latitude, longitude }), sent with a new one: the server
// checks it is near them (it has their position only while they are visible)
export function FlashEventScreen({ id, latitude, longitude, from }) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { byId, saveEvent } = useEvents();
  const existing = id ? byId[id] : null;
  const isNew = !id;
  const [title, setTitle] = useState(existing?.title ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [startsIn, setStartsIn] = useState(0);
  const [lasts, setLasts] = useState(120);
  const [spots, setSpots] = useState(existing?.spotsNeeded ?? 0);
  const [category, setCategory] = useState(existing?.categories?.[0] ?? 'sports');
  const [saving, setSaving] = useState(false);
  const allowLeaving = useDiscardGuard(title.trim() !== (existing?.title ?? '') || description.trim() !== (existing?.description ?? ''));
  // One for this new event, the same if it is sent again (the answer lost on a bad network)
  const [creationKey] = useState(newEventKey);
  // The keyboard's "next" on the title goes on to the description
  const descriptionInput = useRef(null);
  // Create pressed with something missing: said under it (the button never just stays grey)
  const [showMissing, setShowMissing] = useState(false);
  const place = Number.isFinite(latitude) && Number.isFinite(longitude) ? { latitude, longitude } : null;
  const filled = title.trim().length > 0 && description.trim().length > 0 && (isNew ? !!place : !!existing);

  // The clock of the times shown under "When", kept current while the sheet is open
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  // The place stays marked on the map while this sheet is open
  useEffect(() => {
    if (Number.isFinite(latitude) && Number.isFinite(longitude)) setMapDraft({ latitude, longitude });
    return () => setMapDraft(null);
  }, [latitude, longitude]);

  // The real times, so "Now" and "2 h" read as a plan
  const startsAt = new Date(now + startsIn * 60000);
  const endsAt = new Date(startsAt.getTime() + lasts * 60000);
  // Another event here leaves no room (the map refuses such a place at once; an event
  // made meanwhile by someone else may take it while the sheet is open)
  const crowding = isNew ? crowdingEvent(Object.values(byId), { location: place }, now) : null;
  const valid = filled && !crowding;

  const save = async () => {
    if (!filled) {
      setShowMissing(true);
      return;
    }
    if (!valid || saving) return;
    setSaving(true);
    const what = { title: title.trim(), description: description.trim(), categories: [category], spotsNeeded: spots };
    try {
      if (isNew) {
        const start = startingIn(startsIn);
        const newId = await saveEvent(null, {
          ...what,
          location: place,
          dates: { startDate: start.toISOString(), endDate: new Date(start.getTime() + lasts * 60000).toISOString() },
          flash: true,
          ...(from ? { from } : {}),
        }, { key: creationKey });
        successFeedback();
        requestMapFocus(newId);
      } else {
        await saveEvent(id, what);
      }
      allowLeaving();
      router.back();
    } catch (error) {
      setSaving(false);
      Alert.alert(
        isNew ? 'Could not create it' : 'Could not save it',
        placementMessage(error) ?? failureMessage(error),
      );
    }
  };

  const step = (delta) => {
    tapFeedback();
    setSpots((value) => Math.min(FLASH.maxSpots, Math.max(0, value + delta)));
  };

  return (
    <View style={styles.page}>
      <SheetHeader
        title={isNew ? 'Flash event' : 'Edit flash event'}
        leftLabel="Cancel"
        onLeft={() => router.back()}
        rightLabel={isNew ? 'Create' : 'Save'}
        onRight={save}
        rightDisabled={!!crowding}
        rightBusy={saving}
      />
      <View collapsable={false} style={styles.flex}>
        <KeyboardAvoidingView collapsable={false} style={styles.flex} behavior={process.env.EXPO_OS === 'ios' ? 'padding' : undefined}>
          <ScrollView contentContainerStyle={[styles.form, { paddingBottom: insets.bottom + 24 }]} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag">
            <Section styles={styles} label="What">
              <View style={styles.group}>
                <TextInput
                  value={title}
                  onChangeText={setTitle}
                  placeholder="e.g. Five-a-side, 2 missing"
                  placeholderTextColor={colors.inactive}
                  maxLength={LIMITS.title}
                  autoFocus={isNew}
                  returnKeyType="next"
                  submitBehavior="submit"
                  onSubmitEditing={() => descriptionInput.current?.focus()}
                  style={styles.titleInput}
                  accessibilityLabel="What's happening"
                />
                <View style={styles.divider} />
                <TextInput
                  ref={descriptionInput}
                  value={description}
                  onChangeText={setDescription}
                  placeholder="What to bring, where exactly, who it's for"
                  placeholderTextColor={colors.inactive}
                  maxLength={LIMITS.description}
                  multiline
                  style={styles.descriptionInput}
                  accessibilityLabel="Description"
                />
              </View>
              {showMissing && !filled ? (
                <Notice icon="create-outline" text={!title.trim() ? 'Say what it is, and a line about it.' : 'Add a line about it: what to bring, where exactly, who it\'s for.'} />
              ) : null}
            </Section>

            <Section styles={styles} label="Kind">
              <View style={styles.kinds}>
                {QUICK_CATEGORIES.map((key) => (
                  <KindTile key={key} styles={styles} colors={colors} info={categoryInfo(key)} selected={category === key} onPress={() => setCategory(key)} />
                ))}
              </View>
            </Section>

            {isNew ? (
              <Section styles={styles} label="When">
                <Choice styles={styles} label="Starts" options={FLASH.startOptions} value={startsIn} onChange={setStartsIn} />
                <Choice styles={styles} label="Lasts" options={FLASH.durationOptions} value={lasts} onChange={setLasts} />
                {crowding ? (
                  <Notice icon="location" text={`${tooCloseMessage(crowding)} Hold the map a little farther away.`} />
                ) : (
                  <Text style={styles.note}>
                    {formatTime(startsAt)} – {formatTime(endsAt)}, right where you held the map. It disappears when it ends.
                  </Text>
                )}
              </Section>
            ) : null}

            <Section styles={styles} label="Looking for">
              <View style={styles.spotsRow}>
                <Text style={styles.spotsValue} accessibilityLiveRegion="polite">
                  {spots === 0 ? 'Anyone welcome' : spots === 1 ? '1 more person' : `${spots} more people`}
                </Text>
                <View style={styles.stepper}>
                  <StepButton styles={styles} colors={colors} icon="remove" label="Fewer" disabled={spots === 0} onPress={() => step(-1)} />
                  <View style={styles.stepperDivider} />
                  <StepButton styles={styles} colors={colors} icon="add" label="More" disabled={spots >= FLASH.maxSpots} onPress={() => step(1)} />
                </View>
              </View>
            </Section>
          </ScrollView>
        </KeyboardAvoidingView>
      </View>
    </View>
  );
}

function Section({ styles, label, children }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{label}</Text>
      {children}
    </View>
  );
}

// A category as a tile of the 4 × 2 grid: all the same size, the icon in its colour
function KindTile({ styles, colors, info, selected, onPress }) {
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityState={{ selected }}
      accessibilityLabel={info.label}
      onPress={onPress}
      style={({ pressed }) => [styles.kind, selected && styles.kindSelected, pressed && styles.pressed]}
    >
      <Ionicons name={info.icon} size={20} color={selected ? colors.onAccent : info.color} />
      <Text style={[styles.kindLabel, selected && styles.kindLabelSelected]} numberOfLines={1}>{info.label}</Text>
    </Pressable>
  );
}

// A label and its options side by side, the options as one segmented control
function Choice({ styles, label, options, value, onChange }) {
  return (
    <View style={styles.choice}>
      <Text style={styles.choiceLabel}>{label}</Text>
      <View style={styles.flex}>
        <SegmentedTabs
          tabs={options.map((option) => ({ key: option.minutes, label: option.label }))}
          value={value}
          onChange={onChange}
        />
      </View>
    </View>
  );
}

function StepButton({ styles, colors, icon, label, disabled, onPress }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      style={({ pressed }) => [styles.stepButton, (pressed || disabled) && styles.pressed]}
    >
      <Ionicons name={icon} size={18} color={colors.active} />
    </Pressable>
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
  form: {
    padding: 20,
    gap: 26,
  },
  section: {
    gap: 10,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.inactive,
  },
  // Title and description in one card, a hairline between them
  group: {
    borderRadius: 14,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 14,
    backgroundColor: colors.border,
  },
  titleInput: {
    height: 52,
    paddingHorizontal: 14,
    fontSize: 17,
    fontWeight: '600',
    color: colors.active,
  },
  descriptionInput: {
    minHeight: 84,
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 12,
    fontSize: 16,
    lineHeight: 22,
    textAlignVertical: 'top',
    color: colors.active,
  },
  kinds: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  // Four to a row: a quarter of the width, less the three gaps
  kind: {
    width: '23.2%',
    flexGrow: 1,
    height: 64,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 5,
    borderRadius: 14,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
  },
  kindSelected: {
    backgroundColor: colors.accent,
  },
  kindLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.active,
  },
  kindLabelSelected: {
    color: colors.onAccent,
  },
  choice: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
  },
  choiceLabel: {
    width: 52,
    fontSize: 15,
    fontWeight: '600',
    color: colors.active,
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.inactive,
    fontVariant: ['tabular-nums'],
  },
  spotsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 52,
    paddingLeft: 14,
    paddingRight: 6,
    borderRadius: 14,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
  },
  spotsValue: {
    flex: 1,
    fontSize: 16,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    color: colors.active,
  },
  // − and + in one pill, like a native stepper
  stepper: {
    flexDirection: 'row',
    alignItems: 'center',
    height: 36,
    borderRadius: 10,
    borderCurve: 'continuous',
    backgroundColor: colors.pill,
  },
  stepperDivider: {
    width: StyleSheet.hairlineWidth,
    height: 18,
    backgroundColor: colors.inactive,
    opacity: 0.5,
  },
  stepButton: {
    width: 44,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  pressed: {
    opacity: 0.5,
  },
});
