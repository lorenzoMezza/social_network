// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Edge cases of the app's rules: events, albums, names, chat times, QR codes, WebViews.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PLACEMENT, STATUS, activeEventCount, applyLocalFilters, canRate, cancelledBeforeStart, crowdingEvent, distanceMeters, eventStatus, formatDay, goingLine,
  MAX_DAYS_AHEAD, eventAddress, formatDistance, formatTime, groupByDay, isFull, joinRefusal, matchesSearch, placementMessage, safeWebLink, searchPoint, spotsLine, statusLine, timeLine, validateDraft, whenLine,
} from '../src/features/events/model/eventModel.js';
import { albumOpen, canPost, canRemove, whoCanPostLine } from '../src/features/album/model/albumModel.js';
import { BEAM_COLORS, BEAM_STYLES, SPONSORED_BEAM, beamColor, beamStyle, cleanTheme, themeToSave } from '../src/features/events/model/eventTheme.js';
import { cleanUsername, usernameProblem } from '../src/features/profile/model/names.js';
import { formatChatTime, formatCloses, formatDaySeparator, formatSince, formatTime as chatTime, peopleCount } from '../src/features/social/model/format.js';
import { decodeQr, encodeQr } from '../src/features/social/connect/protocol.js';
import { localPageOnly } from '../src/lib/localPageOnly.js';
import { notificationLink, notificationText, peopleLine } from '../src/features/notifications/model/notificationModel.js';
import {
  DEFAULT_PRICES, SPONSORED_SLOTS, packFor, promotionDue, promotionQuote, sponsoredFirst,
} from '../src/features/promotions/model/promotionModel.js';
import { storySections } from '../src/features/profile/model/story.js';
import { createResponseCache } from '../src/features/api/responseCache.js';
import { failureMessage } from '../src/features/api/failureMessage.js';

