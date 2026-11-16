// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo } from 'react';
import { useApi } from '../../api/useApi';
import { createConnectApi } from './connectApi';

// The connect operations as the signed-in user (connectApi.js)
export function useConnectApi() {
  const request = useApi();
  return useMemo(() => createConnectApi({ request }), [request]);
}
