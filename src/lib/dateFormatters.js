// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

export const timeFormatter = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
export const shortDayFormatter = new Intl.DateTimeFormat(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
