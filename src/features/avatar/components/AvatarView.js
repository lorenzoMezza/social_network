// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image } from 'expo-image';
import { useIsFocused, useRootNavigationState } from 'expo-router';
import Ionicons from '@expo/vector-icons/Ionicons';
import { localPageOnly } from '../../../lib/localPageOnly';
import { useColors } from '../../../theme/colors';
import { emoteUrl, resolveAvatar } from '../../../../avatar-server/shared/avatarFormat';
import { AVATAR_FILES_URL } from '../api/avatarServer';
import { useUserAvatar } from '../state/AvatarProvider';

import { loadViewer } from './viewerSource';
import { AvatarLoader } from '../../../components/ui/AvatarLoader';
import { useScreenVisible } from '../../../components/navigation/useScreenVisible';

// Posters: a picture of an avatar taken by the viewer, shown at once next time while
// the 3D view starts (a WebView and a few models take a moment on a phone)
const POSTER_PREFIX = 'avatar:poster:';
// Long side of a poster, in pixels: a little under the view's own resolution (the viewer
// draws at most at 2× the screen), sharp enough for the moment the 3D takes to start
const POSTER_SIZE = 1000;
// Bumped when posters are taken differently: the old ones are taken again once
const POSTER_VERSION = 3;
const posters = new Map();
const posterWriteOwners = new Map();
let posterWriteQueue = Promise.resolve();
// The look and what surrounds it: a picture of one does not stand in for the other
const lookHash = (avatar, stage) => {
  const text = JSON.stringify([POSTER_VERSION, avatar.bodyShape, avatar.colors, avatar.wearables, stage ?? null]);
  let hash = 5381;
  for (let i = 0; i < text.length; i++) hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  return hash.toString(36);
};

const call = (method, ...args) => `window.avatarViewer && window.avatarViewer.${method}(${args.map((arg) => JSON.stringify(arg)).join(',')}); true;`;

/**
 * A 3D avatar: drag sideways to turn it (it comes back to face you), tap it (onTap).
 * frame: 'body' | 'head' | 'upper' | 'lower' | 'feet'. greet: wave once when shown;
 * waveOnTap: wave back when tapped (someone else's avatar). posterKey: keep a picture of
 * it on the device under this key, shown instantly next time. insets: { top, bottom }
 * points of the view covered by the screen's own controls; the avatar is framed in
 * the band between them (the camera eases there when they change). stage: what
 * surrounds the avatar (a theme from profile/state/profileStyle.js stageOf), drawn by
 * the viewer; without it the view is transparent. greeting: the emote played by greet
 * and waveOnTap (an emote id of the catalog, 'wave' by default); changing it while the
 * avatar is shown plays the new one (a preview). persistent: the 3D view is never let go
 * while its screen is mounted (the user's own profile), only paused out of sight.
 */
// Sheets over a screen under which its avatar keeps living (root routes, app/_layout.js)
const LIVE_UNDER = new Set(['profile-style']);

// The routes on show, from the root navigator down (the root wraps the app's stack)
function shownRoutes(state) {
  const names = [];
  for (let current = state; current?.routes?.length;) {
    const route = current.routes[current.index ?? current.routes.length - 1];
    names.push(route.name);
    current = route.state;
  }
  return names;
}

export const AvatarView = memo(function AvatarView({ persistent = false, ...props }) {
  // The 3D view lives only while its screen can be seen: each one is a WebView with
  // its own WebKit process (~250 MB), freed when the user goes to another tab or
  // opens a page over it, and started again on return (the poster, when there is
  // one, shows meanwhile): profiles opened from profiles would otherwise pile up
  // live scenes. The user's own (persistent) is the exception: it is there again at
  // once, without starting again, and out of sight it only sleeps (LiveAvatarView:
  // no frame drawn, no work of its page). The greeting is played once per mount of
  // the screen.
  const visible = useScreenVisible();
  const [greeted, setGreeted] = useState(false);
  const onGreeted = useCallback(() => setGreeted(true), []);
  if (visible || persistent) return <LiveAvatarView {...props} greeted={greeted} onGreeted={onGreeted} />;
  const { posterKey, stage, style } = props;
  const poster = posterKey ? posters.get(posterKey) : null;
  return (
    <View style={[styles.container, stage && { backgroundColor: stage.sky[1] }, style]}>
      {poster ? <Image source={{ uri: poster.image }} style={StyleSheet.absoluteFill} contentFit="contain" /> : null}
    </View>
  );
});

