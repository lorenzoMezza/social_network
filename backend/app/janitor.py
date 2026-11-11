# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Once a minute, what has run out is forgotten: expired tokens and connect codes,
finished connect sessions, uploads never used (and their files), cooldowns and rate
windows, the idempotency keys of old messages, export links, and what the retention
policy says has been kept long enough (privacy.retention_sweep). Nothing grows forever."""

import asyncio
import time
from pathlib import Path

from . import auth, limits, notifications, privacy, promotions, realtime
from .domain import event_chat_members, forget_old_watches, notify_event
from .routes import events, social
from .store import store
from .util import DAY, now_ms  # noqa: F401

EVERY_S = 60
SESSION_KEEP_MS = 10 * 60 * 1000


def sweep():
    now = now_ms()
    for token in [t for t, (until, _) in auth._cache.items() if until < time.time()]:
        del auth._cache[token]
    for token in [t for t, entry in social.tokens.items() if entry["expiresAt"] < now]:
        del social.tokens[token]
    for session_id in [s for s, entry in social.sessions.items() if entry.get("created", now) < now - SESSION_KEEP_MS]:
        del social.sessions[session_id]
    for upload_id in [u for u, upload in store.uploads.items() if upload.expires_at < now]:
        upload = store.uploads.pop(upload_id)
        if upload.path:
            Path(upload.path).unlink(missing_ok=True)
    for key in [k for k, message in store.sent.items() if message.at < now - DAY]:
        del store.sent[key]
    # Promotions pay the next 24 hours, or pause; a smaller reach is told to whoever saw
    # the event from farther
    for event, why in promotions.tick(now):
        notify_event(event, also_within=max(promotions.RADII))
        if why == "paused":
            notifications.notify(event.creator_id, "promotion.paused", event=event)
    # An event that just ended: its chat leaves the phones of who is online now (the others
    # find out at their next load of the chats)
    for event in store.events.values():
        if now - 2 * EVERY_S * 1000 < event.end <= now and not event.cancelled:
            for member in event_chat_members(event):
                realtime.hub.send(member, {"type": "chat.removed", "chatId": f"event:{event.id}"})
    forget_old_watches(now)
    auth.sweep_erased()
    events.sweep(now)
    # "Starting soon" to who joins an event; old notifications go
    notifications.remind_starting(now)
    notifications.sweep(now)
    limits.sweep()
    realtime.sweep()
    privacy.sweep()
    privacy.retention_sweep(now)


async def loop():
    while True:
        await asyncio.sleep(EVERY_S)
        try:
            sweep()
        except Exception as error:  # noqa: BLE001 (the loop must survive)
            print("janitor:", repr(error))
