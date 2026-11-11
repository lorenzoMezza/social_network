# Copyright (c) 2026 Lorenzo Mezzabarba. All rights reserved.

"""Connections, blocks, reports and connecting in person (API.md; CONNECT-PROTOCOL.md rules)."""

import secrets

from fastapi import APIRouter, Depends, Response

from .. import limits, position_guard
from ..auth import current_user
from ..domain import end_shared_events, push_chat, require_chat
from ..moderation import forget_member
from ..errors import ApiError, bad_request, not_found
from ..realtime import dirty, hub, presences
from ..store import User, store
from ..util import distance_m, iso, new_id, now_ms
from ..views import connection_view, event_status, sees_message, summary_of

router = APIRouter(prefix="/v1")

# People are met in person, and lists of them come whole, are checked at every read and loaded
# when someone opens the map: nobody needs more
CONNECTIONS_MAX = 5000
BLOCKS_MAX = 5000


@router.get("/me/connections")
async def connections(user: User = Depends(current_user)):
    entries = sorted(store.connections.get(user.id, {}).items(), key=lambda item: item[1]["since"], reverse=True)
    return {"items": [connection_view(other, entry) for other, entry in entries]}


def _leave_own_groups(owner: str, other: str):
    for chat in store.chats.values():
        if chat.kind == "group" and chat.owner_id == owner and other in chat.members:
            del chat.members[other]
            forget_member(chat.id, other)
            hub.send(other, {"type": "chat.removed", "chatId": chat.id})
            push_chat(chat.id, chat.members)


@router.delete("/me/connections/{other_id}", status_code=204)
async def disconnect(other_id: str, user: User = Depends(current_user)):
    if not store.is_connected(user.id, other_id):
        raise not_found("not connected")
    store.disconnect(user.id, other_id)
    _leave_own_groups(user.id, other_id)
    _tell_disconnected(user.id, other_id)
    return Response(status_code=204)


def _tell_disconnected(a: str, b: str):
    """Both phones at once, also the other's: no more connection, and their direct chat
    can no longer be written in"""
    hub.send(a, {"type": "connection.removed", "userId": b})
    hub.send(b, {"type": "connection.removed", "userId": a})
    direct = store.direct.get(frozenset((a, b)))
    if direct:
        push_chat(direct, (a, b))


@router.get("/me/blocks")
async def blocks(user: User = Depends(current_user)):
    entries = sorted(store.blocks.get(user.id, {}).items(), key=lambda item: item[1], reverse=True)
    return {"items": [{"user": summary_of(other), "since": iso(since)} for other, since in entries if other in store.users]}


def _refresh_presence(*user_ids):
    for user_id in user_ids:
        if user_id in presences:
            dirty[user_id] = presences[user_id].cell


@router.put("/me/blocks/{other_id}", status_code=204)
async def block(other_id: str, user: User = Depends(current_user)):
    if other_id == user.id or other_id not in store.users:
        raise not_found("user not found")
    limits.check(user.id, "block")
    if other_id not in store.blocks.get(user.id, {}) and len(store.blocks.get(user.id, {})) >= BLOCKS_MAX:
        raise ApiError(409, "too_many_blocks", "you have blocked as many people as one can")
    store.blocks.setdefault(user.id, {})[other_id] = now_ms()
    if store.is_connected(user.id, other_id):
        store.disconnect(user.id, other_id)
        hub.send(other_id, {"type": "connection.removed", "userId": user.id})
    store.disconnected.add(frozenset((user.id, other_id)))
    # Both ways: whoever blocks the owner of a group leaves it, or they would go on writing to
    # the others unseen by who runs it (a block hides each from the other)
    _leave_own_groups(user.id, other_id)
    _leave_own_groups(other_id, user.id)
    direct = store.direct.get(frozenset((user.id, other_id)))
    if direct:
        hub.send(user.id, {"type": "chat.removed", "chatId": direct})
        hub.send(other_id, {"type": "chat.removed", "chatId": direct})
    # Neither is at the other's events any more, and those leave their lists and maps
    end_shared_events(user.id, other_id)
    _tell_events_changed(user.id, other_id)
    # They leave each other's map at once
    _refresh_presence(user.id, other_id)
    return Response(status_code=204)


