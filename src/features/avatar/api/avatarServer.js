// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { devHost } from '../../../lib/devHost';

// Where avatars come from. Until the backend exists, the local avatar server
// (avatar-server/, `make dev`) on the computer running Expo, like the map's
// tiles; EXPO_PUBLIC_AVATAR_URL points elsewhere (e.g. the real backend).
const LOCAL_PORT = 8092;

export const AVATAR_SERVER_URL = (process.env.EXPO_PUBLIC_AVATAR_URL
  || (devHost ? `http://${devHost}:${LOCAL_PORT}` : null))?.replace(/\/+$/, '') ?? null;

// Base of the catalog's relative file paths (models, textures, thumbnails)
export const AVATAR_FILES_URL = AVATAR_SERVER_URL ? `${AVATAR_SERVER_URL}/v1/files` : null;
