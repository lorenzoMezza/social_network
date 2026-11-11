// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { uploadFile } from '../../api/uploads';
import { ALBUM_LIMITS, DEFAULT_SETTINGS } from '../model/albumModel';

// Event albums on the backend (docs/API.md, Albums). Photos carry their author as a
// UserSummary; `authorId` repeats its ID for the rules (albumModel.js).

const normalizeSettings = (settings) => ({
  whoCanPost: settings?.whoCanPost ?? DEFAULT_SETTINGS.whoCanPost,
  contributors: settings?.contributors ?? [],
});

const normalizePhoto = (photo) => ({
  ...photo,
  authorId: photo.author?.id ?? null,
  thumbUrl: photo.thumbUrl ?? photo.url,
  width: photo.width || 1,
  height: photo.height || 1,
});

const path = (eventId, rest = '') => `/events/${encodeURIComponent(eventId)}/photos${rest}`;
const json = (body) => JSON.stringify(body);

/**
 * @param {object} deps
 * @param {(path: string, options?: RequestInit) => Promise<any>} deps.request - useApi()
 */
export function createAlbumApi({ request }) {
  return {
    // Newest first, a page at a time
    async getAlbum(eventId, { cursor, signal } = {}) {
      const query = new URLSearchParams({ limit: '60', ...(cursor ? { cursor } : {}) });
      const answer = await request(`${path(eventId)}?${query}`, { signal });
      return {
        settings: normalizeSettings(answer?.settings),
        photos: (answer?.items ?? []).map(normalizePhoto),
        total: answer?.total ?? answer?.items?.length ?? 0,
        // How many more the user may add (the server's limits)
        room: answer?.room ?? ALBUM_LIMITS.perPick,
        nextCursor: answer?.nextCursor ?? null,
      };
    },

    // Organizer only
    async setAlbumSettings(eventId, settings) {
      return normalizeSettings(await request(path(eventId, '/settings'), { method: 'PUT', body: json(settings) }));
    },

    // The file to the storage, then the API publishes it (EXIF and position removed,
    // sizes made)
    // `sent`: the uploadId of a try before, whose file the storage already has (it is not
    // sent again); `onSent(uploadId)`: the file reached the storage; `key`: the same for
    // every try of this photo (API.md, Idempotency-Key). An upload is used once: naming it
    // again answers 410 when the try before did add the photo and only its answer was lost
    async uploadPhoto(eventId, { uri, mimeType, fileSize, width, height }, { signal, sent = null, onSent, key } = {}) {
      const uploadId = sent ?? await uploadFile(request, { purpose: 'event-photo', eventId, uri, mimeType: mimeType ?? 'image/jpeg', fileSize, width, height, signal });
      if (!sent) onSent?.(uploadId);
      return normalizePhoto(await request(path(eventId), {
        method: 'POST',
        body: json({ uploadId }),
        signal,
        ...(key ? { headers: { 'Idempotency-Key': key } } : {}),
      }));
    },

    deletePhoto: (eventId, photoId) => request(path(eventId, `/${encodeURIComponent(photoId)}`), { method: 'DELETE' }),

    // POST /reports (reasons: albumModel.js PHOTO_REPORT_REASONS)
    reportPhoto: (eventId, photoId, { reason }) => request('/reports', {
      method: 'POST',
      body: json({ kind: 'photo', targetId: photoId, eventId, reasons: [reason] }),
    }),
  };
}
