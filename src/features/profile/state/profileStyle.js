// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useMemo } from 'react';
import { useMe } from '../../me/MeProvider';

// How a profile looks: the world around the avatar (backdrop, what it stands on, an
// effect), how the avatar greets and the accent of the page, which follows the
// backdrop. Part of every profile on the server (ProfileStyle, docs/API.md).
export const BACKDROPS = [
  { id: 'studio', label: 'Studio', sky: ['#F3F4F8', '#D8DBE6'], floor: '#E6E8F0', light: '#FFFFFF', rim: '#BFD0FF', accent: '#4B5BD6' },
  { id: 'sunset', label: 'Sunset', sky: ['#FFC08A', '#FF6F91'], floor: '#FF9AA6', light: '#FFE6CC', rim: '#FF4F9A', accent: '#F2546B' },
  { id: 'ocean', label: 'Ocean', sky: ['#8EDCFF', '#3B78FF'], floor: '#66A6FF', light: '#EAF7FF', rim: '#2EE6FF', accent: '#2F7BFF' },
  { id: 'forest', label: 'Forest', sky: ['#C7F5A8', '#3CB37C'], floor: '#66C892', light: '#FFF6DA', rim: '#C2FF6B', accent: '#1F9D63' },
  { id: 'candy', label: 'Candy', sky: ['#FFD6F6', '#C3A3FF'], floor: '#E3C2FF', light: '#FFF2FB', rim: '#FF86D9', accent: '#A855F7' },
  { id: 'lemon', label: 'Lemon', sky: ['#FFF6B0', '#FFC24D'], floor: '#FFD670', light: '#FFFFFF', rim: '#FF9A1F', accent: '#E08A00' },
  { id: 'night', label: 'Night', sky: ['#33397A', '#0E1030'], floor: '#272C66', light: '#D3DCFF', rim: '#8A9BFF', accent: '#6E7FF5' },
  { id: 'ember', label: 'Ember', sky: ['#5A2236', '#1C0B14'], floor: '#4A1C2E', light: '#FFD9C2', rim: '#FF6A3D', accent: '#F06A3D' },
];
export const PEDESTALS = [
  { id: 'none', label: 'Floor', icon: 'remove-outline' },
  { id: 'disc', label: 'Pedestal', icon: 'ellipse' },
  { id: 'ring', label: 'Halo', icon: 'ellipse-outline' },
];
export const EFFECTS = [
  { id: 'none', label: 'None', icon: 'close' },
  { id: 'sparkles', label: 'Sparkles', icon: 'sparkles-outline' },
  { id: 'bubbles', label: 'Bubbles', icon: 'water-outline' },
  { id: 'fireflies', label: 'Fireflies', icon: 'bulb-outline' },
  { id: 'notes', label: 'Notes', icon: 'musical-notes-outline' },
  { id: 'hearts', label: 'Hearts', icon: 'heart-outline' },
  { id: 'confetti', label: 'Confetti', icon: 'balloon-outline' },
  { id: 'petals', label: 'Petals', icon: 'flower-outline' },
];
// A line around the avatar's silhouette, or none
export const OUTLINES = [
  { id: 'outline', label: 'Outline', icon: 'scan-outline' },
  { id: 'none', label: 'None', icon: 'close' },
];
// The emote the avatar greets with when its profile opens (and when tapped, on
// someone else's): the emotes of the avatar catalog (avatar-server build-library.mjs)
export const GREETINGS = [
  { id: 'wave', label: 'Wave', icon: 'hand-left-outline' },
  { id: 'fistpump', label: 'Fist pump', icon: 'trophy-outline' },
  { id: 'handsair', label: 'Hands up', icon: 'happy-outline' },
  { id: 'dab', label: 'Dab', icon: 'body-outline' },
  { id: 'dontsee', label: 'Don’t look', icon: 'eye-off-outline' },
  { id: 'punch', label: 'Punch', icon: 'flash-outline' },
  { id: 'shrug', label: 'Shrug', icon: 'help-outline' },
];
const DEFAULT_STYLE = { backdrop: 'ocean', pedestal: 'disc', effect: 'sparkles', greeting: 'wave', outline: 'outline' };

// A stored style made valid for this version of the app: effects that were merged
// into others or removed take their heir (stars → sparkles, snow and lanterns → notes), unknown
// values the default
const RENAMED_EFFECTS = { stars: 'sparkles', snow: 'notes', lanterns: 'notes' };
function cleanStyle(style) {
  const effect = RENAMED_EFFECTS[style?.effect] ?? style?.effect;
  return {
    ...DEFAULT_STYLE,
    ...style,
    effect: EFFECTS.some((entry) => entry.id === effect) ? effect : DEFAULT_STYLE.effect,
  };
}

// The theme the avatar viewer draws (webview/avatar/src/stage.js), and the accent
export function stageOf(rawStyle) {
  const style = cleanStyle(rawStyle);
  const backdrop = BACKDROPS.find((entry) => entry.id === style?.backdrop) ?? BACKDROPS[0];
  return {
    theme: { sky: backdrop.sky, floor: backdrop.floor, light: backdrop.light, rim: backdrop.rim, pedestal: style?.pedestal ?? 'none', effect: style?.effect ?? 'none', outline: style?.outline !== 'none' },
    backdrop,
    accent: backdrop.accent,
    greeting: GREETINGS.find((entry) => entry.id === style?.greeting)?.id ?? 'wave',
  };
}

// The accent of a profile's backdrop (null for none or an unknown one): someone's own
// colour, on the map too (their name's dot and rings)
export const backdropAccent = (id) => BACKDROPS.find((entry) => entry.id === id)?.accent ?? null;

// Whether a colour (#RRGGBB) is dark: text and the status bar over it turn light
export function isDarkColor(hex) {
  const value = parseInt(hex.slice(1), 16);
  return ((value >> 16) * 0.299 + ((value >> 8) & 255) * 0.587 + (value & 255) * 0.114) < 140;
}

// The user's own style (MeProvider: Me.style on the server), shared by every screen
// that shows it (profile, its editor, the avatar editor); each change is saved at once
export function useOwnProfileStyle() {
  const { me, update } = useMe();
  const raw = me?.style;
  const style = useMemo(() => cleanStyle(raw), [raw]);
  const change = useCallback((changes) => {
    update({ style: changes }).catch(() => {});
  }, [update]);
  return [style, change];
}