function LiveAvatarView({ avatar, catalog, frame = 'body', greet = false, waveOnTap = false, posterKey, onTap, onDragChange, style, status, error, onRetry, insets, stage, greeting = 'wave', greeted, onGreeted }) {
  const colors = useColors();
  const webView = useRef(null);
  const [source, setSource] = useState(null);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState({ status: 'loading', message: null });
  // Whether this WebView has shown the avatar (later looks keep the camera)
  const shownOnce = useRef(false);
  const [attempt, setAttempt] = useState(0);
  const [poster, setPoster] = useState(() => (posterKey ? posters.get(posterKey) ?? null : null));
  const activePosterKey = useRef(posterKey);
  const posterOwner = useRef({});
  const hash = avatar ? lookHash(avatar, stage) : null;

  useLayoutEffect(() => {
    activePosterKey.current = posterKey;
    return () => {
      if (activePosterKey.current === posterKey) activePosterKey.current = null;
    };
  }, [posterKey]);

  useEffect(() => {
    if (!posterKey || posters.has(posterKey)) return;
    let cancelled = false;
    AsyncStorage.getItem(POSTER_PREFIX + posterKey)
      .then((stored) => {
        const entry = stored ? JSON.parse(stored) : null;
        if (!cancelled && entry) {
          posters.set(posterKey, entry);
          setPoster(entry);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [posterKey]);

  useEffect(() => {
    loadViewer().then(setSource).catch((loadError) => setView({ status: 'error', message: loadError.message }));
  }, []);

  const plan = useMemo(
    () => (avatar && catalog ? resolveAvatar(avatar, catalog, AVATAR_FILES_URL) : null),
    [avatar, catalog],
  );

  // While a look is still on its way when the viewer is ready (someone's profile opened
  // for the first time), the viewer makes the shaders every avatar shares ready with the
  // user's own look, its files on the phone (webview/avatar main.js warmUp): the avatar
  // shows sooner once it arrives. A call after 'ready', the same on iOS and Android
  const own = useUserAvatar();
  const ownPlan = useMemo(
    () => (own.avatar && own.catalog ? resolveAvatar(own.avatar, own.catalog, AVATAR_FILES_URL) : null),
    [own.avatar, own.catalog],
  );
  const warmedUp = useRef(false);
  useEffect(() => {
    if (!ready || plan || !ownPlan || warmedUp.current) return;
    warmedUp.current = true;
    webView.current?.injectJavaScript(call('warmUp', ownPlan));
  }, [ready, plan, ownPlan]);

  // A new plan replaces the avatar in place (the editor's live preview)
  useEffect(() => {
    if (!ready || !plan) return;
    const options = {
      frame,
      emote: greet && !greeted ? emoteUrl(catalog, greeting, plan.bodyShape, AVATAR_FILES_URL) ?? emoteUrl(catalog, 'wave', plan.bodyShape, AVATAR_FILES_URL) : undefined,
      keepCamera: shownOnce.current,
      // A new picture only when the look changed
      snapshot: posterKey && posters.get(posterKey)?.hash !== lookHash(avatar, stage) ? POSTER_SIZE : undefined,
      snapshotKey: posterKey && hash ? `${posterKey}:${hash}` : null,
      // The user's own saved look (the one with a poster): its files stay on the device
      keep: !!posterKey,
    };
    webView.current?.injectJavaScript(call('show', plan, options));
    // frame is sent on its own below: changing it does not rebuild the avatar
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, plan, attempt]);

  useEffect(() => {
    if (ready) webView.current?.injectJavaScript(call('setFrame', frame));
  }, [ready, frame]);

  // A new greeting is played at once, so the user sees what they picked
  const lastGreeting = useRef(greeting);
  const avatarShown = ready && view.status === 'shown' && !!plan;
  useEffect(() => {
    if (lastGreeting.current === greeting) return;
    lastGreeting.current = greeting;
    if (!avatarShown) return;
    const url = emoteUrl(catalog, greeting, plan.bodyShape, AVATAR_FILES_URL);
    if (url) webView.current?.injectJavaScript(call('playEmote', url));
  }, [greeting, avatarShown, catalog, plan]);

  // The first stage appears at once, later ones fade
  const stageKey = stage ? JSON.stringify(stage) : null;
  const stageSent = useRef(false);
  useEffect(() => {
    if (!ready || !stageKey) return;
    webView.current?.injectJavaScript(call('setStage', JSON.parse(stageKey), !stageSent.current));
    stageSent.current = true;
  }, [ready, stageKey]);

  // The first framing is immediate, later ones ease
  const insetsSent = useRef(false);
  const insetTop = insets?.top ?? 0;
  const insetBottom = insets?.bottom ?? 0;
  useEffect(() => {
    if (!ready) return;
    webView.current?.injectJavaScript(call('setInsets', insetTop, insetBottom, !insetsSent.current));
    insetsSent.current = true;
  }, [ready, insetTop, insetBottom]);

  // Off screen the viewer stops drawing and sleeps (no frame requested, no timer): when
  // its screen loses the focus (another tab, a page over it), unless what covers it is
  // a sheet that leaves the avatar in view (LIVE_UNDER: the profile's Style sheet,
  // where every choice shows on the avatar at once)
  const focused = useIsFocused();
  const rootState = useRootNavigationState();
  const live = focused || shownRoutes(rootState).some((name) => LIVE_UNDER.has(name));
  useEffect(() => {
    if (ready) webView.current?.injectJavaScript(call('setActive', live));
  }, [ready, live]);

  const onMessage = (event) => {
    let message;
    try {
      message = JSON.parse(event.nativeEvent.data);
    } catch {
      return;
    }
    if (message.type === 'ready') setReady(true);
    else if (message.type === 'loading') setView((current) => ({ ...current, status: current.status === 'shown' ? 'shown' : 'loading' }));
    else if (message.type === 'loaded') {
      shownOnce.current = true;
      onGreeted();
      setView({ status: 'shown', message: null });
    } else if (message.type === 'error') setView({ status: 'error', message: message.message });
    else if (message.type === 'snapshot' && posterKey && message.snapshotKey === `${posterKey}:${hash}` && message.image && avatar) {
      const entry = { hash: lookHash(avatar, stage), image: message.image };
      posters.set(posterKey, entry);
      setPoster(entry);
      const key = POSTER_PREFIX + posterKey;
      const owner = posterOwner.current;
      posterWriteOwners.set(key, owner);
      posterWriteQueue = posterWriteQueue.catch(() => {}).then(async () => {
        if (activePosterKey.current !== posterKey || posterWriteOwners.get(key) !== owner) return;
        await AsyncStorage.setItem(key, JSON.stringify(entry));
        // If this view ended before its write completed, do not restore the account's
        // poster after logout cleanup. A newer view owns the key if it wrote meanwhile.
        if (activePosterKey.current !== posterKey && posterWriteOwners.get(key) === owner) {
          posterWriteOwners.delete(key);
          await AsyncStorage.removeItem(key);
        } else if (posterWriteOwners.get(key) === owner) {
          posterWriteOwners.delete(key);
        }
      }).catch(() => {
        if (posterWriteOwners.get(key) === owner) posterWriteOwners.delete(key);
      });
    } else if (message.type === 'tap') {
      if (waveOnTap && plan) webView.current?.injectJavaScript(call('playEmote', emoteUrl(catalog, greeting, plan.bodyShape, AVATAR_FILES_URL)));
      onTap?.();
    }
    else if (message.type === 'drag') onDragChange?.(message.active);
  };

  const failed = status === 'error' || view.status === 'error';
  const loading = !failed && view.status !== 'shown';
  // The avatar fades in when its scene is ready, instead of popping in
  const [reveal] = useState(() => new Animated.Value(0));
  useEffect(() => {
    if (loading) {
      reveal.setValue(0);
      return;
    }
    Animated.timing(reveal, { toValue: 1, duration: 280, useNativeDriver: true }).start();
  }, [loading, reveal]);
  // The picture of this very look, while the 3D view is not ready
  const showPoster = loading && poster && (!hash || poster.hash === hash);

  return (
    <View style={[styles.container, stage && { backgroundColor: stage.sky[1] }, style]}>
      {source ? (
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: reveal }]}>
        <WebView
          ref={webView}
          source={source}
          style={styles.webview}
          containerStyle={styles.webviewContainer}
          originWhitelist={['*']}
          allowFileAccess
          allowFileAccessFromFileURLs
          allowUniversalAccessFromFileURLs
          allowingReadAccessToURL={source.uri}
          onShouldStartLoadWithRequest={localPageOnly(source.uri)}
          setSupportMultipleWindows={false}
          javaScriptEnabled
          scrollEnabled={false}
          bounces={false}
          overScrollMode="never"
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
          setBuiltInZoomControls={false}
          onMessage={onMessage}
          onContentProcessDidTerminate={() => webView.current?.reload()}
          onRenderProcessGone={() => webView.current?.reload()}
          onLoadStart={() => {
            // A page starting again (its process was ended by the system) knows nothing:
            // no avatar shown, no stage, no framing. The poster or the loader covers it
            // until the avatar is back, and the first calls are immediate again
            setReady(false);
            warmedUp.current = false;
            shownOnce.current = false;
            stageSent.current = false;
            insetsSent.current = false;
            setView((current) => (current.status === 'shown' ? { status: 'loading', message: null } : current));
          }}
          webviewDebuggingEnabled={__DEV__}
        />
        </Animated.View>
      ) : null}
      {showPoster ? (
        <Image source={{ uri: poster.image }} style={StyleSheet.absoluteFill} contentFit="contain" pointerEvents="none" />
      ) : null}
      {loading && !showPoster ? (
        <View style={[styles.loader, { top: insets?.top ?? 0, bottom: insets?.bottom ?? 0 }]} pointerEvents="none">
          <AvatarLoader color={loaderColor(stage, colors)} />
        </View>
      ) : null}
      {failed ? (
        <View style={styles.overlay}>
          <Ionicons name="cloud-offline-outline" size={26} color={colors.inactive} />
          <Text style={[styles.errorText, { color: colors.inactive }]}>
            {error?.code === 'no-server' ? 'Avatar server not running' : 'Avatar did not load'}
          </Text>
          {onRetry ? (
            <Pressable accessibilityRole="button" hitSlop={8} onPress={() => {
              setView({ status: 'loading', message: null });
              setAttempt((value) => value + 1);
              onRetry();
            }}>
              <Text style={[styles.retry, { color: colors.active }]}>Try again</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

// The loader's colour: light over a dark backdrop, a deep shade of the backdrop over
// a light one, the app's grey without a backdrop
function loaderColor(stage, colors) {
  if (!stage) return colors.inactive;
  const value = parseInt(stage.sky[0].slice(1), 16);
  const luma = ((value >> 16) * 0.299 + ((value >> 8) & 255) * 0.587 + (value & 255) * 0.114) / 255;
  if (luma < 0.45) return '#FFFFFF';
  const rim = parseInt((stage.rim ?? '#334455').slice(1), 16);
  const shade = (channel) => Math.round(((rim >> channel) & 255) * 0.45);
  return `rgb(${shade(16)}, ${shade(8)}, ${shade(0)})`;
}

const styles = StyleSheet.create({
  container: {
    overflow: 'hidden',
  },
  webviewContainer: {
    backgroundColor: 'transparent',
  },
  webview: {
    flex: 1,
    backgroundColor: 'transparent',
  },
  // Centred in the space the avatar will take (between the screen's own controls)
  loader: {
    position: 'absolute',
    left: 0,
    right: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  overlay: {
    ...StyleSheet.absoluteFill,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  errorText: {
    fontSize: 14,
  },
  retry: {
    fontSize: 15,
    fontWeight: '600',
  },
});
