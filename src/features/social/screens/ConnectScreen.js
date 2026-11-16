// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Animated, Easing, Linking, ScrollView, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { initialWindowMetrics, useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { usePreventScreenCapture } from 'expo-screen-capture';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useColors } from '../../../theme/colors';
import { Button } from '../../../components/ui/Button';
import { successFeedback, tapFeedback } from '../../../lib/haptics';
import { SegmentedTabs } from '../../../components/ui/SegmentedTabs';
import { SheetHeader } from '../../../components/ui/SheetHeader';
import { useOwnProfile } from '../../profile/state/useOwnProfile';
import { useSocial } from '../state/SocialProvider';
import { QrCode } from '../components/QrCode';
import { CONNECT_ERRORS, TOKEN_ROTATE_MS, decodeQr, encodeQr } from '../connect/protocol';
import { useGuestClaim, useHostSession } from '../connect/useConnect';
import { useRealtimeEvent } from '../../realtime/RealtimeProvider';

const MODES = [
  { key: 'qr', label: 'My code' },
  { key: 'scan', label: 'Scan' },
];

// What went wrong, in words (codes in connect/protocol.js)
const ERROR_TEXT = {
  [CONNECT_ERRORS.expired]: 'This code is no longer valid. Scan the code on their screen again.',
  [CONNECT_ERRORS.tooFar]: 'You need to be next to each other. Stand together and try again.',
  [CONNECT_ERRORS.self]: 'This is your own code. Scan the code on the other phone.',
  [CONNECT_ERRORS.blocked]: 'You cannot connect with this person.',
  [CONNECT_ERRORS.already]: 'You are already connected.',
  [CONNECT_ERRORS.rateLimited]: 'Too many attempts. Wait a minute, then try again.',
  [CONNECT_ERRORS.offline]: 'You are offline. Check your connection and try again.',
  [CONNECT_ERRORS.invalid]: 'This is not a connection code from the app.',
};
const errorText = (error) => ERROR_TEXT[error?.code] ?? 'Something went wrong. Try again.';

// The sheet's steps: a low one, so that dragging it down does not close it at once; one as
// tall as what it shows; the whole height. A step this near the top is the top
const LOW_STEP = 0.5;
const NEAR_THE_TOP = 0.96;

// Opens as tall as its content, measured once (on this phone, with its text size, an
// invitation's line included): the steps are set when the sheet opens, then left alone
function useSheetFitsContent() {
  const navigation = useNavigation();
  const { height: windowHeight } = useWindowDimensions();
  const header = useRef(0);
  const content = useRef(0);
  const done = useRef(false);
  const fit = () => {
    if (done.current || !header.current || !content.current) return;
    done.current = true;
    // Steps count from the full height of a sheet: the window less the top inset
    const room = windowHeight - (initialWindowMetrics?.insets.top ?? 0);
    const step = Math.max(LOW_STEP + 0.1, Math.ceil(((header.current + content.current) / room) * 100) / 100);
    navigation.setOptions({ sheetAllowedDetents: step >= NEAR_THE_TOP ? [LOW_STEP, 1] : [LOW_STEP, step, 1] });
  };
  return {
    onHeader: (event) => {
      header.current = event.nativeEvent.layout.height;
      fit();
    },
    onContent: (_width, height) => {
      content.current = height;
      fit();
    },
  };
}

