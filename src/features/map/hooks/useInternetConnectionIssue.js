// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useEffect, useState } from 'react';
import { networkStatus, subscribeNetwork } from '../../api/networkStatus';

// Offline this long before the map says so: a short drop (a tunnel, a lift) says nothing
const OFFLINE_CONFIRMATION_MS = 10_000;

export function useInternetConnectionIssue() {
  const [internetIssue, setInternetIssue] = useState(false);

  useEffect(() => {
    let timer = null;
    const onChange = (next) => {
      if (next === 'offline') {
        timer ??= setTimeout(() => {
          timer = null;
          setInternetIssue(true);
        }, OFFLINE_CONFIRMATION_MS);
        return;
      }
      clearTimeout(timer);
      timer = null;
      setInternetIssue(false);
    };
    const unsubscribe = subscribeNetwork(onChange);
    // Already known offline (another screen asked first): counted from now
    if (networkStatus() === 'offline') onChange('offline');
    return () => {
      clearTimeout(timer);
      unsubscribe();
    };
  }, []);

  return internetIssue;
}
