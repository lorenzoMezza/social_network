// Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

// When the user's position is shared and the people around received: while they are on
// the map's screen, and for MAP_LEAVE_GRACE_MS after they leave it for another page of
// the app (a look at a chat does not make them disappear from the street). Then it stops,
// until the map opens again. The app leaving the front ends it at once: nothing is ever
// shared from the background (the socket closes too, and the server takes them off
// everyone's map: docs/API.md, `presence`). Which way they are shared is the mode they
// chose on the map (mapVisibility.js): invisible shares nothing at any time.
const MAP_LEAVE_GRACE_MS = 60 * 1000;

/**
 * createSharingWindow({ onChange(sharing) }) → { enter(), leave({ now }), appLeft(), sharing() }
 *   enter    the map's screen shows
 *   leave    it no longer shows; now: no minute to wait (invisible: nothing to keep going)
 *   appLeft  the app left the front
 */
export function createSharingWindow({ onChange, graceMs = MAP_LEAVE_GRACE_MS, schedule = setTimeout, cancel = clearTimeout }) {
  let onMap = false;
  let sharing = false;
  let timer = null;

  const set = (next) => {
    if (next === sharing) return;
    sharing = next;
    onChange(next);
  };
  const stopTimer = () => {
    if (timer !== null) cancel(timer);
    timer = null;
  };

  return {
    enter() {
      onMap = true;
      stopTimer();
      set(true);
    },
    leave({ now = false } = {}) {
      onMap = false;
      stopTimer();
      if (now) set(false);
      else if (sharing) {
        timer = schedule(() => {
          timer = null;
          set(false);
        }, graceMs);
      }
    },
    // On the map it goes on when the app is back; from another page it does not
    appLeft() {
      stopTimer();
      if (!onMap) set(false);
    },
    sharing: () => sharing,
  };
}
