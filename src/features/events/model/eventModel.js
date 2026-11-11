// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { shortDayFormatter, timeFormatter } from '../../../lib/dateFormatters';

// Rules and formatting of events, from the API (docs/API.md, Events): the server
// checks the same limits. Screens never compute these themselves.

export const LIMITS = {
  title: 50,
  description: 500,
  comment: 500,
  report: 500,
  address: 200,
  link: 500,
};

// Ratings are 0–10 in the API, shown as five stars (one star = 2 points)
export const MAX_RATING = 10;
export const STARS = 5;

// Event.status in the API
export const STATUS = {
  upcoming: 'upcoming',
  ongoing: 'ongoing',
  concluded: 'concluded',
  cancelled: 'cancelled',
};

// reportEvent.reportCategories in the API
export const REPORT_REASONS = [
  { id: 'offensive content', label: 'Offensive content' },
  { id: 'inappropriate content', label: 'Inappropriate content' },
  { id: 'not an event', label: 'Not an event' },
];

// The area asked to the server for the events around (metres, its maximum). There is
// no distance to choose: each event's reach keeps the list local (800 m at most without
// a promotion; docs/PROMOTIONS.md)
export const NEARBY_RANGE = 10000;

// The point the events around are asked for from: the user's position rounded to 3
// decimals (about 100 m, docs/API.md): enough to find what is around, never their
// exact place, and the same point for everyone close by (answers repeat and cost a 304)
const roundCoordinate = (value) => Math.round(value * 1000) / 1000;
export const searchPoint = ({ latitude, longitude }) => ({ latitude: roundCoordinate(latitude), longitude: roundCoordinate(longitude) });
export const WHEN_OPTIONS = [
  { id: 'any', label: 'Any time' },
  { id: 'today', label: 'Today' },
  { id: 'week', label: 'Next 7 days' },
];
export const DEFAULT_FILTERS = { categories: [], when: 'any' };

// Filters kept on the phone (settingsStore), checked against today's options: anything
// unknown (an option removed since) falls back to the default. Null when nothing valid.
export function savedFilters(value, categoryIds) {
  if (!value || typeof value !== 'object') return null;
  return {
    categories: Array.isArray(value.categories) ? value.categories.filter((id) => categoryIds.has(id)) : [],
    when: WHEN_OPTIONS.some((option) => option.id === value.when) ? value.when : DEFAULT_FILTERS.when,
  };
}

const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;

const time = (iso) => (iso ? new Date(iso).getTime() : NaN);
const isValidDate = (date) => date instanceof Date && Number.isFinite(date.getTime());

// Only HTTPS links open from an event: its link is written by another user, and an
// insecure or app-specific scheme must never be followed. Returns the link or null.
export function safeWebLink(link) {
  if (typeof link !== 'string') return null;
  const value = link.trim();
  if (/\s/.test(value) || !/^https:\/\//i.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.hostname || url.username || url.password) return null;
    return url.href;
  } catch {
    return null;
  }
}

// The status from the dates, so a list loaded an hour ago does not show a finished
// event as "live". Cancelled events stay cancelled.
export function eventStatus(event, now = Date.now()) {
  if (!event) return STATUS.upcoming;
  if (event.status === STATUS.cancelled || event.dates?.cancelDate) return STATUS.cancelled;
  const start = time(event.dates?.startDate);
  const end = time(event.dates?.endDate);
  if (Number.isFinite(end) && now >= end) return STATUS.concluded;
  if (Number.isFinite(start) && now >= start) return STATUS.ongoing;
  return event.status ?? STATUS.upcoming;
}

export const isPast = (event, now) => {
  const status = eventStatus(event, now);
  return status === STATUS.concluded || status === STATUS.cancelled;
};

// Cancelled before it began: it never happened, so it may leave the Saved list and the
// user's own. One that took place, even in part, stays there (backend took_place)
export function cancelledBeforeStart(event) {
  const cancelled = time(event?.dates?.cancelDate);
  const start = time(event?.dates?.startDate);
  return Number.isFinite(cancelled) && Number.isFinite(start) && cancelled < start;
}

