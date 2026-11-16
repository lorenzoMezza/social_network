// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { createHttpCache } from '../../shared/httpCache.js';
import { CACHE_BUDGETS } from '../../shared/cacheBudgets.js';

// The avatar files on the device (shared/httpCache.js): the item models and face
// textures of the avatars shown, emotes, and the map avatars of the people around.
// One cache for every page (the profiles' viewers and the map), CACHE_BUDGETS.avatarFiles
// at most, the least recently used going first; the user's own avatar is pinned
// (keepOnDevice in composeAvatar.js), so it shows at once whatever else was seen, and
// the map avatars of their connections go only after everyone else's (map main.js). Whether someone's
// avatar changed is the API's to say (avatarVersion): a new look wears other items,
// that is other files, so a stored file is never out of date for its address.
const MAX_BYTES = CACHE_BUDGETS.avatarFiles;

export const avatarFiles = createHttpCache({ name: 'avatar-file-cache', label: 'Avatar cache', maxBytes: MAX_BYTES });

// A file's bytes, from the device when it was downloaded before
export async function avatarFileBytes(url) {
  const response = await avatarFiles.fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.arrayBuffer();
}
