// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Alert, Animated, FlatList, PanResponder, Pressable, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { Image } from 'expo-image';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { tapFeedback, successFeedback } from '../../../lib/haptics';
import { SheetHeader } from '../../../components/ui/SheetHeader';
import { EmptyState } from '../../../components/ui/StateViews';
import {
  BODY_SHAPES, categoryInfo, findItem, removeItem, switchBodyShape, validateAvatar, wearItem,
} from '../../../../avatar-server/shared/avatarFormat';
import { getPresets } from '../api/avatarApi';
import { AVATAR_FILES_URL } from '../api/avatarServer';
import { useAvatars, useUserAvatar } from '../state/AvatarProvider';
import { AvatarView } from '../components/AvatarView';
import { isDarkColor, stageOf, useOwnProfileStyle } from '../../profile/state/profileStyle';

// Editor tabs: the slots they edit (chips when several), the colour they offer, and
// where the camera looks
const TABS = [
  { key: 'looks', label: 'Looks', frame: 'body' },
  { key: 'body', label: 'Body', frame: 'body', color: 'skin' },
  { key: 'face', label: 'Face', frame: 'head', slots: ['eyes', 'eyebrows', 'mouth'], color: 'eyes' },
  { key: 'hair', label: 'Hair', frame: 'head', slots: ['hair', 'facial_hair'], color: 'hair' },
  { key: 'top', label: 'Top', frame: 'upper', slots: ['upper_body'] },
  { key: 'bottom', label: 'Bottom', frame: 'lower', slots: ['lower_body'] },
  { key: 'shoes', label: 'Shoes', frame: 'feet', slots: ['feet'] },
  { key: 'accessories', label: 'Extras', frame: 'head', slots: ['eyewear', 'hat', 'earring', 'mask', 'helmet', 'tiara', 'top_head', 'hands_wear'] },
];
const COLOR_LABELS = { skin: 'Skin tone', hair: 'Hair colour', eyes: 'Eye colour' };
const COLUMNS = 4;
const HEADER_HEIGHT = 56;
// Heights of the panel of items over the avatar, as shares of the screen: small (the
// avatar big, a row of items), medium (where it opens) and large (to browse, the
// avatar small above). Drag the handle between them, tap it to go up a level (from
// the top, back to the smallest), tap the avatar to see it big.
const LEVELS = [0.3, 0.44, 0.66];
const START_LEVEL = 1;
const SLOT_FRAMES = { hands_wear: 'upper' };

// #RRGGBB → rgba(…, alpha)
const rgba = (hex, alpha) => {
  const value = parseInt(hex.slice(1), 16);
  return `rgba(${value >> 16}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`;
};

const fileUrl = (path) => (path ? `${AVATAR_FILES_URL}/${path}` : null);

