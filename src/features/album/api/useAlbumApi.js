// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo } from 'react';
import { useApi } from '../../api/useApi';
import { createAlbumApi } from './albumApi';

// The albums API as the signed-in user (albumApi.js)
export function useAlbumApi() {
  const request = useApi();
  return useMemo(() => createAlbumApi({ request }), [request]);
}