// Only ongoing and finished events can be rated (Rating in the API), by who joined them
export function canRate(event, userId, now = Date.now()) {
  const status = eventStatus(event, now);
  return (status === STATUS.ongoing || status === STATUS.concluded) && event.creatorId !== userId && !!event.following;
}

// How many people are going: the full list when loaded, else the list's count
export function goingCount(event) {
  return Math.max(event?.followerCount ?? 0, event?.followers?.length ?? 0);
}

const connectionsWord = (count) => (count === 1 ? '1 connection' : `${count} connections`);

// Who is going, in a few words for a card: "14 going · 2 connections", "You and 13
// others", "Just you so far"; once over, who went ("14 went"); null when nobody
export function goingLine(event, now = Date.now()) {
  const going = goingCount(event);
  const friends = event?.friendsGoing ?? 0;
  if (!going) return null;
  const others = going - 1;
  // A cancelled event never took place: nobody "went"
  const cancelled = eventStatus(event, now) === STATUS.cancelled;
  const over = !cancelled && isPast(event, now);
  const after = cancelled ? ' were going' : over ? ' went' : '';
  const people = event.following
    ? (others ? `You and ${others === 1 ? '1 other' : `${others} others`}${after}` : cancelled ? 'Only you were going' : over ? 'Only you went' : 'Just you so far')
    : `${going} ${cancelled ? 'were going' : over ? 'went' : 'going'}`;
  return friends ? `${people} · ${connectionsWord(friends)}` : people;
}

// Flash events: made on the spot from the map, starting within the hour
export const FLASH = {
  startOptions: [{ minutes: 0, label: 'Now' }, { minutes: 30, label: 'In 30 min' }, { minutes: 60, label: 'In 1 h' }],
  durationOptions: [{ minutes: 60, label: '1 h' }, { minutes: 120, label: '2 h' }, { minutes: 180, label: '3 h' }],
  maxSpots: 20,
  // Made only around the player (metres from them on the map): a flash event is a plan
  // for right here, right now
  maxDistance: 500,
};

// Room and limits of events (docs/API.md, Events): the server refuses the rest with
// 409 too_close / too_many_events; the app checks first with the events it knows
export const PLACEMENT = {
  // No event this close to another: the map shows every event from the moment it is
  // made until it ends (useMapEvents), so two would be drawn on top of each other
  minSpacingMeters: 15,
  // Events of one organizer not ended nor cancelled
  maxActive: 5,
};

// The known event, not ended nor cancelled, within minSpacingMeters of `location`, or
// null. `id`: the event being moved, which never blocks itself
export function crowdingEvent(events, { id, location }, now = Date.now()) {
  if (!location) return null;
  for (const other of events) {
    if (!other || other.id === id || isPast(other, now)) continue;
    const metres = distanceMeters(location, other.location);
    if (metres != null && metres < PLACEMENT.minSpacingMeters) return other;
  }
  return null;
}

// The user's events on or to come (not ended, not cancelled)
export function activeEventCount(events, userId, now = Date.now()) {
  return events.filter((event) => event && event.creatorId === userId && !isPast(event, now)).length;
}

export const tooCloseMessage = (event) => (event?.title
  ? `Too close to “${event.title}”: events need ${PLACEMENT.minSpacingMeters} m between them until they end.`
  : `Another event is less than ${PLACEMENT.minSpacingMeters} m away.`);
export const TOO_MANY_EVENTS_MESSAGE = `You already have ${PLACEMENT.maxActive} events on. Cancel one, or wait for one to end.`;

// The app's words for the server's refusal of a new or moved event, or null
export function placementMessage(error) {
  if (error?.code === 'too_close') return tooCloseMessage(null);
  if (error?.code === 'too_many_events') return TOO_MANY_EVENTS_MESSAGE;
  if (error?.code === 'too_far') return `Flash events are for right around you: within ${FLASH.maxDistance} m of where you are.`;
  if (error?.code === 'position_needed') return 'Your position is needed for a flash event. Turn on location and try again.';
  return null;
}

