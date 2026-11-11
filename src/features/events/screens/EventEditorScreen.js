// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, Alert, KeyboardAvoidingView, Pressable, ScrollView, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useDiscardGuard } from '../../../components/navigation/useDiscardGuard';
import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import { GlassFill } from '../../../components/ui/GlassFill';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { Chip } from '../../../components/ui/Chip';
import { Slider } from '../../../components/ui/Slider';
import { useEvents } from '../state/EventsProvider';
import { getUserPosition } from '../hooks/useUserPosition';
import { SheetHeader } from '../../../components/ui/SheetHeader';
import { EmptyState } from '../../../components/ui/StateViews';
import { Notice } from '../../../components/ui/Notice';
import { EventPhotosField } from '../components/EventPhotosField';
import { CATEGORIES, QUICK_CATEGORIES } from '../model/categories';
import {
  activeEventCount, crowdingEvent, draftToEvent, emptyDraft, eventToDraft, formatDay, formatRange, formatTime, latestStart, LIMITS, PLACEMENT, REACH_VALUES,
  newEventKey, placementMessage, tooCloseMessage, TOO_MANY_EVENTS_MESSAGE, validateDraft,
} from '../model/eventModel';
import { failureMessage } from '../../api/failureMessage';

// The form's fields in order, by the names of their errors (eventModel validateDraft)
const FIELD_ORDER = ['title', 'description', 'startDate', 'endDate', 'location', 'categories', 'links'];
// A field's count of characters shows only once it nears its limit (share of it)
const COUNTER_FROM = 0.8;

