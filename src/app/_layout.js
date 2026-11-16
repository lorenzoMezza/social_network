// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useContext, useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';
import { Stack, ThemeProvider } from 'expo-router';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import * as Linking from 'expo-linking';
import { LogtoContext, LogtoProvider, useLogto } from '@logto/rn';
import { logtoConfig } from '../features/auth/logtoConfig';
import { useUpdateRequired } from '../features/api/appVersion';
import { useSessionExpiryCheck } from '../features/auth/useSessionExpiryCheck';
import { navigationThemes } from '../theme/colors';
import { EventsProvider } from '../features/events/state/EventsProvider';
import { AlbumsProvider } from '../features/album/state/AlbumsProvider';
import { AvatarProvider } from '../features/avatar/state/AvatarProvider';
import { SocialProvider } from '../features/social/state/SocialProvider';
import { PromotionsProvider } from '../features/promotions/state/PromotionsProvider';
import { NotificationsProvider } from '../features/notifications/state/NotificationsProvider';
import { MeProvider } from '../features/me/MeProvider';
import { RealtimeProvider } from '../features/realtime/RealtimeProvider';
import { NearbyPeopleListener } from '../features/map/state/nearbyPeople';
import { ConnectListener } from '../features/social/connect/connectInvites';
import { loadSettings } from '../features/settings/settingsStore';

// The saved theme (light, dark or the phone's) applies before the first screen
loadSettings();

// Keep the splash screen until the saved session has been read from the device
SplashScreen.preventAutoHideAsync();

// Something went wrong while drawing a screen: a way out instead of a blank page
export function ErrorBoundary({ retry }) {
  return (
    <View style={fallback.page}>
      <Text style={fallback.title}>Something went wrong</Text>
      <Text style={fallback.text}>Nothing you saved was lost. Try again, and if it keeps happening, restart the app.</Text>
      <Pressable accessibilityRole="button" onPress={retry} style={fallback.button}>
        <Text style={fallback.buttonText}>Try again</Text>
      </Pressable>
    </View>
  );
}

function UpdateRequired() {
  return (
    <View style={fallback.page}>
      <Text style={fallback.title}>Time to update</Text>
      <Text style={fallback.text}>This version of the app is no longer supported. Update it from the App Store or Google Play to carry on.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});

const fallback = StyleSheet.create({
  page: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, padding: 32, backgroundColor: '#FFFFFF' },
  title: { fontSize: 22, fontWeight: '700', color: '#111111', textAlign: 'center' },
  text: { fontSize: 15, color: '#555555', textAlign: 'center' },
  button: { marginTop: 8, paddingHorizontal: 20, paddingVertical: 12, borderRadius: 14, backgroundColor: '#111111' },
  buttonText: { fontSize: 15, fontWeight: '600', color: '#FFFFFF' },
});

// The app follows the phone's light or dark theme (app.json userInterfaceStyle)
export default function RootLayout() {
  const scheme = useColorScheme() === 'dark' ? 'dark' : 'light';

  return (
    <GestureHandlerRootView style={styles.root}>
      <LogtoProvider config={logtoConfig}>
        <ThemeProvider value={navigationThemes[scheme]}>
          <RootNavigator />
        </ThemeProvider>
        <StatusBar style="auto" />
      </LogtoProvider>
    </GestureHandlerRootView>
  );
}