// The app's words for a refused Join, wherever it was pressed, or null when the refusal
// says nothing about the event (the connection, the server: failureMessage)
export function joinRefusal(error) {
  if (error?.code === 'full') return { title: 'This event is full', message: 'Everyone it was looking for has joined.' };
  if (error?.code === 'gone') return { title: 'This event is over', message: 'You can no longer join it.' };
  if (error?.code === 'forbidden') return { title: 'You can\'t join this event', message: 'The organizer removed you from it.' };
  if (error?.code === 'too_many_joined') return { title: 'You joined many events', message: 'Leave one you are not going to, then try again.' };
  return null;
}

// Asked before leaving, wherever it was pressed: it takes them out of more than a list
export const LEAVE_EVENT = {
  title: 'Not going any more?',
  message: "You leave its list of people and its chat. You can join again while it's on.",
};

// A flash event that asked for some people and has them all (the server refuses more)
export const isFull =(event) => !!event?.flash && (event.spotsNeeded ?? 0) > 0 && goingCount(event) >= event.spotsNeeded;

// "Looking for 2 more" (who already joined taken off), "Full", "Anyone welcome", or null
// for other events
export function spotsLine(event) {
  if (!event?.flash) return null;
  const spots = event.spotsNeeded ?? 0;
  if (spots <= 0) return 'Anyone welcome';
  const left = spots - goingCount(event);
  if (left <= 0) return 'Full';
  return left === 1 ? 'Looking for 1 more' : `Looking for ${left} more`;
}

// The address its organizer wrote, or null: "Near you" was once stored by the demo
// world as if it were one, and reads wrong to anyone not near it
export function eventAddress(event) {
  const address = event?.location?.address?.trim();
  return address && address !== 'Near you' ? address : null;
}

export function averageRating(ratings) {
  if (!ratings?.length) return null;
  return ratings.reduce((sum, rating) => sum + rating.rating, 0) / ratings.length;
}

// Distance in metres between two { latitude, longitude }
export function distanceMeters(from, to) {
  if (!from || !to) return null;
  const toRad = (degrees) => (degrees * Math.PI) / 180;
  const dLat = toRad(to.latitude - from.latitude);
  const dLon = toRad(to.longitude - from.longitude);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(from.latitude)) * Math.cos(toRad(to.latitude)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(a));
}

export function formatDistance(meters) {
  if (meters == null) return null;
  if (meters < 1000) return `${Math.max(50, Math.round(meters / 50) * 50)} m`;
  return `${(meters / 1000).toFixed(meters < 10000 ? 1 : 0)} km`;
}

export function formatRange(meters) {
  return meters < 1000 ? `${meters} m` : `${meters / 1000} km`;
}

const longDayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

// Formatters answer '' for a missing or invalid date (Intl throws on them)
export function formatDay(date, now = Date.now()) {
  if (!isValidDate(date)) return '';
  const days = Math.round((startOfDay(date) - startOfDay(new Date(now))) / DAY);
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Yesterday';
  return shortDayFormatter.format(date);
}

export const formatTime = (date) => (isValidDate(date) ? timeFormatter.format(date) : '');
export const formatLongDay = (date) => (isValidDate(date) ? longDayFormat.format(date) : '');

// Short label for the badge on a card
// Minutes until an upcoming event starts, when it starts within the hour, else null
export function startsInMinutes(event, now = Date.now()) {
  if (eventStatus(event, now) !== STATUS.upcoming) return null;
  const minutes = Math.round((time(event.dates?.startDate) - now) / 60000);
  return minutes < 60 ? Math.max(1, minutes) : null;
}

function statusLabel(event, now = Date.now()) {
  const status = eventStatus(event, now);
  if (status === STATUS.cancelled) return 'Cancelled';
  if (status === STATUS.concluded) return 'Ended';
  if (status === STATUS.ongoing) return 'Live now';
  const start = time(event.dates?.startDate);
  const minutes = Math.round((start - now) / 60000);
  if (minutes < 60) return `In ${Math.max(1, minutes)} min`;
  if (minutes < 6 * 60) return `In ${Math.round(minutes / 60)} h`;
  return formatDay(new Date(start), now);
}

