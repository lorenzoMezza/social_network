# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""The user's rights over their data (GDPR art. 15, 17, 20; legal/ for the policy):
erasing an account completely, and a copy of everything that is theirs.

What erasure keeps, and why (legal/it/conservazione-dati.md):
  - reports *about* the user, for the safety of others and to defend legal claims
    (legitimate interest), with the target's ID only, for the retention period
  - reports the user *filed*, without who filed them (the report stays useful)
  - nothing else: profile, picture, avatar, connections, blocks, events they organized
    (with their cover, album and chat), photos they posted anywhere, messages they sent
    anywhere, ratings, follows, uploads, push tokens and the wallet are deleted. A group
    they owned passes to who has been in it longest, what the others said stays.
The identity at the sign-in provider (Logto) is deleted by the production backend
through its Management API (not reachable from this development server)."""

import secrets
import time

from . import media, notifications, promotions
from .realtime import hub
from .store import User, store
from .util import iso, now_ms
from .views import Urls

# A copy of the data is fetched through a one-time link: minutes to use it
EXPORT_TTL_S = 10 * 60
_exports: dict[str, tuple[str, float]] = {}  # token → (user id, expiry on the monotonic clock)


def _event_files(event) -> list:
    album = store.albums.get(event.id)
    files = list(event.image_urls)
    if album:
        for photo in album.photos:
            files += [photo.url, photo.thumb_url]
    return files


def erase_user(user: User):
    uid = user.id
    files = [user.picture_url]
    from .domain import event_watch
    event_watch.pop(uid, None)

    # Events they organized, with everything that hangs from them. Who was going is told, with
    # the event's name since the event itself will be gone
    now = now_ms()
    for event in [event for event in store.events.values() if event.creator_id == uid]:
        if not event.cancelled and event.end > now:
            notifications.notify_going(event, "event.cancelled", data={"title": event.title})
        erase_event(event)

    # What they did on other people's events
    for followers in store.followers.values():
        followers.pop(uid, None)
    for ratings in store.ratings.values():
        ratings.pop(uid, None)
    for album in store.albums.values():
        theirs = [photo for photo in album.photos if photo.author_id == uid]
        for photo in theirs:
            files += [photo.url, photo.thumb_url]
            album.photos.remove(photo)
        if uid in album.contributors:
            album.contributors.remove(uid)

    # Chats: direct ones go, from the other's phone too. A group they own passes to who has
    # been in it longest (what the others said is theirs), and goes only if nobody is left.
    # Elsewhere their messages go, the polls they made with them, their votes and their roles
    from .domain import end_group, hand_over, next_owner
    for chat in list(store.chats.values()):
        if uid not in chat.members:
            continue
        successor = next_owner(chat, uid) if chat.kind == "group" and chat.owner_id == uid else None
        del chat.members[uid]
        if chat.kind == "direct" or (chat.owner_id == uid and successor is None):
            end_group(chat)
        elif successor:
            hand_over(chat, successor)
    for chat_id, messages in store.messages.items():
        for message in messages:
            if message.sender == uid:
                store.polls.pop(message.id, None)
        store.messages[chat_id] = [message for message in messages if message.sender != uid]
    for poll in store.polls.values():
        poll.votes.pop(uid, None)
    for moderation in store.moderation.values():
        moderation.admins.discard(uid)
        moderation.muted.pop(uid, None)
        moderation.banned.discard(uid)
    for key in [key for key in store.read_at if key[1] == uid]:
        del store.read_at[key]
    for key in [key for key in store.sent if key[1] == uid]:
        del store.sent[key]
    for pair in [pair for pair in store.direct if uid in pair]:
        del store.direct[pair]

    # People
    for other in list(store.connections.get(uid, {})):
        store.connections.get(other, {}).pop(uid, None)
    store.connections.pop(uid, None)
    store.disconnected = {pair for pair in store.disconnected if uid not in pair}
    store.blocks.pop(uid, None)
    for blocked in store.blocks.values():
        blocked.pop(uid, None)

    # Reports they filed stay, without them
    for report in store.reports:
        if report.get("by") == uid:
            report["by"] = None

    # Uploads not yet used
    for upload in [upload for upload in store.uploads.values() if upload.user_id == uid]:
        media.discard_upload(upload)
        store.uploads.pop(upload.id, None)

    # The wallet of promotion credits (its purchases stay known, never credited again)
    promotions.forget_user(uid)
    # Saved events, notifications (and their name in others'), the story's choices
    store.saved.pop(uid, None)
    store.saved_hidden.pop(uid, None)
    notifications.forget_user(uid)

    for token, (owner, _) in list(_exports.items()):
        if owner == uid:
            del _exports[token]
    store.by_username.pop(user.username, None)
    store.users.pop(uid, None)
    media.discard(*files)


# How long things are kept once their use is over (legal/it/compliance/conservazione-dati.md)
DAY_MS = 24 * 3600 * 1000
EVENT_CHAT_KEPT_MS = 30 * DAY_MS     # an event's chat after the event ends
EVENT_KEPT_MS = 365 * DAY_MS         # an event, its album and chat after it ends
REPORT_KEPT_MS = 365 * DAY_MS        # a report after it was made


def erase_event(event):
    """An event and everything that hangs from it, files included"""
    files = _event_files(event)
    chat_id = f"event:{event.id}"
    from .domain import tell_event_gone
    tell_event_gone(event)
    # Gone from the phones of who is going, its chat first
    for user_id in store.followers.get(event.id, {}):
        hub.send(user_id, {"type": "chat.removed", "chatId": chat_id})
        hub.send(user_id, {"type": "events.stale"})
    store.events.pop(event.id, None)
    store.albums.pop(event.id, None)
    store.followers.pop(event.id, None)
    store.ratings.pop(event.id, None)
    store.promotions.pop(event.id, None)
    store.reminded.discard(event.id)
    for saved in store.saved.values():
        saved.pop(event.id, None)
    for hidden in store.saved_hidden.values():
        hidden.discard(event.id)
    for message in store.messages.pop(chat_id, []):
        store.polls.pop(message.id, None)
    store.moderation.pop(chat_id, None)
    media.discard(*files)


def retention_sweep(now: int):
    """What has been kept long enough goes (the janitor, once a minute)"""
    for event in list(store.events.values()):
        ended = event.cancelled or event.end
        if ended < now - EVENT_KEPT_MS:
            erase_event(event)
        elif ended < now - EVENT_CHAT_KEPT_MS:
            for message in store.messages.pop(f"event:{event.id}", []):
                store.polls.pop(message.id, None)
    store.reports[:] = [report for report in store.reports if report.get("at", now) >= now - REPORT_KEPT_MS]


def consents_of(user: User) -> dict:
    """kind → [{ version, at, mode? }]: the consents the user gave (accounts saved
    before consents were recorded have none)"""
    if not isinstance(getattr(user, "consents", None), dict):
        user.consents = {}
    return user.consents


def export_ticket(user_id: str) -> tuple[str, int]:
    """A one-time token for the user's copy; answers it and when it expires (ms)"""
    sweep()
    token = secrets.token_urlsafe(32)
    _exports[token] = (user_id, time.monotonic() + EXPORT_TTL_S)
    return token, now_ms() + EXPORT_TTL_S * 1000


