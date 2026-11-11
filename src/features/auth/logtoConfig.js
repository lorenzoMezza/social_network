// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { Prompt, UserScope } from '@logto/rn';

// Public client (native app): there is no secret, the app ID is not confidential.
// The SDK always adds the `openid`, `profile` and `offline_access` scopes;
// `offline_access` gives the refresh token that keeps the user signed in.
// Identifier of the backend in Logto Console > API resources. Without it the access token
// is an opaque token only valid for Logto itself, which the backend cannot verify.
// Adding or changing it needs a new sign-in: resources are granted at sign-in time.
export const API_RESOURCE = process.env.EXPO_PUBLIC_API_RESOURCE || undefined;

export const logtoConfig = {
  endpoint: 'https://bl5ooc.logto.app/',
  appId: 'n5b35te70myyr7cafk5ed',
  scopes: [UserScope.Email],
  resources: API_RESOURCE ? [API_RESOURCE] : [],
  // iOS: share the browser session, so Google shows the accounts already signed in
  // instead of asking for email and password every time
  preferEphemeralSession: false,
  // `login`: after signing out, the user picks the account again instead of being
  // signed back in silently; `consent` is required to get the refresh token
  prompt: [Prompt.Login, Prompt.Consent],
};

// Uses `expo.scheme` from app.json. It must be listed, exactly like this, in
// Logto Console > Applications > this app > Redirect URIs.
export const LOGTO_REDIRECT_URI = 'projectexpofrontend://callback';
