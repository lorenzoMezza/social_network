// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Who may open what from outside the app: other apps and web pages can open any address of
// this scheme, and each screen is one tap from doing something (the Connect screen shows the
// user's code). The app gives out no links of its own, so a link opens the app and
// nothing more. On Android the Logto sign-in callback also comes here, and the Logto SDK
// handles it: the router stays out of it.
import { LOGTO_REDIRECT_URI } from '../features/auth/logtoConfig';

export function redirectSystemPath({ path }) {
  if (typeof path === 'string' && path.startsWith(LOGTO_REDIRECT_URI)) return null;
  // In development Expo itself opens the app with addresses of its own
  return __DEV__ ? path : '/';
}
