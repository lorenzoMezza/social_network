// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { LogtoNativeClientError, useLogto } from '@logto/rn';
import { LOGTO_REDIRECT_URI } from './logtoConfig';
import { useColors } from '../../theme/colors'; 

// How each button opens Logto. `directSignIn` skips the Logto page and goes straight to
// the social provider (its target is shown in Logto Console > Connectors); if the
// connector is missing, Logto shows its normal sign-in page instead.
const SIGN_IN_OPTIONS = {
  google: { directSignIn: { method: 'social', target: 'google' } },
  register: { firstScreen: 'register' },
  signIn: { firstScreen: 'sign_in' },
};

// Shown only when nobody is signed in. Credentials are typed on the Logto pages, opened in
// the system browser (Authorization Code + PKCE): the app never sees the password.
export function SignInScreen() {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { signIn } = useLogto();
  const [pendingOption, setPendingOption] = useState(null);
  const [errorMessage, setErrorMessage] = useState(null);

  const start = async (option) => {
    setPendingOption(option);
    setErrorMessage(null);
    try {
      await signIn({ redirectUri: LOGTO_REDIRECT_URI, ...SIGN_IN_OPTIONS[option] });
      // On success the root layout replaces this screen with the app
    } catch (error) {
      // The user closed the browser: nothing went wrong
      if (!(error instanceof LogtoNativeClientError && error.code === 'auth_session_failed')) {
        console.warn('Sign-in failed:', error);
        setErrorMessage('Sign-in failed. Check your connection and try again.');
      }
      setPendingOption(null);
    }
  };

  const buttonProps = (option) => ({
    loading: pendingOption === option,
    disabled: pendingOption !== null,
    onPress: () => start(option),
  });

  return (
    <View style={[styles.page, { paddingTop: insets.top, paddingBottom: Math.max(insets.bottom, 24) }]}>
      <View style={styles.hero}>
        <View style={styles.logo}>
          <Ionicons name="map" size={36} color={colors.onAccent} />
        </View>
        <Text style={styles.title} accessibilityRole="header">Enjoy your free time.</Text>
        <Text style={styles.subtitle}>Discover events and people around you.</Text>
      </View>

      <View style={styles.actions}>
        {errorMessage ? (
          <Text style={styles.error} accessibilityLiveRegion="polite">{errorMessage}</Text>
        ) : null}
        <AuthButton label="Continue with Google" icon="logo-google" variant="outline" styles={styles} colors={colors} {...buttonProps('google')} />

        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerLabel}>or</Text>
          <View style={styles.dividerLine} />
        </View>

        <AuthButton label="Create account" variant="primary" styles={styles} colors={colors} {...buttonProps('register')} />
        <AuthButton label="Sign in" variant="secondary" styles={styles} colors={colors} {...buttonProps('signIn')} />
        {/* What continuing means, in one line: no extra step */}
        <Text style={styles.legal}>
          By continuing you accept the{' '}
          <Text style={styles.legalLink} accessibilityRole="link" onPress={() => router.push('/legal/terms')}>Terms of use</Text>
          {' '}and the{' '}
          <Text style={styles.legalLink} accessibilityRole="link" onPress={() => router.push('/legal/guidelines')}>Community guidelines</Text>
          {' '}and confirm you are 18 or older. The{' '}
          <Text style={styles.legalLink} accessibilityRole="link" onPress={() => router.push('/legal/privacy')}>Privacy policy</Text>
          {' '}explains how we use your data.
        </Text>
      </View>
    </View>
  );
}

function AuthButton({ label, icon, variant, loading, disabled, onPress, styles, colors }) {
  const textColor = variant === 'primary' ? colors.onAccent : colors.active;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, busy: loading }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        styles[variant],
        (pressed || (disabled && !loading)) && styles.buttonDimmed,
      ]}
    >
      {loading ? (
        <ActivityIndicator color={textColor} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={20} color={textColor} /> : null}
          <Text style={[styles.buttonLabel, { color: textColor }]}>{label}</Text>
        </>
      )}
    </Pressable>
  );
}

const createStyles = (colors) => StyleSheet.create({
  page: {
    flex: 1,
    paddingHorizontal: 24,
    backgroundColor: colors.page,
  },
  hero: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 12,
  },
  logo: {
    width: 72,
    height: 72,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
    backgroundColor: colors.accent,
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: colors.active,
    textAlign: 'center',
  },
  subtitle: {
    fontSize: 16,
    color: colors.inactive,
    textAlign: 'center',
  },
  actions: {
    gap: 12,
  },
  legal: {
    fontSize: 12,
    lineHeight: 17,
    color: colors.inactive,
    textAlign: 'center',
    marginTop: 4,
  },
  legalLink: {
    color: colors.active,
    textDecorationLine: 'underline',
  },
  error: {
    fontSize: 14,
    color: colors.error,
    textAlign: 'center',
  },
  divider: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    marginVertical: 4,
  },
  dividerLine: {
    flex: 1,
    height: StyleSheet.hairlineWidth,
    backgroundColor: colors.border,
  },
  dividerLabel: {
    fontSize: 13,
    color: colors.inactive,
  },
  button: {
    height: 52,
    borderRadius: 26,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 10,
  },
  primary: {
    backgroundColor: colors.accent,
  },
  secondary: {
    backgroundColor: colors.pill,
  },
  outline: {
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.page,
  },
  buttonDimmed: {
    opacity: 0.6,
  },
  buttonLabel: {
    fontSize: 16,
    fontWeight: '600',
  },
});
