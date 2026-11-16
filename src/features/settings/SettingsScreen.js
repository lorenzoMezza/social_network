// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo, useRef } from 'react';
import { Alert, Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useScrollToTop } from 'expo-router';
import Constants from 'expo-constants';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useLogto } from '@logto/rn';
import { useColors } from '../../theme/colors';
import { useTabBarHeight } from '../../components/navigation/tabBarHeight';
import { tapFeedback } from '../../lib/haptics';
import { useSettings } from './settingsStore';
import { useMe } from '../me/MeProvider';
import { useApi } from '../api/useApi';
import { safeServiceUrl } from '../api/apiConfig';
import { failureMessage } from '../api/failureMessage';

const THEMES = [
  { id: 'system', label: 'System' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
];

// The app's settings, grouped like every social app: account, privacy, notifications,
// appearance, about, sign out. Profile and avatar are edited on the profile page, the
// visibility of the moment on the map: here only what changes rarely.
export function SettingsScreen() {
  const insets = useSafeAreaInsets();
  // Tapping its tab again brings the page back to the top
  const scroller = useRef(null);
  useScrollToTop(scroller);
  const tabBarHeight = useTabBarHeight();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { signOut } = useLogto();
  const [settings, set] = useSettings();
  // The account's own settings (the server's: notifications reach the user wherever
  // they sign in); theme and map are this phone's
  const { me, email, update } = useMe();
  const request = useApi();
  const notify = me?.settings ?? {};
  const onlyConnections = (me?.storyAudience ?? 'connections') === 'connections';

  const toggle = (key) => (value) => {
    tapFeedback();
    set(key, value);
  };
  const toggleNotify = (key) => (value) => {
    tapFeedback();
    update({ settings: { [key]: value } }).catch(() => Alert.alert('Could not save', 'Try again in a moment.'));
  };
  const toggleStoryAudience = (only) => {
    tapFeedback();
    update({ storyAudience: only ? 'connections' : 'everyone' }).catch((error) => Alert.alert('Could not change it', failureMessage(error)));
  };

  const confirmSignOut = () => {
    Alert.alert('Sign out?', 'You can sign back in at any time.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Sign out', style: 'destructive', onPress: () => signOut().catch((error) => console.warn('Sign-out failed:', error)) },
    ]);
  };

  // Everything goes: profile, avatar, events organized, photos, messages, connections, credits
  const confirmDelete = () => {
    Alert.alert('Delete your account?', 'Your profile, avatar, events, photos, messages, connections and any credits you have are deleted for good. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        // Deleted is deleted: a sign-out that then fails is not "could not delete"
        onPress: () => request('/me', { method: 'DELETE' })
          .then(
            () => signOut().catch((error) => console.warn('Sign-out failed:', error)),
            (error) => Alert.alert('Could not delete the account', failureMessage(error)),
          ),
      },
    ]);
  };

  // A copy of everything that is theirs (GDPR art. 15, 20): a one-time link, opened in
  // the browser, where the file downloads
  const downloadData = () => {
    request('/me/export', { method: 'POST' })
      .then(({ url }) => {
        const safeUrl = safeServiceUrl(url);
        if (!safeUrl) throw new Error('The export service returned an unsafe URL');
        return Linking.openURL(safeUrl);
      })
      .catch((error) => Alert.alert('Could not prepare your data', failureMessage(error)));
  };

  const row = (props) => <Row styles={styles} colors={colors} {...props} />;

  return (
    // A tab of its own: the page title as on the other tabs, room for the floating bar
    <View style={[styles.page, { paddingTop: insets.top + 6 }]}>
      <View style={styles.topBar}>
        <Text style={styles.title} accessibilityRole="header">Settings</Text>
      </View>
      <ScrollView ref={scroller} contentContainerStyle={[styles.content, { paddingBottom: (tabBarHeight || insets.bottom) + 32 }]} showsVerticalScrollIndicator={false}>
        <Section styles={styles} title="Account" footer="Your profile and your avatar are edited right on your profile page.">
          {row({ icon: 'mail-outline', label: 'Email', value: email ?? '–', stacked: true, last: true })}
        </Section>

        <Section
          styles={styles}
          title="Privacy"
          footer={settings.mapStartInvisible
            ? 'On: you start invisible every time you open the app.'
            : 'Off: the map opens in the mode you chose last: visible, approximate or invisible.'}
        >
          {row({
            icon: 'eye-off-outline',
            label: 'Start invisible',
            toggle: settings.mapStartInvisible,
            onToggle: toggle('mapStartInvisible'),
            last: true,
          })}
        </Section>

        <Section
          styles={styles}
          title="Your story"
          footer={onlyConnections
            ? 'On: only people you connected with see your story, the events you organize, who you know and which events you go to.'
            : 'Off: anyone who opens your profile or an event you joined sees all of this, including where you are going.'}
        >
          {row({
            icon: 'lock-closed-outline',
            label: 'Only my connections',
            toggle: onlyConnections,
            onToggle: toggleStoryAudience,
            last: true,
          })}
        </Section>

        <Section styles={styles} title="Safety" footer="Blocked people cannot find you nearby, message you or connect with you.">
          {row({ icon: 'hand-left-outline', label: 'Blocked people', onPress: () => router.push('/blocked'), last: true })}
        </Section>

        <Section styles={styles} title="Notifications">
          {/* Saving an event (a private bookmark) never notifies: these are about the events the
              user organizes or joins (backend notifications.py) */}
          {row({ icon: 'calendar-outline', label: 'Events I organize or join', toggle: notify.notifyEventUpdates ?? true, onToggle: toggleNotify('notifyEventUpdates') })}
          {row({ icon: 'people-outline', label: 'New connections', toggle: notify.notifyConnections ?? true, onToggle: toggleNotify('notifyConnections') })}
          {row({ icon: 'chatbubble-outline', label: 'Messages', toggle: notify.notifyMessages ?? true, onToggle: toggleNotify('notifyMessages'), last: true })}
        </Section>

        <Section styles={styles} title="Appearance">
          <View style={styles.themeRow}>
            {THEMES.map((theme) => {
              const selected = settings.theme === theme.id;
              return (
                <Pressable
                  key={theme.id}
                  accessibilityRole="radio"
                  accessibilityState={{ selected }}
                  onPress={() => {
                    if (selected) return;
                    tapFeedback();
                    set('theme', theme.id);
                  }}
                  style={[styles.themeOption, selected && styles.themeSelected]}
                >
                  <Ionicons
                    name={theme.id === 'light' ? 'sunny-outline' : theme.id === 'dark' ? 'moon-outline' : 'phone-portrait-outline'}
                    size={20}
                    color={selected ? colors.onAccent : colors.active}
                  />
                  <Text style={[styles.themeLabel, selected && styles.themeLabelSelected]}>{theme.label}</Text>
                </Pressable>
              );
            })}
          </View>
        </Section>

        <Section styles={styles} title="Your data and our terms" footer="Your copy of your data opens in the browser as a file. The link works once, for 10 minutes.">
          {row({ icon: 'shield-checkmark-outline', label: 'Privacy policy', onPress: () => router.push('/legal/privacy') })}
          {row({ icon: 'document-text-outline', label: 'Terms of use', onPress: () => router.push('/legal/terms') })}
          {row({ icon: 'people-outline', label: 'Community guidelines', onPress: () => router.push('/legal/guidelines') })}
          {row({ icon: 'download-outline', label: 'Download my data', onPress: downloadData, last: true })}
        </Section>

        <Section styles={styles} title="About">
          {row({ icon: 'ribbon-outline', label: 'Licenses', onPress: () => router.push('/licenses') })}
          {row({ icon: 'information-circle-outline', label: 'Version', value: Constants.expoConfig?.version ?? '–', last: true })}
        </Section>

        <Pressable accessibilityRole="button" onPress={confirmSignOut} style={({ pressed }) => [styles.signOut, pressed && styles.pressed]}>
          <Text style={styles.signOutLabel}>Sign out</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={confirmDelete} hitSlop={8} style={({ pressed }) => [styles.deleteAccount, pressed && styles.pressed]}>
          <Text style={styles.deleteAccountLabel}>Delete account</Text>
        </Pressable>
      </ScrollView>
    </View>
  );
}

