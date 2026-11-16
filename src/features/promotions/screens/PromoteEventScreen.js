// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useEffect, useMemo, useState } from 'react';
import { Alert, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { useColors } from '../../../theme/colors';
import { Button } from '../../../components/ui/Button';
import { Slider } from '../../../components/ui/Slider';
import { successFeedback } from '../../../lib/haptics';
import { SheetHeader } from '../../../components/ui/SheetHeader';
import { EmptyState } from '../../../components/ui/StateViews';
import { useEvents } from '../../events/state/EventsProvider';
import { STATUS, eventStatus } from '../../events/model/eventModel';
import { usePromotions } from '../state/PromotionsProvider';
import {
  formatCredits, formatRadius, packFor, promotionDue, promotionMessage, promotionQuote,
} from '../model/promotionModel';
import { failureMessage } from '../../api/failureMessage';

// Promoting one of the user's events (docs/PROMOTIONS.md): how far it is shown, what
// that costs a day and at most, the user's credits, and one button. Opened from the
// event's page only, never pushed anywhere else.
export function PromoteEventScreen({ id }) {
  const insets = useSafeAreaInsets();
  const colors = useColors();
  const styles = useMemo(() => createStyles(colors), [colors]);
  const { byId, promoteEvent, stopPromotion } = useEvents();
  const { prices, wallet, canBuy, testPurchases, buyPack, packPrice, refreshWallet } = usePromotions();
  // The credits decide what the button does (promote, or add credits first): until they
  // are known nothing is offered, never a purchase the user may not need. Asked again each
  // time: a charge or something given back may have changed them since
  const [walletFailed, setWalletFailed] = useState(false);
  useEffect(() => {
    refreshWallet().catch(() => setWalletFailed(true));
  }, [refreshWallet]);
  const event = byId[id];
  const promotion = event?.promotion ?? null;
  const live = promotion?.status === 'live';
  const radii = prices.tiers.map((tier) => tier.radius);
  const [chosen, setRadius] = useState(() => (promotion && radii.includes(promotion.radius) ? promotion.radius : radii[0]));
  // The price list can arrive (or change) while this is open: a distance it no longer
  // offers has no price, so the first one it does offer takes its place
  const radius = radii.includes(chosen) ? chosen : radii[0];
  const [busy, setBusy] = useState(false);

  const status = event ? eventStatus(event) : null;
  if (!event || event.flash || status === STATUS.concluded || status === STATUS.cancelled || !radii.length) {
    return (
      <View style={styles.page}>
        <SheetHeader title="Promote" leftLabel="Close" onLeft={() => router.back()} />
        <EmptyState icon="megaphone-outline" title="Nothing to promote" message="Only events still to come or happening now can be promoted." actionLabel="Back" onAction={() => router.back()} />
      </View>
    );
  }

  const quote = promotionQuote(prices, event, radius);
  const balance = wallet?.balance ?? 0;
  const due = promotionDue(event, quote);
  const unchanged = live && promotion.radius === radius;
  // Credits short for what is due now: a pack covering all the rest, so it never pauses
  // midway (one purchase)
  const short = !!wallet && due.now > balance;
  const pack = short ? packFor(prices, Math.max(0, due.now + due.later - balance)) : null;
  // Enough for now, not for all of it: said, never pushed
  const coveredDays = short ? 0 : 1 + Math.floor((balance - due.now) / Math.max(1, quote.daily));

  const promote = async () => {
    setBusy(true);
    let bought = false;
    try {
      if (short) {
        if (!pack) throw Object.assign(new Error('No pack'), { code: 'unavailable' });
        await buyPack(pack);
        bought = true;
      }
      await promoteEvent(event.id, { radius, daily: quote.daily });
      refreshWallet().catch(() => {});
      successFeedback();
      router.back();
    } catch (error) {
      setBusy(false);
      if (error?.cancelled) return;
      Alert.alert(
        'Could not promote it',
        promotionMessage(error)
          ?? (error?.code === 'unavailable' ? 'Purchases are not available on this device.'
            : bought ? 'Your credits were added and stay yours. Check your connection and try again.'
              : 'Check your connection and try again. Nothing was charged.'),
      );
    }
  };

  const stop = () => {
    Alert.alert('Stop the promotion?', 'It stays promoted until the time already paid runs out, and nothing more is charged. Paid time comes back only if you cancel the event or cut it short.', [
      { text: 'Keep it', style: 'cancel' },
      {
        text: 'Stop',
        style: 'destructive',
        onPress: async () => {
          setBusy(true);
          try {
            await stopPromotion(event.id);
            router.back();
          } catch (error) {
            setBusy(false);
            Alert.alert('Could not stop it', failureMessage(error));
          }
        },
      },
    ]);
  };

  const priceOfPack = pack ? packPrice(pack) ?? formatCredits(pack.credits) : null;
  let label;
  if (unchanged) label = null;
  else if (short) label = pack ? `Add ${priceOfPack} and promote` : 'Promote';
  else if (due.paid) label = due.now ? `Widen to ${formatRadius(radius)} for ${formatCredits(due.now)}` : `Change to ${formatRadius(radius)}`;
  else label = `Promote for ${formatCredits(due.now)} now`;

  return (
    <View style={styles.page}>
      <SheetHeader title={live ? 'Promotion' : 'Promote'} leftLabel="Close" onLeft={() => router.back()} />
      {/* Wrapped: in an iOS form sheet a scroll view right under the screen is resized
          by the screens library and drawn out of view */}
      <View collapsable={false} style={styles.flex}>
      <ScrollView style={styles.flex} contentContainerStyle={styles.content}>
        <Text style={styles.intro}>
          {`“${event.title}” shows to people farther away, in their list of events nearby, marked as sponsored. On the map it shows like every event: to whoever has it in sight.`}
        </Text>

        <View style={styles.section}>
          <View style={styles.row}>
            <Text style={styles.label}>How far</Text>
            <Text style={styles.value}>{formatRadius(radius)}</Text>
          </View>
          <Slider values={radii} value={radius} onChange={setRadius} format={formatRadius} accessibilityLabel="How far" />
          <Text style={styles.note}>{`Free: within ${formatRadius(event.baseReach ?? prices.reach.max)}.`}</Text>
        </View>

        <View style={styles.group}>
          <Line styles={styles} label="A day" value={formatCredits(quote.daily)} detail={quote.discountPercent ? `${quote.discountPercent}% off for a long promotion` : null} />
          <View style={styles.divider} />
          <Line styles={styles} label="Now" value={formatCredits(due.now)} />
          <View style={styles.divider} />
          <Line styles={styles} label="At most" value={formatCredits(due.now + due.later)} detail="If you leave it on until the event ends" strong />
        </View>
        <Text style={styles.note}>
          {`Charged 24 hours at a time from your credits, the first now. Stop whenever you like: nothing more is charged. If you cancel the event or cut it short, the time not used comes back as credits, except the first ${prices.minHours ?? 6} hours.`}
        </Text>

        <View style={styles.group}>
          <Line styles={styles} label="Your credits" value={wallet ? formatCredits(balance) : '…'} />
          {live ? (
            <>
              <View style={styles.divider} />
              <Line styles={styles} label="Charged so far" value={formatCredits(promotion.charged)} />
            </>
          ) : null}
        </View>
        {short && pack ? (
          <Text style={styles.note}>
            {`Adds ${formatCredits(pack.credits)} of credits: enough for all of it. What is left stays yours for another promotion; credits never expire.`}
          </Text>
        ) : null}
        {wallet && !short && !unchanged && coveredDays < quote.days ? (
          <Text style={styles.note}>
            {`Your credits cover ${coveredDays === 1 ? 'the next 24 hours' : `about ${coveredDays} days`}. Add more by then, or it pauses until you do.`}
          </Text>
        ) : null}
        {!wallet ? (
          <Text style={[styles.note, walletFailed && styles.problem]}>
            {walletFailed ? 'Your credits could not be checked. Check your connection and try again.' : 'Checking your credits…'}
          </Text>
        ) : null}
        {wallet && short && !canBuy ? <Text style={[styles.note, styles.problem]}>Purchases are not available on this device.</Text> : null}
        {testPurchases && short ? <Text style={styles.note}>Development server: test credits, nothing is paid.</Text> : null}

        <Text style={styles.fine}>
          {process.env.EXPO_OS === 'ios' ? 'Payments are made through the App Store.' : 'Payments are made through Google Play.'} Credits are for promotions in this app only.
        </Text>
      </ScrollView>
      {/* Always in sight: at the sheet's first height the page goes on below its edge */}
      <View style={[styles.actions, { paddingBottom: insets.bottom + 12 }]}>
        {label ? <Button label={label} busy={busy} disabled={!wallet || (short && !canBuy)} onPress={promote} /> : null}
        {live || promotion?.status === 'paused' ? <Button label="Stop the promotion" variant="secondary" disabled={busy} onPress={stop} /> : null}
      </View>
      </View>
    </View>
  );
}

function Line({ styles, label, value, detail, strong }) {
  return (
    <View style={styles.line}>
      <View style={styles.flex}>
        <Text style={styles.lineLabel}>{label}</Text>
        {detail ? <Text style={styles.lineDetail}>{detail}</Text> : null}
      </View>
      <Text style={[styles.lineValue, strong && styles.strong]}>{value}</Text>
    </View>
  );
}

const createStyles = (colors) => StyleSheet.create({
  page: {
    flex: 1,
    backgroundColor: colors.page,
  },
  flex: {
    flex: 1,
  },
  content: {
    padding: 20,
    gap: 14,
  },
  intro: {
    fontSize: 15,
    lineHeight: 21,
    color: colors.active,
  },
  section: {
    gap: 4,
    marginTop: 6,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
  },
  label: {
    fontSize: 13,
    fontWeight: '700',
    color: colors.inactive,
  },
  value: {
    fontSize: 22,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
    color: colors.active,
  },
  note: {
    fontSize: 13,
    lineHeight: 18,
    color: colors.inactive,
  },
  problem: {
    color: colors.error,
  },
  group: {
    borderRadius: 14,
    borderCurve: 'continuous',
    backgroundColor: colors.surface,
    marginTop: 6,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 14,
    backgroundColor: colors.border,
  },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  lineLabel: {
    fontSize: 16,
    color: colors.active,
  },
  lineDetail: {
    fontSize: 13,
    color: colors.inactive,
    marginTop: 2,
  },
  lineValue: {
    fontSize: 16,
    fontVariant: ['tabular-nums'],
    color: colors.active,
  },
  strong: {
    fontWeight: '700',
  },
  actions: {
    gap: 10,
    paddingHorizontal: 20,
    paddingTop: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },
  fine: {
    fontSize: 12,
    lineHeight: 17,
    color: colors.inactive,
    textAlign: 'center',
  },
});
