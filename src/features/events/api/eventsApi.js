// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { discardPickedFile, uploadFile } from '../../api/uploads';

// Events on the backend (docs/API.md, Events): one method per operation. People in
// events are UserSummary objects ({ id, username, name, pictureUrl }): the organizer
// (`creator`), who is going (`followers`), who rated (`Rating.user`).

// Lists and dates always exist, so screens never meet a missing field. `creatorId`
// repeats `creator.id` for the rules (eventModel.js) that only need the ID. Fields only
// the details have (followers, ratings, myRating, album) are left out of a summary, so
// merging a summary never wipes the details already loaded.
export const normalizeEvent = (event) => ({
  ...event,
  creatorId: event.creator?.id ?? event.creatorId ?? null,
  dates: event.dates ?? {},
  imageUrls: event.imageUrls ?? [],
  categories: event.categories ?? [],
  theme: event.theme ?? null,
  followerCount: event.followerCount ?? event.followers?.length ?? 0,
  photoCount: event.photoCount ?? 0,
  // How far away people see it now (metres), and whether a promotion pays for that
  reach: event.reach ?? 800,
  sponsored: !!event.sponsored,
  // `following`: the user joins it (going); `saved`: their private bookmark. Their
  // connections going: how many, and the first few (UserSummary)
  saved: !!event.saved,
  friendsGoing: event.friendsGoing ?? 0,
  friends: event.friends ?? [],
});

const toQuery = (params) => {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value == null) continue;
    for (const item of Array.isArray(value) ? value : [value]) query.append(name, String(item));
  }
  const text = query.toString();
  return text ? `?${text}` : '';
};

const json = (body) => JSON.stringify(body);
const path = (eventId, rest = '') => `/events/${encodeURIComponent(eventId)}${rest}`;

/**
 * @param {object} deps
 * @param {(path: string, options?: RequestInit) => Promise<any>} deps.request - useApi()
 */
export function createEventsApi({ request }) {
  return {
    // GET /events: around a point, nearest first
    async getEvents({ range, categories, latitude, longitude }, { signal } = {}) {
      const answer = await request(`/events${toQuery({ latitude, longitude, range, categories })}`, { signal, revalidate: true });
      return (answer?.items ?? []).map(normalizeEvent);
    },

    // GET /me/events: the saved ones and the user's own, in one request
    async getOwnEvents({ signal } = {}) {
      const answer = await request('/me/events', { signal, revalidate: true });
      return { followed: (answer?.followed ?? []).map(normalizeEvent), created: (answer?.created ?? []).map(normalizeEvent) };
    },

    // GET /events/{id}: with who is going, the ratings and the album's rules
    async getEvDetails(eventId, { signal } = {}) {
      return normalizeEvent(await request(path(eventId), { signal }));
    },

    // POST /events → the new event. Flash events (from the map) send `flash` and
    // `spotsNeeded` (people still wanted, 0 = anyone welcome)
    // `key`: the same for every try of the same event: an answer lost on the way never
    // makes a second one
    async createEvent(fields, { key } = {}) {
      return normalizeEvent(await request('/events', { method: 'POST', body: json(fields), ...(key ? { headers: { 'Idempotency-Key': key } } : {}) }));
    },

    // PATCH /events/{id} with the changed fields → the event
    async modifyEvent(eventId, fields) {
      return normalizeEvent(await request(path(eventId), { method: 'PATCH', body: json(fields) }));
    },

    // The pictures, in order (the first is the cover; API.md images): an address the
    // event already shows stays, a file picked on the phone is uploaded first; [] none
    async setImages(eventId, photos) {
      const images = [];
      for (const photo of photos) {
        images.push(/^https?:\/\//.test(photo)
          ? { url: photo }
          : { uploadId: await uploadFile(request, { purpose: 'event-cover', eventId, uri: photo }) });
      }
      const event = normalizeEvent(await request(path(eventId), { method: 'PATCH', body: json({ images }) }));
      // The server has them: the copies picked on the phone go
      for (const photo of photos) discardPickedFile(photo);
      return event;
    },

    // DELETE /events/{id} → the cancelled event
    async cancelEvent(eventId) {
      return normalizeEvent(await request(path(eventId), { method: 'DELETE' }));
    },

    // PUT /events/{id}/promotion → the event (with `promotion`, the organizer's view).
    // `daily`: the price shown, so a price that changed meanwhile is never charged
    async promote(eventId, { radius, daily }) {
      return normalizeEvent(await request(path(eventId, '/promotion'), { method: 'PUT', body: json({ radius, daily }) }));
    },

    // DELETE /events/{id}/promotion → the event: nothing more is charged, and it stays
    // promoted until the time paid runs out
    async stopPromotion(eventId) {
      return normalizeEvent(await request(path(eventId, '/promotion'), { method: 'DELETE' }));
    },

    // Join / leave (going) → { following, followerCount }
    followEvent: (eventId) => request(path(eventId, '/followers/me'), { method: 'PUT' }),
    unfollowEvent: (eventId) => request(path(eventId, '/followers/me'), { method: 'DELETE' }),

    // Save / unsave (a private bookmark) → { saved }. Unsaving one that is over also
    // takes it out of the Saved list (the story keeps it)
    bookmarkEvent: (eventId) => request(path(eventId, '/saved/me'), { method: 'PUT' }),
    unbookmarkEvent: (eventId) => request(path(eventId, '/saved/me'), { method: 'DELETE' }),
    // Every event that is over out of the Saved list
    clearCancelledSaved: () => request('/me/saved/cancelled', { method: 'DELETE' }),


    rateEvent: (eventId, { rating, comment }) => request(path(eventId, '/ratings'), { method: 'POST', body: json({ rating, comment }) }),
    modifyRating: (eventId, { rating, comment }) => request(path(eventId, '/ratings/me'), { method: 'PUT', body: json({ rating, comment }) }),
    deleteRating: (eventId) => request(path(eventId, '/ratings/me'), { method: 'DELETE' }),

    // POST /reports (reasons: eventModel.js REPORT_REASONS)
    reportEvent: (eventId, { reportCategories, description }) => request('/reports', {
      method: 'POST',
      body: json({ kind: 'event', targetId: eventId, reasons: reportCategories, details: description || undefined }),
    }),
  };
}