function Section({ styles, title, footer, children }) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.group}>{children}</View>
      {footer ? <Text style={styles.footer}>{footer}</Text> : null}
    </View>
  );
}

// Long words wrap instead of being cut, whatever the phone's width or text size.
// `stacked`: the value under its label, on one line, smaller when long (an email broken in
// two is no use)
function Row({ styles, colors, icon, label, value, stacked, onPress, toggle, onToggle, last }) {
  // Selectable on iOS only: on Android a selectable text loses its ellipsis
  const selectable = process.env.EXPO_OS === 'ios';
  const content = (
    <View style={[styles.row, !last && styles.divider]}>
      <Ionicons name={icon} size={20} color={colors.active} />
      {stacked ? (
        <View style={styles.rowStack}>
          <Text style={styles.rowStackLabel}>{label}</Text>
          <Text style={styles.rowStackValue} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.65} selectable={selectable}>{value}</Text>
        </View>
      ) : (
        <Text style={styles.rowLabel}>{label}</Text>
      )}
      {value != null && !stacked ? <Text style={styles.rowValue} selectable={selectable}>{value}</Text> : null}
      {toggle != null ? (
        // A box of the switch's own size, centred in the row: the iOS 26 switch draws
        // past its measured frame and otherwise sits high in the row
        <View style={styles.switchBox}>
          <Switch value={toggle} onValueChange={onToggle} trackColor={{ true: colors.accent }} thumbColor={process.env.EXPO_OS === 'android' ? '#FFFFFF' : undefined} accessibilityLabel={label} />
        </View>
      ) : null}
      {onPress ? <Ionicons name="chevron-forward" size={16} color={colors.inactive} /> : null}
    </View>
  );
  return onPress ? (
    <Pressable accessibilityRole="button" onPress={onPress} style={({ pressed }) => pressed && styles.pressed}>{content}</Pressable>
  ) : content;
}

