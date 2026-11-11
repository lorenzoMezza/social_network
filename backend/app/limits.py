# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""How often one user may do something (a sliding window per user and action): what a
script could abuse is limited, what a person does is never noticed. 429 with
Retry-After otherwise."""

import math
import time
from collections import deque

from .errors import rate_limited

# action → (times, seconds)
RULES = {
    "message": (20, 10),          # chat messages
    "direct-chat": (30, 3600),    # new direct chats (people nearby)
    "event": (20, 3600),          # events created
    "upload": (120, 3600),        # upload tickets
    "picture": (30, 3600),        # profile and group pictures changed
    "purchase": (30, 3600),       # store purchases sent to be credited
    "report": (20, 3600),
    "connect-session": (10, 60),
    "connect-claim": (10, 60),
    "gesture": (60, 60),          # gestures, whoever to (each brings the sender on a map)
    "invite": (30, 3600),         # "Connect" invitations, whoever to (each is a notification)
    "save": (120, 60),            # events saved and unsaved
    "chat-edit": (120, 3600),     # running a chat: names, roles, mutes, pins, read-only (each one reaches everyone in it)
    "block": (60, 3600),          # people blocked and unblocked
    "connect-token": (30, 60),    # new codes for a session (the app asks for one every 5 s)
    "requests": (3000, 60),       # all requests of one person: nothing a person does comes near it
    "people": (600, 60),          # profiles read: nobody walks through everyone's connections
    "profile": (300, 3600),       # changes to the profile
    "username": (5, 86400),       # another @handle: nobody takes over names by the dozen
    "export": (5, 3600),          # copies of one's data (GDPR art. 15, 20)
    # Each of these reaches other people (a frame or a notification to everyone concerned)
    "vote": (30, 60),             # votes in polls
    "group": (20, 3600),          # groups created
    "members": (60, 3600),        # people added to groups
    "join": (60, 60),             # joining and leaving events
    "rating": (30, 3600),         # ratings written
    "event-edit": (120, 3600),    # changes to events
    "avatar": (60, 3600),         # avatars saved (each new look is made by the avatar server)
}

_hits: dict[tuple, deque] = {}


def check(user_id: str, action: str):
    times, seconds = RULES[action]
    now = time.monotonic()
    hits = _hits.setdefault((user_id, action), deque())
    while hits and hits[0] <= now - seconds:
        hits.popleft()
    if len(hits) >= times:
        raise rate_limited(max(1, math.ceil(hits[0] + seconds - now)))
    hits.append(now)


def sweep():
    now = time.monotonic()
    for key in [key for key, hits in _hits.items() if not hits or hits[-1] <= now - RULES[key[1]][1]]:
        del _hits[key]
