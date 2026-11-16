// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo, useState } from 'react';
import { Modal, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { tapFeedback } from '../../../lib/haptics';
import { Button } from '../../../components/ui/Button';
import { GlassFill } from '../../../components/ui/GlassFill';
import { updateSetting, useSettings } from '../../settings/settingsStore';
import { useApi } from '../../api/useApi';
import { recordConsent } from '../../me/consents';
import { useMapMode } from '../state/mapVisibility';
import { APPROXIMATE_RADIUS_M, MAP_RANGE_M, useMapAudience } from '../state/mapPresence';

const MODES = {
  visible: {
    label: 'Visible',
    icon: 'eye',
    description: 'People visible to you see where you are, and you see them.',
    toast: 'You are visible to people nearby',
  },
  approximate: {
    label: 'Approximate',
    icon: 'locate',
    description: `Only your area (about ${APPROXIMATE_RADIUS_M} m) is shown, and you see others' areas.`,
    toast: 'People nearby see only your area',
  },
  invisible: {
    label: 'Invisible',
    icon: 'eye-off',
    description: 'No one sees you, and you see no one.',
    toast: 'You are invisible',
  },
};

const ORDER = ['visible', 'approximate', 'invisible'];

// How the user is on the map, switched right where it matters: a glass pill at the top
// of the map, in the same material as the tab bar, with the mode and how many people
// around can see the user (so nobody is watched without knowing). It opens the three
// modes. The first times the user shows themselves, a short explanation says what it
// means; once they say "don't show again", a line at the bottom of the map
// (onAnnounce) confirms each switch instead.
export function VisibilitySwitch({ onAnnounce }) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const [mode, setMode] = useMapMode();
  const [settings] = useSettings();
  const audience = useMapAudience(mode);
  const [menuOpen, setMenuOpen] = useState(false);
  const [explaining, setExplaining] = useState(null); // the mode being explained
  const request = useApi();
  const current = MODES[mode];
  const top = insets.top + 8;

  // Showing oneself is a consent (GDPR art. 7(1)), recorded every time, not only the
  // times the explanation is shown: going invisible withdraws it, and a later return
  // must be on record too
  const share = (next) => {
    if (next !== 'invisible') recordConsent(request, 'location-sharing', { mode: next }).catch(() => {});
    setMode(next);
  };

  const apply = (next) => {
    share(next);
    onAnnounce?.(MODES[next].toast);
  };

  const choose = (next) => {
    setMenuOpen(false);
    if (next === mode) return;
    tapFeedback();
    if (next !== 'invisible' && !settings.mapModeExplained) {
      setExplaining(next);
      return;
    }
    apply(next);
  };

  const confirm = (dontShowAgain) => {
    const next = explaining;
    setExplaining(null);
    if (dontShowAgain) updateSetting('mapModeExplained', true).catch(() => {});
    // The user agreed, having read what it means
    share(next);
  };

  const audienceLabel = audience.total === 1 ? '1 person nearby can see you' : `${audience.total} people nearby can see you`;

  return (
    <>
      <View style={[styles.position, { top }]} pointerEvents="box-none">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`On the map: ${current.label}${mode === 'invisible' ? '' : `, ${audienceLabel}`}`}
          accessibilityHint="Choose how others see you on the map"
          hitSlop={8}
          onPress={() => {
            tapFeedback();
            setMenuOpen(true);
          }}
          style={({ pressed }) => [styles.pill, pressed && styles.pressed]}
        >
          <GlassFill />
          {mode === 'invisible' ? (
            <Ionicons name="eye-off" size={15} color={colors.barMuted} />
          ) : (
            <View style={[styles.dot, { backgroundColor: mode === 'visible' ? colors.live : colors.star }]} />
          )}
          <Text style={[styles.label, mode === 'invisible' && { color: colors.barMuted }]}>{current.label}</Text>
          {mode !== 'invisible' ? (
            <View style={styles.audience} collapsable={false}>
              <Ionicons name="eye-outline" size={13} color={colors.barMuted} />
              <Text style={styles.audienceText}>{audience.total}</Text>
            </View>
          ) : null}
          <Ionicons name="chevron-down" size={13} color={colors.barMuted} />
        </Pressable>
      </View>

      <Modal visible={menuOpen} transparent animationType="fade" onRequestClose={() => setMenuOpen(false)}>
        <Pressable accessibilityLabel="Close" style={StyleSheet.absoluteFill} onPress={() => setMenuOpen(false)} />
        <View style={[styles.menu, { top: top + 44 }]} accessibilityRole="menu">
          <GlassFill />
          {ORDER.map((key, index) => {
            const option = MODES[key];
            const selected = key === mode;
            return (
              <Pressable
                key={key}
                accessibilityRole="menuitem"
                accessibilityState={{ selected }}
                onPress={() => choose(key)}
                style={({ pressed }) => [styles.option, index > 0 && styles.divider, pressed && { backgroundColor: colors.barPill }]}
              >
                <Ionicons name={option.icon} size={20} color={colors.active} style={styles.optionIcon} />
                <View style={styles.optionText}>
                  <Text style={styles.optionTitle}>{option.label}</Text>
                  <Text style={styles.optionDescription}>{option.description}</Text>
                </View>
                {/* Always there, only its colour changes: swapping it for an empty view
                    (flattened away by React Native) broke the order of the row's native
                    children and crashed the app when choosing another mode */}
                <Ionicons name="checkmark" size={20} color={selected ? colors.accent : 'transparent'} />
              </Pressable>
            );
          })}
          <Text style={styles.menuFooter}>Only people within about {MAP_RANGE_M / 1000} km, never the whole world.</Text>
        </View>
      </Modal>

      <Modal visible={!!explaining} transparent animationType="fade" onRequestClose={() => setExplaining(null)}>
        <Pressable accessibilityLabel="Cancel" style={[StyleSheet.absoluteFill, { backgroundColor: colors.scrim }]} onPress={() => setExplaining(null)} />
        {explaining ? (
          <View style={styles.dialogArea} pointerEvents="box-none">
            <View style={styles.dialog} accessibilityRole="alert">
              <GlassFill />
              <Text style={styles.dialogTitle}>{explaining === 'visible' ? 'Be visible on the map?' : 'Show your area on the map?'}</Text>
              <Point
                styles={styles}
                colors={colors}
                icon="locate-outline"
                text={explaining === 'visible'
                  ? `Only people within about ${MAP_RANGE_M / 1000} km, the map's range, see where you are. Not the whole world.`
                  : `Only people within about ${MAP_RANGE_M / 1000} km see your area, about ${APPROXIMATE_RADIUS_M} m wide. Never where you are exactly.`}
              />
              <Point
                styles={styles}
                colors={colors}
                icon="swap-horizontal-outline"
                text="Only people who are visible too can see you, and you see them the same way. The map shows 25 people at most: your connections first, then the nearest."
              />
              <Point styles={styles} colors={colors} icon="eye-off-outline" text="Go invisible any time from this button." />
              <Button label="OK" onPress={() => confirm(false)} style={styles.dialogButton} />
              <Button label="Got it, don't show again" variant="ghost" compact onPress={() => confirm(true)} />
            </View>
          </View>
        ) : null}
      </Modal>
    </>
  );
}

