// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Consents the user gives in the app, recorded on the server with the version of the
// text they read (docs/API.md: PUT /me/consents/{kind}), so the service can show
// when and to what they agreed (GDPR art. 7(1)). Bump a version when its text changes.
const CONSENT_VERSIONS = {
  // The "Be visible on the map?" / "Show your area on the map?" dialog (VisibilitySwitch)
  'location-sharing': 2,
};

export function recordConsent(request, kind, details = {}) {
  const version = CONSENT_VERSIONS[kind];
  if (!version) return Promise.reject(new Error(`unknown consent ${kind}`));
  return request(`/me/consents/${encodeURIComponent(kind)}`, {
    method: 'PUT',
    body: JSON.stringify({ version, ...details }),
  });
}