// Connecting happens only in person: one phone shows a code that changes every few
// seconds (My code), the other scans it (Scan), and the two are connected. Rules and the
// server's part: docs/CONNECT-PROTOCOL.md.
// Opened by an invitation (connectInvites.js): `mode` its tab, `with` the other's name,
// `invite` its id, `invited` on the phone of the one who accepted.
export function ConnectScreen() {
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const params = useLocalSearchParams();
  const insets = useSafeAreaInsets();
  const [mode, setMode] = useState(() => (MODES.some((item) => item.key === params.mode) ? params.mode : 'qr'));
  const sheet = useSheetFitsContent();

  return (
    <View style={styles.page}>
      <SheetHeader title="Connect" rightLabel="Done" onRight={() => router.back()} onLayout={sheet.onHeader} />
      {/* Scrolls where the sheet is shorter than its content (a small phone); wrapped: in an
          iOS form sheet a scroll view right under the header is resized by the screens
          library and drawn out of view */}
      <View collapsable={false} style={styles.flex}>
      <ScrollView contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + 20 }]} onContentSizeChange={sheet.onContent} showsVerticalScrollIndicator={false}>
        {params.with ? <InviteLine styles={styles} colors={colors} name={String(params.with)} invite={String(params.invite ?? '')} invited={params.invited === '1'} mode={mode} /> : null}
        <SegmentedTabs tabs={MODES} value={mode} onChange={setMode} />
        {mode === 'qr' ? <HostView styles={styles} colors={colors} /> : null}
        {mode === 'scan' ? <ScanView styles={styles} colors={colors} onShowCode={() => setMode('qr')} /> : null}
        <View style={styles.rules}>
          <Rule styles={styles} colors={colors} icon="people-outline" text="Only in person: you always know who you connect with." />
          <Rule styles={styles} colors={colors} icon="chatbubble-ellipses-outline" text="Chat with your connections anywhere, and add them to your groups." />
        </View>
      </ScrollView>
      </View>
    </View>
  );
}

// How long an invitation waits for its answer (the server's INVITE_TTL_S)
const INVITE_WAIT_MS = 60 * 1000;

// With whom, and what to do now: on the inviting phone, whether they accepted
function InviteLine({ styles, colors, name, invite, invited, mode }) {
  const who = name;
  const [answer, setAnswer] = useState(invited ? 'accepted' : 'waiting');
  useRealtimeEvent('connect.answer', useCallback((frame) => {
    if (frame.invite === invite) setAnswer(frame.accept ? 'accepted' : 'declined');
  }, [invite]));
  useEffect(() => {
    if (answer !== 'waiting') return undefined;
    const timer = setTimeout(() => setAnswer('silent'), INVITE_WAIT_MS);
    return () => clearTimeout(timer);
  }, [answer]);
  const todo = {
    qr: `Let ${who} scan your code.`,
    scan: `Scan the code on ${who}'s phone.`,
  }[mode];
  const text = {
    waiting: `Waiting for ${who} to accept…`,
    accepted: invited ? todo : `${who} is ready. ${todo}`,
    declined: `${who} said not now.`,
    silent: `${who} didn't answer. You can still connect here together.`,
  }[answer];
  const icon = answer === 'waiting' ? 'time-outline' : answer === 'accepted' ? 'checkmark-circle' : 'information-circle-outline';
  return (
    <View style={styles.inviteLine} accessibilityLiveRegion="polite">
      <Ionicons name={icon} size={18} color={answer === 'accepted' ? colors.live : colors.inactive} />
      <Text style={styles.inviteText}>{text}</Text>
    </View>
  );
}

// A connection made on this screen: a little buzz, and the social store refreshed
// (the server has it, with where they met; the socket usually brought it already)
function useConnectedFeedback(user) {
  const { refresh } = useSocial();
  const told = useRef(null);
  useEffect(() => {
    if (!user?.id || told.current === user.id) return;
    told.current = user.id;
    successFeedback();
    refresh();
  }, [user, refresh]);
}

