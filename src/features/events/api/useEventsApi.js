// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo } from 'react';
import { useApi } from '../../api/useApi';
import { createEventsApi } from './eventsApi';

// The events API as the signed-in user (eventsApi.js)
export function useEventsApi() {
  const request = useApi();
  return useMemo(() => createEventsApi({ request }), [request]);
}
