// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { useMemo } from 'react';
import { useAudienceCount, useNearbyPeople } from './nearbyPeople';

// The rules (who sees whom, how precisely): model/presenceRules.js, applied by the
// server; the app only shows what it is sent
export { APPROXIMATE_RADIUS_M, MAP_RANGE_M } from '../model/presenceRules';

// The people around who can see the user in their current mode: { total, precise, area }.
// `total` is the server's (who has the user on their map); `precise` and `area` count the
// people the user sees. Shown on the map, so nobody is watched without knowing.
export function useMapAudience(mode) {
  const people = useNearbyPeople();
  const told = useAudienceCount();
  return useMemo(() => {
    const audience = { total: 0, precise: 0, area: 0 };
    if (mode === 'invisible') return audience;
    for (const person of people) {
      audience.total += 1;
      audience[person.precision === 'precise' ? 'precise' : 'area'] += 1;
    }
    return { ...audience, total: told ?? audience.total };
  }, [people, mode, told]);
}