function Point({ styles, colors, icon, text }) {
  return (
    <View style={styles.point}>
      <Ionicons name={icon} size={18} color={colors.active} />
      <Text style={styles.pointText}>{text}</Text>
    </View>
  );
}

const createStyles = (colors) => StyleSheet.create({
  position: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    zIndex: 10,
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    height: 36,
    paddingLeft: 14,
    paddingRight: 12,
    borderRadius: 18,
    overflow: 'hidden',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.barEdge,
    boxShadow: '0 2px 10px rgba(0, 0, 0, 0.12)',
  },
  pressed: {
    opacity: 0.75,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
    color: colors.active,
  },
  audience: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingLeft: 7,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: colors.barEdge,
  },
  audienceText: {
    fontSize: 13,
    fontWeight: '600',
    fontVariant: ['tabular-nums'],
    color: colors.barMuted,
  },
  menu: {
    position: 'absolute',
    alignSelf: 'center',
    width: 320,
    maxWidth: '92%',
    borderRadius: 18,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.barEdge,
    boxShadow: '0 8px 30px rgba(0, 0, 0, 0.18)',
    overflow: 'hidden',
  },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  divider: {
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.barEdge,
  },
  optionIcon: {
    width: 22,
  },
  optionText: {
    flex: 1,
    gap: 2,
  },
  optionTitle: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.active,
  },
  optionDescription: {
    fontSize: 13,
    lineHeight: 17,
    color: colors.barMuted,
  },
  menuFooter: {
    fontSize: 12,
    color: colors.barMuted,
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.barEdge,
  },
  dialogArea: {
    flex: 1,
    justifyContent: 'center',
    padding: 24,
  },
  dialog: {
    gap: 14,
    padding: 22,
    borderRadius: 24,
    borderCurve: 'continuous',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: colors.barEdge,
    boxShadow: '0 12px 40px rgba(0, 0, 0, 0.25)',
    overflow: 'hidden',
  },
  dialogTitle: {
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: -0.3,
    color: colors.active,
    marginBottom: 2,
  },
  point: {
    flexDirection: 'row',
    gap: 12,
    alignItems: 'flex-start',
  },
  pointText: {
    flex: 1,
    fontSize: 15,
    lineHeight: 20,
    color: colors.active,
  },
  dialogButton: {
    marginTop: 6,
  },
});