const createStyles = (colors) => StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: colors.page,
  },
  topBar: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 20,
    paddingBottom: 6,
  },
  title: {
    fontSize: 30,
    fontWeight: '700',
    letterSpacing: -0.6,
    color: colors.active,
  },
  content: {
    paddingHorizontal: 20,
    paddingTop: 8,
    gap: 28,
  },
  section: {
    gap: 8,
  },
  sectionTitle: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.inactive,
    paddingHorizontal: 4,
  },
  group: {
    borderRadius: 16,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
    overflow: 'hidden',
  },
  footer: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.inactive,
    paddingHorizontal: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  divider: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  switchBox: {
    height: 32,
    justifyContent: 'center',
    alignItems: 'flex-end',
  },
  rowLabel: {
    flex: 1,
    fontSize: 16,
    color: colors.active,
  },
  rowValue: {
    flexShrink: 1,
    textAlign: 'right',
    fontSize: 15,
    color: colors.inactive,
  },
  rowStack: {
    flex: 1,
    gap: 2,
  },
  rowStackLabel: {
    fontSize: 13,
    color: colors.inactive,
  },
  rowStackValue: {
    fontSize: 16,
    color: colors.active,
  },
  pressed: {
    opacity: 0.6,
  },
  themeRow: {
    flexDirection: 'row',
    gap: 8,
    padding: 8,
  },
  themeOption: {
    flex: 1,
    alignItems: 'center',
    gap: 6,
    paddingVertical: 12,
    borderRadius: 12,
    borderCurve: 'continuous',
  },
  themeSelected: {
    backgroundColor: colors.accent,
  },
  themeLabel: {
    fontSize: 13,
    fontWeight: '600',
    color: colors.active,
  },
  themeLabelSelected: {
    color: colors.onAccent,
  },
  signOut: {
    height: 52,
    borderRadius: 16,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  signOutLabel: {
    fontSize: 16,
    fontWeight: '600',
    color: colors.error,
  },
  deleteAccount: {
    alignSelf: 'center',
    paddingVertical: 14,
  },
  deleteAccountLabel: {
    fontSize: 14,
    color: colors.inactive,
  },
});
