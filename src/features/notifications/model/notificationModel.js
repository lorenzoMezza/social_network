// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Words and destinations of the notifications (docs/API.md, Notifications). The
// server says what happened (kind, who, which event, how many); the app says it.

// "Sara Moretti", "Sara Moretti and Luca", "Sara Moretti and 3 others" (`count`: the
// people in all). Whole names: many accounts are not a first and last name ("Blue Note
// TV", "f/8 and be there"), and cut at the first word they read wrong
export function peopleLine(actors, count = actors.length) {
  const [first, second] = actors.map((person) => person.name || person.username || 'Someone');
  if (!first) return count > 1 ? `${count} people` : 'Someone';
  if (count <= 1) return first;
  if (count === 2 && second) return `${first} and ${second}`;
  return `${first} and ${count - 1} others`;
}

const quoted = (event) => (event?.title ? `“${event.title}”` : 'an event');

// { text, icon } of a notification: one sentence, what happened first
export function notificationText({ kind, actors, count, event, data }) {
  switch (kind) {
    case 'event.joined':
      return { text: `${peopleLine(actors, count)} joined ${quoted(event)}`, icon: 'person-add-outline' };
    case 'event.rated':
      return { text: `${peopleLine(actors, count)} rated ${quoted(event)}`, icon: 'star-outline' };
    case 'album.photos': {
      const photos = count === 1 ? 'a photo' : `${count} photos`;
      return { text: `${peopleLine(actors, Math.min(actors.length, count))} added ${photos} to ${quoted(event)}`, icon: 'images-outline' };
    }
    case 'event.changed': {
      const changes = data?.changes ?? [];
      const what = changes.includes('time') && changes.includes('place') ? 'a new time and place' : changes.includes('place') ? 'a new place' : 'a new time';
      return { text: `${quoted(event)} has ${what}`, icon: 'create-outline' };
    }
    case 'event.cancelled':
      // Its organizer's account is gone, and the event with it: its name came with the notice
      return { text: `${quoted(event ?? { title: data?.title })} was cancelled`, icon: 'close-circle-outline' };
    case 'event.removed':
      return { text: `You were removed from ${quoted(event)}`, icon: 'remove-circle-outline' };
    case 'event.starting':
      return { text: `${quoted(event)} starts soon`, icon: 'time-outline' };
    case 'promotion.paused':
      return { text: `The promotion of ${quoted(event)} is paused: not enough credits to go on`, icon: 'megaphone-outline' };
    case 'connect.invite':
      return { text: `${peopleLine(actors, 1)} wanted to connect with you`, icon: 'link-outline' };
    default:
      return { text: 'Something new', icon: 'notifications-outline' };
  }
}

// Where tapping it goes (a route for expo-router), or null
export function notificationLink({ kind, event, actors }) {
  if (kind === 'promotion.paused' && event) return { pathname: '/event-promote', params: { id: event.id } };
  if (kind === 'album.photos' && event) return { pathname: '/album/[id]', params: { id: event.id } };
  if (kind === 'connect.invite' && actors[0]) return { pathname: '/user/[id]', params: { id: actors[0].id, name: actors[0].name, username: actors[0].username } };
  if (event) return { pathname: '/event/[id]', params: { id: event.id } };
  return null;
}
