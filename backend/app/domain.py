# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Rules shared by several endpoints: who may write to whom, what a chat is for a user,
posting a message (stored, then pushed over the socket), telling people an event changed."""

from . import media, notifications, promotions
from .errors import forbidden, not_found
from .realtime import are_near, bot_reply, hub, presences
from .moderation import RANK, forget_member, is_moderated, moderation_of, muted_until, role_of, write_rule
from .seed import seed_event_chat
from .store import Chat, Message, store
from .util import distance_m, iso, new_id, now_ms
from .views import event_chat_summary, event_status, event_summary, group_or_direct_summary, message_view, sees_message, summary_of


def stats(user_id: str) -> dict:
    organized = [e for e in store.events.values() if e.creator_id == user_id and not e.cancelled]
    return {
        "organized": len(organized),
        "connections": len(store.connections.get(user_id, {})),
    }


def can_message(a: str, b: str) -> tuple[bool, str | None]:
    """(allowed, why) of a direct chat between a and b."""
    if a == b or store.blocked_either(a, b):
        return False, "blocked"
    if store.is_connected(a, b):
        return True, None
    if frozenset((a, b)) in store.disconnected:
        return False, "disconnected"
    if are_near(a, b):
        return True, "nearby"
    return False, "away"


# --- chats ---

# The most members one answer lists (a chat of an event can have thousands)
MAX_MEMBERS_SHOWN = 200
# The newest chats of the inbox: an older one comes back with its next message
INBOX_MAX = 500


def event_chat_members(event) -> list[str]:
    return [event.creator_id] + [uid for uid in store.followers.get(event.id, {}) if uid != event.creator_id]


def event_chat_open(event) -> bool:
    return not event.cancelled and event_status(event) != "concluded"


def summary_for(chat_id: str, user_id: str) -> dict | None:
    """The chat as the user sees it, or None when they are not in it (or it is hidden)."""
    if chat_id.startswith("event:"):
        event = store.events.get(chat_id[6:])
        if not event or not event_chat_open(event) or user_id not in event_chat_members(event):
            return None
        seed_event_chat(event)
        return with_moderation(event_chat_summary(event, user_id), user_id)
    chat = store.chats.get(chat_id)
    if not chat or user_id not in chat.members:
        return None
    if chat.kind == "direct":
        other = next(uid for uid in chat.members if uid != user_id)
        if store.blocked_either(user_id, other):
            return None
        allowed, why = can_message(user_id, other)
        return with_moderation(group_or_direct_summary(chat, user_id, why=why, can_write=allowed), user_id)
    return with_moderation(group_or_direct_summary(chat, user_id), user_id)


def pinned_messages(chat_id: str) -> list[Message]:
    moderation = store.moderation.get(chat_id)
    if not moderation or not moderation.pins:
        return []
    by_id = {message.id: message for message in store.messages.get(chat_id, []) if message.id in moderation.pins}
    return [by_id[i] for i in moderation.pins if i in by_id]


def with_moderation(view: dict, user_id: str) -> dict:
    """The user's role in the chat and what it allows (Moderation, API.md)."""
    chat_id = view["id"]
    if not is_moderated(chat_id):
        view.update({"role": None, "readOnly": False, "muted": False, "mutedUntil": None, "pinned": []})
        return view
    moderation = store.moderation.get(chat_id)
    muted, until = muted_until(chat_id, user_id)
    view.update({
        "role": role_of(chat_id, user_id),
        "readOnly": bool(moderation and moderation.read_only),
        "muted": muted,
        "mutedUntil": iso(until) if muted and until else None,
        "pinned": [message_view(m, user_id) for m in pinned_messages(chat_id) if sees_message(chat_id, user_id, m)],
    })
    rule = write_rule(chat_id, user_id)
    if rule and view["canWrite"]:
        view["canWrite"] = False
        view["why"] = rule
    return view


def chats_of(user_id: str) -> list[dict]:
    ids = [chat.id for chat in store.chats.values() if user_id in chat.members]
    ids += [f"event:{event.id}" for event in store.events.values()
            if (event.creator_id == user_id or user_id in store.followers.get(event.id, {})) and event_chat_open(event)]
    chats = [summary for chat_id in ids if (summary := summary_for(chat_id, user_id))
             and not (summary["kind"] == "direct" and not summary["lastMessage"] and store.chats[chat_id].opened_by not in (None, user_id))]
    chats.sort(key=lambda c: c["lastMessage"]["at"] if c["lastMessage"] else "", reverse=True)
    return chats[:INBOX_MAX]


def members_of(chat_id: str) -> list[str]:
    if chat_id.startswith("event:"):
        event = store.events.get(chat_id[6:])
        return event_chat_members(event) if event else []
    chat = store.chats.get(chat_id)
    return list(chat.members) if chat else []


