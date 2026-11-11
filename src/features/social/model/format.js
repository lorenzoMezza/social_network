// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { timeFormatter } from '../../../lib/dateFormatters';

// Times of chats and messages, the way messaging apps say them. They take milliseconds
// or the API's ISO strings.
const ms = (time) => (typeof time === 'string' ? Date.parse(time) : time);
const weekdayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const dayFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const longDayFormat = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
const startOfDay = (time) => new Date(time).setHours(0, 0, 0, 0);

export const formatTime = (time) => timeFormatter.format(ms(time));

// In the inbox: 14:05 today, "Yesterday", the weekday this week, else the date
export function formatChatTime(time, now = Date.now()) {
  time = ms(time);
  const days = Math.round((startOfDay(now) - startOfDay(time)) / 86400000);
  if (days <= 0) return timeFormatter.format(time);
  if (days === 1) return 'Yesterday';
  if (days < 7) return weekdayFormat.format(time);
  return dayFormat.format(time);
}

// Separators between days in a chat
export function formatDaySeparator(time, now = Date.now()) {
  time = ms(time);
  const days = Math.round((startOfDay(now) - startOfDay(time)) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return longDayFormat.format(time);
}

// "closes in 3 h", "closes in 25 min", "closes tomorrow"
export function formatCloses(time, now = Date.now()) {
  time = ms(time);
  const minutes = Math.round((time - now) / 60000);
  if (minutes < 60) return `closes in ${Math.max(minutes, 1)} min`;
  if (minutes < 24 * 60) return `closes in ${Math.round(minutes / 60)} h`;
  const days = Math.round(minutes / (24 * 60));
  return days === 1 ? 'closes tomorrow' : `closes in ${days} days`;
}

// When a connection was made, after "Connected": "today", "yesterday", "3 days ago",
// "on 18 Sep"
export function formatSince(time, now = Date.now()) {
  time = ms(time);
  const days = Math.floor((now - time) / 86400000);
  if (days < 1) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days} days ago`;
  return `on ${dayFormat.format(time)}`;
}

// "1 person", "12 people": the members of a group or an event chat
export const peopleCount = (count) => (count === 1 ? '1 person' : `${count ?? 0} people`);

// How long someone stays muted: "until 18:30" today, "until Mon" this week, else the
// date; null (muted until someone unmutes them): "until unmuted"
export function formatMutedUntil(time, now = Date.now()) {
  if (!time) return 'until unmuted';
  time = ms(time);
  const days = Math.round((startOfDay(time) - startOfDay(now)) / 86400000);
  if (days <= 0) return `until ${timeFormatter.format(time)}`;
  if (days < 7) return `until ${weekdayFormat.format(time)} ${timeFormatter.format(time)}`;
  return `until ${dayFormat.format(time)}`;
}
