// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { normalizeEvent } from '../../events/api/eventsApi';

const monthFormat = new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' });
// The moments a story can hold (components/TimelineItem.js)
const STORY_KINDS = new Set(['organized', 'going', 'there', 'went', 'reviewed', 'connected']);

// A profile's story in sections: "Coming up" (soonest first), then one per month,
// newest first. Entries: { key, kind, event?, person?, rating?, date, upcoming,
// withYou } (`withYou`: a connection with the user looking).
export function storySections(items, viewerId) {
  const result = [];
  for (const item of items ?? []) {
    // What this version cannot draw (a kind added later, the event of a moment gone
    // meanwhile, no date) is left out, never a broken page
    if (!STORY_KINDS.has(item?.kind) || (item.kind === 'connected' ? !item.person : !item.event)) continue;
    const date = new Date(item.at);
    if (!Number.isFinite(date.getTime())) continue;
    const entry = {
      key: item.id,
      kind: item.kind,
      event: item.event ? normalizeEvent(item.event) : null,
      person: item.person ? { ...item.person, place: item.place } : null,
      rating: item.rating,
      date,
      upcoming: item.upcoming,
      withYou: !!item.person && item.person.id === viewerId,
      // Not shown to others (one's own story only): hidden one by one, or its kind off
      hidden: !!item.hidden,
    };
    const key = entry.upcoming ? 'upcoming' : `${date.getFullYear()}-${date.getMonth()}`;
    let section = result.find((candidate) => candidate.key === key);
    if (!section) {
      section = { key, title: entry.upcoming ? 'Coming up' : monthFormat.format(date), data: [] };
      result.push(section);
    }
    section.data.push(entry);
  }
  return result;
}
