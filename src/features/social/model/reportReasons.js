// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// Why someone can be reported (the categories asked by the EU Digital Services Act
// and the app stores' rules for social apps). The backend will receive the id.
export const USER_REPORT_REASONS = [
  { id: 'harassment', label: 'Harassment or bullying' },
  { id: 'hate', label: 'Hate speech or symbols' },
  { id: 'threat', label: 'Threats or violence' },
  { id: 'sexual', label: 'Sexual or inappropriate content' },
  { id: 'impersonation', label: 'Pretending to be someone else' },
  { id: 'spam', label: 'Spam or scam' },
  { id: 'minor', label: 'May be under the minimum age' },
  { id: 'other', label: 'Something else' },
];

// Why a message, or a group, can be reported (API.md: the same words on the server)
export const CONTENT_REPORT_REASONS = [
  { id: 'harassment', label: 'Harassment or bullying' },
  { id: 'hate', label: 'Hate speech or symbols' },
  { id: 'threat', label: 'Threats or violence' },
  { id: 'sexual', label: 'Sexual or inappropriate content' },
  { id: 'spam', label: 'Spam or scam' },
  { id: 'other', label: 'Something else' },
];
