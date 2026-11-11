// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useEffect, useMemo, useState } from 'react';
import { useEvents } from '../../events/state/EventsProvider';
import { eventEmoji } from '../../events/model/categories';
import { beamColor, beamStyle } from '../../events/model/eventTheme';
import { STATUS, eventStatus, goingCount } from '../../events/model/eventModel';

// The events to show as beacons on the map (webview/map/src/scene/eventBeacons.js): every
// one around, saved or own that has a place and is not over (ended or cancelled),
// however far ahead it starts. How far they show is the map's: up to where its fog is
// complete (as far as its tiles always reach), so the map draws the ones in sight and
// the others as the user (or the camera) comes near. Recomputed every minute, so an
// event that starts begins to pulse and one that ends goes away.
export function useMapEvents() {
  const { byId, nearby, followed, created, user, isGoing } = useEvents();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60 * 1000);
    return () => clearInterval(timer);
  }, []);

  return useMemo(() => {
    const list = [];
    const ids = new Set(nearby.ids);
    for (const id of followed.ids) ids.add(id);
    for (const id of created.ids) ids.add(id);
    for (const id of ids) {
      const event = byId[id];
      const latitude = event?.location?.latitude;
      const longitude = event?.location?.longitude;
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
      const status = eventStatus(event, now);
      if (status === STATUS.concluded || status === STATUS.cancelled) continue;
      list.push({
        id,
        latitude,
        longitude,
        // Only the colours offered: what a server or an old version sends is never gold
        color: beamColor(event.theme),
        beamStyle: beamStyle(event.theme),
        emoji: eventEmoji(event),
        crowd: goingCount(event),
        live: status === STATUS.ongoing,
        sponsored: !!event.sponsored,
        mine: !!user && event.creatorId === user.id,
        following: isGoing(id),
      });
    }
    return list;
  }, [byId, nearby.ids, followed.ids, created.ids, user, isGoing, now]);
}