export function matchesSearch(event, query) {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const text = `${event.title} ${event.description ?? ''} ${(event.categories ?? []).join(' ')} ${event.location?.address ?? ''}`.toLowerCase();
  return words.every((word) => text.includes(word));
}

// The filter the API does not apply: the time window (past events never show here)
export function applyLocalFilters(events, { when }, now = Date.now()) {
  const endOfToday = startOfDay(new Date(now)) + DAY;
  return events.filter((event) => {
    if (isPast(event, now)) return false;
    const start = time(event.dates?.startDate);
    if (when === 'today') return start < endOfToday;
    if (when === 'week') return start < now + 7 * DAY;
    return true;
  });
}

export function activeFilterCount(filters) {
  let count = filters.categories.length;
  if (filters.when !== DEFAULT_FILTERS.when) count++;
  return count;
}

// Validation of the event editor, with the API limits. Returns { field: message }.
// Events are organized at most a month ahead: their start within this many days of
// now (docs/API.md, Events); the server refuses the rest
export const MAX_DAYS_AHEAD = 31;
export const latestStart = (now = Date.now()) => new Date(now + MAX_DAYS_AHEAD * DAY);
// An event lasts at most this many days: it holds its place on everyone's map until it ends
const MAX_DAYS_LONG = 31;

// `originalStart`: the start of the event being edited (a start it already had is kept,
// even beyond a month ahead: only moving it there is refused)
export function validateDraft(draft, { isNew, now = Date.now(), originalStart = null }) {
  const errors = {};
  const title = draft.title.trim();
  if (!title) errors.title = 'Give your event a title';
  else if (title.length > LIMITS.title) errors.title = `At most ${LIMITS.title} characters`;
  const description = draft.description.trim();
  if (!description) errors.description = 'Tell people what the event is about';
  else if (description.length > LIMITS.description) errors.description = `At most ${LIMITS.description} characters`;
  if (draft.categories.length === 0) errors.categories = 'Pick at least one category';
  const startMoved = isNew || !originalStart || draft.startDate.getTime() !== originalStart.getTime();
  if (!isNew && originalStart && startMoved && originalStart.getTime() <= now) errors.startDate = 'The event has started: its start stays as it is';
  else if ((isNew || (originalStart && startMoved)) && draft.startDate.getTime() < now - 5 * 60000) errors.startDate = 'The event cannot start in the past';
  else if (startMoved && draft.startDate > latestStart(now)) errors.startDate = `Events start at most a month ahead: by ${formatDay(latestStart(now), now)}`;
  if (draft.endDate <= draft.startDate) errors.endDate = 'The event must end after it starts';
  else if (draft.endDate - draft.startDate > MAX_DAYS_LONG * DAY) errors.endDate = `An event lasts at most ${MAX_DAYS_LONG} days`;
  else if (draft.endDate.getTime() <= now) errors.endDate = 'The event must end in the future';
  if (!draft.location) errors.location = 'Set where the event takes place';
  if (draft.links.trim() && (!safeWebLink(draft.links) || !/^https:\/\/\S+\.\S+/i.test(draft.links.trim()))) errors.links = 'Enter a full link, starting with https://';
  return errors;
}