def redeem(token: str) -> str | None:
    """The user a token was made for, once and while it lasts"""
    entry = _exports.pop(token, None)
    if not entry or entry[1] < time.monotonic():
        return None
    return entry[0]


def sweep():
    now = time.monotonic()
    for token in [token for token, (_, expires) in _exports.items() if expires < now]:
        del _exports[token]


def _picture(reference: str | None) -> str | None:
    if isinstance(reference, str) and reference.startswith("media:"):
        return Urls.media(reference[len("media:"):])
    return reference


def export_data(user: User) -> dict:
    """Everything the service keeps that is the user's, in a structured, machine-readable
    form (GDPR art. 20). Other people appear by their public name and username only."""
    uid = user.id

    def person(other_id: str) -> dict:
        other = store.users.get(other_id)
        return {"id": other_id, "username": other.username, "name": other.name} if other else {"id": other_id}

    events = [
        {
            "id": event.id, "title": event.title, "description": event.description, "categories": event.categories,
            "latitude": event.latitude, "longitude": event.longitude, "address": event.address,
            "start": iso(event.start), "end": iso(event.end), "created": iso(event.created),
            "cancelled": iso(event.cancelled) if event.cancelled else None, "links": event.links,
            "pictures": [_picture(url) for url in event.image_urls],
        }
        for event in store.events.values() if event.creator_id == uid
    ]
    following = [
        {"eventId": event_id, "since": iso(since)}
        for event_id, followers in store.followers.items() for follower, since in followers.items() if follower == uid
    ]
    ratings = [
        {"eventId": event_id, "rating": rating.rating, "comment": rating.comment, "date": iso(rating.date)}
        for event_id, by_user in store.ratings.items() for rater, rating in by_user.items() if rater == uid
    ]
    photos = [
        {"eventId": event_id, "id": photo.id, "url": _picture(photo.url), "posted": iso(photo.created_at)}
        for event_id, album in store.albums.items() for photo in album.photos if photo.author_id == uid
    ]
    chats = []
    for chat_id, messages in store.messages.items():
        mine = [{"id": message.id, "text": message.text, "at": iso(message.at)} for message in messages if message.sender == uid and not message.system]
        if mine:
            chat = store.chats.get(chat_id)
            chats.append({"chatId": chat_id, "kind": chat.kind if chat else "event", "title": chat.title if chat else None, "messagesSent": mine})
    return {
        "format": "masterkey.export",
        "version": 1,
        "exportedAt": iso(now_ms()),
        "notes": [
            "Your position on the map is never stored as history: only the latest one, in memory, while the map is open.",
            "Messages show what you sent; the conversations themselves also belong to the people you wrote with.",
        ],
        "account": {
            "id": uid, "username": user.username, "name": user.name, "email": user.email, "bio": user.bio,
            "picture": _picture(user.picture_url), "created": iso(user.created_at),
        },
        "settings": user.settings,
        "consents": {kind: [{**entry, "at": iso(entry["at"])} for entry in log] for kind, log in consents_of(user).items()},
        "profileStyle": user.style,
        "avatar": user.avatar,
        "pushTokens": [{"platform": platform} for platform in user.push_tokens.values()],
        "connections": [
            {**person(other), "since": iso(info["since"]) if info.get("since") else None, "place": info.get("place")}
            for other, info in store.connections.get(uid, {}).items()
        ],
        "blocked": [{**person(other), "since": iso(since)} for other, since in store.blocks.get(uid, {}).items()],
        "eventsOrganized": events,
        "eventsFollowed": following,
        "eventsSaved": [{"eventId": event_id, "since": iso(since)} for event_id, since in store.saved.get(uid, {}).items()],
        "story": {"audience": user.story_audience, "shows": user.story, "hiddenMoments": sorted(user.story_hidden)},
        "notifications": [{"kind": n.kind, "at": iso(n.at), "eventId": n.event_id} for n in store.notifications.get(uid, [])],
        "ratings": ratings,
        "photosPosted": photos,
        "chats": chats,
        "promotionCredits": {key: value for key, value in promotions.wallet_view(uid).items() if key != "accountToken"} if uid in store.wallets else None,
        "reportsFiled": [
            {"kind": report["kind"], "targetId": report["targetId"], "reasons": report["reasons"], "details": report["details"], "at": iso(report["at"])}
            for report in store.reports if report.get("by") == uid
        ],
    }