def _tell_events_changed(*user_ids):
    """What events these people see changed: their phones ask again"""
    for user_id in user_ids:
        hub.send(user_id, {"type": "events.stale"})


@router.delete("/me/blocks/{other_id}", status_code=204)
async def unblock(other_id: str, user: User = Depends(current_user)):
    limits.check(user.id, "block")
    store.blocks.get(user.id, {}).pop(other_id, None)
    # Unblocking does not reconnect: that is done in person again
    store.disconnected.add(frozenset((user.id, other_id)))
    _tell_events_changed(user.id, other_id)
    _refresh_presence(user.id, other_id)
    return Response(status_code=204)


REPORT_REASONS = {
    "user": {"harassment", "hate", "threat", "sexual", "impersonation", "spam", "minor", "other"},
    "event": {"offensive content", "inappropriate content", "not an event"},
    "photo": {"shows_me", "inappropriate", "harassment", "unrelated"},
    "message": {"harassment", "hate", "threat", "sexual", "spam", "other"},
    "group": {"harassment", "hate", "threat", "sexual", "spam", "other"},
}


def _reported(kind: str, target: str, event_id, user: User) -> dict:
    """What is reported as it is now, kept with the report: it may be changed or gone by the
    time someone reads it. 404 for what does not exist, or the user could not have seen."""
    if kind == "user":
        other = store.user(target)
        if other:
            return {"name": other.name, "username": other.username, "bio": other.bio, "picture": other.picture_url}
    elif kind == "event":
        event = store.events.get(target)
        if event:
            return {"title": event.title, "description": event.description, "creator": event.creator_id, "images": list(event.image_urls)}
    elif kind == "photo":
        # Looked up, never made: a report must not leave an empty album behind for any id
        album = store.albums.get(event_id) if isinstance(event_id, str) else None
        photo = next((p for p in album.photos if p.id == target), None) if album else None
        if photo:
            return {"url": photo.url, "author": photo.author_id}
    elif kind == "message":
        for chat_id, messages in store.messages.items():
            message = next((m for m in messages if m.id == target), None)
            if message:
                require_chat(chat_id, user.id)
                if not sees_message(chat_id, user.id, message):
                    raise not_found("nothing to report")
                return {"chatId": chat_id, "text": message.text, "author": message.sender, "at": message.at}
    elif kind == "group":
        chat = store.chats.get(target)
        if chat and chat.kind == "group" and user.id in chat.members:
            return {"title": chat.title, "picture": chat.picture_url, "owner": chat.owner_id}
    raise not_found("nothing to report")


@router.post("/reports", status_code=201)
async def report(body: dict, user: User = Depends(current_user)):
    kind, target, reasons = body.get("kind"), body.get("targetId"), body.get("reasons")
    details = body.get("details") or ""
    if not isinstance(kind, str) or kind not in REPORT_REASONS or not isinstance(target, str) or not target:
        raise bad_request("kind and targetId are needed")
    if not isinstance(reasons, list) or not reasons or any(not isinstance(r, str) or r not in REPORT_REASONS[kind] for r in reasons):
        raise bad_request("unknown reasons", sorted(REPORT_REASONS[kind]))
    if not isinstance(details, str) or len(details) > 500:
        raise bad_request("details: at most 500 characters")
    event_id = body.get("eventId")
    snapshot = _reported(kind, target, event_id, user)
    limits.check(user.id, "report")
    entry = {"id": new_id("rep"), "by": user.id, "kind": kind, "targetId": target, "eventId": event_id if isinstance(event_id, str) else None,
             "reasons": reasons, "details": details, "at": now_ms(), "snapshot": snapshot}
    store.reports.append(entry)
    return {"id": entry["id"]}


# --- connecting in person ---