// The avatar fills the whole screen, under the header and a panel of items with
// three heights (LEVELS; scrolling the items opens it fully). The camera frames the
// part of the avatar the open section is about (head, upper body, legs, feet) in the
// space the panel leaves free, so it is never under the panel or the header.
export function AvatarEditorScreen() {
  const insets = useSafeAreaInsets();
  const { width, height: windowHeight } = useWindowDimensions();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { saveOwnAvatar } = useAvatars();
  // The avatar is dressed in its own world, as on the profile
  const [profileStyle] = useOwnProfileStyle();
  const stage = stageOf(profileStyle).theme;
  const { avatar: saved, catalog, status, error, reload } = useUserAvatar();

  // The avatar being edited: the saved one until the first change
  const [edits, setDraft] = useState(null);
  const draft = edits ?? saved;
  const [tab, setTab] = useState('body');
  const [slot, setSlot] = useState({});
  const [saving, setSaving] = useState(false);
  const [presets, setPresets] = useState(null);

  useEffect(() => {
    if (tab === 'looks' && !presets) getPresets().then(setPresets).catch(() => setPresets([]));
  }, [tab, presets]);

  // The panel: its height follows the finger, then springs to the nearest level
  const [height, setHeight] = useState(windowHeight);
  const levels = useMemo(() => LEVELS.map((share) => Math.round(height * share)), [height]);
  const [level, setLevel] = useState(START_LEVEL);
  const [panelHeight] = useState(() => new Animated.Value(Math.round(windowHeight * LEVELS[START_LEVEL])));
  // Where the panel was when a drag began (kept across the drag's callbacks)
  const [drag0] = useState(() => ({ height: 0 }));

  const snap = useCallback((next) => {
    setLevel(next);
    Animated.spring(panelHeight, {
      toValue: levels[next],
      useNativeDriver: false,
      damping: 24,
      stiffness: 240,
      mass: 0.9,
    }).start();
  }, [panelHeight, levels]);

  const onLayout = (event) => {
    const next = Math.round(event.nativeEvent.layout.height);
    if (next === height) return;
    setHeight(next);
    panelHeight.setValue(Math.round(next * LEVELS[level]));
  };

  const drag = useMemo(() => PanResponder.create({
    // Vertical drags only: the tabs scroll sideways
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dy) > 6 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
    onPanResponderGrant: () => {
      panelHeight.stopAnimation((value) => {
        drag0.height = value;
      });
    },
    onPanResponderMove: (_, gesture) => {
      panelHeight.setValue(Math.min(Math.max(drag0.height - gesture.dy, levels[0] - 40), levels[levels.length - 1] + 30));
    },
    onPanResponderRelease: (_, gesture) => {
      const reached = drag0.height - gesture.dy;
      // The nearest level, or the next one in the direction of a flick
      let next = levels.reduce((best, value, index) => (Math.abs(value - reached) < Math.abs(levels[best] - reached) ? index : best), 0);
      if (gesture.vy < -0.4) next = Math.max(next, levels.findIndex((value) => value > reached + 1) === -1 ? levels.length - 1 : levels.findIndex((value) => value > reached + 1));
      if (gesture.vy > 0.4) next = Math.min(next, Math.max(0, levels.findLastIndex((value) => value < reached - 1)));
      tapFeedback();
      snap(next);
    },
    onPanResponderTerminate: () => snap(level),
  }), [panelHeight, snap, level, levels, drag0]);

  const current = TABS.find((entry) => entry.key === tab);
  const activeSlot = current.slots ? slot[tab] ?? current.slots[0] : null;
  const changed = !!draft && !!saved && JSON.stringify({ ...draft, updatedAt: null }) !== JSON.stringify({ ...saved, updatedAt: null });

  // The items of the open slot that exist for the body shape ("None" first where optional)
  const items = (() => {
    if (!catalog || !draft || !activeSlot) return [];
    const list = catalog.items.filter((item) => item.category === activeSlot && item.representations[draft.bodyShape]);
    return categoryInfo(activeSlot)?.required ? list : [{ id: null, name: 'None' }, ...list];
  })();

  const update = (next) => {
    tapFeedback();
    setDraft(next);
  };

  const close = () => {
    if (!changed) {
      router.back();
      return;
    }
    Alert.alert('Discard your changes?', 'Your avatar stays as it was.', [
      { text: 'Keep editing', style: 'cancel' },
      { text: 'Discard', style: 'destructive', onPress: () => router.back() },
    ]);
  };

  const save = async () => {
    setSaving(true);
    try {
      await saveOwnAvatar(validateAvatar(draft, catalog).avatar);
      successFeedback();
      router.back();
    } catch (saveError) {
      setSaving(false);
      Alert.alert('Could not save your avatar', saveError?.details?.join('\n') ?? 'Check that the avatar server is reachable and try again.');
    }
  };

  if (!draft || !catalog) {
    return (
      <View style={[styles.page, process.env.EXPO_OS === 'android' && { paddingTop: insets.top }]}>
        <SheetHeader grabber={false} title="Avatar" leftLabel="Cancel" onLeft={() => router.back()} />
        <View style={styles.centered}>
          {status === 'error' ? (
            <EmptyState
              icon="cloud-offline-outline"
              title={error?.code === 'no-server' ? 'Avatar server not running' : 'Avatar did not load'}
              message={error?.code === 'no-server' ? 'Start it on your computer with make dev.' : 'Check your connection and try again.'}
              actionLabel="Try again"
              onAction={reload}
            />
          ) : <ActivityIndicator color={colors.inactive} />}
        </View>
      </View>
    );
  }

  const frame = activeSlot ? SLOT_FRAMES[activeSlot] ?? current.frame : current.frame;
  const tileSize = (width - 40 - (COLUMNS - 1) * 10) / COLUMNS;

  const header = (
    <View style={styles.controls}>
      {tab === 'body' ? (
        <View style={styles.shapes}>
          {[['Body A', BODY_SHAPES.female], ['Body B', BODY_SHAPES.male]].map(([label, shape]) => {
            const selected = draft.bodyShape === shape;
            const item = findItem(catalog, shape);
            return (
              <Pressable
                key={shape}
                accessibilityRole="radio"
                accessibilityState={{ selected }}
                accessibilityLabel={label}
                onPress={() => !selected && update(switchBodyShape(draft, catalog, shape))}
                style={[styles.shape, selected && styles.selectedTile]}
              >
                <Image source={fileUrl(item?.thumbnail)} style={styles.shapeImage} contentFit="contain" />
                <Text style={styles.shapeLabel}>{label}</Text>
              </Pressable>
            );
          })}
        </View>
      ) : null}
      {current.slots && current.slots.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          {current.slots.map((id) => {
            const selected = id === activeSlot;
            const worn = !!draft.wearables[id];
            return (
              <Pressable
                key={id}
                accessibilityRole="tab"
                accessibilityState={{ selected }}
                onPress={() => setSlot({ ...slot, [tab]: id })}
                style={[styles.chip, selected && styles.chipSelected]}
              >
                <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>{categoryInfo(id).label}</Text>
                {worn && !categoryInfo(id).required ? <View style={[styles.dot, selected && styles.dotSelected]} /> : null}
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      {current.color && (tab !== 'face' || activeSlot === 'eyes') ? (
        <View style={styles.colorSection}>
          <Text style={styles.sectionLabel}>{COLOR_LABELS[current.color]}</Text>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.swatches}>
            {catalog.palettes[current.color].map((hex) => {
              const selected = draft.colors[current.color].toUpperCase() === hex.toUpperCase();
              return (
                <Pressable
                  key={hex}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  accessibilityLabel={`${COLOR_LABELS[current.color]} ${hex}`}
                  onPress={() => update({ ...draft, colors: { ...draft.colors, [current.color]: hex } })}
                  style={[styles.swatchRing, selected && { borderColor: colors.active }]}
                >
                  <View style={[styles.swatch, { backgroundColor: hex }]} />
                </Pressable>
              );
            })}
          </ScrollView>
        </View>
      ) : null}
      {activeSlot ? <Text style={styles.sectionLabel}>{categoryInfo(activeSlot).label}</Text> : null}
      {tab === 'looks' ? <Text style={styles.sectionLabel}>Start from a ready-made look, then make it yours</Text> : null}
    </View>
  );

  const faceSlot = categoryInfo(activeSlot)?.kind === 'texture';
  const renderItem = ({ item }) => {
    const selected = item.id === null ? !draft.wearables[activeSlot] : draft.wearables[activeSlot] === item.id;
    return (
      <Pressable
        accessibilityRole="radio"
        accessibilityState={{ selected }}
        accessibilityLabel={item.name}
        onPress={() => {
          if (selected) return;
          update(item.id === null ? removeItem(draft, activeSlot) : wearItem(draft, catalog, item.id));
        }}
        style={({ pressed }) => [
          styles.tile,
          { width: tileSize, height: tileSize },
          // Face features are drawn on the skin they will sit on
          faceSlot && { backgroundColor: draft.colors.skin },
          selected && styles.selectedTile,
          pressed && styles.pressed,
        ]}
      >
        {item.id === null ? (
          <Ionicons name="close" size={24} color={colors.inactive} />
        ) : (
          <Image source={fileUrl(item.thumbnail)} style={styles.tileImage} contentFit="contain" recyclingKey={item.id} transition={120} />
        )}
      </Pressable>
    );
  };

  const renderPreset = ({ item }) => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Look ${item.id}`}
      onPress={() => update({ ...item.avatar, updatedAt: draft.updatedAt })}
      style={({ pressed }) => [styles.tile, { width: tileSize, height: tileSize }, pressed && styles.pressed]}
    >
      <Image source={fileUrl(item.image)} style={styles.presetImage} contentFit="cover" recyclingKey={item.id} transition={120} />
    </Pressable>
  );

  const topInset = process.env.EXPO_OS === 'android' ? insets.top : 0;

  return (
    <View style={styles.stagePage} onLayout={onLayout}>
      <AvatarView
        avatar={draft}
        catalog={catalog}
        frame={frame}
        insets={{ top: topInset + HEADER_HEIGHT + 12, bottom: levels[level] + 8 }}
        stage={stage}
        onTap={() => {
          if (level === 0) return;
          tapFeedback();
          snap(0);
        }}
        style={StyleSheet.absoluteFill}
      />
      {/* A fade of the backdrop's colour behind the header: its words read over the
          avatar (a white shirt, a dark coat) */}
      <View
        pointerEvents="none"
        style={[styles.headerFade, {
          height: topInset + HEADER_HEIGHT + 36,
          experimental_backgroundImage: `linear-gradient(to bottom, ${rgba(stage.sky[0], 0.92)} 0%, ${rgba(stage.sky[0], 0.6)} 55%, ${rgba(stage.sky[0], 0)} 100%)`,
        }]}
      />
      <SheetHeader
        grabber={false}
        title="Avatar"
        leftLabel="Cancel"
        onLeft={close}
        rightLabel="Save"
        onRight={save}
        rightBusy={saving}
        rightDisabled={!changed}
        style={[styles.overStage, { marginTop: topInset }]}
        // Over the backdrop, whatever the app's theme: light over dark, dark over light
        textColor={isDarkColor(stage.sky[0]) ? '#FFFFFF' : '#111111'}
      />
      <Animated.View style={[styles.panel, { height: panelHeight, paddingBottom: insets.bottom }]}>
        <View {...drag.panHandlers}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={level === LEVELS.length - 1 ? 'Show more of the avatar' : 'Show more items'}
            hitSlop={{ top: 10, bottom: 4 }}
            onPress={() => {
              tapFeedback();
              snap(level === LEVELS.length - 1 ? 0 : level + 1);
            }}
            style={styles.handleArea}
          >
            <View style={styles.handle} />
          </Pressable>
          {/* A fixed height: a horizontal ScrollView sized by its content can collapse and
              let the list below draw over the tabs */}
          <View style={styles.tabBar}>
            <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.tabs}>
              {TABS.map((entry) => {
                const selected = entry.key === tab;
                return (
                  <Pressable
                    key={entry.key}
                    accessibilityRole="tab"
                    accessibilityState={{ selected }}
                    onPress={() => {
                      if (selected) return;
                      tapFeedback();
                      setTab(entry.key);
                    }}
                    style={styles.tab}
                  >
                    <Text style={[styles.tabLabel, selected && styles.tabLabelSelected]}>{entry.label}</Text>
                    {selected ? <View style={styles.tabUnderline} /> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </View>
        <FlatList
          key={`${tab}-${activeSlot}`}
          data={tab === 'looks' ? presets ?? [] : tab === 'body' ? [] : items}
          keyExtractor={(item) => String(item.id)}
          renderItem={tab === 'looks' ? renderPreset : renderItem}
          numColumns={COLUMNS}
          ListHeaderComponent={header}
          ListEmptyComponent={tab === 'looks' && !presets ? <ActivityIndicator color={colors.inactive} style={styles.listSpinner} /> : null}
          columnWrapperStyle={styles.row}
          contentContainerStyle={styles.list}
          onScrollBeginDrag={() => {
            if (level < LEVELS.length - 1) snap(LEVELS.length - 1);
          }}
          showsVerticalScrollIndicator={false}
          initialNumToRender={24}
          windowSize={7}
        />
      </Animated.View>
    </View>
  );
}

const createStyles = (colors) => StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: colors.page,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  stagePage: {
    flex: 1,
    backgroundColor: colors.surface,
  },
  headerFade: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  // Over the avatar's world the header is see-through
  overStage: {
    borderBottomWidth: 0,
    backgroundColor: 'transparent',
  },
  panel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderCurve: 'continuous',
    backgroundColor: colors.page,
    boxShadow: '0 -4px 20px rgba(0, 0, 0, 0.08)',
    overflow: 'hidden',
  },
  handleArea: {
    alignItems: 'center',
    paddingTop: 8,
    paddingBottom: 2,
  },
  handle: {
    width: 38,
    height: 5,
    borderRadius: 3,
    backgroundColor: colors.border,
  },
  tabBar: {
    height: 48,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  tabs: {
    paddingHorizontal: 12,
    height: 48,
  },
  tab: {
    paddingHorizontal: 10,
    paddingTop: 14,
    alignItems: 'center',
  },
  tabLabel: {
    fontSize: 15,
    fontWeight: '600',
    color: colors.inactive,
    paddingBottom: 12,
  },
  tabLabelSelected: {
    color: colors.active,
  },
  tabUnderline: {
    position: 'absolute',
    left: 10,
    right: 10,
    bottom: 0,
    height: 2,
    borderRadius: 1,
    backgroundColor: colors.accent,
  },
  list: {
    paddingHorizontal: 20,
    paddingBottom: 24,
  },
  row: {
    gap: 10,
    marginBottom: 10,
  },
  controls: {
    paddingTop: 16,
    paddingBottom: 6,
    gap: 14,
  },
  shapes: {
    flexDirection: 'row',
    gap: 12,
  },
  shape: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 12,
    borderRadius: 16,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: 'transparent',
    gap: 6,
  },
  shapeImage: {
    width: 72,
    height: 72,
  },
  shapeLabel: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.active,
  },
  chips: {
    gap: 8,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    height: 34,
    paddingHorizontal: 14,
    borderRadius: 17,
    backgroundColor: colors.surface,
  },
  chipSelected: {
    backgroundColor: colors.accent,
  },
  chipLabel: {
    fontSize: 14,
    fontWeight: '500',
    color: colors.active,
  },
  chipLabelSelected: {
    color: colors.onAccent,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: colors.accent,
  },
  dotSelected: {
    backgroundColor: colors.onAccent,
  },
  colorSection: {
    gap: 10,
  },
  sectionLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.inactive,
  },
  swatches: {
    gap: 8,
  },
  swatchRing: {
    width: 40,
    height: 40,
    borderRadius: 20,
    borderWidth: 2,
    borderColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatch: {
    width: 30,
    height: 30,
    borderRadius: 15,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(0,0,0,0.12)',
  },
  tile: {
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 14,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: 'transparent',
    overflow: 'hidden',
  },
  selectedTile: {
    borderColor: colors.active,
  },
  pressed: {
    opacity: 0.7,
  },
  tileImage: {
    width: '82%',
    height: '82%',
  },
  presetImage: {
    width: '100%',
    height: '100%',
  },
  listSpinner: {
    marginTop: 32,
  },
});