// What makes sending a new event again harmless (Idempotency-Key)
export const newEventKey = () => `e${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

// Editor draft → Event fields of createEvent / modifyEvent
export function draftToEvent(draft) {
  return {
    title: draft.title.trim(),
    description: draft.description.trim(),
    categories: draft.categories,
    location: draft.location,
    dates: { startDate: draft.startDate.toISOString(), endDate: draft.endDate.toISOString() },
    links: draft.links.trim() || null,
    reach: draft.reach,
  };
}

// How far away people see an event, free (metres; docs/API.md, Promotions)
const REACH = { min: 100, max: 800, step: 50, default: 800 };
export const REACH_VALUES = Array.from({ length: (REACH.max - REACH.min) / REACH.step + 1 }, (_, index) => REACH.min + index * REACH.step);

// A new event starts at the next full hour and lasts two hours
export function emptyDraft(now = Date.now()) {
  const start = new Date(Math.ceil((now + 30 * 60000) / HOUR) * HOUR);
  return {
    title: '',
    description: '',
    categories: [],
    startDate: start,
    endDate: new Date(start.getTime() + 2 * HOUR),
    location: null,
    links: '',
    reach: REACH.default,
  };
}

export function eventToDraft(event) {
  const fallback = emptyDraft();
  const start = new Date(event.dates?.startDate);
  const end = new Date(event.dates?.endDate);
  return {
    title: event.title ?? '',
    description: event.description ?? '',
    categories: event.categories ?? [],
    startDate: isValidDate(start) ? start : fallback.startDate,
    endDate: isValidDate(end) ? end : fallback.endDate,
    location: event.location ?? null,
    links: event.links ?? '',
    // The reach it was given (a promotion may show it farther for now: `reach`)
    reach: event.baseReach ?? Math.min(event.reach ?? REACH.default, REACH.max),
  };
}

// The time of an event as one short line for a list row, where the day is already
// the section title: "18:00 – 23:00", "Live now, until 23:00", "Ended"
export function timeLine(event, now = Date.now()) {
  const status = eventStatus(event, now);
  if (status === STATUS.cancelled) return 'Cancelled';
  if (status === STATUS.concluded) {
    const day = formatDay(new Date(event.dates.endDate), now);
    return `Ended ${['Today', 'Yesterday'].includes(day) ? day.toLowerCase() : day}`;
  }
  const start = new Date(event.dates.startDate);
  const end = new Date(event.dates.endDate);
  const endText = startOfDay(start) === startOfDay(end) ? formatTime(end) : `${formatDay(end, now)} ${formatTime(end)}`;
  if (status === STATUS.ongoing) return `Live now, until ${endText}`;
  return `${formatTime(start)} – ${endText}`;
}

// The same with its day, where no heading above it says which (the map's card)
export function whenLine(event, now = Date.now()) {
  const line = timeLine(event, now);
  return eventStatus(event, now) === STATUS.upcoming ? `${formatDay(new Date(event.dates?.startDate), now)} · ${line}` : line;
}

// Events in sections by day, in time order: "Happening now", "Today", "Tomorrow",
// "Sat 18 Oct"… Past events go to one "Past" section, most recent first.
export function groupByDay(events, now = Date.now()) {
  const sections = new Map();
  const add = (key, title, event) => {
    if (!sections.has(key)) sections.set(key, { key, title, data: [] });
    sections.get(key).data.push(event);
  };
  const sorted = [...events].sort((a, b) => time(a.dates?.startDate) - time(b.dates?.startDate));
  for (const event of sorted) {
    const status = eventStatus(event, now);
    if (status === STATUS.ongoing) add('now', 'Happening now', event);
  }
  for (const event of sorted) {
    if (eventStatus(event, now) !== STATUS.upcoming) continue;
    const start = new Date(event.dates?.startDate);
    if (isValidDate(start)) add(`day-${startOfDay(start)}`, formatDay(start, now), event);
    else add('later', 'Later', event);
  }
  const past = sorted.filter((event) => isPast(event, now)).reverse();
  for (const event of past) add('past', 'Past', event);
  return [...sections.values()];
}

// One line on the state of an event for its page: "Live now, until 23:00", "Starts in 3 h",
// "Ended", "Cancelled". Nothing when it would only repeat the date printed under it
export function statusLine(event, now = Date.now()) {
  const status = eventStatus(event, now);
  if (status === STATUS.cancelled) return 'Cancelled by the organizer';
  if (status === STATUS.concluded) return 'This event has ended';
  if (status === STATUS.ongoing) return timeLine(event, now);
  const label = statusLabel(event, now);
  return label.startsWith('In ') ? `Starts in ${label.slice(3)}` : null;
}