// Creates an event (no id) or edits one of the user's own (id)
export function EventEditorScreen({ id }) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { byId, user, saveEvent, saveEventImages } = useEvents();
  const existing = id ? byId[id] : null;
  const isNew = !id;

  const [draft, setDraft] = useState(() => (existing?.dates?.startDate ? eventToDraft(existing) : emptyDraft()));
  // Its pictures (optional): the event's addresses, and files picked here
  const [photos, setPhotos] = useState(() => existing?.imageUrls ?? []);
  const [showErrors, setShowErrors] = useState(false);
  const [saving, setSaving] = useState(false);
  // One for this new event, the same if it is sent again (the answer lost on a bad network)
  const [creationKey] = useState(newEventKey);
  const [locating, setLocating] = useState(false);
  // The keyboard's "next" on the title goes on to the description
  const descriptionInput = useRef(null);
  // The everyday categories first; the others (and any already picked) behind "More"
  const [allCategories, setAllCategories] = useState(false);
  // The header floats over the form, frosted (the form scrolls under it): its height
  const [headerHeight, setHeaderHeight] = useState(56);
  const original = existing?.dates?.startDate ? eventToDraft(existing) : null;
  const errors = validateDraft(draft, { isNew, originalStart: original?.startDate });
  // Room around the event (docs/API.md, Events), checked as the server does: for a
  // new event, or when the place changes. Shown at once, not after Create
  const moved = !original
    || draft.location?.latitude !== original.location?.latitude || draft.location?.longitude !== original.location?.longitude;
  const crowding = moved && draft.location ? crowdingEvent(Object.values(byId), { id, location: draft.location }) : null;
  if (crowding && !errors.location) errors.location = `${tooCloseMessage(crowding)} Move a little and update the position.`;
  const valid = Object.keys(errors).length === 0;
  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(existing?.dates?.startDate ? eventToDraft(existing) : null)
      || JSON.stringify(photos) !== JSON.stringify(existing?.imageUrls ?? []),
    [draft, photos, existing],
  );

  const update = (fields) => setDraft((current) => ({ ...current, ...fields }));

  // Where each field is in the form: a Create with something missing scrolls to the
  // first one, so its message is never out of sight
  const scroll = useRef(null);
  const fieldY = useRef({});
  const place = (names, y) => {
    for (const name of names) fieldY.current[name] = y;
  };

  const locate = async () => {
    setLocating(true);
    const position = await getUserPosition();
    setLocating(false);
    if (position) update({ location: { ...position, address: draft.location?.address } });
    else Alert.alert('Location unavailable', 'Allow the app to use your location (the map asks for it) to place the event where you are.');
  };

  // A new event is placed where the user is
  useEffect(() => {
    if (!isNew) return undefined;
    let alive = true;
    getUserPosition().then((position) => {
      if (alive && position) setDraft((current) => (current.location ? current : { ...current, location: position }));
    });
    return () => {
      alive = false;
    };
  }, [isNew]);

  // A new event with nothing typed in has nothing to lose
  const allowLeaving = useDiscardGuard(dirty && !(isNew && !draft.title && !draft.description && !photos.length));

  const save = async () => {
    if (!valid) {
      setShowErrors(true);
      const first = FIELD_ORDER.find((name) => errors[name]);
      // Clear of the floating header
      if (first && fieldY.current[first] !== undefined) scroll.current?.scrollTo({ y: Math.max(0, fieldY.current[first] - headerHeight - 12), animated: true });
      return;
    }
    setSaving(true);
    try {
      const eventId = await saveEvent(id ?? null, draftToEvent(draft), { key: creationKey });
      // The pictures need the event first (they are uploaded for it); the event stays
      // saved when they fail
      try {
        await saveEventImages(eventId, photos);
      } catch {
        Alert.alert(isNew ? 'Event created, photos not added' : 'Event saved, photos not changed', 'Add them again from Edit when you are online.');
      }
      allowLeaving();
      if (isNew) router.replace(`/event/${eventId}`);
      else router.back();
    } catch (error) {
      setSaving(false);
      Alert.alert('Could not save the event', placementMessage(error) ?? failureMessage(error));
    }
  };

  // Moving the start keeps the duration
  const setStart = (startDate) => {
    const duration = draft.endDate - draft.startDate;
    update({ startDate, endDate: new Date(startDate.getTime() + Math.max(duration, 30 * 60000)) });
  };

  const error = (field) => ((showErrors || (field === 'location' && crowding)) && errors[field] ? <Text style={styles.error}>{errors[field]}</Text> : null);
  const shownCategories = allCategories
    ? CATEGORIES
    : CATEGORIES.filter((category) => QUICK_CATEGORIES.includes(category.id) || draft.categories.includes(category.id));

  // Editing needs the event: saving an empty form would overwrite it
  if (!isNew && !existing?.dates?.startDate) {
    return (
      <View style={[styles.page, process.env.EXPO_OS === 'android' && { paddingTop: insets.top }]}>
        <SheetHeader grabber={false} title="Edit event" leftLabel="Cancel" onLeft={() => router.back()} />
        <EmptyState icon="calendar-clear-outline" title="Event not available" message="Open the event again, then edit it." actionLabel="Back" onAction={() => router.back()} />
      </View>
    );
  }

  // A new event needs a free slot (the server checks it too)
  if (isNew && !saving && user && activeEventCount(Object.values(byId), user.id) >= PLACEMENT.maxActive) {
    return (
      <View style={[styles.page, process.env.EXPO_OS === 'android' && { paddingTop: insets.top }]}>
        <SheetHeader grabber={false} title="New event" leftLabel="Cancel" onLeft={() => router.back()} />
        <EmptyState icon="calendar-clear-outline" title={`${PLACEMENT.maxActive} events on`} message={TOO_MANY_EVENTS_MESSAGE} actionLabel="Back" onAction={() => router.back()} />
      </View>
    );
  }

  return (
    <View style={[styles.page, process.env.EXPO_OS === 'android' && { paddingTop: insets.top }]}>
      <KeyboardAvoidingView style={styles.flex} behavior={process.env.EXPO_OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          ref={scroll}
          contentContainerStyle={[styles.form, { paddingTop: headerHeight + 20, paddingBottom: insets.bottom + 32 }]}
          scrollIndicatorInsets={{ top: headerHeight }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <Field styles={styles} names={['title']} onPlace={place} label="Title" count={draft.title.length} max={LIMITS.title}>
            <TextInput
              value={draft.title}
              onChangeText={(title) => update({ title })}
              placeholder="e.g. Pickup football at the park"
              placeholderTextColor={colors.inactive}
              maxLength={LIMITS.title}
              style={styles.input}
              returnKeyType="next"
              submitBehavior="submit"
              onSubmitEditing={() => descriptionInput.current?.focus()}
            />
            {error('title')}
          </Field>

          <Field styles={styles} names={['description']} onPlace={place} label="Description" count={draft.description.length} max={LIMITS.description}>
            <TextInput
              ref={descriptionInput}
              value={draft.description}
              onChangeText={(description) => update({ description })}
              placeholder="What will happen, who is it for, what to bring…"
              placeholderTextColor={colors.inactive}
              maxLength={LIMITS.description}
              multiline
              textAlignVertical="top"
              style={[styles.input, styles.multiline]}
            />
            {error('description')}
          </Field>

          <Field styles={styles} label="Photos" hint="Optional. The first one is the cover">
            <EventPhotosField photos={photos} onChange={setPhotos} />
          </Field>

          <Field styles={styles} names={['startDate', 'endDate']} onPlace={place} label="When">
            <View style={styles.group}>
              <DateRow
                styles={styles}
                colors={colors}
                label="Starts"
                value={draft.startDate}
                onChange={setStart}
                minimumDate={isNew ? new Date() : undefined}
                // At most a month ahead (a start already later, from before, stays as it is)
                maximumDate={draft.startDate <= latestStart() ? latestStart() : undefined}
              />
              <View style={styles.groupDivider} />
              <DateRow styles={styles} colors={colors} label="Ends" value={draft.endDate} onChange={(endDate) => update({ endDate })} minimumDate={draft.startDate} />
            </View>
            {error('startDate')}
            {error('endDate')}
          </Field>

          <Field styles={styles} names={['location']} onPlace={place} label="Where">
            <View style={styles.group}>
              <Pressable accessibilityRole="button" onPress={locate} style={styles.locationRow}>
                <View style={styles.locationIcon}>
                  {locating ? <ActivityIndicator size="small" color={colors.active} /> : <Ionicons name="navigate-outline" size={18} color={colors.active} />}
                </View>
                <View style={styles.flex}>
                  {/* An event being edited keeps its place until the user moves it here */}
                  <Text style={styles.rowTitle}>{!draft.location ? 'Use my current position' : original && !moved ? 'Where the event is' : 'Right where you are'}</Text>
                  <Text style={styles.rowSubtitle}>
                    {!draft.location ? 'People see events only near them' : original && !moved ? 'Tap to move it to where you are now' : 'Moved? Tap to pin it here again'}
                  </Text>
                </View>
              </Pressable>
              <View style={styles.groupDivider} />
              <TextInput
                value={draft.location?.address ?? ''}
                onChangeText={(address) => update({ location: draft.location ? { ...draft.location, address } : null })}
                editable={!!draft.location}
                placeholder="Place name or address (optional)"
                placeholderTextColor={colors.inactive}
                maxLength={LIMITS.address}
                style={styles.groupInput}
              />
            </View>
            {(showErrors || crowding) && errors.location ? <Notice icon="location" text={errors.location} /> : null}
          </Field>

          <Field styles={styles} label="Who sees it" hint="People farther away don't see it in their list or on their map">
            <View style={styles.group}>
              <View style={styles.reachRow}>
                <Text style={styles.rowTitle}>Within</Text>
                <Text style={styles.reachValue}>{formatRange(draft.reach)}</Text>
              </View>
              <View style={styles.reachSlider}>
                <Slider values={REACH_VALUES} value={draft.reach} onChange={(reach) => update({ reach })} format={(metres) => `Within ${formatRange(metres)}`} accessibilityLabel="Who sees it" />
              </View>
            </View>
          </Field>

          <Field styles={styles} names={['categories']} onPlace={place} label="Categories" hint="Pick one or more. The first gives the event its colour">
            <View style={styles.chips}>
              {shownCategories.map((category) => {
                const selected = draft.categories.includes(category.id);
                return (
                  <Chip
                    key={category.id}
                    label={category.label}
                    icon={category.icon}
                    tint={category.color}
                    selected={selected}
                    onPress={() => update({
                      categories: selected
                        ? draft.categories.filter((idValue) => idValue !== category.id)
                        : [...draft.categories, category.id],
                    })}
                  />
                );
              })}
              {allCategories ? null : (
                <Chip label="More" icon="ellipsis-horizontal" onPress={() => setAllCategories(true)} />
              )}
            </View>
            {error('categories')}
          </Field>

          <Field styles={styles} names={['links']} onPlace={place} label="Link" hint="Tickets, menu, a group chat… (optional)">
            <TextInput
              value={draft.links}
              onChangeText={(links) => update({ links })}
              placeholder="https://"
              placeholderTextColor={colors.inactive}
              maxLength={LIMITS.link}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
              style={styles.input}
            />
            {error('links')}
          </Field>
        </ScrollView>
      </KeyboardAvoidingView>
      {/* Frosted, as the tab bar: the form shows softly through it as it scrolls */}
      <View style={[styles.headerFloat, process.env.EXPO_OS === 'android' && { top: insets.top }]} onLayout={(event) => setHeaderHeight(event.nativeEvent.layout.height)}>
        <GlassFill />
        <SheetHeader
          grabber={false}
          style={styles.headerClear}
          title={isNew ? 'New event' : 'Edit event'}
          leftLabel="Cancel"
          onLeft={() => router.back()}
          rightLabel={isNew ? 'Create' : 'Save'}
          onRight={save}
          rightBusy={saving}
          rightDisabled={!isNew && !dirty}
        />
      </View>
    </View>
  );
}

function Field({ styles, label, hint, count, max, names, onPlace, children }) {
  return (
    <View style={styles.field} onLayout={names ? (event) => onPlace(names, event.nativeEvent.layout.y) : undefined}>
      <View style={styles.labelRow}>
        <Text style={styles.label}>{label}</Text>
        {max && count >= max * COUNTER_FROM ? <Text style={[styles.counter, count > max * 0.9 && styles.counterWarning]}>{count}/{max}</Text> : null}
      </View>
      {hint ? <Text style={styles.hint}>{hint}</Text> : null}
      {children}
    </View>
  );
}

// iOS: the compact native picker in the row. Android: the system dialogs, date then time.
function DateRow({ styles, colors, label, value, onChange, minimumDate, maximumDate }) {
  const openAndroid = () => {
    DateTimePickerAndroid.open({
      value,
      mode: 'date',
      minimumDate,
      maximumDate,
      onValueChange: (_, date) => {
        DateTimePickerAndroid.open({
          value: date,
          mode: 'time',
          is24Hour: true,
          onValueChange: (__, time) => onChange(time),
        });
      },
    });
  };

  return (
    <View style={styles.dateRow}>
      <Text style={styles.rowTitle}>{label}</Text>
      {process.env.EXPO_OS === 'ios' ? (
        <DateTimePicker
          value={value}
          mode="datetime"
          display="compact"
          minuteInterval={5}
          minimumDate={minimumDate}
          maximumDate={maximumDate}
          themeVariant={colors.scheme}
          accentColor={colors.active}
          onValueChange={(_, date) => onChange(date)}
        />
      ) : (
        <Pressable accessibilityRole="button" onPress={openAndroid} style={styles.androidDate}>
          <Text style={styles.androidDateText}>{formatDay(value)} · {formatTime(value)}</Text>
        </Pressable>
      )}
    </View>
  );
}

const createStyles = (colors) => StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: colors.page,
  },
  headerFloat: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    overflow: 'hidden',
  },
  headerClear: {
    backgroundColor: 'transparent',
  },
  flex: {
    flex: 1,
  },
  form: {
    paddingHorizontal: 20,
    gap: 24,
  },
  field: {
    gap: 8,
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  label: {
    fontSize: 15,
    fontWeight: '700',
    color: colors.active,
  },
  hint: {
    fontSize: 13,
    color: colors.inactive,
    marginTop: -4,
  },
  counter: {
    fontSize: 13,
    color: colors.inactive,
    fontVariant: ['tabular-nums'],
  },
  counterWarning: {
    color: colors.error,
  },
  input: {
    minHeight: 48,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
    color: colors.active,
    backgroundColor: colors.surface,
  },
  multiline: {
    minHeight: 120,
  },
  error: {
    fontSize: 13,
    color: colors.error,
  },
  group: {
    borderRadius: 14,
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  groupDivider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
    marginLeft: 14,
  },
  groupInput: {
    height: 48,
    paddingHorizontal: 14,
    fontSize: 16,
    color: colors.active,
  },
  dateRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 52,
    paddingHorizontal: 14,
  },
  rowTitle: {
    fontSize: 16,
    color: colors.active,
  },
  rowSubtitle: {
    fontSize: 13,
    color: colors.inactive,
    marginTop: 2,
  },
  androidDate: {
    paddingHorizontal: 12,
    height: 34,
    borderRadius: 10,
    justifyContent: 'center',
    backgroundColor: colors.pill,
  },
  androidDateText: {
    fontSize: 15,
    color: colors.active,
  },
  reachRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 14,
    paddingTop: 14,
  },
  reachValue: {
    fontSize: 16,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    color: colors.active,
  },
  reachSlider: {
    paddingHorizontal: 14,
    paddingBottom: 6,
  },
  locationRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
  },
  locationIcon: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.pill,
  },
  chips: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
});
