// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// The app's WebViews show one local page each (the map, the avatar viewer) with access
// to local files: they must never navigate anywhere else (a link, a redirect, a
// window.open from a compromised script), or that page would get the same rights and
// the native bridge. Use as onShouldStartLoadWithRequest.
const page = (url) => (typeof url === 'string' ? url.split('#')[0].split('?')[0] : '');

export function localPageOnly(uri) {
  const allowed = page(uri);
  return (request) => request.url === 'about:blank' || page(request.url) === allowed;
}
