# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Notifications (API.md, Notifications): only what matters to the user, never noise.

  event.changed     an event they join changed its time or place (from its organizer)
  event.cancelled   an event they join was cancelled
  event.starting    an event they join starts within the hour (once)
  event.removed     the organizer or an admin took them out of an event, for good
  event.joined      people joined their event (gathered: "Sara and 2 others")
  event.rated       people rated their event (gathered)
  album.photos      new photos of an event they went to or organized (gathered)
  promotion.paused  their promotion stopped: not enough credits to go on
  connect.invite    someone near them asked to connect

Alike notifications still unread within a day are gathered into one (newest actor
first, `count` the things gathered). Each is pushed over the socket at once
(`notification`, with the unread count). The settings decide: event kinds follow
notifyEventUpdates, connect.invite notifyConnections; promotion.paused always comes
(it is about money). Nobody hears about someone blocked either way. A user keeps their
newest MAX_KEPT notifications, for KEPT_DAYS at most.
"""

from .realtime import hub
from .store import Notification, store
from .util import DAY, iso, new_id, now_ms
from .views import event_summary, summary_of

GATHER_MS = DAY
MAX_KEPT = 100
KEPT_DAYS = 60
SHOWN = 50
ACTORS_SHOWN = 3

SETTING_OF = {
    "event.changed": "notifyEventUpdates",
    "event.cancelled": "notifyEventUpdates",
    "event.starting": "notifyEventUpdates",
    "event.removed": "notifyEventUpdates",
    "event.joined": "notifyEventUpdates",
    "event.rated": "notifyEventUpdates",
    "album.photos": "notifyEventUpdates",
    "connect.invite": "notifyConnections",
}
GATHERED = {"event.changed", "event.joined", "event.rated", "album.photos"}


def notify(user_id: str, kind: str, *, actor: str | None = None, event=None, data: dict | None = None):
    user = store.user(user_id)
    if user is None or user.bot or actor == user_id:
        return
    if actor and store.blocked_either(user_id, actor):
        return
    if event is not None and store.blocked_either(user_id, event.creator_id):
        return
    setting = SETTING_OF.get(kind)
    if setting and not user.settings.get(setting, True):
        return
    now = now_ms()
    mine = store.notifications.setdefault(user_id, [])
    event_id = event.id if event is not None else None
    same = next((n for n in reversed(mine) if kind in GATHERED and not n.read and n.kind == kind
                 and n.event_id == event_id and n.at > now - GATHER_MS), None)
    if same:
        mine.remove(same)
        if actor:
            same.actors = [actor] + [a for a in same.actors if a != actor]
        same.count += 1
        same.at = now
        if data:
            for key, value in data.items():
                # Lists (what changed) add up; the rest is the latest
                same.data[key] = sorted(set(same.data.get(key, [])) | set(value)) if isinstance(value, list) else value
        entry = same
    else:
        entry = Notification(id=new_id("nt"), kind=kind, at=now, actors=[actor] if actor else [], event_id=event_id, data=dict(data or {}))
    mine.append(entry)
    del mine[:-MAX_KEPT]
    hub.send(user_id, {"type": "notification", "notification": view(entry, user_id), "unread": unread(user_id)})


def notify_going(event, kind: str, *, actor: str | None = None, data: dict | None = None, also=(), but=()):
    """Everyone who joins the event (not its organizer), and `also`, but not `but`"""
    people = {uid for uid in store.followers.get(event.id, {}) if uid != event.creator_id} | set(also)
    for uid in people - set(but):
        notify(uid, kind, actor=actor, event=event, data=data)


def _named(entry: Notification, event, viewer_id: str, actor: str) -> bool:
    """Whether this notification may say who: nobody blocked either way, and new photos do not
    say who went to someone who may not know (Store.sees_story). The organizer knows."""
    if not store.user(actor) or store.blocked_either(viewer_id, actor):
        return False
    return (entry.kind != "album.photos" or store.sees_story(viewer_id, actor)
            or (event is not None and event.creator_id == viewer_id))


def view(entry: Notification, viewer_id: str) -> dict:
    event = store.events.get(entry.event_id) if entry.event_id else None
    actors = [a for a in entry.actors if _named(entry, event, viewer_id, a)]
    return {
        "id": entry.id,
        "kind": entry.kind,
        "at": iso(entry.at),
        "read": entry.read,
        "actors": [summary_of(a) for a in actors[:ACTORS_SHOWN]],
        "count": entry.count,
        "event": event_summary(event, viewer_id) if event and not store.blocked_either(viewer_id, event.creator_id) else None,
        "data": entry.data,
    }


def unread(user_id: str) -> int:
    return sum(1 for n in store.notifications.get(user_id, []) if not n.read)


def list_view(user_id: str) -> dict:
    mine = store.notifications.get(user_id, [])
    return {"items": [view(n, user_id) for n in reversed(mine[-SHOWN:])], "unread": unread(user_id)}


def mark_read(user_id: str):
    for entry in store.notifications.get(user_id, []):
        entry.read = True


def remind_starting(now: int):
    """Once, within the hour before an event starts: who joins it (janitor)"""
    for event in store.events.values():
        if event.cancelled or event.id in store.reminded or not now < event.start <= now + 60 * 60 * 1000:
            continue
        store.reminded.add(event.id)
        notify_going(event, "event.starting")


def sweep(now: int):
    oldest = now - KEPT_DAYS * DAY
    for user_id, mine in list(store.notifications.items()):
        mine[:] = [n for n in mine if n.at > oldest]
        if not mine:
            del store.notifications[user_id]
    store.reminded = {event_id for event_id in store.reminded if event_id in store.events and store.events[event_id].end > now}


def forget_user(user_id: str):
    """Account deleted (privacy.erase_user): theirs go, and they leave others'"""
    store.notifications.pop(user_id, None)
    for mine in store.notifications.values():
        for entry in mine:
            if user_id in entry.actors:
                entry.actors = [a for a in entry.actors if a != user_id]
