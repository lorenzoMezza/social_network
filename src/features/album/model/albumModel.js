// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { STATUS, eventStatus } from '../../events/model/eventModel';

// An event's photo album: the photos its people took, shared in the app. It opens when
// the event starts and stays after it ends, so the evening can be seen again. The
// organizer decides who can add photos and can remove any of them; everyone removes
// their own. The server checks the same rules (docs/API.md): these only decide what
// the screens offer.

// Who can add photos (AlbumSettings.whoCanPost)
export const WHO_CAN_POST = {
  everyone: 'everyone',
  chosen: 'chosen',
  organizer: 'organizer',
};

export const WHO_CAN_POST_OPTIONS = [
  { value: WHO_CAN_POST.everyone, label: 'Everyone who joined', description: 'Anyone who joined the event' },
  { value: WHO_CAN_POST.chosen, label: 'People you choose', description: 'Pick them among who joined' },
  { value: WHO_CAN_POST.organizer, label: 'Only you', description: 'Nobody else can add photos' },
];

export const DEFAULT_SETTINGS = { whoCanPost: WHO_CAN_POST.everyone, contributors: [] };

export const ALBUM_LIMITS = {
  // Photos picked at once, and the largest file sent (after the picker's compression)
  perPick: 30,
  maxBytes: 20 * 1024 * 1024,
  // Sent at the same time: more would slow each of them down on a phone network
  concurrentUploads: 2,
  // Asked per page of the album
  pageSize: 60,
};

// The picker re-encodes as JPEG at this quality: a phone photo of 3-6 MB becomes
// about 1-2 MB, with no visible loss on a phone screen
export const PICK_QUALITY = 0.8;

// Why a photo is reported. "Shows me" comes first: at events, people end up in
// photos they did not want shared.
export const PHOTO_REPORT_REASONS = [
  { value: 'shows_me', label: "I'm in it and don't want it shared" },
  { value: 'inappropriate', label: 'Nudity or violence' },
  { value: 'harassment', label: 'Mocks or targets someone' },
  { value: 'unrelated', label: 'Spam or not from this event' },
];

export const isOrganizer = (event, user) => !!user?.id && event?.creatorId === user.id;
// Whether the user joined the event (is going): the server says so on every event
const joined = (event, user) => !!user && (event?.following ?? event?.followers?.some((person) => person.id === user.id) ?? false);

// The album exists from the start of the event (photos are taken there), and not for
// cancelled events
export function albumOpen(event, now = Date.now()) {
  if (!event?.dates?.startDate) return false;
  const status = eventStatus(event, now);
  return status === STATUS.ongoing || status === STATUS.concluded;
}

export function canPost(event, settings, user) {
  if (!albumOpen(event) || !user) return false;
  if (isOrganizer(event, user)) return true;
  const { whoCanPost, contributors } = settings ?? DEFAULT_SETTINGS;
  if (whoCanPost === WHO_CAN_POST.everyone) return joined(event, user);
  if (whoCanPost === WHO_CAN_POST.chosen) return joined(event, user) && (contributors ?? []).includes(user.id);
  return false;
}

// The organizer removes any photo, everyone else their own
export const canRemove = (event, photo, user) => isOrganizer(event, user) || (!!user?.id && photo?.authorId === user.id);

// "Everyone who joined can add photos": the rule, in words, under the album's title
export function whoCanPostLine(event, settings, user) {
  const { whoCanPost, contributors } = settings ?? DEFAULT_SETTINGS;
  const own = isOrganizer(event, user);
  if (whoCanPost === WHO_CAN_POST.organizer) return own ? 'Only you can add photos' : 'Only the organizer adds photos';
  if (whoCanPost === WHO_CAN_POST.chosen) {
    const count = contributors?.length ?? 0;
    if (!own) return canPost(event, settings, user) ? 'You were invited to add photos' : 'Only invited people add photos';
    return count ? `You and ${count === 1 ? '1 person' : `${count} people`} you chose can add photos` : 'Only you can add photos, choose who else';
  }
  return 'Everyone who joined can add photos';
}

export const photoCountLabel = (count) => (count === 1 ? '1 photo' : `${count} photos`);
