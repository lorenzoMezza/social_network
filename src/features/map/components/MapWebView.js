// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { Animated, Platform, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView } from 'react-native-webview';
import { Asset } from 'expo-asset';
import { devHost } from '../../../lib/devHost';
import { API_URL } from '../../api/apiConfig';
import { useNetworkRecovery } from '../../api/useNetworkRecovery';
import { localPageOnly } from '../../../lib/localPageOnly';
import { AvatarLoader } from '../../../components/ui/AvatarLoader';
import { useColors } from '../../../theme/colors';
import { useDisplayLimit } from '../hooks/useDisplayLimit';
import { SHOWCASE, useShowcaseDirector } from '../../../showcase/useShowcaseDirector';

// How long the cover takes to fade once the scene can be seen (ms)
const COVER_FADE_MS = 200;
// The page loaded but never said it is ready (its script failed, no WebGL…): loaded again
const MAP_READY_TIMEOUT_MS = 20_000;
// Waits before trying again what failed (the page file, the page): ever longer, up to the last
const retryDelay = (failures) => Math.min(30_000, 1000 * 2 ** Math.min(failures, 5));

// The map's only tile source: tile-provider/'s TileJSON, served by the computer
// running Expo in development (tile-provider/scripts/serve.mjs)
const TILES_PORT = 8093;
const tileUrl = process.env.EXPO_PUBLIC_TILE_URL
  || (devHost ? `http://${devHost}:${TILES_PORT}/tiles.json` : null);

// When this code first ran, for the developer overlay (how long the app takes before the page)
const APP_STARTED = Date.now();

const loadMapWebViewHtmlContent = async () => {
  try {
    const htmlFile = Asset.fromModule(require('../../../../assets/webview/map.html'));
    await htmlFile.downloadAsync();

    // The tile source in the page's URL, read before any script of the page runs
    // (webview/map/src/config.js): an injected script may come too late on Android
    const page = htmlFile.localUri;
    const query = [tileUrl && `tiles=${encodeURIComponent(tileUrl)}`, __DEV__ && `appStarted=${APP_STARTED}`].filter(Boolean).join('&');
    return { page, uri: query ? `${page}?${query}` : page };
  } catch (error) {
    console.error('Error loading HTML Asset:', error);
    throw error;
  }
};

