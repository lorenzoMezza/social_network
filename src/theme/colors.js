// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useColorScheme } from 'react-native';
import { DarkTheme, DefaultTheme } from 'expo-router';

// The app's palette, light and dark (ART-DIRECTION.md): clean white or night pages,
// near-black ink, and one accent, the cobalt of the map's noon sky, for actions and
// what is selected, starting soon or new. The app follows the phone's theme
// (app.json userInterfaceStyle "automatic"). The same names in both, so a screen
// only asks for useColors() and never checks the scheme itself.
const light = {
  scheme: 'light',
  page: '#FFFFFF',
  border: '#E6E6E6',
  active: '#111111',
  inactive: '#8E8E93',
  pill: '#EFEFEF',
  // Cards, fields and other surfaces on the page
  surface: '#F5F5F7',
  // The one accent: primary actions, what is selected, starting soon, unread
  accent: '#316CEE',
  onAccent: '#FFFFFF',
  // A tint of it, behind something selected that keeps its own ink
  accentSoft: 'rgba(49,108,238,0.12)',
  // Gold means paid for, here and on the map: nothing else uses it
  gold: '#92690A',
  // Edges of cards that say something: on now, sponsored
  liveEdge: 'rgba(30,158,90,0.45)',
  goldEdge: 'rgba(214,158,28,0.70)',
  // A card lifted off the page (light only: shadows do not show on dark)
  cardShadow: '0 1px 2px rgba(20, 24, 40, 0.06), 0 8px 24px rgba(20, 24, 40, 0.08)',
  // Text on top of colourful banners and photos
  onBanner: '#FFFFFF',
  scrim: 'rgba(0,0,0,0.32)',
  live: '#1E9E5A',
  star: '#F5A623',
  error: '#C62828',
  // Translucent bar over the content: a frosted layer on iOS, a veil on Android
  barBlurTint: 'systemChromeMaterialLight',
  barVeil: 'rgba(255,255,255,0.86)',
  // On the tab bar's frosted layer: its ink stays readable over anything the map shows
  barGlassVeil: 'rgba(255,255,255,0.35)',
  barAccent: '#316CEE',
  // Second-rank ink on glass (the page's grey is lost over the map's colours)
  barMuted: '#5A5A61',
  barEdge: 'rgba(0,0,0,0.08)',
  // Controls on the glass cards over the map: a tint of the glass, not a grey patch on it
  barPill: 'rgba(0,0,0,0.06)',
};

const dark = {
  scheme: 'dark',
  page: '#0E0F12',
  border: '#2A2B31',
  active: '#F2F2F4',
  inactive: '#8C8C94',
  pill: '#24252B',
  surface: '#17181C',
  accent: '#6A9BFF',
  onAccent: '#0B1230',
  accentSoft: 'rgba(106,155,255,0.18)',
  gold: '#F0C14B',
  liveEdge: 'rgba(61,214,140,0.45)',
  goldEdge: 'rgba(240,193,75,0.60)',
  cardShadow: undefined,
  onBanner: '#FFFFFF',
  scrim: 'rgba(0,0,0,0.42)',
  live: '#3DD68C',
  star: '#FFB938',
  error: '#FF6B5E',
  barBlurTint: 'systemChromeMaterialDark',
  barVeil: 'rgba(18,19,23,0.84)',
  barGlassVeil: 'rgba(18,19,23,0.35)',
  // The accent, lighter: the bar can be mid-tone over a bright map
  barAccent: '#A9C6FF',
  barMuted: '#BDBDC6',
  barEdge: 'rgba(255,255,255,0.10)',
  barPill: 'rgba(255,255,255,0.10)',
};

export function useColors() {
  return useColorScheme() === 'dark' ? dark : light;
}

// Styles built from the palette once per theme and shared by every component using
// them: for list items (cards, rows) that would otherwise each build their own copy
// when they mount. const useStyles = themedStyles((colors) => StyleSheet.create(...))
export function themedStyles(create) {
  const sheets = {};
  return function useThemedStyles() {
    const colors = useColors();
    sheets[colors.scheme] ??= create(colors);
    return sheets[colors.scheme];
  };
}

// Navigation themes in the same colours: the background behind screens during
// transitions never flashes white in dark mode
const navigationTheme = (base, palette) => ({
  ...base,
  colors: {
    ...base.colors,
    primary: palette.active,
    background: palette.page,
    card: palette.page,
    text: palette.active,
    border: palette.border,
  },
});

export const navigationThemes = {
  light: navigationTheme(DefaultTheme, light),
  dark: navigationTheme(DarkTheme, dark),
};
