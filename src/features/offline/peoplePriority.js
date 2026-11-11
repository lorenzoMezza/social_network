// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

import { PRIORITY } from '../../lib/offline/diskCache';

// How close someone is to the user, for what the phone keeps of them (pictures,
// profiles, avatars): the user, their connections, everyone else. Told by MeProvider
// (the user) and SocialProvider (the connections).
let ownId = null;
let connected = new Set();

export const setOwnPerson = (id) => {
  ownId = id ?? null;
};
export const setConnectedPeople = (ids) => {
  connected = new Set(ids);
};

export const priorityOfPerson = (id) => {
  if (id && id === ownId) return PRIORITY.OWN;
  if (id && connected.has(id)) return PRIORITY.CLOSE;
  return PRIORITY.RECENT;
};