// My code: a code that changes every few seconds, valid only while this is on screen.
// Screenshots and recordings are blocked, and would be useless seconds later anyway.
function HostView({ styles, colors }) {
  usePreventScreenCapture('connect-code');
  const profile = useOwnProfile();
  const host = useHostSession(true);
  useConnectedFeedback(host.phase === 'connected' ? host.user : null);

  if (host.phase === 'error') return <Problem styles={styles} colors={colors} error={host.error} onRetry={host.retry} />;
  if (host.phase === 'connected') return <Connected styles={styles} colors={colors} user={host.user} />;
  return (
    <View style={styles.center}>
      <View style={styles.qrCard}>
        {host.phase === 'ready' ? <QrCode value={encodeQr(host.token)} size={220} /> : <View style={styles.qrPlaceholder} />}
      </View>
      {host.phase === 'ready' ? <RotationBar key={host.issuedAt} colors={colors} styles={styles} /> : null}
      <Text style={styles.name}>{profile.name}</Text>
      {profile.username ? <Text style={styles.handle}>@{profile.username}</Text> : null}
      <Text style={styles.explain}>Let them scan it from Social › Connect › Scan, standing next to you.</Text>
    </View>
  );
}

// A thin line that empties until the code changes
function RotationBar({ styles, colors }) {
  const [progress] = useState(() => new Animated.Value(1));
  useEffect(() => {
    const animation = Animated.timing(progress, { toValue: 0, duration: TOKEN_ROTATE_MS, easing: Easing.linear, useNativeDriver: true });
    animation.start();
    return () => animation.stop();
  }, [progress]);
  return (
    <View style={styles.rotationTrack} accessibilityLabel="The code changes every few seconds">
      <Animated.View style={[styles.rotationFill, { backgroundColor: colors.accent, transform: [{ scaleX: progress }] }]} />
    </View>
  );
}

// Scan: the camera reads the other phone's code and the two are connected
function ScanView({ styles, colors, onShowCode }) {
  const [permission, requestPermission] = useCameraPermissions();
  const { isBlocked } = useSocial();
  const guest = useGuestClaim();
  const [invalid, setInvalid] = useState(false);
  const [failed, setFailed] = useState(false);
  // The camera reports the same code many times a second: only the first one counts
  // until "Scan again"
  const handled = useRef(false);
  useConnectedFeedback(guest.phase === 'connected' ? guest.user : null);

  const again = () => {
    handled.current = false;
    setInvalid(false);
    guest.reset();
  };

  const onScanned = ({ data }) => {
    if (handled.current) return;
    handled.current = true;
    const token = decodeQr(data);
    if (!token) {
      setInvalid(true);
      return;
    }
    tapFeedback();
    guest.submit(token, (user) => (isBlocked(user?.id) ? CONNECT_ERRORS.blocked : null));
  };

  if (!permission) return <View style={styles.scanArea} />;
  if (!permission.granted) {
    return (
      <View style={styles.center}>
        <Ionicons name="camera-outline" size={34} color={colors.inactive} />
        <Text style={styles.title}>Scan their code</Text>
        <Text style={styles.explain}>{"The camera is used only to read the other phone's code."}</Text>
        <Button label={permission.canAskAgain ? 'Allow camera' : 'Open Settings'} compact onPress={permission.canAskAgain ? requestPermission : () => Linking.openSettings()} />
      </View>
    );
  }
  if (invalid) return <Problem styles={styles} colors={colors} error={{ code: CONNECT_ERRORS.invalid }} retryLabel="Scan again" onRetry={again} />;
  if (guest.phase === 'error') return <Problem styles={styles} colors={colors} error={guest.error} retryLabel="Scan again" onRetry={again} />;
  if (guest.phase === 'connected') return <Connected styles={styles} colors={colors} user={guest.user} />;
  if (guest.phase === 'connecting') {
    return (
      <View style={styles.center}>
        <ActivityIndicator color={colors.inactive} />
        <Text style={styles.explain}>Connecting…</Text>
      </View>
    );
  }
  return (
    <View style={styles.scanArea}>
      {failed ? (
        <View style={styles.center}>
          <Ionicons name="videocam-off-outline" size={34} color={colors.inactive} />
          <Text style={styles.explain}>The camera is not available on this device.</Text>
          <Button label="Show my code instead" variant="secondary" compact onPress={onShowCode} />
        </View>
      ) : (
        <>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={onScanned}
            onMountError={() => setFailed(true)}
          />
          <View style={styles.viewfinder} pointerEvents="none" />
          <Text style={styles.scanHint}>{"Point at the other phone's code"}</Text>
        </>
      )}
    </View>
  );
}