const HOUR = 3600 * 1000;
const NOW = Date.UTC(2026, 9, 15, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
const event = (startH, endH, extra = {}) => ({
  id: 'e1', title: 'Picnic', description: 'By the lake', categories: ['food'], creatorId: 'org',
  dates: { startDate: iso(NOW + startH * HOUR), endDate: iso(NOW + endH * HOUR) }, ...extra,
});

describe('links written by other people', () => {
  it('opens only HTTPS links', () => {
    assert.equal(safeWebLink('https://example.com/a?b=1'), 'https://example.com/a?b=1');
    assert.equal(safeWebLink('  https://example.com  '), 'https://example.com/');
    for (const bad of ['http://example.com', 'https://user:pass@example.com', 'javascript:alert(1)', 'JAVASCRIPT:alert(1)', 'file:///etc/passwd', 'data:text/html,<b>x', 'intent://scan', 'https://', 'https:// example.com', '//example.com', 'tel:123', null, 42, {}]) {
      assert.equal(safeWebLink(bad), null, String(bad));
    }
  });
});

describe('event status and rules', () => {
  it('derives the status from the dates, cancelled wins', () => {
    assert.equal(eventStatus(event(1, 2), NOW), STATUS.upcoming);
    assert.equal(eventStatus(event(-1, 2), NOW), STATUS.ongoing);
    assert.equal(eventStatus(event(-3, -1), NOW), STATUS.concluded);
    assert.equal(eventStatus(event(-1, 2, { status: 'cancelled' }), NOW), STATUS.cancelled);
    assert.equal(eventStatus(event(1, 2, { dates: { cancelDate: iso(NOW) } }), NOW), STATUS.cancelled);
  });

  it('survives missing or broken dates', () => {
    assert.equal(eventStatus(null, NOW), STATUS.upcoming);
    assert.equal(eventStatus({ dates: {} }, NOW), STATUS.upcoming);
    assert.equal(eventStatus({ dates: { startDate: 'nonsense', endDate: 'x' } }, NOW), STATUS.upcoming);
    assert.equal(formatDay(new Date('nonsense'), NOW), '');
    assert.equal(formatTime(new Date(NaN)), '');
  });

  it('lets only people who joined rate, once it started, never the organizer', () => {
    const joined = { following: true };
    assert.equal(canRate(event(1, 2, joined), 'me', NOW), false);
    assert.equal(canRate(event(-1, 2, joined), 'me', NOW), true);
    assert.equal(canRate(event(-3, -1, joined), 'me', NOW), true);
    assert.equal(canRate(event(-1, 2, joined), 'org', NOW), false);
    assert.equal(canRate(event(-1, 2, { ...joined, status: 'cancelled' }), 'me', NOW), false);
    // Who never joined has no say on it
    assert.equal(canRate(event(-1, 2), 'me', NOW), false);
    assert.equal(canRate(event(-3, -1, { following: false }), 'me', NOW), false);
  });

  it('counts down the people a flash event looks for, then it is full', () => {
    const flash = (spotsNeeded, followerCount) => event(0, 1, { flash: true, spotsNeeded, followerCount });
    assert.equal(spotsLine(event(0, 1)), null);
    assert.equal(spotsLine(flash(0, 9)), 'Anyone welcome');
    assert.equal(spotsLine(flash(3, 0)), 'Looking for 3 more');
    assert.equal(spotsLine(flash(3, 2)), 'Looking for 1 more');
    assert.equal(spotsLine(flash(3, 3)), 'Full');
    assert.equal(spotsLine(flash(3, 5)), 'Full');
    assert.equal(isFull(flash(3, 2)), false);
    assert.equal(isFull(flash(3, 3)), true);
    assert.equal(isFull(flash(0, 9)), false);
    assert.equal(isFull(event(0, 1, { spotsNeeded: 1, followerCount: 3 })), false);
  });

  it('refuses in the editor what never ends or is over', () => {
    const draft = {
      title: 'A', description: 'B', categories: ['food'], location: { latitude: 1, longitude: 1 }, links: '',
      startDate: new Date(NOW + HOUR), endDate: new Date(NOW + 2 * HOUR),
    };
    assert.deepEqual(validateDraft(draft, { isNew: true, now: NOW }), {});
    assert.ok(validateDraft({ ...draft, endDate: new Date(NOW + 40 * 24 * HOUR) }, { isNew: true, now: NOW }).endDate);
    assert.ok(validateDraft({ ...draft, startDate: new Date(NOW - 3 * HOUR), endDate: new Date(NOW - HOUR) }, { isNew: false, now: NOW }).endDate);
  });

  it('validates the editor with the API limits', () => {
    const good = { title: 'Picnic', description: 'Bring food', categories: ['food'], startDate: new Date(NOW + HOUR), endDate: new Date(NOW + 2 * HOUR), location: { latitude: 41.9, longitude: 12.5 }, links: '' };
    assert.deepEqual(validateDraft(good, { isNew: true, now: NOW }), {});
    const errors = validateDraft({ ...good, title: '  ', description: 'x'.repeat(501), categories: [], endDate: good.startDate, location: null, links: 'javascript:alert(1)' }, { isNew: true, now: NOW });
    assert.deepEqual(Object.keys(errors).sort(), ['categories', 'description', 'endDate', 'links', 'location', 'title']);
    assert.ok(validateDraft({ ...good, title: 'x'.repeat(51) }, { isNew: true, now: NOW }).title);
    assert.ok(validateDraft({ ...good, startDate: new Date(NOW - HOUR) }, { isNew: true, now: NOW }).startDate);
    // Editing an event that already started is allowed
    assert.equal(validateDraft({ ...good, startDate: new Date(NOW - HOUR) }, { isNew: false, now: NOW }).startDate, undefined);
  });

  it('lets events be organized at most a month ahead', () => {
    const good = { title: 'Picnic', description: 'Bring food', categories: ['food'], startDate: new Date(NOW + 30 * 24 * HOUR), endDate: new Date(NOW + 30 * 24 * HOUR + 2 * HOUR), location: { latitude: 41.9, longitude: 12.5 }, links: '' };
    assert.deepEqual(validateDraft(good, { isNew: true, now: NOW }), {});
    const late = { ...good, startDate: new Date(NOW + 32 * 24 * HOUR), endDate: new Date(NOW + 32 * 24 * HOUR + HOUR) };
    assert.match(validateDraft(late, { isNew: true, now: NOW }).startDate, /a month ahead/);
    // Moving an event there is refused; a start it already had is kept
    assert.ok(validateDraft(late, { isNew: false, now: NOW, originalStart: good.startDate }).startDate);
    assert.equal(validateDraft(late, { isNew: false, now: NOW, originalStart: late.startDate }).startDate, undefined);
    assert.equal(MAX_DAYS_AHEAD, 31);
  });

  it('filters and groups lists by time', () => {
    const list = [event(-3, -1, { id: 'past' }), event(-1, 1, { id: 'live' }), event(2, 3, { id: 'today' }), event(30, 31, { id: 'later' }), event(200, 201, { id: 'far' })];
    assert.deepEqual(applyLocalFilters(list, { when: 'any' }, NOW).map((e) => e.id), ['live', 'today', 'later', 'far']);
    assert.deepEqual(applyLocalFilters(list, { when: 'week' }, NOW).map((e) => e.id), ['live', 'today', 'later']);
    const sections = groupByDay(list, NOW);
    assert.equal(sections[0].title, 'Happening now');
    assert.equal(sections.at(-1).key, 'past');
    assert.equal(sections.flatMap((s) => s.data).length, list.length);
    assert.ok(timeLine(list[0], NOW).startsWith('Ended'));
    assert.ok(statusLine(list[1], NOW).startsWith('Live now'));
  });

  it('the status line only says what the date under it does not', () => {
    const starting = (hours) => ({
      dates: { startDate: new Date(NOW + hours * 3600000).toISOString(), endDate: new Date(NOW + (hours + 2) * 3600000).toISOString() },
    });
    assert.ok(statusLine(starting(2), NOW).startsWith('Starts in'));
    assert.equal(statusLine(starting(24 * 5), NOW), null);
  });

  it('searches every word, case-insensitive, with odd input', () => {
    const e = event(1, 2, { title: 'Vinyl Market', location: { address: 'Via Roma' } });
    assert.ok(matchesSearch(e, 'vinyl roma'));
    assert.ok(!matchesSearch(e, 'vinyl jazz'));
    assert.ok(matchesSearch(e, '   '));
    assert.ok(matchesSearch({ title: 'x' }, 'x'));
  });

  it('measures and formats distances, without positions too', () => {
    assert.equal(distanceMeters(null, { latitude: 1, longitude: 1 }), null);
    assert.ok(Math.abs(distanceMeters({ latitude: 41.9, longitude: 12.5 }, { latitude: 41.9 + 1000 / 111320, longitude: 12.5 }) - 1000) < 5);
    assert.equal(formatDistance(null), null);
    assert.equal(formatDistance(3), '50 m');
    assert.equal(formatDistance(1234), '1.2 km');
    assert.equal(formatDistance(25000), '25 km');
  });
});

describe('room between events and events on at once', () => {
  const here = { latitude: 41.9, longitude: 12.5 };
  const north = (metres) => ({ latitude: here.latitude + metres / 111320, longitude: here.longitude });
  const at = (location, startH, endH, extra) => event(startH, endH, { location, ...extra });
  const spot = (location, startH, endH, id) => ({ id, location, start: NOW + startH * HOUR, end: NOW + endH * HOUR });

  it('finds an event within 15 m', () => {
    const picnic = at(here, 1, 3);
    assert.equal(crowdingEvent([picnic], spot(north(10), 1, 2), NOW), picnic);
    assert.equal(crowdingEvent([picnic], spot(north(16), 1, 2), NOW), null);
  });

  it('keeps the place taken until the event ends, whenever the other one is', () => {
    // Every event is on the map until it ends: one next week would be drawn on top of it
    const picnic = at(here, 1, 3);
    assert.equal(crowdingEvent([picnic], spot(here, 20, 22), NOW), picnic);
    assert.equal(crowdingEvent([picnic], spot(here, 24 * 7, 24 * 7 + 2), NOW), picnic);
    // An event in a month takes the place from now on too
    const later = at(here, 24 * 30, 24 * 30 + 2);
    assert.equal(crowdingEvent([later], spot(here, 1, 2), NOW), later);
  });

  it('ignores ended, cancelled and the moved event itself', () => {
    assert.equal(crowdingEvent([at(here, -3, -1)], spot(here, 0, 1), NOW), null);
    assert.equal(crowdingEvent([at(here, 1, 3, { status: STATUS.cancelled })], spot(here, 1, 2), NOW), null);
    assert.equal(crowdingEvent([at(here, 1, 3)], spot(here, 1, 2, 'e1'), NOW), null);
    assert.equal(crowdingEvent([at(here, 1, 3)], { location: null, start: NOW, end: NOW + HOUR }, NOW), null);
  });

  it('counts the organizer\'s events on or to come', () => {
    const mine = [at(here, 1, 2), at(here, -1, 1), at(here, 100, 101), at(here, -5, -4), at(here, 1, 2, { status: STATUS.cancelled }), at(here, 1, 2, { creatorId: 'else' })];
    assert.equal(activeEventCount(mine, 'org', NOW), 3);
    assert.equal(PLACEMENT.maxActive, 5);
  });

  it('words the server\'s refusals', () => {
    assert.match(placementMessage({ code: 'too_close' }), /15 m/);
    assert.match(placementMessage({ code: 'too_many_events' }), /5 events/);
    assert.equal(placementMessage({ code: 'forbidden' }), null);
    assert.equal(placementMessage(null), null);
  });
});

describe('promotions', () => {
  const here = { latitude: 41.9, longitude: 12.5 };
  const north = (metres) => ({ latitude: here.latitude + metres / 111320, longitude: here.longitude });

  it('prices time as the server does: tier, discount for long promotions, at least six hours', () => {
    // Lasting 3 hours from now: charged the least, a quarter of a day
    assert.deepEqual(promotionQuote(DEFAULT_PRICES, event(1, 3), 2000, NOW), { radius: 2000, daily: 299, days: 1, discountPercent: 0, firstCharge: 75, total: 75 });
    // Until 61 hours from now: three days, 10% off; the first 24 hours now
    assert.deepEqual(promotionQuote(DEFAULT_PRICES, event(1, 61), 2000, NOW), { radius: 2000, daily: 269, days: 3, discountPercent: 10, firstCharge: 269, total: 684 });
    // Only what is left of it counts
    assert.equal(promotionQuote(DEFAULT_PRICES, event(-25, 35), 1000, NOW).days, 2);
    assert.equal(promotionQuote(DEFAULT_PRICES, event(1, 3), 1800, NOW), null);
    // A promotion running keeps the discount it started with, however little is left
    const running = { ...event(-100, 10), promotion: { status: 'live', startedAt: new Date(NOW - 100 * 3600 * 1000).toISOString() } };
    assert.equal(promotionQuote(DEFAULT_PRICES, running, 1000, NOW).discountPercent, 20);
  });

  it('charges only what a wider radius adds to the time already paid', () => {
    const paid = {
      ...event(-1, 47),
      promotion: { status: 'live', paidRate: 100, startedAt: new Date(NOW - 12 * 3600 * 1000).toISOString(), paidUntil: new Date(NOW + 12 * 3600 * 1000).toISOString() },
    };
    const quote = { daily: 300, firstCharge: 300 };
    assert.deepEqual(promotionDue(paid, quote, NOW), { now: 100, later: 438, paid: true });
    assert.equal(promotionDue(paid, { daily: 100, firstCharge: 100 }, NOW).now, 0);
    // The time paid has run out: a new 24 hours
    assert.equal(promotionDue(paid, quote, NOW + 13 * 3600 * 1000).paid, false);
    // Nothing paid: the first charge, the rest later
    assert.deepEqual(promotionDue(event(1, 61), { daily: 240, firstCharge: 240 }, NOW), { now: 240, later: 370, paid: false });
    // Paused: 24 hours from now, without the minimum all over again
    const paused = { ...event(-1, 2), promotion: { status: 'paused', paidRate: 100, paidUntil: new Date(NOW - 3600 * 1000).toISOString() } };
    assert.equal(promotionDue(paused, { daily: 240, firstCharge: 999 }, NOW).now, 20);
  });

  it('puts the two nearest sponsored events first, the rest in place', () => {
    const list = [
      event(1, 2, { id: 'far', sponsored: true, location: north(3000) }),
      event(1, 2, { id: 'plain', location: north(100) }),
      event(1, 2, { id: 'near', sponsored: true, location: north(500) }),
      event(1, 2, { id: 'mid', sponsored: true, location: north(1500) }),
      event(-3, -1, { id: 'ended', sponsored: true, location: north(10) }),
    ];
    const { top, rest } = sponsoredFirst(list, here, NOW);
    assert.equal(SPONSORED_SLOTS, 2);
    assert.deepEqual(top.map((e) => e.id), ['near', 'mid']);
    assert.deepEqual(rest.map((e) => e.id), ['far', 'plain', 'ended']);
  });

  it('suggests the smallest pack that covers everything', () => {
    const prices = { ...DEFAULT_PRICES, packs: [{ productId: 'b', credits: 999 }, { productId: 'a', credits: 499 }] };
    assert.equal(packFor(prices, 300).productId, 'a');
    assert.equal(packFor(prices, 800).productId, 'b');
    assert.equal(packFor(prices, 5000).productId, 'b');
  });
});

describe('who is going', () => {
  it('says how many, the user and their connections', () => {
    assert.equal(goingLine(event(1, 2, { followerCount: 0 }), NOW), null);
    assert.equal(goingLine(event(1, 2, { followerCount: 14 }), NOW), '14 going');
    assert.equal(goingLine(event(1, 2, { followerCount: 14, friendsGoing: 2 }), NOW), '14 going · 2 connections');
    assert.equal(goingLine(event(1, 2, { followerCount: 14, friendsGoing: 1, following: true }), NOW), 'You and 13 others · 1 connection');
    assert.equal(goingLine(event(1, 2, { followerCount: 2, following: true }), NOW), 'You and 1 other');
    assert.equal(goingLine(event(1, 2, { followerCount: 1, following: true }), NOW), 'Just you so far');
    assert.equal(goingLine(event(-3, -1, { followerCount: 9, following: true }), NOW), 'You and 8 others went');
    assert.equal(goingLine(event(-3, -1, { followerCount: 9 }), NOW), '9 went');
  });

  it('never says anyone went to an event that was cancelled', () => {
    const cancelled = (extra) => event(1, 2, { status: 'cancelled', ...extra });
    assert.equal(goingLine(cancelled({ followerCount: 5 }), NOW), '5 were going');
    assert.equal(goingLine(cancelled({ followerCount: 5, following: true, friendsGoing: 2 }), NOW), 'You and 4 others were going · 2 connections');
    assert.equal(goingLine(cancelled({ followerCount: 1, following: true }), NOW), 'Only you were going');
  });
});

describe('notifications', () => {
  const sara = { id: 's', name: 'Sara Moretti', username: 'sara' };
  const luca = { id: 'l', name: 'Luca', username: 'luca' };
  const picnic = { id: 'e1', title: 'Picnic' };
  it('names the people, the event, what happened', () => {
    assert.equal(peopleLine([sara]), 'Sara Moretti');
    assert.equal(peopleLine([sara, luca]), 'Sara Moretti and Luca');
    assert.equal(peopleLine([sara, luca], 5), 'Sara Moretti and 4 others');
    // Whole names: an account that is not a first and last name never reads cut
    assert.equal(peopleLine([{ id: 'f', name: 'f/8 and be there', username: 'f8' }], 22), 'f/8 and be there and 21 others');
    assert.equal(notificationText({ kind: 'event.joined', actors: [sara, luca], count: 3, event: picnic }).text, 'Sara Moretti and 2 others joined “Picnic”');
    assert.equal(notificationText({ kind: 'event.changed', actors: [], count: 1, event: picnic, data: { changes: ['time', 'place'] } }).text, '“Picnic” has a new time and place');
    assert.equal(notificationText({ kind: 'album.photos', actors: [sara], count: 4, event: picnic }).text, 'Sara Moretti added 4 photos to “Picnic”');
    assert.equal(notificationText({ kind: 'connect.invite', actors: [sara], count: 1, event: null }).text, 'Sara Moretti wanted to connect with you');
  });
  it('opens what it is about', () => {
    assert.deepEqual(notificationLink({ kind: 'event.joined', actors: [sara], event: picnic }), { pathname: '/event/[id]', params: { id: 'e1' } });
    assert.equal(notificationLink({ kind: 'promotion.paused', actors: [], event: picnic }).pathname, '/event-promote');
    assert.equal(notificationLink({ kind: 'album.photos', actors: [sara], event: picnic }).pathname, '/album/[id]');
    assert.equal(notificationLink({ kind: 'connect.invite', actors: [sara], event: null }).params.id, 's');
    assert.equal(notificationLink({ kind: 'event.cancelled', actors: [], event: null }), null);
  });
});

describe('album rules', () => {
  // These rules read the clock: events around the real now
  const at = (startH, endH, extra = {}) => ({ ...event(0, 0, extra), dates: { startDate: iso(Date.now() + startH * HOUR), endDate: iso(Date.now() + endH * HOUR) } });
  const user = { id: 'me' };
  const live = at(-1, 2, { following: true });
  it('is open from the start, never for cancelled events', () => {
    assert.equal(albumOpen(at(1, 2)), false);
    assert.equal(albumOpen(at(-1, 2)), true);
    assert.equal(albumOpen(at(-48, -47)), true);
    assert.equal(albumOpen(at(-1, 2, { status: 'cancelled' })), false);
    assert.equal(albumOpen(null), false);
  });

  it('lets post who the organizer chose', () => {
    assert.equal(canPost(live, { whoCanPost: 'everyone', contributors: [] }, user), true);
    assert.equal(canPost({ ...live, following: false }, { whoCanPost: 'everyone' }, user), false);
    assert.equal(canPost(live, { whoCanPost: 'chosen', contributors: ['someone'] }, user), false);
    assert.equal(canPost(live, { whoCanPost: 'chosen', contributors: ['me'] }, user), true);
    assert.equal(canPost(live, { whoCanPost: 'organizer' }, user), false);
    assert.equal(canPost(live, { whoCanPost: 'organizer' }, { id: 'org' }), true);
    assert.equal(canPost(live, { whoCanPost: 'everyone' }, null), false);
    assert.equal(canPost(at(1, 2, { following: true }), { whoCanPost: 'everyone' }, user), false);
    // From the details' followers when the summary flag is missing
    assert.equal(canPost(at(-1, 2, { followers: [{ id: 'me' }] }), { whoCanPost: 'everyone' }, user), true);
  });

  it('removes: the author their own, the organizer any', () => {
    assert.equal(canRemove(live, { authorId: 'me' }, user), true);
    assert.equal(canRemove(live, { authorId: 'other' }, user), false);
    assert.equal(canRemove(live, { authorId: 'other' }, { id: 'org' }), true);
    assert.equal(canRemove(live, { authorId: 'me' }, null), false);
    assert.equal(typeof whoCanPostLine(live, undefined, user), 'string');
  });
});

describe('usernames', () => {
  it('keeps only what a handle may hold', () => {
    assert.equal(cleanUsername('@Mario.Rossi!'), 'mario.rossi');
    assert.equal(cleanUsername('Ünïcødé ✨ 名前'), 'ncd');
    assert.equal(cleanUsername('a'.repeat(50)).length, 30);
    assert.equal(cleanUsername('<script>'), 'script');
  });

  it('says what is wrong', () => {
    assert.ok(usernameProblem('ab'));
    assert.ok(usernameProblem('.abc'));
    assert.ok(usernameProblem('abc.'));
    assert.ok(usernameProblem('a..b'));
    assert.equal(usernameProblem('mario_rossi.2'), null);
  });
});

describe('chat times', () => {
  it('takes milliseconds and the API strings alike', () => {
    const at = NOW - 2 * HOUR;
    assert.equal(chatTime(at), chatTime(iso(at)));
    assert.equal(formatChatTime(at, NOW), formatChatTime(iso(at), NOW));
    assert.equal(formatDaySeparator(iso(at), NOW), 'Today');
    assert.equal(formatSince(iso(NOW - 3 * 24 * HOUR), NOW), '3 days ago');
    // After "Connected": an older one says its day
    assert.match(formatSince(iso(NOW - 40 * 24 * HOUR), NOW), /^on \S/);
  });

  it('never says a closed chat closes in negative time', () => {
    assert.equal(formatCloses(iso(NOW - HOUR), NOW), 'closes in 1 min');
    assert.equal(formatCloses(NOW + 25 * HOUR, NOW), 'closes tomorrow');
  });
});

describe('QR codes', () => {
  const token = 'AbC-_' + 'x'.repeat(20);
  it('reads back what it writes', () => {
    assert.equal(decodeQr(encodeQr(token)), token);
  });

  it('refuses codes that are not ours or not tokens', () => {
    for (const bad of [token, `https://evil.example/${token}`, encodeQr('short'), encodeQr(`${token}/../x`), encodeQr(`${token} `), encodeQr('x'.repeat(200)), encodeQr(`${token}<script>`), '', null, 123]) {
      assert.equal(decodeQr(bad), null, String(bad));
    }
  });
});

describe('WebViews stay on their page', () => {
  const allow = localPageOnly('file:///app/assets/map.html');
  it('allows the page itself and blank, nothing else', () => {
    assert.equal(allow({ url: 'file:///app/assets/map.html' }), true);
    assert.equal(allow({ url: 'file:///app/assets/map.html#debug' }), true);
    assert.equal(allow({ url: 'about:blank' }), true);
    for (const url of ['https://evil.example', 'http://localhost:7777', 'file:///app/assets/other.html', 'file:///etc/passwd', 'javascript:alert(1)', '', undefined]) {
      assert.equal(allow({ url }), false, String(url));
    }
  });
});

describe('the point the events around are asked from', () => {
  it('is rounded to about 100 m, the same for people close by', () => {
    assert.deepEqual(searchPoint({ latitude: 41.89534, longitude: 12.49176 }), { latitude: 41.895, longitude: 12.492 });
    assert.deepEqual(searchPoint({ latitude: 41.89531, longitude: 12.49158 }), searchPoint({ latitude: 41.89534, longitude: 12.49176 }));
    assert.deepEqual(searchPoint({ latitude: -33.86882, longitude: 151.20929 }), { latitude: -33.869, longitude: 151.209 });
  });
});

describe('an event\'s address', () => {
  it('is what its organizer wrote, never a stand-in', () => {
    assert.equal(eventAddress({ location: { address: ' Via Roma 1 ' } }), 'Via Roma 1');
    assert.equal(eventAddress({ location: { address: 'Near you' } }), null);
    assert.equal(eventAddress({ location: { address: '  ' } }), null);
    assert.equal(eventAddress({ location: {} }), null);
    assert.equal(eventAddress(null), null);
  });
});

describe('a profile\'s story', () => {
  const at = (iso) => iso;
  it('groups by month, coming up first, and leaves out what it cannot draw', () => {
    const sections = storySections([
      { id: 'a', kind: 'going', event: { id: 'e1', title: 'Soon' }, at: at('2026-11-02T18:00:00Z'), upcoming: true },
      { id: 'b', kind: 'organized', event: { id: 'e2', title: 'Picnic' }, at: at('2026-10-05T18:00:00Z') },
      { id: 'c', kind: 'went', event: null, at: at('2026-10-04T18:00:00Z') }, // its event is gone
      { id: 'd', kind: 'teleported', event: { id: 'e3', title: 'New kind' }, at: at('2026-10-03T18:00:00Z') }, // a kind added later
      { id: 'e', kind: 'connected', person: { id: 'me', name: 'Me' }, at: at('2026-09-01T18:00:00Z') },
      { id: 'f', kind: 'reviewed', event: { id: 'e4', title: 'No date' } }, // no date
    ], 'me');
    assert.deepEqual(sections.map((section) => section.data.map((entry) => entry.key)), [['a'], ['b'], ['e']]);
    assert.equal(sections[0].title, 'Coming up');
    assert.equal(sections[2].data[0].withYou, true);
    assert.equal(sections[1].data[0].event.creatorId, null, 'events come normalized');
    assert.deepEqual(storySections(undefined, 'me'), []);
  });
});

describe('member counts', () => {
  it('says person and people', () => {
    assert.equal(peopleCount(1), '1 person');
    assert.equal(peopleCount(2), '2 people');
    assert.equal(peopleCount(undefined), '0 people');
  });
});

describe('answers kept to ask again cheaply', () => {
  it('keeps the newest ones, and only what has an ETag', () => {
    const cache = createResponseCache(2);
    cache.set('/a', 'W/"1"', { a: 1 });
    assert.deepEqual(cache.get('/a'), { etag: 'W/"1"', body: { a: 1 } });
    cache.set('/b', 'W/"2"', { b: 1 });
    // Used again, so /b is the oldest when /c arrives… set again moves it last
    cache.set('/a', 'W/"3"', { a: 2 });
    cache.set('/c', 'W/"4"', { c: 1 });
    assert.equal(cache.get('/b'), null);
    assert.equal(cache.get('/a').etag, 'W/"3"');
    assert.equal(cache.size, 2);
    // An answer without an ETag cannot be checked later: what was kept goes
    cache.set('/a', null, { a: 3 });
    assert.equal(cache.get('/a'), null);
    cache.clear();
    assert.equal(cache.size, 0);
  });
});

describe('being taken out of an event', () => {
  it('says so, and leads to the event', () => {
    const event = { id: 'e1', title: 'Picnic' };
    assert.match(notificationText({ kind: 'event.removed', actors: [], count: 1, event }).text, /removed from “Picnic”/);
    assert.deepEqual(notificationLink({ kind: 'event.removed', actors: [], event }), { pathname: '/event/[id]', params: { id: 'e1' } });
  });

  it('who is not going adds no photos, even if chosen before', () => {
    const live = { id: 'e1', creatorId: 'org', following: false, dates: { startDate: new Date(Date.now() - HOUR).toISOString(), endDate: new Date(Date.now() + HOUR).toISOString() } };
    assert.equal(canPost(live, { whoCanPost: 'chosen', contributors: ['me'] }, { id: 'me' }), false);
    assert.equal(canPost({ ...live, following: true }, { whoCanPost: 'chosen', contributors: ['me'] }, { id: 'me' }), true);
  });
});

describe('what to say when something did not happen', () => {
  it('blames the connection only when it is the connection', () => {
    assert.match(failureMessage({ status: 0 }), /connection/);
    assert.match(failureMessage(new Error('x')), /connection/);
    for (const status of [400, 403, 404, 409, 410, 413, 422, 429, 500, 503]) {
      assert.doesNotMatch(failureMessage({ status }), /connection/, String(status));
    }
    assert.match(failureMessage({ status: 410 }), /no longer possible/);
    assert.match(failureMessage({ status: 429 }), /Wait a moment/);
  });
});

describe('when an event is, with nothing above it to say the day', () => {
  it('names the day of one to come, not of one under way or over', () => {
    assert.ok(whenLine(event(1, 2), NOW).startsWith('Today · '));
    assert.ok(whenLine(event(24, 25), NOW).startsWith('Tomorrow · '));
    assert.ok(whenLine(event(-1, 2), NOW).startsWith('Live now'));
    assert.ok(whenLine(event(-3, -1), NOW).startsWith('Ended'));
    assert.equal(whenLine(event(1, 2, { status: 'cancelled' }), NOW), 'Cancelled');
  });
});

describe('a Join the server refused', () => {
  it('says why when the event is the reason, whichever button it was', () => {
    for (const code of ['full', 'gone', 'forbidden', 'too_many_joined']) {
      assert.ok(joinRefusal({ code })?.title, code);
    }
  });

  it('leaves the connection and the server to the general message', () => {
    for (const error of [null, {}, { status: 0 }, { code: 'rate_limited' }, { status: 500, code: 'internal' }]) {
      assert.equal(joinRefusal(error), null);
    }
  });
});

describe('an event already under way', () => {
  it('keeps its start, and no start moves into the past', async () => {
    const { validateDraft } = await import('../src/features/events/model/eventModel.js');
    const now = Date.parse('2026-11-04T12:00:00Z');
    const draft = (startDate) => ({
      title: 'T', description: 'D', categories: ['party'], location: { latitude: 1, longitude: 1 }, links: '',
      startDate: new Date(startDate), endDate: new Date(now + 48 * 3600 * 1000),
    });
    const started = new Date(now - 3600 * 1000);
    assert.equal(validateDraft(draft(now + 3600 * 1000), { isNew: false, now, originalStart: started }).startDate, 'The event has started: its start stays as it is');
    assert.equal(validateDraft(draft(started), { isNew: false, now, originalStart: started }).startDate, undefined);
    const later = new Date(now + 3600 * 1000);
    assert.equal(validateDraft(draft(now - 3600 * 1000), { isNew: false, now, originalStart: later }).startDate, 'The event cannot start in the past');
    assert.equal(validateDraft(draft(now + 7200 * 1000), { isNew: false, now, originalStart: later }).startDate, undefined);
  });
});

describe('what may leave the lists', () => {
  const dates = (startDate, cancelDate) => ({ dates: { startDate, endDate: '2030-01-01T20:00:00.000Z', cancelDate } });
  it('only an event cancelled before it began', () => {
    assert.equal(cancelledBeforeStart(dates('2030-01-01T18:00:00.000Z', '2030-01-01T10:00:00.000Z')), true);
    assert.equal(cancelledBeforeStart(dates('2030-01-01T18:00:00.000Z', '2030-01-01T19:00:00.000Z')), false);
    assert.equal(cancelledBeforeStart(dates('2030-01-01T18:00:00.000Z')), false);
    assert.equal(cancelledBeforeStart(null), false);
  });
});

describe('the beam of an event', () => {
  it('is apart from the page colour, and only one of those offered', () => {
    const theme = cleanTheme({ color: '#4D78BF', beam: BEAM_COLORS[0].color });
    assert.equal(theme.color, '#4D78BF');
    assert.equal(theme.beam, BEAM_COLORS[0].color);
    assert.equal(beamColor({ color: BEAM_COLORS[0].color }), null);
    assert.equal(beamColor({ beam: '#123456' }), null);
  });

  it('can never be the gold of sponsored events', () => {
    assert.equal(beamColor({ beam: SPONSORED_BEAM }), null);
    assert.ok(BEAM_COLORS.every(({ color }) => color !== SPONSORED_BEAM));
  });

  it('is saved even when it is the only choice', () => {
    assert.equal(themeToSave({ beam: BEAM_COLORS[1].color }).beam, BEAM_COLORS[1].color);
    assert.equal(themeToSave({ beamStyle: 'helix' }).beamStyle, 'helix');
    assert.equal(themeToSave({ beamStyle: 'beam' }), null);
    assert.equal(themeToSave({}), null);
  });

  it('looks like one of the styles offered, else a plain beam', () => {
    assert.ok(BEAM_STYLES.some(({ id }) => id === 'helix'));
    assert.equal(beamStyle({ beamStyle: 'veil' }), 'veil');
    assert.equal(beamStyle({ beamStyle: 'laser' }), 'beam');
    assert.equal(beamStyle(null), 'beam');
  });
});
