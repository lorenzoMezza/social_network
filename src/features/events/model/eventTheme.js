// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import { EVENT_COLORS } from './categories';

// How an organizer dresses their event (Event.theme; its pictures are Event.imageUrls).
// Every choice is optional: an event without a theme looks like any other.
//   color: its page and its tile in lists; beam, beamStyle: its light on the map; emoji:
//   its symbol everywhere; background and title: its page.
//   { color, beam, beamStyle: 'beam'|'pulse'|'helix'|'stardust'|'veil', emoji,
//     background: 'plain'|'glow'|'tint'|'aurora'|'pattern', title: 'classic'|'bold'|'serif'|'mono' }

export const THEME_COLORS = EVENT_COLORS;

// The beam's colours: bright, they are light. No gold nor yellow: on the map gold means
// sponsored and nothing else
export const BEAM_COLORS = [
  { color: '#FF5C5C', label: 'Red' },
  { color: '#FF5FA2', label: 'Pink' },
  { color: '#A46BFF', label: 'Violet' },
  { color: '#4DA3FF', label: 'Blue' },
  { color: '#22D3C5', label: 'Teal' },
  { color: '#5CD66B', label: 'Green' },
  { color: '#FF7A3D', label: 'Orange' },
];
// How the beam looks on the map (eventBeacons.js) and in the style sheet (BeamPreview.js)
export const BEAM_STYLES = [
  { id: 'beam', label: 'Beam' },
  { id: 'pulse', label: 'Pulse' },
  { id: 'helix', label: 'Helix' },
  { id: 'stardust', label: 'Stardust' },
  { id: 'veil', label: 'Veil' },
];
export const beamStyle = (theme) => (BEAM_STYLES.some((entry) => entry.id === theme?.beamStyle) ? theme.beamStyle : 'beam');
export const beamColor = (theme) => (BEAM_COLORS.some((entry) => entry.color === theme?.beam) ? theme.beam : null);
// The gold of sponsored events on the map (eventBeacons.js)
export const SPONSORED_BEAM = '#FFB300';

// Symbols for an event, in place of its category's icon
export const THEME_EMOJIS = [
  '🎉', '🥳', '🎂', '🍕', '🍔', '🍣', '🍦', '🍹', '🍷', '🍺', '☕', '🎵', '🎸', '🎧', '🎤', '💃', '🪩',
  '⚽', '🏀', '🎾', '🏐', '🏃', '🚴', '🧘', '🏄', '⛰️', '🎮', '🎲', '♟️', '📸', '🎨', '🎭', '🎬', '📚',
  '💻', '🌳', '🌸', '🌻', '🏖️', '🧺', '🐶', '🛍️', '👗', '🔥', '🌙', '⭐', '✨', '❤️', '🌈',
];

export const THEME_BACKGROUNDS = [
  { id: 'plain', label: 'Plain', icon: 'square-outline' },
  { id: 'glow', label: 'Glow', icon: 'sunny-outline' },
  { id: 'tint', label: 'Tinted', icon: 'color-fill-outline' },
  { id: 'aurora', label: 'Aurora', icon: 'color-palette-outline' },
  { id: 'pattern', label: 'Pattern', icon: 'apps-outline' },
];

export const THEME_TITLES = [
  { id: 'classic', label: 'Classic' },
  { id: 'bold', label: 'Bold' },
  { id: 'serif', label: 'Elegant' },
  { id: 'mono', label: 'Typewriter' },
];

// Only known values: what a server or an old version sends never breaks the page
export function cleanTheme(theme) {
  return {
    color: THEME_COLORS.includes(theme?.color) ? theme.color : null,
    beam: beamColor(theme),
    beamStyle: beamStyle(theme),
    emoji: THEME_EMOJIS.includes(theme?.emoji) ? theme.emoji : null,
    background: THEME_BACKGROUNDS.some((entry) => entry.id === theme?.background) ? theme.background : 'plain',
    title: THEME_TITLES.some((entry) => entry.id === theme?.title) ? theme.title : 'classic',
  };
}

// The theme to send: null when nothing was chosen
export function themeToSave(theme) {
  const clean = cleanTheme(theme);
  const chosen = clean.color || clean.beam || clean.beamStyle !== 'beam' || clean.emoji || clean.background !== 'plain' || clean.title !== 'classic';
  return chosen ? clean : null;
}

// The title's type, per style. The fonts are the phone's own (no download)
export function titleFont(title) {
  switch (title) {
    case 'bold':
      return { fontWeight: '900', fontSize: 32, letterSpacing: -1, lineHeight: 36 };
    case 'serif':
      return { fontFamily: Platform.select({ ios: 'Georgia', default: 'serif' }), fontWeight: '700', letterSpacing: -0.3 };
    case 'mono':
      return { fontFamily: Platform.select({ ios: 'Menlo', default: 'monospace' }), fontWeight: '700', fontSize: 25, letterSpacing: -0.8 };
    default:
      return null;
  }
}

// `color` laid over `base` at `amount` (0-1), as a solid hex: a tinted page stays
// opaque, so the bars on it can share its colour
function mixColors(base, color, amount) {
  const channels = (hex) => [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16));
  const a = channels(base);
  const b = channels(color);
  return `#${a.map((value, index) => Math.round(value + (b[index] - value) * amount).toString(16).padStart(2, '0')).join('')}`;
}

export const withAlpha = (hex, alpha) => `${hex}${Math.round(alpha * 255).toString(16).padStart(2, '0')}`;

// The colour turned round the colour wheel by `degrees` (same lightness and
// saturation): the second colour of the aurora background
export function shiftHue(hex, degrees) {
  const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const light = (max + min) / 2;
  const delta = max - min;
  if (!delta) return hex;
  const saturation = delta / (1 - Math.abs(2 * light - 1));
  let hue = max === r ? ((g - b) / delta) % 6 : max === g ? (b - r) / delta + 2 : (r - g) / delta + 4;
  hue = (hue * 60 + degrees + 360) % 360;
  const chroma = (1 - Math.abs(2 * light - 1)) * saturation;
  const x = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = light - chroma / 2;
  const [r1, g1, b1] = hue < 60 ? [chroma, x, 0] : hue < 120 ? [x, chroma, 0] : hue < 180 ? [0, chroma, x]
    : hue < 240 ? [0, x, chroma] : hue < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return `#${[r1, g1, b1].map((value) => Math.round((value + m) * 255).toString(16).padStart(2, '0')).join('')}`;
}

// The page's own background: the app's, or tinted with the event's colour (`tone`)
export function pageColor(theme, tone, colors) {
  if (theme?.background !== 'tint') return colors.page;
  return mixColors(colors.page, tone, colors.scheme === 'dark' ? 0.14 : 0.08);
}

// The look being tried in the style sheet, shown on the event's page under it before
// it is saved: { [eventId]: { theme } }
let previews = {};
const listeners = new Set();
const subscribe = (listener) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export function setThemePreview(eventId, preview) {
  previews = { ...previews };
  if (preview) previews[eventId] = preview;
  else delete previews[eventId];
  for (const listener of listeners) listener();
}

export function useThemePreview(eventId) {
  return useSyncExternalStore(subscribe, () => previews[eventId] ?? null);
}
