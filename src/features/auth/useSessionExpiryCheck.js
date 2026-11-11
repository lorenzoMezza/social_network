// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useEffect } from 'react';
import { AppState } from 'react-native';
import { LogtoClientError, LogtoRequestError, useLogto } from '@logto/rn';
import { API_RESOURCE } from './logtoConfig';

// Logto rejects a refresh token that expired or was revoked with `invalid_grant`, and one
// from a sign-in that did not grant the API resource (e.g. added later) with `invalid_target`.
// Network errors are not listed here: an offline user stays signed in.
function isSessionExpired(error) {
  if (error instanceof LogtoRequestError) {
    return error.code === 'oidc.invalid_grant' || error.code === 'oidc.invalid_target';
  }
  if (error instanceof LogtoClientError) return error.code === 'not_authenticated';
  return false;
}

// The SDK keeps the user signed in by refreshing the access token with the refresh token.
// When the session is over, it throws but keeps the old tokens in storage: here we sign
// out locally, so the sign-in screen opens again. Checked at launch and on every resume.
export function useSessionExpiryCheck() {
  const { isAuthenticated, getAccessToken, signOut } = useLogto();

  useEffect(() => {
    if (!isAuthenticated) return;

    let cancelled = false;
    let latestCheck = 0;
    const checkSession = async () => {
      const check = ++latestCheck;
      try {
        // Same resource as the API calls: the SDK shares one refresh per resource, while
        // parallel refreshes for different resources reuse the same refresh token
        await getAccessToken(API_RESOURCE);
      } catch (error) {
        // A check from a previous login, or one superseded by a newer successful
        // check, must not sign out the current session.
        if (!cancelled && check === latestCheck && isSessionExpired(error)) await signOut();
      }
    };

    checkSession();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') checkSession();
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [isAuthenticated, getAccessToken, signOut]);
}