// Signed-in users only reach the tabs, everyone else only the sign-in screen.
// When the session ends (sign-out or expiry) the guard flips and the sign-in screen opens.
function RootNavigator() {
  const { isInitialized, isAuthenticated, client } = useLogto();
  const { setIsAuthenticated } = useContext(LogtoContext);
  const redirectRecovery = useRef(null);
  const [startupReady, setStartupReady] = useState(false);
  const updateRequired = useUpdateRequired();
  useSessionExpiryCheck();

  useEffect(() => {
    if (!isInitialized) return undefined;
    let mounted = true;

    if (!redirectRecovery.current) {
      redirectRecovery.current = (async () => {
        if (Platform.OS === 'web') return;
        const initialUrl = await Linking.getInitialURL();
        if (initialUrl && await client.isSignInRedirected(initialUrl)) {
          await client.handleSignInCallback(initialUrl);
          setIsAuthenticated(true);
        }
      })().catch((error) => {
        console.warn('Could not resume sign-in from the initial link:', error);
      });
    }

    redirectRecovery.current.then(() => {
      if (mounted) setStartupReady(true);
    });
    return () => { mounted = false; };
  }, [client, isInitialized, setIsAuthenticated]);

  useEffect(() => {
    if (isInitialized && startupReady) SplashScreen.hide();
  }, [isInitialized, startupReady]);

  // Nothing under the splash screen until the saved session is known: the navigator
  // then starts on the right side of the guard. Mounted earlier, it starts on the
  // sign-in screen and slides to the tabs as the splash goes, a flash at every start.
  if (!isInitialized || !startupReady) return null;
  if (updateRequired) return <UpdateRequired />;

  return (
    <MeProvider>
    <RealtimeProvider>
    {/* The people around, from the moment the connection opens */}
    <NearbyPeopleListener />
    {/* What this phone can do to connect, and invitations to connect */}
    <ConnectListener />
    <EventsProvider>
      <AlbumsProvider>
      <AvatarProvider>
      <SocialProvider>
      <PromotionsProvider>
      <NotificationsProvider>
      <Stack screenOptions={{ headerShown: false }}>
        <Stack.Protected guard={isAuthenticated}>
          <Stack.Screen name="(tabs)" />
          {/* Event screens cover the tab bar: the details have their own action bar */}
          <Stack.Screen name="event/[id]" />
          <Stack.Screen name="event-editor" options={{ presentation: 'modal' }} />
          {/* Made from a long press on the map: the map stays in view above */}
          <Stack.Screen name="flash-event" options={sheet([0.72, 1])} />
          <Stack.Screen name="event-filters" options={sheet([0.85, 1], { fixedBottom: true })} />
          <Stack.Screen name="event-rating" options={sheet([0.7, 1])} />
          <Stack.Screen name="event-report" options={sheet([0.75, 1])} />
          {/* Half height: the event's page stays in view above, changing live */}
          <Stack.Screen name="event-style" options={sheet([0.5, 0.9])} />
          {/* The event's page stays in view above */}
          <Stack.Screen name="event-promote" options={sheet([0.75, 1])} />
          {/* Photos cover the tab bar; one photo opens full screen, on black */}
          <Stack.Screen name="album/[id]" />
          <Stack.Screen name="album-photo" options={{ presentation: 'transparentModal', animation: 'fade' }} />
          <Stack.Screen name="album-settings" options={sheet([0.7, 1])} />
          <Stack.Screen name="user/[id]" />
          <Stack.Screen name="organized/[id]" />
          <Stack.Screen name="people/[id]" />
          {/* Chats cover the tab bar: their composer sits at the bottom */}
          <Stack.Screen name="chat/[id]" />
          <Stack.Screen name="chat-info/[id]" />
          <Stack.Screen name="new-group" options={sheet([0.92])} />
          {/* Opens on the middle step; ConnectScreen sets it to the height of its content */}
          <Stack.Screen name="connect" options={{ ...sheet(CONNECT_DETENTS), sheetInitialDetentIndex: 1 }} />
          <Stack.Screen name="report-user" options={sheet([0.92, 1])} />
          <Stack.Screen name="blocked" />
          {/* Swiping down would throw away the changes: Cancel asks first */}
          <Stack.Screen name="avatar-editor" options={{ presentation: 'modal', gestureEnabled: false }} />
          {/* Half height: the profile and its avatar stay in view above, changing live */}
          <Stack.Screen name="profile-style" options={sheet([0.48, 0.85])} />
          {/* Over the profile: the story changes under it */}
          <Stack.Screen name="story-settings" options={sheet([0.62, 1])} />
          <Stack.Screen name="licenses" />
          <Stack.Screen name="notifications" />
        </Stack.Protected>
        <Stack.Protected guard={!isAuthenticated}>
          <Stack.Screen name="sign-in" options={{ animation: 'fade' }} />
        </Stack.Protected>
        {/* Privacy policy, terms, guidelines: readable before signing in too */}
        <Stack.Screen name="legal/[doc]" />
      </Stack>
      </NotificationsProvider>
      </PromotionsProvider>
      </SocialProvider>
      </AvatarProvider>
      </AlbumsProvider>
    </EventsProvider>
    </RealtimeProvider>
    </MeProvider>
  );
}

const CONNECT_DETENTS = [0.5, 0.82, 1];

// Short forms slide up as a sheet, dragged by its top (Android: at most 3 detents,
// no grabber, the sheet stays below the status bar). On Android the content is as tall
// as the largest detent, so at a smaller one its bottom is out of view until dragged
// up: `fixedBottom` (controls pinned at the bottom) keeps it to its first detent there.
const sheet = (detents, { fixedBottom = false } = {}) => ({
  presentation: 'formSheet',
  sheetAllowedDetents: fixedBottom && process.env.EXPO_OS === 'android' ? detents.slice(0, 1) : detents,
  sheetGrabberVisible: true,
  sheetCornerRadius: 24,
});