def chat_detail(chat_id: str, user_id: str) -> dict:
    summary = summary_for(chat_id, user_id)
    if summary is None:
        raise not_found("chat not found")
    members = [uid for uid in members_of(chat_id) if not store.blocked_either(user_id, uid)]
    if not is_moderated(chat_id):
        summary["members"] = [{"user": summary_of(uid), "role": "member", "muted": False, "mutedUntil": None} for uid in members]
        return summary
    roles = {uid: role_of(chat_id, uid) for uid in members}
    # Who is muted: for the owner and the admins, who can change it
    sees_mutes = RANK[roles.get(user_id, "member")] >= RANK["admin"]
    # An event's people, as on its page: who runs it sees all of them (to moderate), the
    # others only who lets them know they go (Store.sees_story)
    if chat_id.startswith("event:") and not sees_mutes:
        members = [uid for uid in members if roles[uid] != "member" or store.sees_story(user_id, uid)]
    members.sort(key=lambda uid: (-RANK[roles[uid]], uid != user_id, ((summary_of(uid) or {}).get("name") or "").casefold()))
    entries = []
    for uid in members:
        muted, until = muted_until(chat_id, uid) if sees_mutes else (False, None)
        entries.append({"user": summary_of(uid), "role": roles[uid], "muted": muted, "mutedUntil": iso(until) if muted and until else None})
    # Owner, admins and the user first: memberCount says how many there are in all
    summary["members"] = entries[:MAX_MEMBERS_SHOWN]
    return summary


def push_chat(chat_id: str, user_ids):
    for user_id in user_ids:
        summary = summary_for(chat_id, user_id)
        if summary:
            hub.send(user_id, {"type": "chat", "chat": summary})


def post_message(chat_id: str, sender: str, text: str, client_id: str | None = None, system=False, poll=None) -> Message:
    if client_id and (chat_id, sender, client_id) in store.sent:
        return store.sent[(chat_id, sender, client_id)]
    # Always later than the last one of the chat: what was read is told by this time, and a
    # message in the same millisecond as the one read would count as read too
    existing = store.messages.get(chat_id)
    at = max(now_ms(), existing[-1].at + 1) if existing else now_ms()
    message = Message(id=new_id("msg"), chat_id=chat_id, sender=sender, text=text, at=at, client_id=client_id, system=system)
    if poll is not None:
        # Before the message goes out: everyone receives it with its poll
        poll.message_id = message.id
        store.polls[message.id] = poll
    store.messages.setdefault(chat_id, []).append(message)
    store.read_at[(chat_id, sender)] = message.at
    if client_id:
        store.sent[(chat_id, sender, client_id)] = message
    payload = {"type": "message", "message": message_view(message), "author": summary_of(sender)}
    for member in members_of(chat_id):
        if not store.blocked_either(sender, member):
            hub.send(member, payload)
    # A demo person answers a direct message
    chat = store.chats.get(chat_id)
    if chat and chat.kind == "direct" and not system:
        other = next((uid for uid in chat.members if uid != sender), None)
        if other and store.users[other].bot:
            bot_reply(chat_id, other, lambda bot, reply: post_message(chat_id, bot, reply))
    return message


def require_chat(chat_id: str, user_id: str) -> dict:
    summary = summary_for(chat_id, user_id)
    if summary is None:
        raise not_found("chat not found")
    return summary


def leave_chat(chat_id: str, user_id: str, removed_by: str | None = None):
    """Out of a group or an event chat: they leave, or a higher role removes them. Out
    of an event chat means out of the event (removed: for good, they cannot rejoin),
    however it was done: from the chat, or from the event's page."""
    event = store.events.get(chat_id[6:]) if chat_id.startswith("event:") else None
    if event:
        store.followers.get(event.id, {}).pop(user_id, None)
        if removed_by:
            moderation_of(chat_id).banned.add(user_id)
    else:
        store.chats[chat_id].members.pop(user_id, None)
    forget_member(chat_id, user_id)
    hub.send(user_id, {"type": "chat.removed", "chatId": chat_id})
    # In a group its people know each other. In an event's chat the name would tell everyone
    # who was going, also about someone who keeps that to their connections (Store.sees_story)
    if not event:
        name = store.users[user_id].name if user_id in store.users else "Someone"
        if removed_by:
            post_message(chat_id, removed_by, f"{store.users[removed_by].name} removed {name}", system=True)
        else:
            post_message(chat_id, user_id, f"{name} left", system=True)
    push_chat(chat_id, members_of(chat_id))
    if event:
        # The event as it is for them now, on all their devices (not "Going" any more),
        # and when someone else took them out, told why it is gone
        hub.send(user_id, {"type": "event", "event": event_summary(event, user_id)})
        if removed_by:
            notifications.notify(user_id, "event.removed", actor=removed_by, event=event)
        notify_spots(event)