TOKEN_TTL_MS = 10_000
MAX_DISTANCE_M = 100
LOCATION_MAX_AGE_MS = 2 * 60 * 1000
# The most a phone's "accuracy" widens the distance above: it comes from the phone, and a
# huge one must not excuse any distance (the map discards fixes coarser than this)
MAX_CLAIMED_ACCURACY_M = 100
sessions: dict[str, dict] = {}
tokens: dict[str, dict] = {}


def _issue(session_id: str, location) -> dict:
    session = sessions[session_id]
    session["location"] = location
    token = secrets.token_urlsafe(18)  # 144 bits
    expires = now_ms() + TOKEN_TTL_MS
    tokens[token] = {"sessionId": session_id, "expiresAt": expires}
    return {"token": token, "expiresAt": iso(expires)}


def _own_session(session_id: str, user: User) -> dict:
    session = sessions.get(session_id)
    if not session or session["host"] != user.id:
        raise not_found("session not found")
    return session


@router.post("/connections/sessions")
async def start_session(body: dict, user: User = Depends(current_user)):
    limits.check(user.id, "connect-session")
    session_id = new_id("cs")
    sessions[session_id] = {"host": user.id, "status": "waiting", "guest": None, "location": None, "created": now_ms()}
    return {"sessionId": session_id, **_issue(session_id, body.get("location"))}


@router.post("/connections/sessions/{session_id}/token")
async def rotate(session_id: str, body: dict, user: User = Depends(current_user)):
    session = _own_session(session_id, user)
    if session["status"] != "waiting":
        raise ApiError(410, "expired", "the session is over")
    limits.check(user.id, "connect-token")
    return _issue(session_id, body.get("location"))


@router.get("/connections/sessions/{session_id}")
async def get_session(session_id: str, user: User = Depends(current_user)):
    session = _own_session(session_id, user)
    return {"status": session["status"], "user": summary_of(session["guest"]) if session["guest"] else None}


@router.delete("/connections/sessions/{session_id}", status_code=204)
async def close_session(session_id: str, user: User = Depends(current_user)):
    session = _own_session(session_id, user)
    if session["status"] == "waiting":
        session["status"] = "closed"
    for token in [t for t, entry in tokens.items() if entry["sessionId"] == session_id]:
        del tokens[token]
    return Response(status_code=204)


def _point(location) -> tuple[float, float] | None:
    """The coordinates of a position a phone sent, when they are coordinates."""
    if not isinstance(location, dict):
        return None
    latitude, longitude = location.get("latitude"), location.get("longitude")
    if not all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in (latitude, longitude)):
        return None
    return (latitude, longitude) if -90 <= latitude <= 90 and -180 <= longitude <= 180 else None


def _recent(location) -> bool:
    timestamp = location.get("timestamp") if isinstance(location, dict) else None
    return isinstance(timestamp, (int, float)) and now_ms() - timestamp <= LOCATION_MAX_AGE_MS


def _usable(location, user_id: str) -> dict | None:
    """The position sent if it is recent, else where the map last saw the user, else None."""
    if _point(location) and _recent(location):
        return location
    presence = presences.get(user_id)
    return {"latitude": presence.latitude, "longitude": presence.longitude, "accuracy": presence.accuracy} if presence else None


def _claimed_accuracy(location: dict) -> float:
    accuracy = location.get("accuracy")
    return min(accuracy, MAX_CLAIMED_ACCURACY_M) if isinstance(accuracy, (int, float)) and accuracy > 0 else 0


def _too_far(host: str, guest: str, host_location, guest_location) -> bool:
    """Connecting is in person: refused on a fake position or one the user cannot be at,
    and when both are known and more than 100 m apart (beyond their accuracy). A phone
    with no position at all (no permission, indoors) is not stopped: nobody gets an extra
    step for it (the code itself lasts 10 s and must be seen or touched)."""
    for location, user_id in ((host_location, host), (guest_location, guest)):
        if isinstance(location, dict) and location.get("mocked"):
            return True
        point = _point(location)
        if point and not position_guard.plausible(user_id, *point):
            return True
    a, b = _usable(host_location, host), _usable(guest_location, guest)
    if not a or not b:
        return False
    metres = distance_m(a["latitude"], a["longitude"], b["latitude"], b["longitude"])
    return metres - _claimed_accuracy(a) - _claimed_accuracy(b) > MAX_DISTANCE_M


