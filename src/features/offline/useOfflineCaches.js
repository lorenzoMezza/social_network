// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo } from 'react';
import { useMe } from '../me/MeProvider';
import { offlineFor } from '../../lib/offline/offlineStore';

// The signed-in account's caches on the phone ({ people, events, chats }, see
// lib/offline/offlineStore.js), or null when nobody is signed in
export function useOfflineCaches() {
  const { id } = useMe();
  return useMemo(() => offlineFor(id), [id]);
}