def next_owner(chat: Chat, leaving: str) -> str | None:
    """Who takes a group over: the admin who has been in it longest, else whoever has"""
    moderation = store.moderation.get(chat.id)
    others = [uid for uid in chat.members if uid != leaving and uid in store.users]
    admins = [uid for uid in others if moderation and uid in moderation.admins]
    return min(admins or others, key=lambda uid: (chat.members[uid], uid), default=None)


def hand_over(chat: Chat, owner: str):
    """The group passes to `owner`, who is told in it. Whoever has a block with them leaves: a
    block must not make someone invisible to who runs where they write."""
    chat.owner_id = owner
    forget_member(chat.id, owner)
    for member in [uid for uid in chat.members if uid != owner and store.blocked_either(owner, uid)]:
        del chat.members[member]
        forget_member(chat.id, member)
        hub.send(member, {"type": "chat.removed", "chatId": chat.id})
    post_message(chat.id, owner, f"{store.users[owner].name} now runs the group", system=True)
    push_chat(chat.id, chat.members)


def end_group(chat: Chat):
    """A group gone for everyone, with its picture and messages"""
    for member in chat.members:
        hub.send(member, {"type": "chat.removed", "chatId": chat.id})
    media.discard(chat.picture_url)
    store.chats.pop(chat.id, None)
    for message in store.messages.pop(chat.id, []):
        store.polls.pop(message.id, None)
    store.moderation.pop(chat.id, None)
    for key in [key for key in store.read_at if key[0] == chat.id]:
        del store.read_at[key]


def notify_spots(event):
    """A flash event looking for people: how many it still needs changed, for everyone
    who sees it (its page and the map say so)"""
    if event.flash and event.spots_needed:
        notify_event(event)


def end_shared_events(a: str, b: str):
    """Two people blocked each other: neither is at the other's events any more, and each
    event not over leaves their chats (their pages already answer "not found")."""
    now = now_ms()
    for event in store.events.values():
        if event.cancelled or event.end <= now:
            continue
        for organizer, guest in ((a, b), (b, a)):
            if event.creator_id == organizer and store.followers.get(event.id, {}).pop(guest, None) is not None:
                forget_member(f"event:{event.id}", guest)
                hub.send(guest, {"type": "chat.removed", "chatId": f"event:{event.id}"})
                push_chat(f"event:{event.id}", members_of(f"event:{event.id}"))


# --- events ---

# Where each user looks for events (GET /events: centre, range, when), in memory only:
# a new or changed event reaches the people whose map or list shows that place. Kept while
# it is of use: this long after the last search for someone with no socket open
event_watch: dict[str, tuple[float, float, float, int]] = {}
WATCH_KEPT_OFFLINE_MS = 10 * 60 * 1000
# Someone who never asked for events but is on the map: the events around them
DEFAULT_WATCH_M = 2000


def watch_events(user_id: str, latitude: float, longitude: float, radius: float):
    event_watch[user_id] = (latitude, longitude, radius, now_ms())


def forget_old_watches(now: int):
    for user_id, watch in list(event_watch.items()):
        if watch[3] < now - WATCH_KEPT_OFFLINE_MS and not hub.online(user_id):
            del event_watch[user_id]


def _watching(user_id: str, event, reach: float) -> bool:
    watch = event_watch.get(user_id)
    if watch is None:
        presence = presences.get(user_id)
        if presence is None or presence.latitude is None:
            return False
        watch = (presence.latitude, presence.longitude, DEFAULT_WATCH_M)
    latitude, longitude, radius = watch[:3]
    return distance_m(latitude, longitude, event.latitude, event.longitude) <= min(radius, reach)


def tell_event_gone(event):
    """An event erased: who has it on their map or list asks for them again"""
    reach = promotions.reach_now(event)
    for user_id in list(hub.clients):
        if _watching(user_id, event, reach):
            hub.send(user_id, {"type": "events.stale"})


def notify_event(event, also_within: float = 0):
    """An event appeared or changed (created, edited, cancelled): who organizes or saved
    it, and everyone online whose events or map show its place, within its reach (not
    blocked either way). A cancelled event arrives with its status, a smaller reach
    (`also_within`: the reach it had) with the new one: the apps take it off their
    lists and maps."""
    involved = {event.creator_id, *store.followers.get(event.id, {})}
    involved |= {user_id for user_id, saved in store.saved.items()
                 if event.id in saved and not store.blocked_either(user_id, event.creator_id)}
    reach = max(promotions.reach_now(event), also_within)
    for user_id in list(hub.clients):
        if user_id in involved or (_watching(user_id, event, reach) and not store.blocked_either(user_id, event.creator_id)):
            hub.send(user_id, {"type": "event", "event": event_summary(event, user_id)})
