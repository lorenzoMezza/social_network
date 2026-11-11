// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// What to tell the user when the server was asked for something and it did not happen,
// for what has no words of its own: "check your connection" only when it really is that.
// A refusal is not a network problem, and trying again would not help.
export function failureMessage(error) {
  const status = error?.status;
  if (status === 429) return 'Too many tries in a row. Wait a moment, then try again.';
  if (status === 401) return 'Your session is over. Sign in again.';
  if (status === 403 || status === 404 || status === 409 || status === 410) return 'This is no longer possible: it may have changed or ended.';
  if (status === 400 || status === 413 || status === 422) return 'The server did not accept this. Check what you entered.';
  if (status >= 500) return 'Something went wrong on our side. Try again in a moment.';
  return 'Check your connection and try again.';
}
