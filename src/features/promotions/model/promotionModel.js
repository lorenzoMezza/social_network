// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { STATUS, distanceMeters, eventStatus } from '../../events/model/eventModel';

// Reach and promotions of events (docs/API.md, Promotions; the reasons in
// docs/PROMOTIONS.md). The server decides and charges; the app shows the same prices,
// from the price list the server sends (GET /promotions/prices).

// The price list until the server's arrives: the same values
export const DEFAULT_PRICES = {
  currency: 'EUR',
  reach: { min: 100, max: 800, step: 50, default: 800 },
  tiers: [
    { radius: 1000, daily: 99 }, { radius: 1500, daily: 199 }, { radius: 2000, daily: 299 }, { radius: 3000, daily: 499 },
    { radius: 4000, daily: 699 }, { radius: 5000, daily: 899 }, { radius: 7500, daily: 1099 }, { radius: 10000, daily: 1299 },
  ],
  durationDiscounts: [{ fromDays: 2, percent: 10 }, { fromDays: 4, percent: 20 }, { fromDays: 8, percent: 30 }],
  zoneFactor: 1,
  minHours: 6,
  packs: [],
  devPurchases: false,
};

// At most this many sponsored events open the nearby list: the nearest
export const SPONSORED_SLOTS = 2;

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const time = (iso) => (iso ? new Date(iso).getTime() : NaN);

// How many days it runs if nobody stops it, from `since` to the event's end
function promotedDays(event, since) {
  const length = time(event?.dates?.endDate) - since;
  return Number.isFinite(length) ? Math.max(1, Math.ceil(length / DAY)) : 1;
}

// A stretch of time at a price a day, in whole credits (up: a charge)
const cost = (daily, milliseconds) => Math.ceil((daily * milliseconds) / DAY);

export function discountPercent(prices, days) {
  return Math.max(0, ...prices.durationDiscounts.filter((discount) => days >= discount.fromDays).map((discount) => discount.percent));
}

// What promoting `event` at `radius` (one of the tiers) costs from now, as the server
// computes it (promotions.quote): a day, the first charge (at least the minimum of hours,
// whatever is cancelled later) and at most, if nobody stops it. A promotion running keeps
// the discount of the days it was started for.
export function promotionQuote(prices, event, radius, now = Date.now()) {
  const tier = prices.tiers.find((entry) => entry.radius === radius);
  if (!tier) return null;
  const running = ['live', 'stopped', 'paused'].includes(event?.promotion?.status);
  const percent = discountPercent(prices, promotedDays(event, running ? time(event.promotion.startedAt) : now));
  const daily = Math.round((tier.daily * (100 - percent)) / 100 * prices.zoneFactor);
  const left = Math.max(0, time(event?.dates?.endDate) - now);
  const least = (prices.minHours ?? DEFAULT_PRICES.minHours) * HOUR;
  return {
    radius,
    daily,
    days: promotedDays(event, now),
    discountPercent: percent,
    firstCharge: cost(daily, Math.max(least, Math.min(DAY, left))),
    total: cost(daily, Math.max(least, left)),
  };
}

// What pressing the button charges now (promotions.promote), and what the rest would come
// to until the event's end. With time still paid: only what a wider radius adds to it.
export function promotionDue(event, quote, now = Date.now()) {
  const promotion = event?.promotion;
  const end = time(event?.dates?.endDate);
  const paidUntil = time(promotion?.paidUntil);
  if (['live', 'stopped'].includes(promotion?.status) && now < paidUntil) {
    return {
      now: cost(Math.max(0, quote.daily - (promotion.paidRate ?? 0)), paidUntil - now),
      later: cost(quote.daily, Math.max(0, end - paidUntil)),
      paid: true,
    };
  }
  const left = Math.max(0, end - now);
  const first = promotion?.status === 'paused' ? cost(quote.daily, Math.min(DAY, left)) : quote.firstCharge;
  return { now: first, later: cost(quote.daily, Math.max(0, left - DAY)), paid: false };
}

// The smallest credit pack that covers `needed` (all of it, so the promotion never
// pauses for lack of credits), else the largest
export function packFor(prices, needed) {
  const packs = [...prices.packs].sort((a, b) => a.credits - b.credits);
  return packs.find((pack) => pack.credits >= needed) ?? packs.at(-1) ?? null;
}

const euro = new Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR' });

// Credits are euro cents
export const formatCredits = (credits) => euro.format((credits ?? 0) / 100);

export const formatRadius = (metres) => (metres < 1000 ? `${metres} m` : `${metres / 1000} km`);

// The nearby list: the nearest SPONSORED_SLOTS sponsored events first (`top`), then the
// rest as usual (`rest`: other sponsored events keep their place there, still marked)
export function sponsoredFirst(events, position, now = Date.now()) {
  const sponsored = events
    .filter((event) => event.sponsored && eventStatus(event, now) !== STATUS.concluded && eventStatus(event, now) !== STATUS.cancelled)
    .map((event) => ({ event, metres: distanceMeters(position, event.location) ?? Infinity }))
    // The nearest; as near (within 50 m of each other), the one starting first
    .sort((a, b) => (Math.abs(a.metres - b.metres) > 50 ? a.metres - b.metres : time(a.event.dates?.startDate) - time(b.event.dates?.startDate)))
    .slice(0, SPONSORED_SLOTS)
    .map(({ event }) => event);
  const top = new Set(sponsored.map((event) => event.id));
  return { top: sponsored, rest: events.filter((event) => !top.has(event.id)) };
}

// The app's words for the server's refusals of a promotion, or null
export function promotionMessage(error) {
  if (error?.code === 'insufficient_balance') return 'Not enough credits. Add some, then try again.';
  if (error?.code === 'price_changed') return 'The price just changed. Check the new one, then try again.';
  if (error?.code === 'gone') return 'This event is over.';
  return null;
}

// The organizer's row on the event's page: what its promotion does now (Event.promotion)
export function promotionRow(event) {
  const promotion = event.promotion;
  const radius = promotion ? formatRadius(promotion.radius) : null;
  if (promotion?.status === 'live') {
    return {
      title: `Promoted within ${radius}`,
      subtitle: `${formatCredits(promotion.daily)} a day · ${promotion.daysLeft ? 'charged 24 h at a time' : 'nothing more to pay'}`,
    };
  }
  if (promotion?.status === 'paused') return { title: 'Promotion paused', subtitle: 'Not enough credits to go on: add some to resume' };
  if (promotion?.status === 'stopped' && event.sponsored) return { title: `Promoted within ${radius} for now`, subtitle: 'Stopped: it ends with the time already paid' };
  return { title: 'Promote your event', subtitle: `Seen within ${formatRadius(event.baseReach ?? event.reach)}. Show it farther` };
}