MEETING_DISTANCE_M = 150


def _meeting_place(*points) -> str | None:
    """Where two people met: the event happening right where they are, if any."""
    best, best_distance = None, MEETING_DISTANCE_M
    for point in points:
        if not isinstance(point, dict) or not isinstance(point.get("latitude"), (int, float)):
            continue
        for event in store.events.values():
            if event_status(event) != "ongoing":
                continue
            metres = distance_m(point["latitude"], point["longitude"], event.latitude, event.longitude)
            if metres <= best_distance:
                best, best_distance = event.title, metres
    return best


def _where(user_id: str, location):
    """A location sent with the request, else where the map last saw the user."""
    if _point(location):
        return location
    presence = presences.get(user_id)
    return {"latitude": presence.latitude, "longitude": presence.longitude} if presence else None


def connect_users(host_id: str, guest_id: str, session_id: str, guest_location=None):
    session = sessions[session_id]
    place = _meeting_place(_where(host_id, session.get("location")), _where(guest_id, guest_location))
    store.connect(host_id, guest_id, place)
    session["status"], session["guest"] = "connected", guest_id
    for token in [t for t, entry in tokens.items() if entry["sessionId"] == session_id]:
        del tokens[token]
    entry = store.connections[host_id][guest_id]
    hub.send(host_id, {"type": "connection.created", "connection": connection_view(guest_id, entry)})
    hub.send(guest_id, {"type": "connection.created", "connection": connection_view(host_id, entry)})
    # A direct chat with them may now be written
    direct = store.direct.get(frozenset((host_id, guest_id)))
    if direct:
        push_chat(direct, (host_id, guest_id))


@router.post("/connections/claims")
async def claim(body: dict, user: User = Depends(current_user)):
    limits.check(user.id, "connect-claim")
    token = body.get("token")
    if not isinstance(token, str):
        raise bad_request("a token is needed")
    entry = tokens.pop(token, None)
    if not entry or entry["expiresAt"] < now_ms():
        raise ApiError(410, "expired", "the code expired")
    session = sessions.get(entry["sessionId"])
    if not session or session["status"] != "waiting":
        raise ApiError(410, "expired", "the code expired")
    host = session["host"]
    # The account was deleted a moment ago: its codes died with it
    if host not in store.users:
        raise ApiError(410, "expired", "the code expired")
    if host == user.id:
        raise ApiError(403, "self", "this is your own code")
    if store.blocked_either(host, user.id):
        raise ApiError(403, "blocked", "you cannot connect")
    if store.is_connected(host, user.id):
        raise ApiError(409, "already", "already connected")
    if _too_far(host, user.id, session.get("location"), body.get("location")):
        raise ApiError(403, "too_far", "you need to be together")
    if max(len(store.connections.get(host, {})), len(store.connections.get(user.id, {}))) >= CONNECTIONS_MAX:
        raise ApiError(409, "too_many_connections", "one of you has as many connections as one can")
    connect_users(host, user.id, entry["sessionId"], body.get("location"))
    return {"status": "connected", "user": summary_of(host)}


# --- showcase recordings only (config.SHOWCASE, refused in production) ---

@router.post("/dev/showcase/scanned")
async def showcase_scanned(body: dict, user: User = Depends(current_user)):
    """The code the caller is showing gets scanned by `guest` (a demo person), as if they
    were standing together: the real connection, with its frames to both phones."""
    from .. import config
    if not config.SHOWCASE:
        raise ApiError(404, "not_found", "not found")
    guest = body.get("guest")
    if not isinstance(guest, str) or guest not in store.users or guest == user.id:
        raise bad_request("guest: a user id")
    waiting = [sid for sid, s in sessions.items() if s["host"] == user.id and s["status"] == "waiting"]
    if not waiting:
        raise ApiError(410, "expired", "open My code first")
    connect_users(user.id, guest, waiting[-1])
    return {"status": "connected", "user": summary_of(guest)}
