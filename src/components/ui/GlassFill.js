// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { Platform, StyleSheet, View } from 'react-native';
import { BlurView } from 'expo-blur';
import { useColors } from '../../theme/colors';

// The app's one glass, for what floats over colourful content (the map, a profile's
// backdrop): frosted in the theme's material with a veil on it, so its ink stays readable
// over anything; on Android, where blurring the map's WebView is not reliable, a translucent
// veil; in a browser, the veil over a CSS blur. It fills its parent, which clips it. Not the system's liquid glass: that turns light
// or dark by what is under it while the ink follows the theme (contrast 2:1 over the map).
export function GlassFill() {
  const colors = useColors();
  // A browser blurs what is behind with CSS, the map's iframe included
  if (Platform.OS === 'web') return <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.barVeil, backdropFilter: 'blur(18px) saturate(140%)', borderRadius: 'inherit' }]} />;
  if (Platform.OS !== 'ios') return <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.barVeil }]} />;
  return (
    <>
      <BlurView tint={colors.barBlurTint} intensity={90} style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, { backgroundColor: colors.barGlassVeil }]} />
    </>
  );
}
