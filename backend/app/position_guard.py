# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Is the position a phone claims physically possible for this user?

Who someone sees, who they may write to and which events they find all depend on where
they say they are, and a phone can say anything. A position farther from the last one
than even a plane could have flown meanwhile is refused, whatever the app is (a
fake-GPS app, a modified client, a script on the socket). It costs the user no step: a
phone on a real GPS never gets here (API.md, Security).

This stops jumps across the world, not a cheat of a few kilometres: a position that only
comes from the phone cannot be proved by the server alone.

What is kept for this, in memory only: one rounded point per user (about 1 km) and when,
for KEEP_S at most. Never a history, never on disk (legal/it/compliance/conservazione-dati.md).
"""

import time

from . import config
from .util import distance_m

# Margin (m) for a first bad fix, the rounding of the point and a phone's jump indoors
SLACK_M = 2000
# The point moves on only this often (s): moving it at every claim would let a cheat hop
# SLACK_M at a time, as fast as it can send, and go anywhere
ANCHOR_S = 60
# After this long (s) anywhere on Earth is reachable at MAX_SPEED: nothing left to compare
KEEP_S = 16 * 3600

_anchors: dict[str, tuple[float, float, float]] = {}


def plausible(user_id: str, latitude: float, longitude: float) -> bool:
    """Whether the user can be there now. Remembers the position when they can."""
    now = time.monotonic()
    anchor = _anchors.get(user_id)
    if anchor and now - anchor[2] < KEEP_S:
        reachable = SLACK_M + config.MAX_TRAVEL_SPEED_MPS * (now - anchor[2])
        if distance_m(anchor[0], anchor[1], latitude, longitude) > reachable:
            return False
        if now - anchor[2] < ANCHOR_S:
            return True
    _anchors[user_id] = (round(latitude, 2), round(longitude, 2), now)
    return True


def forget(user_id: str):
    _anchors.pop(user_id, None)


def sweep():
    limit = time.monotonic() - KEEP_S
    for user_id in [user_id for user_id, anchor in _anchors.items() if anchor[2] < limit]:
        del _anchors[user_id]