function Connected({ styles, colors, user }) {
  return (
    <View style={styles.center} accessibilityLiveRegion="polite">
      <Ionicons name="checkmark-circle" size={48} color={colors.live} />
      <Text style={styles.title}>Connected!</Text>
      <Text style={styles.explain}>You and @{user?.username} can now chat from anywhere.</Text>
      <Button label="Done" compact onPress={() => router.back()} />
    </View>
  );
}

function Problem({ styles, colors, error, text, onRetry, retryLabel = 'Try again' }) {
  return (
    <View style={styles.center}>
      <Ionicons name="alert-circle" size={44} color={colors.error} />
      <Text style={styles.title}>Could not connect</Text>
      <Text style={styles.explain}>{text ?? errorText(error)}</Text>
      <Button label={retryLabel} variant="secondary" compact onPress={onRetry} />
    </View>
  );
}

function Rule({ styles, colors, icon, text }) {
  return (
    <View style={styles.rule}>
      <Ionicons name={icon} size={18} color={colors.inactive} />
      <Text style={styles.ruleText}>{text}</Text>
    </View>
  );
}

const createStyles = (colors) => StyleSheet.create({
  inviteLine: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderRadius: 14,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
  },
  inviteText: {
    flex: 1,
    fontSize: 14,
    lineHeight: 19,
    color: colors.active,
  },
  page: {
    flex: 1,
    backgroundColor: colors.page,
  },
  flex: {
    flex: 1,
  },
  // As tall as what it shows, not as the sheet: that is what the sheet's height is made from
  content: {
    padding: 20,
    gap: 20,
  },
  title: {
    fontSize: 20,
    fontWeight: '800',
    letterSpacing: -0.3,
    color: colors.active,
  },
  explain: {
    fontSize: 14,
    lineHeight: 20,
    textAlign: 'center',
    color: colors.inactive,
    paddingHorizontal: 12,
  },
  scanArea: {
    height: 300,
    borderRadius: 24,
    borderCurve: 'continuous',
    overflow: 'hidden',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  viewfinder: {
    width: 200,
    height: 200,
    borderRadius: 24,
    borderWidth: 3,
    borderColor: '#FFFFFF',
  },
  scanHint: {
    position: 'absolute',
    bottom: 14,
    fontSize: 14,
    fontWeight: '600',
    color: '#FFFFFF',
    textShadowColor: 'rgba(0,0,0,0.5)',
    textShadowRadius: 6,
  },
  center: {
    alignItems: 'center',
    gap: 10,
    paddingVertical: 12,
  },
  qrPlaceholder: {
    width: 220,
    height: 220,
  },
  rotationTrack: {
    width: 160,
    height: 3,
    borderRadius: 2,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    marginBottom: 6,
  },
  rotationFill: {
    width: '100%',
    height: '100%',
    transformOrigin: 'left',
  },
  qrCard: {
    padding: 14,
    borderRadius: 24,
    borderCurve: 'continuous',
    backgroundColor: '#FFFFFF',
    boxShadow: '0 4px 18px rgba(0, 0, 0, 0.10)',
    marginBottom: 10,
  },
  name: {
    fontSize: 18,
    fontWeight: '800',
    color: colors.active,
  },
  handle: {
    fontSize: 14,
    color: colors.inactive,
    marginBottom: 6,
  },
  rules: {
    gap: 10,
  },
  rule: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  ruleText: {
    flex: 1,
    fontSize: 13,
    lineHeight: 18,
    color: colors.inactive,
  },
});