// Fills the whole page area: with the tabs it ends right above the bar.
// onEventTap(id): an event's beacon was tapped; onMapTap(): the map anywhere else;
// onLongPress({ latitude, longitude, player }): a finger held on the map (player: where
// the avatar stands, { latitude, longitude }); onPersonTap(userId):
// someone nearby (their figure or their name); onPlayerTap(): the user's own avatar.
export const MapWebView = memo(forwardRef(function MapWebView({ onReady, onEventTap, onMapTap, onLongPress, onPersonTap, onPlayerTap }, forwardedRef) {
  const webViewRef = useRef(null);
  const insets = useSafeAreaInsets();
  const [mapWebViewHtmlContent, setMapWebViewHtmlContent] = useState(null);
  const colors = useColors();
  // Over the map until the scene can be seen as it is (the page's `view-ready`: the map, the
  // user's own avatar and the sky drawn): the user never watches an avatar being put together.
  // Back on when the page reloads (a crashed WebView process).
  const [coverShown, setCoverShown] = useState(true);
  const [cover] = useState(() => new Animated.Value(1));
  const showCover = useCallback(() => {
    cover.stopAnimation();
    cover.setValue(1);
    setCoverShown(true);
  }, [cover]);
  const liftCover = useCallback(() => {
    Animated.timing(cover, { toValue: 0, duration: COVER_FADE_MS, useNativeDriver: true }).start(({ finished }) => {
      if (finished) setCoverShown(false);
    });
  }, [cover]);
  const isMapReady = useRef(false);
  // Pages that failed in a row, and the timers of the next try and of the ready check
  const pageFailures = useRef(0);
  const reloadTimer = useRef(null);
  const readyTimer = useRef(null);
  const pendingPosition = useRef(null);
  const pendingProvisional = useRef(null);
  const isActive = useRef(false);
  // The user's avatar: kept until the page is ready, sent again when it reloads
  const pendingAvatar = useRef(null);
  // The same for the events, the event in view and the place of a new event
  const pendingEvents = useRef([]);
  const pendingFocus = useRef(null);
  const pendingDraft = useRef(null);
  // The people around, their looks (userId → render plan) and the one selected
  const pendingPeople = useRef([]);
  const pendingLooks = useRef(new Map());
  const pendingStandIn = useRef(null);
  const pendingPerson = useRef(null);
  const pendingKept = useRef(null);
  // The live weather (useMapWeather): { data, fetchedAt }
  const pendingWeather = useRef(null);
  // The handlers of the parent, read when a message arrives (no WebView re-render)
  const handlers = useRef({});
  handlers.current = { onEventTap, onMapTap, onLongPress, onPersonTap, onPlayerTap };

  const run = useCallback((script) => {
    if (isMapReady.current) webViewRef.current?.injectJavaScript(`${script}; true;`);
  }, []);
  // Showcase mode only: scripts from the director of a recording (src/showcase)
  useShowcaseDirector(run);

  const setEvents = useCallback((events) => {
    pendingEvents.current = events;
    run(`window.setMapEvents?.(${JSON.stringify(events)})`);
  }, [run]);

  const focusEvent = useCallback((id) => {
    pendingFocus.current = id ?? null;
    run(`window.focusMapEvent?.(${JSON.stringify(id ?? null)})`);
  }, [run]);

  const setDraftPin = useCallback((point) => {
    pendingDraft.current = point ?? null;
    run(`window.setMapDraftPin?.(${JSON.stringify(point ?? null)})`);
  }, [run]);

  const setPeople = useCallback((people) => {
    pendingPeople.current = people;
    // A look is kept only for someone still on the map
    const ids = new Set();
    for (const person of people) ids.add(person.id);
    for (const id of pendingLooks.current.keys()) if (!ids.has(id)) pendingLooks.current.delete(id);
    run(`window.setMapPeople?.(${JSON.stringify(people)})`);
  }, [run]);

  // Someone's map avatar: its files ({ model, astc, png }, avatarApi.mapAvatarFiles)
  const setPersonAvatar = useCallback((id, files) => {
    pendingLooks.current.set(id, files);
    run(`window.setPersonAvatar?.(${JSON.stringify(id)}, ${JSON.stringify(files)})`);
  }, [run]);

  // The map avatar people wear until theirs has arrived
  const setPeopleStandIn = useCallback((files) => {
    pendingStandIn.current = files ?? null;
    if (files) run(`window.setPeopleStandIn?.(${JSON.stringify(files)})`);
  }, [run]);

  // The map avatars of the user's connections ([files]): kept on the device first
  const keepPeopleAvatars = useCallback((list) => {
    pendingKept.current = list;
    run(`window.keepPeopleAvatars?.(${JSON.stringify(list)})`);
  }, [run]);

  const setWeather = useCallback((weather) => {
    pendingWeather.current = weather;
    run(`window.setMapWeather?.(${JSON.stringify(weather)})`);
  }, [run]);

  const selectPerson = useCallback((id) => {
    pendingPerson.current = id ?? null;
    run(`window.setSelectedPerson?.(${JSON.stringify(id ?? null)})`);
  }, [run]);

  // Moments, not state: lost if the page is not ready (nobody would see them)
  const playGesture = useCallback((gesture) => {
    run(`window.playMapGesture?.(${JSON.stringify(gesture)})`);
  }, [run]);

  const showBubble = useCallback((bubble) => {
    run(`window.showMapBubble?.(${JSON.stringify(bubble)})`);
  }, [run]);

  const setPlayerAvatar = useCallback((plan) => {
    pendingAvatar.current = plan ?? null;
    if (!plan || !isMapReady.current || !webViewRef.current) return;
    webViewRef.current.injectJavaScript(`window.setPlayerAvatar?.(${JSON.stringify(plan)}); true;`);
  }, []);

  // Before the first GPS fix, for drawing only (usePlayerLocation)
  const setProvisionalLocation = useCallback((position) => {
    pendingProvisional.current = position;
    run(`window.setMapProvisionalLocation?.(${JSON.stringify(position)})`);
  }, [run]);

  const setPlayerLocation = useCallback((position) => {
    pendingPosition.current = position;
    if (!isMapReady.current || !webViewRef.current) return;
    // The fused state (usePlayerLocation): walking from the phone's steps
    const payload = JSON.stringify({
      latitude: position.latitude,
      longitude: position.longitude,
      heading: position.heading,
      speed: position.speed,
      accuracy: position.accuracy,
      timestamp: position.timestamp,
      moving: position.moving,
      velocity: position.velocity,
      cadence: position.cadence,
      steps: position.steps,
    });
    webViewRef.current.injectJavaScript(`window.updatePlayerLocation?.(${payload}); true;`);
  }, []);

  const syncMapActivity = useCallback(() => {
    if (!isMapReady.current || !webViewRef.current) return;
    webViewRef.current.injectJavaScript(`window.setMapActive?.(${JSON.stringify(isActive.current)}); true;`);
  }, []);

  const setActive = useCallback((active) => {
    isActive.current = active;
    syncMapActivity();
  }, [syncMapActivity]);

  useImperativeHandle(
    forwardedRef,
    () => ({ setPlayerLocation, setProvisionalLocation, setActive, setPlayerAvatar, setEvents, focusEvent, setDraftPin, setPeople, setPersonAvatar, setPeopleStandIn, keepPeopleAvatars, selectPerson, playGesture, showBubble, setWeather }),
    [setActive, setPlayerLocation, setProvisionalLocation, setPlayerAvatar, setEvents, focusEvent, setDraftPin, setPeople, setPersonAvatar, setPeopleStandIn, keepPeopleAvatars, selectPerson, playGesture, showBubble, setWeather],
  );

  // The page is copied out of the app once; a failure (the phone short of space) is
  // tried again for as long as it takes, the cover staying up meanwhile
  useEffect(() => {
    let alive = true;
    let retry = null;
    const load = (attempt) => loadMapWebViewHtmlContent()
      .then((content) => {
        if (alive) setMapWebViewHtmlContent(content);
      })
      .catch((error) => {
        console.error('Unable to load map WebView asset:', error);
        if (alive) retry = setTimeout(() => load(attempt + 1), retryDelay(attempt));
      });
    load(0);
    return () => {
      alive = false;
      clearTimeout(retry);
    };
  }, []);

  // The page loaded again: after a failure, a little later each time (the cover stays up)
  const reloadPage = useCallback((why) => {
    clearTimeout(readyTimer.current);
    if (reloadTimer.current) return;
    console.warn(`Map page reloaded: ${why}`);
    reloadTimer.current = setTimeout(() => {
      reloadTimer.current = null;
      webViewRef.current?.reload();
    }, retryDelay(pageFailures.current++));
  }, []);
  useEffect(() => () => {
    clearTimeout(reloadTimer.current);
    clearTimeout(readyTimer.current);
  }, []);

  // What the phone's display can show (Low Power Mode: 30 frames a second): the map
  // judges its own speed against it, not against a frame rate it cannot reach. Told
  // when it changes, and again to a page that just loaded
  const displayLimit = useDisplayLimit();
  const sentDisplayLimit = useRef(null);
  const tellDisplayLimit = useCallback(() => {
    run(`window.setMapDisplayLimit?.(${JSON.stringify(sentDisplayLimit.current)})`);
  }, [run]);
  useEffect(() => {
    sentDisplayLimit.current = displayLimit;
    tellDisplayLimit();
  }, [displayLimit, tellDisplayLimit]);

  // The network is back: whatever the map could not download is asked again at once
  // (tiles, weather, avatars), rather than at its next try
  useNetworkRecovery(useCallback(() => run('window.retryMapLoading?.()'), [run]));

  return (
    <View style={styles.container}>
      <View style={styles.webviewContainer}>
        {mapWebViewHtmlContent && (
          <WebView
            ref={webViewRef}
            style={styles.webview}
            source={mapWebViewHtmlContent}
            // The page draws under the status bar: tell it how much to keep clear (debug
            // overlay, read only once the app turns it on, so it may arrive late)
            injectedJavaScriptBeforeContentLoaded={`window.SAFE_AREA_TOP = ${insets.top}; true;`}
            onLoadStart={() => {
              isMapReady.current = false;
              clearTimeout(readyTimer.current);
              showCover();
            }}
            onLoadEnd={() => {
              clearTimeout(readyTimer.current);
              if (!isMapReady.current) readyTimer.current = setTimeout(() => reloadPage('not ready'), MAP_READY_TIMEOUT_MS);
            }}
            onError={() => reloadPage('load error')}
            onMessage={(event) => {
              try {
                const message = JSON.parse(event.nativeEvent.data);
                if (message.type === 'map-ready') {
                  isMapReady.current = true;
                  pageFailures.current = 0;
                  clearTimeout(readyTimer.current);
                  if (pendingPosition.current) setPlayerLocation(pendingPosition.current);
                  else if (pendingProvisional.current) setProvisionalLocation(pendingProvisional.current);
                  if (pendingAvatar.current) setPlayerAvatar(pendingAvatar.current);
                  setEvents(pendingEvents.current);
                  if (pendingDraft.current) setDraftPin(pendingDraft.current);
                  if (pendingFocus.current) focusEvent(pendingFocus.current);
                  if (pendingStandIn.current) setPeopleStandIn(pendingStandIn.current);
                  if (pendingKept.current) keepPeopleAvatars(pendingKept.current);
                  setPeople(pendingPeople.current);
                  for (const [id, files] of pendingLooks.current) setPersonAvatar(id, files);
                  if (pendingPerson.current) selectPerson(pendingPerson.current);
                  if (pendingWeather.current) setWeather(pendingWeather.current);
                  tellDisplayLimit();
                  webViewRef.current?.injectJavaScript(
                    `window.setMapDevToolsAvailable?.(${JSON.stringify(__DEV__ || SHOWCASE)}); true;`,
                  );
                  setActive(isActive.current);
                  onReady?.();
                } else if (message.type === 'view-ready') {
                  liftCover();
                } else if (message.type === 'map-lost') {
                  // The page lost its drawing context: a fresh page draws again
                  isMapReady.current = false;
                  showCover();
                  reloadPage('drawing context lost');
                } else if (message.type === 'event-tap' && typeof message.id === 'string') {
                  handlers.current.onEventTap?.(message.id);
                } else if (message.type === 'person-tap' && typeof message.id === 'string') {
                  handlers.current.onPersonTap?.(message.id);
                } else if (message.type === 'player-tap') {
                  handlers.current.onPlayerTap?.();
                } else if (message.type === 'map-tap') {
                  handlers.current.onMapTap?.();
                } else if (message.type === 'map-long-press' && Number.isFinite(message.latitude) && Number.isFinite(message.longitude)) {
                  handlers.current.onLongPress?.({
                    latitude: message.latitude,
                    longitude: message.longitude,
                    player: Number.isFinite(message.playerLatitude) && Number.isFinite(message.playerLongitude)
                      ? { latitude: message.playerLatitude, longitude: message.playerLongitude }
                      : null,
                  });
                }
              } catch {
                // Ignore messages that are not part of the map bridge.
              }
            }}
            javaScriptEnabled={true}
            domStorageEnabled={true}
            allowFileAccess={true}
            allowFileAccessFromFileURLs={true}
            allowUniversalAccessFromFileURLs={true}
            allowingReadAccessToURL={mapWebViewHtmlContent.page}
            onShouldStartLoadWithRequest={localPageOnly(mapWebViewHtmlContent.page)}
            thirdPartyCookiesEnabled={false}
            originWhitelist={['*']}
            mixedContentMode={API_URL?.startsWith('https:') ? 'never' : 'always'}
            setSupportMultipleWindows={false}
            onRenderProcessGone={(event) => {
              console.warn('WebView crash:', event.nativeEvent.didCrash ? 'CRASH' : 'KILLED');
              isMapReady.current = false;
              reloadPage('render process gone');
            }}
            onContentProcessDidTerminate={() => {
              console.warn('WebView process terminated');
              isMapReady.current = false;
              reloadPage('content process terminated');
            }}
            overScrollMode="never"
            scrollEnabled={false}
            hideKeyboardAccessoryView={true}
            keyboardDisplayRequiresUserAction={false}
            bounces={false}
            setBuiltInZoomControls={false}
            displayZoomControls={false}
            saveFormDataDisabled={true}
            webviewDebuggingEnabled={__DEV__}
            {...(Platform.OS === 'ios' && {
              allowsLinkPreview: false,
              dataDetectorTypes: 'none',
              decelerationRate: 'normal',
              showsHorizontalScrollIndicator: false,
              showsVerticalScrollIndicator: false,
            })}
          />
        )}
      </View>
      {coverShown ? (
        <Animated.View style={[StyleSheet.absoluteFill, styles.cover, { backgroundColor: colors.page, opacity: cover }]} pointerEvents="none">
          {/* Gone in the first part of the fade: the arcs never linger over the map */}
          <Animated.View style={{ opacity: cover.interpolate({ inputRange: [0.65, 1], outputRange: [0, 1], extrapolate: 'clamp' }) }}>
            <AvatarLoader color={colors.inactive} size={54} label="Loading map" />
          </Animated.View>
        </Animated.View>
      ) : null}
    </View>
  );
}));

const styles = StyleSheet.create({
  cover: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  container: {
    backgroundColor: '#000000',
    flex: 1,
  },
  webviewContainer: {
    flex: 1,
    width: '100%',
  },
  webview: {
    flex: 1,
  },
});
