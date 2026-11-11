// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { safeServiceUrl } from './apiConfig';

// uploads.js for the web build (the try-it demo of show-case/): a picture picked in a
// browser is a blob: or data: URL, read with fetch instead of expo-file-system. Same steps:
// a ticket from the API, the bytes to the storage, the uploadId back.
export async function uploadFile(request, { purpose, eventId, chatId, uri, mimeType = 'image/jpeg', fileSize, width, height, signal }) {
  const file = await (await fetch(uri)).blob();
  const type = file.type || mimeType;
  const ticket = await request('/uploads', {
    method: 'POST',
    body: JSON.stringify({ purpose, eventId, chatId, mimeType: type, fileSize: file.size || fileSize, width, height }),
    signal,
  });
  const uploadUrl = safeServiceUrl(ticket?.uploadUrl);
  if (!uploadUrl || typeof ticket?.uploadId !== 'string' || !ticket.uploadId) {
    throw new Error('The upload service returned an invalid ticket');
  }
  const response = await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': type, ...ticket.headers },
    body: file,
    signal,
  });
  if (!response.ok) throw Object.assign(new Error(`Upload failed: ${response.status}`), { status: response.status });
  return ticket.uploadId;
}

// The browser keeps no copy of a picked picture to clean up
export function discardPickedFile(uri) {
  if (typeof uri === 'string' && uri.startsWith('blob:')) URL.revokeObjectURL(uri);
}
