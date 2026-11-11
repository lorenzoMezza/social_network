// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { fetch } from 'expo/fetch';
import { File } from 'expo-file-system';
import { safeServiceUrl } from './apiConfig';

// A file to the storage (docs/API.md, Uploads): a signed address from the API, the
// bytes straight to the storage (never through the API), and the `uploadId` that the
// request using it names (profile picture, event cover, album photo). The server then
// strips the EXIF metadata, the GPS position first, and makes the sizes.
//   purpose: 'profile-picture' | 'event-cover' | 'event-photo' | 'group-picture' (chatId)
// The size said is the file's own, not what the picker reported: the storage holds the
// upload to it.
export async function uploadFile(request, { purpose, eventId, chatId, uri, mimeType = 'image/jpeg', fileSize, width, height, signal }) {
  const file = new File(uri);
  const ticket = await request('/uploads', {
    method: 'POST',
    body: JSON.stringify({ purpose, eventId, chatId, mimeType, fileSize: file.size || fileSize, width, height }),
    signal,
  });
  const uploadUrl = safeServiceUrl(ticket?.uploadUrl);
  if (!uploadUrl || typeof ticket?.uploadId !== 'string' || !ticket.uploadId) {
    throw new Error('The upload service returned an invalid ticket');
  }
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': mimeType, ...ticket.headers },
    body: file,
    signal,
  });
  if (!response.ok) throw Object.assign(new Error(`Upload failed: ${response.status}`), { status: response.status });
  return ticket.uploadId;
}

// A picture picked or taken in the app is a copy made by expo-image-picker in the app's
// caches folder, which would stay there for good: once the server has it (or the user
// dropped it), the copy goes. Files anywhere else are never touched.
const PICKED_COPY = /^file:\/\/.*\/(Caches|cache)\/ImagePicker\//;
export function discardPickedFile(uri) {
  if (typeof uri !== 'string' || !PICKED_COPY.test(uri)) return;
  try {
    const file = new File(uri);
    if (file.exists !== false) file.delete();
  } catch {
    // Already gone
  }
}
